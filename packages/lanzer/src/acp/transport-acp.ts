import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import chalk from 'chalk';
import type { LanzerTaskPayload } from '../campaign/prompt.js';
import { mergeUsage, runAttemptLoop } from './attempts.js';
import { describeRunConfiguration } from './configuration.js';
import { buildClientApp, RecordingClient, type FileAccessRoots } from './client.js';
import { withFileSetCheck, type LanzerFileSetResult } from './file-set.js';
import {
    allowedClaudeTools,
    describePermissionPolicy,
    permissionModeFor,
    resolvePermissionPolicy,
    type LanzerPermissionPolicy
} from './permissions.js';
import { emitRunProgress, type RecordingClientProgress } from './progress.js';
import { sanitizeSpawnEnv } from './spawn-env.js';
import { LANZER_EVALUATION_MODE_PROMPT, LANZER_ISOLATED_ENV } from './evaluation.js';
import { asStageError, atStage, LanzerRunStageError, type StageTracker } from './stages.js';
import { startLanzerToolHost, type LanzerToolHost } from './tool-host.js';
import type { LanzerAgentRunResult, LanzerAgentValidationResult, LanzerRunConfiguration, RunLanzerAgentTaskOptions } from './types.js';

/** Run a task over an ACP agent: spawn it, open sessions, and prompt until the files pass. */
export async function executeLanzerTaskOverAcp(
    task: LanzerTaskPayload,
    context: {
        sessionCwd: string;
        roots: FileAccessRoots;
    },
    options: RunLanzerAgentTaskOptions,
    buildRetryPrompt: (validation: LanzerAgentValidationResult | undefined, attempt: number) => string,
    extraValidate?: (client: RecordingClient) => Promise<LanzerFileSetResult>
): Promise<LanzerAgentRunResult> {
    const startedAtMs = Date.now();
    // Ensure the session CWD exists before spawning the ACP process.
    // The ACP agent passes this directory as the `cwd` for its internal
    // subprocess (e.g. the Claude native binary). A missing directory causes
    // spawn() to emit ENOENT, which the SDK misattributes as a binary launch
    // failure.
    await mkdir(context.sessionCwd, { recursive: true });

    const { child: processHandle, launch } = spawnAcpProcess(options, options.cwd ?? process.cwd());
    const stage: StageTracker = {};
    const agentLog = followAgentLog(processHandle, options.progress);
    const stream = acp.ndJsonStream(
        Writable.toWeb(processHandle.stdin),
        Readable.toWeb(processHandle.stdout)
    );
    const permissions = options.permissions ?? resolvePermissionPolicy(undefined);
    const client = new RecordingClient(context.roots, permissions, options.progress);
    emitRunProgress(options.progress, chalk.dim('[perm]'), 'allowing', describePermissionPolicy(permissions));

    const toolHost = options.toolkit
        ? await startLanzerToolHost(withFileSetCheck(options.toolkit, extraValidate, client))
        : undefined;
    if (toolHost) {
        emitRunProgress(options.progress, chalk.dim('[tools]'), 'serving', toolHost.descriptor.name, 'in-process');
    }

    try {
        // `connectWith` scopes the connection to this callback and closes it on the way out,
        // whether the run finished or threw. The agent process is killed separately below,
        // because it outlives the protocol connection by however long it takes to exit.
        // Raced against the launch failure: a command that does not exist never answers
        // `initialize`, so without this the run would wait on a handshake that cannot arrive.
        return await Promise.race([launch, buildClientApp(client).connectWith(stream, async (agent) => {
            const configuration: LanzerRunConfiguration = describeRunConfiguration(options);
            const initialized = await atStage(stage, 'session', () => agent.request(acp.AGENT_METHODS.initialize, {
                protocolVersion: acp.PROTOCOL_VERSION,
                clientInfo: {
                    name: 'lanzer',
                    version: '0.0.1'
                },
                clientCapabilities: {
                    fs: {
                        readTextFile: true,
                        writeTextFile: true
                    }
                }
            }));

            if (initialized.agentInfo) {
                configuration.agent = { name: initialized.agentInfo.name, version: initialized.agentInfo.version };
            }

            const openedSessions: string[] = [];
            const tokens = { totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0 };
            /** Token counts are per-turn and additive, unlike the cumulative `usage_update` figures. */
            const addTokens = (usage: acp.Usage | null | undefined): void => {
                if (!usage) return;
                tokens.totalTokens += usage.totalTokens;
                tokens.inputTokens += usage.inputTokens;
                tokens.outputTokens += usage.outputTokens;
                tokens.cachedReadTokens += usage.cachedReadTokens ?? 0;
                tokens.cachedWriteTokens += usage.cachedWriteTokens ?? 0;
            };

            try {
                const outcome = await runAttemptLoop(task, options, {
                    openSession: async () => {
                        const { session, permissionMode } = await atStage(stage, 'session', () => openConfiguredSession(agent, context, options, permissions, toolHost));
                        openedSessions.push(session.sessionId);
                        if (permissionMode) configuration.permissionMode = permissionMode;
                        return session.sessionId;
                    },
                    prompt: async (sessionId, text) => {
                        const response = await atStage(stage, 'turn', () => agent.request(acp.AGENT_METHODS.session_prompt, {
                            sessionId,
                            prompt: [{ type: 'text', text }]
                        }));
                        addTokens(response.usage);
                        return { stopReason: response.stopReason };
                    }
                }, buildRetryPrompt, extraValidate ? () => extraValidate(client) : undefined, () => client.getDeniedToolCalls());

                const result = client.getResult();
                return {
                    task,
                    configuration,
                    sessionId: outcome.lastSessionId,
                    attempts: outcome.attempts,
                    stopReason: outcome.stopReason,
                    outputText: result.outputText,
                    agentThoughtText: result.thoughtText,
                    rawUpdates: result.rawUpdates,
                    validation: outcome.validation,
                    attemptLog: outcome.attemptLog,
                    extraFiles: outcome.extraFiles,
                    staleFiles: outcome.staleFiles,
                    toolCalls: [...(toolHost?.calls() ?? [])],
                    deniedToolCalls: client.getDeniedToolCalls(),
                    outsideReads: client.getOutsideReads(),
                    usage: mergeUsage(tokens, client.getReportedUsage()),
                    durationMs: Date.now() - startedAtMs
                };
            } finally {
                await closeSessionsQuietly(agent, openedSessions);
            }
        })]);
    } catch (thrown) {
        const error = stage.current ? asStageError(thrown, stage.current) : thrown;
        // The agent's own log is where a failed launch or a rejected session says what happened,
        // and without `--verbose` nobody has seen it. Attach the tail to the one error that will
        // actually be read rather than leaving the reason on a stream that was never shown.
        const tail = agentLog.tail();
        if (!tail) throw error;
        const message = error instanceof Error ? error.message : String(error);
        const detailed = `${message}\n\nLast output from the agent:\n${tail}`;
        throw error instanceof LanzerRunStageError ? new LanzerRunStageError(error.stage, detailed) : new Error(detailed);
    } finally {
        processHandle.kill();
        await toolHost?.close();
    }
}

/**
 * Say goodbye to every session this run opened, before the connection goes away.
 *
 * Killing the agent process was the whole of the old shutdown, and it cut work the agent was
 * still doing — it starts a background query to name the session once a turn ends, which died
 * mid-flight and printed `failed to generate a session title: Query closed before response
 * received` after the run had already reported success. Closing first lets that work settle.
 *
 * Every failure here is swallowed: the run is over, its result is already computed, and an agent
 * that will not close is about to be killed anyway.
 */
async function closeSessionsQuietly(
    agent: acp.ClientContext,
    sessionIds: readonly string[]
): Promise<void> {
    for (const sessionId of sessionIds) {
        try {
            await agent.request(acp.AGENT_METHODS.session_close, { sessionId });
        } catch {
            // Nothing left to do about it, and nothing that depends on it.
        }
    }
}

/**
 * Open a fresh ACP session and apply per-session configuration (mode, model, effort,
 * provider). Each retry iteration gets one of these so the agent's conversation
 * memory is wiped while the underlying ACP process keeps running.
 */
async function openConfiguredSession(
    agent: acp.ClientContext,
    context: { sessionCwd: string; roots: FileAccessRoots },
    options: RunLanzerAgentTaskOptions,
    permissions: LanzerPermissionPolicy,
    toolHost: LanzerToolHost | undefined
): Promise<{ session: acp.NewSessionResponse; permissionMode?: string }> {
    const tools = allowedClaudeTools(permissions);
    const session = await agent.request(acp.AGENT_METHODS.session_new, {
        cwd: context.sessionCwd,
        // The agent's own sandbox has to admit what Lanzer points it at. `RecordingClient` refuses
        // writes to the read-only ones only for an agent that writes through the client's `fs/*`
        // methods, which ACP leaves optional: `claude-agent-acp` (0.82.0) never calls them, so for
        // Claude these directories are writable like the rest of its session roots.
        additionalDirectories: [...(options.additionalDirectories ?? []), ...(options.readOnlyDirectories ?? [])],
        mcpServers: toolHost ? [toolHost.descriptor] : [],
        // Claude Code reads its per-session options from here. Every other agent ignores the
        // key, which is why this is a hint; `RecordingClient.requestPermission` answers the calls
        // an agent asks about, but ACP makes asking optional, and Claude in `acceptEdits` does
        // not ask before editing. The permission mode is not among these options: the adapter
        // ignores one sent here, so it is set below instead.
        _meta: {
            // Appended to Claude's own preset, which stays: an isolated run is told it is evaluated.
            ...(options.isolated ? { systemPrompt: { append: LANZER_EVALUATION_MODE_PROMPT } } : {}),
            claudeCode: {
                options: {
                    // Without this the adapter offers `bypassPermissions`, and a user whose own
                    // settings default to it would run Lanzer with no permission check at all.
                    allowDangerouslySkipPermissions: false,
                    // An allowlist, not a deny-list: `tools` replaces the agent's default set
                    // outright, so anything Lanzer did not name is unreachable — including the
                    // harness tools whose ACP kind is indistinguishable from ones the run needs.
                    ...(tools ? { tools } : {}),
                    // The adapter loads user, project and local settings by default; an empty list
                    // leaves out the user's CLAUDE.md and AGENTS.md instructions, skills, hooks and
                    // plugins.
                    ...(options.isolated ? { settingSources: [] } : {})
                }
            }
        }
    });

    // The session otherwise opens in whatever mode the user's own agent settings default to. An
    // explicit mode is sent as given; the policy's mode only when the agent offers it, since mode
    // ids are the agent's own and another agent may name none of Claude Code's.
    const policyMode = permissionModeFor(permissions);
    const modeId = options.sessionModeId
        ?? (session.modes?.availableModes.some((mode) => mode.id === policyMode) ? policyMode : undefined);
    if (modeId && session.modes && session.modes.currentModeId !== modeId) {
        await agent.request(acp.AGENT_METHODS.session_set_mode, {
            sessionId: session.sessionId,
            modeId
        });
    }

    if (options.model) {
        const applied = await trySetConfigOption(
            agent,
            session.sessionId,
            session.configOptions ?? [],
            ['model'],
            options.model,
            options.progress
        );
        if (!applied) {
            await trySetLegacySessionModel(agent, session.sessionId, options.model);
        }
    }

    if (options.effort) {
        await trySetConfigOption(
            agent,
            session.sessionId,
            session.configOptions ?? [],
            ['thought_level', 'effort', 'reasoning'],
            options.effort,
            options.progress
        );
    }

    if (options.provider) {
        await trySetConfigOption(
            agent,
            session.sessionId,
            session.configOptions ?? [],
            ['provider'],
            options.provider,
            options.progress
        );
    }

    // The mode the session is in now: the one just set, or the one it opened in. None when the
    // agent has no modes at all.
    return { session, permissionMode: session.modes ? (modeId ?? session.modes.currentModeId) : undefined };
}

/**
 * How many trailing lines of the agent's own logging to keep for a failure report.
 *
 * Enough to carry the reason a launch or a session failed, small enough that holding it costs
 * nothing across a long run.
 */
const AGENT_LOG_TAIL_LINES = 50;

/**
 * Agent log lines that only ever report the agent failing at its own bookkeeping.
 *
 * At the end of every turn `claude-agent-acp` starts a background small-model call to name the
 * session for `session/list`, and deliberately does not wait for it — "turn-end must not wait on
 * it". Lanzer has its result and has torn the session down well inside that window, so the call
 * is cut off and the agent logs the failure, arriving after the run already succeeded. It cannot
 * be declined: `SessionTitles` is constructed for every session with nothing gating it. Waiting
 * for it would add seconds per session for a title Lanzer never reads.
 *
 * Matching on wording is the fragile part of this, and it fails in the safe direction: reworded
 * lines reappear in the log rather than something being quietly mishandled.
 */
const AGENT_SELF_INFLICTED_NOISE = /failed to generate a session title|session title update failed/;

/**
 * Follow the agent process's stderr.
 *
 * The agent narrates itself there — `[session/create] phase=… durationMs=…` and similar — which
 * was going straight to the terminal, interleaved with Lanzer's own progress and belonging to
 * neither. It is diagnostic output, so it is shown under `--verbose` and otherwise kept: the one
 * time it is worth reading unprompted is when the run failed, and then it is the only place that
 * says why.
 */
function followAgentLog(
    processHandle: ReturnType<typeof spawn>,
    progress: RecordingClientProgress | undefined
): { tail: () => string } {
    const kept: string[] = [];
    let partial = '';
    processHandle.stderr?.setEncoding('utf8');
    processHandle.stderr?.on('data', (chunk: string) => {
        partial += chunk;
        let newline: number;
        while ((newline = partial.indexOf('\n')) >= 0) {
            const line = partial.slice(0, newline).trimEnd();
            partial = partial.slice(newline + 1);
            if (line.length === 0) continue;
            if (AGENT_SELF_INFLICTED_NOISE.test(line)) continue;
            kept.push(line);
            if (kept.length > AGENT_LOG_TAIL_LINES) kept.shift();
            if (progress?.verbose) emitRunProgress(progress, chalk.dim('[agent]'), line);
        }
    });
    return { tail: () => kept.join('\n') };
}

/**
 * Spawn the agent, with the failure to start reported rather than thrown at the event loop.
 *
 * A bad `LANZER_ACP_COMMAND` makes `spawn` emit an `error` event, and an unheard `error` event is
 * an uncaught exception — the CLI died with a raw `ENOENT` stack instead of saying which command
 * it could not run. The rejection is parked on the handle so the run loop can surface it in place.
 */
function spawnAcpProcess(options: RunLanzerAgentTaskOptions, cwd: string) {
    const child = spawn(options.command, options.args ?? [], {
        cwd,
        env: sanitizeSpawnEnv({
            ...process.env,
            ...options.env,
            ...(options.isolated ? LANZER_ISOLATED_ENV : {})
        }),
        stdio: ['pipe', 'pipe', 'pipe']
    });
    const launch = new Promise<never>((_resolve, reject) => {
        child.once('error', (error: NodeJS.ErrnoException) => {
            const hint = error.code === 'ENOENT'
                ? ` — no such command. Check LANZER_ACP_COMMAND / LANZER_ACP_ARGS.`
                : '';
            reject(new LanzerRunStageError('launch', `Could not start the ACP agent \`${[options.command, ...(options.args ?? [])].join(' ')}\`: ${error.message}${hint}`));
        });
    });
    // Nothing awaits this unless the run does; without a sink an early rejection would surface as
    // an unhandled rejection instead of the error the run loop is about to report.
    launch.catch(() => undefined);
    return { child, launch };
}

/**
 * Apply one `LANZER_ACP_*` setting to a session, if this agent publishes an option for it.
 *
 * Returns whether a matching option was found — not whether the value stuck. The caller uses it
 * only to decide whether a pre-1.0 fallback request is worth trying, and an agent that published
 * the option is one that has already made that fallback unnecessary.
 *
 * A value the agent does not offer is reported and skipped rather than sent. Sending it anyway
 * fails the whole `generate` run during session setup, before a single prompt goes out, and the
 * agent's rejection arrives as "Internal error" — which names neither the setting nor the value,
 * so a typo in `.env` reads like the agent is broken.
 */
async function trySetConfigOption(
    agent: acp.ClientContext,
    sessionId: string,
    configOptions: acp.SessionConfigOption[],
    hintTerms: string[],
    value: string,
    progress?: RecordingClientProgress
): Promise<boolean> {
    const target = configOptions.find((option) => matchesConfigOption(option, hintTerms));
    if (!target) {
        return false;
    }

    let requested: acp.SetSessionConfigOptionRequest;
    if (target.type === 'boolean') {
        requested = { sessionId, configId: target.id, type: 'boolean', value: value === 'true' };
    } else {
        const matched = target.type === 'select' ? matchSelectValue(target, value) : value;
        if (matched === null) {
            emitRunProgress(
                progress,
                chalk.dim('[acp]'),
                chalk.yellow('warning:'),
                `"${value}" is not one of the values this agent offers for ${target.id} ` +
                `(${flattenOptionValues(target.options).join(', ')}); leaving it at "${target.currentValue}"`
            );
            return true;
        }
        requested = { sessionId, configId: target.id, value: matched };
    }

    try {
        await agent.request(acp.AGENT_METHODS.session_set_config_option, requested);
    } catch (error) {
        // The value was one the agent advertised and it still refused — access to a model the
        // account cannot use looks exactly like this. Its own default is a working run; a thrown
        // error here is no run at all.
        emitRunProgress(
            progress,
            chalk.dim('[acp]'),
            chalk.yellow('warning:'),
            `the agent refused ${target.id}="${value}" (${String(error)}); continuing on "${target.currentValue}"`
        );
    }
    return true;
}

/**
 * Select the model through the pre-1.0 `session/set_model` request.
 *
 * ACP 1.0 folded model selection into the `model` session config option and dropped both the
 * request and the typed method that sent it, so this goes out as an untyped request under the
 * old method name. Reached only when the agent published no matching config option, i.e. it is
 * an older or non-Claude agent that never followed the rename; without it `--model` would be
 * silently ignored for those rather than merely unsupported.
 */
async function trySetLegacySessionModel(
    agent: acp.ClientContext,
    sessionId: string,
    modelId: string
): Promise<void> {
    try {
        await agent.request('session/set_model', { sessionId, modelId });
    } catch {
        // The agent offers neither route; it stays on whichever model it defaulted to.
    }
}

function matchesConfigOption(option: acp.SessionConfigOption, hintTerms: string[]): boolean {
    const haystacks = [
        option.id.toLowerCase(),
        option.name.toLowerCase(),
        option.category?.toLowerCase() ?? ''
    ];
    return hintTerms.some((term) => haystacks.some((haystack) => haystack.includes(term)));
}

function flattenOptionValues(options: acp.SessionConfigSelectOptions): string[] {
    const values: string[] = [];
    for (const option of options) {
        if ('value' in option) {
            values.push(option.value);
        } else {
            for (const nested of option.options) {
                values.push(nested.value);
            }
        }
    }
    return values;
}

function matchSelectValue(
    option: Extract<acp.SessionConfigOption, { type: 'select' }>,
    preference: string
): string | null {
    const needle = preference.trim().toLowerCase();
    if (!needle) {
        return null;
    }

    const exactValue = flattenOptionValues(option.options).find((value) => value.toLowerCase() === needle);
    if (exactValue) {
        return exactValue;
    }

    const flat: Array<{ value: string; name: string }> = [];
    for (const entry of option.options) {
        if ('options' in entry) {
            for (const nested of entry.options) {
                flat.push({ value: nested.value, name: nested.name });
            }
        } else {
            flat.push({ value: entry.value, name: entry.name });
        }
    }

    const byName = flat.find((entry) => entry.name.toLowerCase() === needle);
    if (byName) {
        return byName.value;
    }

    const byPartial = flat.find(
        (entry) => entry.name.toLowerCase().includes(needle) || entry.value.toLowerCase().includes(needle)
    );
    return byPartial?.value ?? null;
}
