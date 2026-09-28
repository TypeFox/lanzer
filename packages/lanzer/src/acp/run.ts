import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import chalk from 'chalk';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult, ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import type { LanzerGenerationJob } from '../campaign/jobs.js';
import { isRecord } from '../util/guards.js';
import type { LanzerRunReport } from '../report/model.js';
import { startLanzerToolHost, type LanzerToolCallRecord, type LanzerToolHost, type LanzerToolkit } from './tool-host.js';
import type { LanzerDslSkillReference, LanzerGenerationPolicy } from '../services/types.js';
import {
    allowedClaudeTools,
    describePermissionPolicy,
    isInteractiveOnlyTool,
    isToolKindAllowed,
    permissionModeFor,
    resolvePermissionPolicy,
    type LanzerPermissionPolicy
} from './permissions.js';
import {
    buildLanzerAgentTask,
    buildLanzerCampaignTask,
    type LanzerPromptToolNames,
    type LanzerTaskPayload
} from '../campaign/prompt.js';

export interface LanzerAgentRunUpdate {
    kind: string;
    text?: string;
    title?: string;
    status?: string;
    toolCallId?: string;
}

export interface LanzerAgentValidationResult {
    ok: boolean;
    issues: string[];
}

/**
 * One prompt sent to the agent, and what the workspace looked like afterwards.
 *
 * Kept per attempt rather than only at the end, because the *shape* of the sequence is the
 * diagnosis: 12 issues then 3 then 0 is an agent converging, 3 then 3 then 3 is one that has
 * stopped learning anything from the prompt, and only the final count is the same in both.
 */
export interface LanzerAttemptRecord {
    index: number;
    kind: 'initial' | 'fix';
    /** Which retry session this attempt belonged to; a retry starts a fresh conversation. */
    session: number;
    stopReason: string;
    durationMs: number;
    issueCount: number;
    issues: string[];
}

/**
 * What the run consumed, as reported by the agent.
 *
 * Two independent sources, because they answer different questions. `session/prompt` returns exact
 * token counts per turn, which sum across a run; `session/update` notifications report how full the
 * context is and what it has cost so far, which do not sum — the last one seen is the total.
 */
export interface LanzerAgentUsage {
    /** Summed across every prompt in the run. */
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cachedReadTokens: number;
    cachedWriteTokens: number;
    /** Latest context occupancy reported by the agent, if it reports any. */
    contextUsed?: number;
    contextSize?: number;
    /** Latest cumulative cost reported by the agent. */
    costAmount?: number;
    costCurrency?: string;
}

export interface RunLanzerAgentTaskOptions {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    additionalDirectories?: string[];
    provider?: string;
    model?: string;
    effort?: string;
    sessionModeId?: string;
    /**
     * Number of FIX passes inside a single ACP session. After the initial prompt,
     * if validation fails the agent receives a focused diagnostics-only edit prompt
     * up to this many times within the same session (conversation context preserved).
     */
    fixIterations?: number;
    /**
     * Number of RETRY iterations — each retry spins up a fresh ACP session and
     * re-sends the original prompt from scratch. Used when the fix budget is
     * exhausted in a session, or as an outer escape hatch when the agent is stuck.
     */
    retryIterations?: number;
    /**
     * @deprecated Use `fixIterations` + `retryIterations`. When set without the new
     * options, mapped to `fixIterations = max(maxAttempts - 1, 0)` and
     * `retryIterations = 1` for backward compatibility.
     */
    maxAttempts?: number;
    policy?: LanzerGenerationPolicy;
    dslSkill?: LanzerDslSkillReference;
    /**
     * What the agent is allowed to do, by ACP tool kind. Defaults to
     * {@link LANZER_BASELINE_TOOL_KINDS} — enough to generate files, and no shell.
     */
    permissions?: LanzerPermissionPolicy;
    /**
     * Tools offered to the agent for the duration of the run, served in-process.
     *
     * Backed by the same host services Lanzer validates with, so the agent can check its own work
     * against the identical implementation instead of waiting for a fix pass to tell it.
     */
    toolkit?: LanzerToolkit;
    /**
     * Fail the run when the agent writes files the campaign did not declare.
     *
     * Off by default: a campaign states what must be true of the result, not everything that may
     * exist, and a language often needs a manifest or index alongside its sources before anything
     * resolves. Extra files are reported either way — this decides whether they sink the run.
     */
    strictFileSet?: boolean;
    validate?: () => Promise<LanzerAgentValidationResult>;
    /**
     * If set, RecordingClient echoes a per-event progress line to `progressStream`
     * (default `process.stderr`). Tool-call start + terminal status are always shown
     * when this is set. Agent message/thought chunks are streamed only when
     * `verbose` is true.
     */
    progress?: {
        label?: string;
        stream?: NodeJS.WritableStream;
        verbose?: boolean;
    };
}

interface AttemptBudget {
    fixIterations: number;
    retryIterations: number;
}

function resolveAttemptBudget(options: RunLanzerAgentTaskOptions): AttemptBudget {
    if (options.fixIterations !== undefined || options.retryIterations !== undefined) {
        return {
            fixIterations: Math.max(options.fixIterations ?? 2, 0),
            retryIterations: Math.max(options.retryIterations ?? 1, 1)
        };
    }
    // Back-compat: a single legacy `maxAttempts` knob represents total prompts in one
    // session, which is the same shape as (1 + fixIterations) without retries.
    const max = Math.max(options.maxAttempts ?? 3, 1);
    return {
        fixIterations: Math.max(max - 1, 0),
        retryIterations: 1
    };
}

/**
 * Extract a human-readable command/argument summary from a tool call's `rawInput`, for verbose
 * progress output. Terminal/execute tools carry the shell command under common keys; anything else
 * falls back to compact, truncated JSON so the operator can still see what was requested.
 */
function extractToolCommand(rawInput: unknown): string | undefined {
    if (rawInput === undefined || rawInput === null) {
        return undefined;
    }
    const truncate = (text: string): string => {
        const oneLine = text.replace(/\s+/g, ' ').trim();
        return oneLine.length > 300 ? oneLine.slice(0, 297) + '...' : oneLine;
    };
    if (typeof rawInput === 'string') {
        return truncate(rawInput);
    }
    if (typeof rawInput === 'object') {
        // Common shapes across agents for shell execution and similar tools. An array reaches
        // here too, and has no such keys — it falls through to the JSON form below.
        if (isRecord(rawInput)) {
            for (const key of ['command', 'cmd', 'script', 'query', 'pattern']) {
                const value = rawInput[key];
                if (typeof value === 'string' && value.length > 0) {
                    return truncate(value);
                }
                if (Array.isArray(value)) {
                    return truncate(value.map(String).join(' '));
                }
            }
        }
        try {
            return truncate(JSON.stringify(rawInput));
        } catch {
            return undefined;
        }
    }
    return undefined;
}

export interface LanzerAgentRunResult {
    task: LanzerTaskPayload;
    sessionId: string;
    attempts: number;
    stopReason: string;
    outputText: string;
    agentThoughtText: string;
    rawUpdates: LanzerAgentRunUpdate[];
    validation?: LanzerAgentValidationResult;
    /** Every Lanzer tool the agent invoked, in order. Empty when no toolkit was offered. */
    toolCalls: LanzerToolCallRecord[];
    /** Tool calls the permission policy refused, in order. */
    deniedToolCalls: { kind: string; title: string }[];
    /** Tokens, context and cost, as far as the agent reported them. */
    usage: LanzerAgentUsage;
    /** Wall-clock time for the whole run, including agent startup and validation. */
    durationMs: number;
    /** Every prompt sent and the validation that followed it, in order. */
    attemptLog: LanzerAttemptRecord[];
    /** Files produced beyond the campaign's declared set. Not a failure unless `strictFileSet`. */
    extraFiles: string[];
    /**
     * Structured outcome of the run, attached by {@link runLanzerCampaign}.
     *
     * Absent when the lower-level entry points are called directly, because the report needs the
     * host's structured verdict and only the campaign-level orchestration has one.
     */
    report?: LanzerRunReport;
}

type JsonScalar = string | number | boolean | null;
type JsonValue = JsonScalar | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };
type CodexCallToolResult = Awaited<ReturnType<McpClient['callTool']>>;

interface RecordingClientProgress {
    label?: string;
    stream?: NodeJS.WritableStream;
    verbose?: boolean;
}

/**
 * The client half of a run: everything the agent says, does, is refused, and writes.
 *
 * Not an `acp.Client` implementation. Under ACP 1.x a client is assembled by registering
 * handlers per method (see {@link buildClientApp}), which type-checks each one against the
 * protocol's own params and response — a stricter guarantee than the interface gave, and one
 * that does not oblige this class to grow a member every time the interface does.
 *
 * It outlives any single session: a retry opens a new one, and the transcript, the written
 * paths and the refusals all have to survive that to describe the run as a whole.
 */
class RecordingClient {
    private readonly updates: LanzerAgentRunUpdate[] = [];
    private readonly outputChunks: string[] = [];
    private readonly thoughtChunks: string[] = [];
    private readonly allowedRoots: string[];
    private readonly writtenPaths = new Set<string>();
    private readonly progress?: RecordingClientProgress;
    private readonly toolTitles = new Map<string, string>();
    private readonly toolKinds = new Map<string, string>();
    /** Commands already echoed per tool call, so the same command isn't printed twice (the agent
     * may send it on the initial tool_call and again on a tool_call_update). */
    private readonly shownToolCommands = new Map<string, string>();
    private readonly permissions: LanzerPermissionPolicy;
    /** Latest context/cost figures seen; these are cumulative on the agent's side, not additive. */
    private latestContext?: { used: number; size: number };
    private latestCost?: { amount: number; currency: string };
    /** Refusals this run, so a fix pass can be told what the agent was not allowed to try. */
    private readonly deniedToolCalls: { kind: string; title: string }[] = [];
    private agentLineBuf = '';
    private thoughtLineBuf = '';

    constructor(
        allowedRoots: string[],
        permissions: LanzerPermissionPolicy,
        progress?: RecordingClientProgress
    ) {
        this.allowedRoots = allowedRoots.map((root) => resolve(root));
        this.permissions = permissions;
        this.progress = progress;
    }

    /**
     * Answer the agent's request to use a tool, against the run's permission policy.
     *
     * Refusals are `reject_once`, not `cancelled`. ACP reserves the cancelled outcome for a
     * client that is abandoning the whole turn, so returning it to say "not that one" tells the
     * agent to stop rather than to try another way — which reads afterwards as a model that gave
     * up, with nothing in the transcript to say the client is what ended it.
     */
    async requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
        const kind = params.toolCall.kind ?? 'other';
        const toolName = claudeToolName(params.toolCall._meta);
        const title = toolName ?? params.toolCall.title ?? kind;
        // Checked before the policy, not through it: these report as `other` or `think`, the same
        // kinds the run legitimately needs, so no policy keyed on kind can single them out.
        const allowed = isInteractiveOnlyTool(toolName)
            ? false
            : isToolKindAllowed(this.permissions, kind);
        const wanted = allowed ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
        const option = wanted
            .map((optionKind) => params.options.find((candidate) => candidate.kind === optionKind))
            .find((candidate) => candidate !== undefined);

        if (!option) {
            // The agent offered no option that expresses this answer. Cancelling is then the only
            // honest reply left, and it is the safe one whichever way the decision went.
            this.updates.push({ kind: 'permission_unanswerable', title, status: allowed ? 'allowed' : 'denied' });
            return { outcome: { outcome: 'cancelled' } };
        }

        if (!allowed) {
            this.deniedToolCalls.push({ kind, title });
            this.updates.push({ kind: 'permission_denied', title, status: kind });
            this.emitProgress(chalk.dim('[perm]'), chalk.red('denied'), chalk.cyan(kind), title);
        } else {
            this.updates.push({ kind: 'permission_allowed', title, status: kind });
        }

        return { outcome: { outcome: 'selected', optionId: option.optionId } };
    }

    /** Context occupancy and cost, as last reported by the agent. */
    getReportedUsage(): { context?: { used: number; size: number }; cost?: { amount: number; currency: string } } {
        return { context: this.latestContext, cost: this.latestCost };
    }

    /** Every refusal this run, in order and with repeats, for explaining a failed validation. */
    getDeniedToolCalls(): { kind: string; title: string }[] {
        return this.deniedToolCalls;
    }

    async sessionUpdate(params: acp.SessionNotification): Promise<void> {
        const update = params.update;
        switch (update.sessionUpdate) {
            case 'agent_message_chunk':
                if (update.content.type === 'text') {
                    this.outputChunks.push(update.content.text);
                    this.updates.push({ kind: update.sessionUpdate, text: update.content.text });
                    if (this.progress?.verbose) this.streamLineBuffered('agent', update.content.text);
                } else {
                    this.updates.push({ kind: update.sessionUpdate });
                }
                return;
            case 'agent_thought_chunk':
                if (update.content.type === 'text') {
                    this.thoughtChunks.push(update.content.text);
                    this.updates.push({ kind: update.sessionUpdate, text: update.content.text });
                    if (this.progress?.verbose) this.streamLineBuffered('thought', update.content.text);
                } else {
                    this.updates.push({ kind: update.sessionUpdate });
                }
                return;
            case 'tool_call': {
                const toolCallId = update.toolCallId;
                const kindStr = update.kind ?? '';
                if (toolCallId) {
                    this.toolTitles.set(toolCallId, update.title ?? '');
                    if (kindStr) this.toolKinds.set(toolCallId, kindStr);
                }
                this.updates.push({
                    kind: update.sessionUpdate,
                    title: update.title,
                    status: update.status ?? undefined
                });
                this.emitProgress(
                    chalk.dim('[tool]'),
                    kindStr ? chalk.cyan(kindStr) + ' ' : '',
                    update.title ?? '',
                    update.status ? chalk.dim(' (' + update.status + ')') : ''
                );
                // Surface what the tool is doing (command + touched files). The initial tool_call
                // often has an empty rawInput; the real command usually arrives on tool_call_update,
                // so we extract from both and dedupe per tool-call id.
                this.emitToolDetail(toolCallId, update.rawInput, update.locations);
                return;
            }
            case 'tool_call_update': {
                const toolCallId = update.toolCallId;
                const status = update.status ?? undefined;
                this.updates.push({
                    kind: update.sessionUpdate,
                    toolCallId,
                    status
                });
                // The command/args and touched files typically arrive here, not on the initial call.
                this.emitToolDetail(toolCallId, update.rawInput, update.locations);
                if (status === 'completed' || status === 'failed') {
                    const title = this.toolTitles.get(toolCallId) ?? toolCallId;
                    const kindStr = this.toolKinds.get(toolCallId) ?? '';
                    const statusColor = status === 'completed' ? chalk.green : chalk.red;
                    this.emitProgress(
                        chalk.dim('[tool]'),
                        kindStr ? chalk.cyan(kindStr) + ' ' : '',
                        title,
                        ' -> ' + statusColor(status)
                    );
                }
                return;
            }
            case 'plan':
                this.updates.push({ kind: update.sessionUpdate });
                if (this.progress?.verbose) {
                    const entries = update.entries;
                    this.emitProgress(chalk.dim('[plan]'), `${entries.length} entries`);
                }
                return;
            case 'compaction_update':
                // The agent ran out of context and is rewriting its own history. Worth showing
                // even without --verbose: a campaign whose fix passes stop improving after one
                // of these has lost the detail it was working from, and nothing else in the
                // output says so.
                this.updates.push({ kind: update.sessionUpdate, status: update.status });
                this.emitProgress(
                    chalk.dim('[context]'),
                    'compaction',
                    update.status === 'failed' ? chalk.red(update.status) : chalk.dim(update.status)
                );
                return;
            case 'usage_update':
                // Cumulative on the agent's side: each notification restates the totals rather
                // than reporting a delta, so the newest simply replaces the last.
                this.latestContext = { used: update.used, size: update.size };
                if (update.cost) {
                    this.latestCost = { amount: update.cost.amount, currency: update.cost.currency };
                }
                this.updates.push({ kind: update.sessionUpdate });
                return;
            case 'compaction_summary_chunk':
            case 'plan_update':
            case 'plan_removed':
            case 'available_commands_update':
            case 'current_mode_update':
            case 'config_option_update':
            case 'session_info_update':
            case 'user_message_chunk':
                this.updates.push({ kind: update.sessionUpdate });
                return;
            default:
                // Named rather than dropped. Every update the protocol grows arrives here first,
                // and an empty switch arm is how `compaction_update` would have gone unnoticed
                // for as long as the previous SDK was pinned.
                this.updates.push({ kind: 'unhandled_session_update' });
                if (this.progress?.verbose) {
                    this.emitProgress(chalk.dim('[acp]'), 'unhandled session update');
                }
                return;
        }
    }

    private streamLineBuffered(channel: 'agent' | 'thought', text: string): void {
        const stream = this.progress?.stream ?? process.stderr;
        const label = this.progress?.label ? `[${this.progress.label}] ` : '';
        const tag = channel === 'agent' ? chalk.dim('[say]') : chalk.dim('[think]');
        let buf = (channel === 'agent' ? this.agentLineBuf : this.thoughtLineBuf) + text;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (line.length > 0) {
                stream.write(label + tag + ' ' + line + '\n');
            }
        }
        if (channel === 'agent') this.agentLineBuf = buf;
        else this.thoughtLineBuf = buf;
    }

    /**
     * Echo what a tool call is doing — the command/args and any files it touches — when verbose.
     * Called for both `tool_call` and `tool_call_update` because the real `rawInput` usually only
     * appears on the update; results are deduped per tool-call id so a command prints at most once.
     */
    private emitToolDetail(
        toolCallId: string | undefined,
        rawInput: unknown,
        locations: { path?: string }[] | undefined | null
    ): void {
        if (!this.progress?.verbose) return;
        const command = extractToolCommand(rawInput);
        const paths = (locations ?? []).map((l) => l.path).filter((p): p is string => !!p);
        // Build a single fingerprint of (command + paths) and only emit when it changes, so the
        // same detail repeated across initial call + updates prints at most once per tool call.
        const detailKey = `${command ?? ''}\u0000${paths.join(',')}`;
        const previous = toolCallId ? this.shownToolCommands.get(toolCallId) : undefined;
        if (detailKey === '\u0000' || detailKey === previous) {
            return;
        }
        if (toolCallId) this.shownToolCommands.set(toolCallId, detailKey);
        if (command && command !== '{}') {
            this.emitProgress(chalk.dim('  $'), command);
        }
        if (paths.length > 0) {
            this.emitProgress(chalk.dim('  @'), paths.join(', '));
        }
    }

    private emitProgress(...parts: string[]): void {
        if (!this.progress) return;
        const stream = this.progress.stream ?? process.stderr;
        const label = this.progress.label ? `[${this.progress.label}] ` : '';
        stream.write(label + parts.filter((p) => p.length > 0).join(' ') + '\n');
    }

    async readTextFile(params: acp.ReadTextFileRequest): Promise<{ content: string }> {
        const filePath = this.assertAllowedPath(params.path);
        const content = await readFile(filePath, 'utf8');
        if (!params.line && !params.limit) {
            return { content };
        }
        const lines = content.split('\n');
        const start = Math.max((params.line ?? 1) - 1, 0);
        const end = params.limit ? start + params.limit : lines.length;
        return { content: lines.slice(start, end).join('\n') };
    }

    async writeTextFile(params: acp.WriteTextFileRequest): Promise<Record<string, never>> {
        const filePath = this.assertAllowedPath(params.path);
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, params.content, 'utf8');
        this.writtenPaths.add(filePath);
        return {};
    }

    getResult(): { outputText: string; thoughtText: string; rawUpdates: LanzerAgentRunUpdate[] } {
        return {
            outputText: this.outputChunks.join(''),
            thoughtText: this.thoughtChunks.join(''),
            rawUpdates: this.updates
        };
    }

    getWrittenPaths(): string[] {
        return Array.from(this.writtenPaths);
    }

    private assertAllowedPath(filePath: string): string {
        const resolvedPath = resolve(filePath);
        const permitted = this.allowedRoots.some((root) => {
            const rel = relative(root, resolvedPath);
            return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
        });
        if (!permitted) {
            throw new Error(`ACP file access denied for path outside allowed roots: ${resolvedPath}`);
        }
        return resolvedPath;
    }
}

/** A file-set verdict, plus the files that were merely extra rather than wrong. */
interface LanzerFileSetResult extends LanzerAgentValidationResult {
    extraFiles: string[];
}

interface WorkspaceSnapshot {
    files: Set<string>;
}

/**
 * The names the agent will see for Lanzer's tools, so the prompt can point at them.
 *
 * MCP namespaces a client's tools as `mcp__<server>__<tool>`, and the prompt has to use that exact
 * form or the agent looks for something that does not exist. Derived from the toolkit rather than
 * from the running host because the prompt is built before the host is listening — and the names
 * do not depend on the port.
 */
function promptToolNames(toolkit: LanzerToolkit | undefined): LanzerPromptToolNames | undefined {
    if (!toolkit) return undefined;
    return {
        ...(toolkit.validate ? { validate: 'mcp__lanzer__validate' } : {}),
        ...(toolkit.grammarReference ? { grammarReference: 'mcp__lanzer__grammar_reference' } : {})
    };
}

export async function runLanzerAgentTaskOverAcp(
    job: LanzerGenerationJob,
    options: RunLanzerAgentTaskOptions
): Promise<LanzerAgentRunResult> {
    const task = buildLanzerAgentTask(job, options.policy, options.dslSkill, promptToolNames(options.toolkit));
    return executeLanzerTaskOverAcp(
        task,
        {
            sessionCwd: job.workspaceRoot ?? options.cwd ?? process.cwd(),
            allowedRoots: [
                options.cwd ?? process.cwd(),
                job.workspaceRoot ?? options.cwd ?? process.cwd(),
                dirname(job.absoluteOutputPath),
                ...(options.additionalDirectories ?? [])
            ]
        },
        options,
        (validation, attempt) => buildRetryPromptForJob(job, validation, attempt)
    );
}

export async function runLanzerCampaignTaskOverAcp(
    jobs: LanzerGenerationJob[],
    options: RunLanzerAgentTaskOptions
): Promise<LanzerAgentRunResult> {
    const task = buildLanzerCampaignTask(jobs, options.policy, options.dslSkill, promptToolNames(options.toolkit));
    const sessionCwd = jobs[0]?.workspaceRoot ?? options.cwd ?? process.cwd();
    const expectedOutputPaths = jobs.map((job) => resolve(job.absoluteOutputPath));
    const supportPaths = jobs[0]?.supportFiles.map((file) => resolve(file.absolutePath)) ?? [];
    const baselineSnapshot = await captureWorkspaceSnapshot(sessionCwd);
    return executeLanzerTaskOverAcp(
        task,
        {
            sessionCwd,
            allowedRoots: [
                options.cwd ?? process.cwd(),
                sessionCwd,
                ...(options.additionalDirectories ?? [])
            ]
        },
        options,
        (validation, attempt) => buildRetryPromptForCampaign(jobs, validation, attempt),
        async () => validateCampaignFileSet(
            sessionCwd,
            baselineSnapshot,
            expectedOutputPaths,
            supportPaths,
            options.strictFileSet ?? false
        )
    );
}

async function executeLanzerTaskOverAcp(
    task: LanzerTaskPayload,
    context: {
        sessionCwd: string;
        allowedRoots: string[];
    },
    options: RunLanzerAgentTaskOptions,
    buildRetryPrompt: (validation: LanzerAgentValidationResult | undefined, attempt: number) => string,
    extraValidate?: (client: RecordingClient) => Promise<LanzerAgentValidationResult>
): Promise<LanzerAgentRunResult> {
    if (shouldUseCodexMcpTransport(options)) {
        return executeLanzerTaskOverCodex(task, context, options, buildRetryPrompt, extraValidate);
    }

    const startedAtMs = Date.now();
    // Ensure the session CWD exists before spawning the ACP process.
    // The ACP agent passes this directory as the `cwd` for its internal
    // subprocess (e.g. the Claude native binary). A missing directory causes
    // spawn() to emit ENOENT, which the SDK misattributes as a binary launch
    // failure.
    await mkdir(context.sessionCwd, { recursive: true });

    const { child: processHandle, launch } = spawnAcpProcess(options, options.cwd ?? process.cwd());
    const agentLog = followAgentLog(processHandle, options.progress);
    const stream = acp.ndJsonStream(
        Writable.toWeb(processHandle.stdin),
        Readable.toWeb(processHandle.stdout)
    );
    const permissions = options.permissions ?? resolvePermissionPolicy(undefined);
    const client = new RecordingClient(context.allowedRoots, permissions, options.progress);
    const { fixIterations, retryIterations } = resolveAttemptBudget(options);
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
            await agent.request(acp.AGENT_METHODS.initialize, {
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
            });

            let stopReason = 'unknown';
            let attempts = 0;
            let lastSessionId = '';
            const openedSessions: string[] = [];
            const attemptLog: LanzerAttemptRecord[] = [];
            let lastExtraFiles: string[] = [];
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
            let validation: LanzerAgentValidationResult | undefined = options.validate
                ? { ok: false, issues: [] }
                : undefined;

            try {
            retryLoop: for (let retry = 1; retry <= retryIterations; retry++) {
                const session = await openConfiguredSession(agent, context, options, permissions, toolHost);
                lastSessionId = session.sessionId;
                openedSessions.push(session.sessionId);

                attempts += 1;
                const initialStartedAt = Date.now();
                const initialResponse = await agent.request(acp.AGENT_METHODS.session_prompt, {
                    sessionId: session.sessionId,
                    prompt: [{ type: 'text', text: task.prompt }]
                });
                stopReason = initialResponse.stopReason;
                addTokens(initialResponse.usage);

                if (!options.validate) {
                    attemptLog.push({
                        index: attempts, kind: 'initial', session: retry, stopReason,
                        durationMs: Date.now() - initialStartedAt, issueCount: 0, issues: []
                    });
                    break;
                }

                validation = await options.validate();
                if (extraValidate) {
                    const fileSet = await extraValidate(client);
                    lastExtraFiles = extraFilesOf(fileSet);
                    validation = mergeValidationResults(validation, fileSet);
                }
                attemptLog.push({
                    index: attempts, kind: 'initial', session: retry, stopReason,
                    durationMs: Date.now() - initialStartedAt,
                    issueCount: validation.issues.length, issues: [...validation.issues]
                });
                if (validation.ok) break retryLoop;

                // A fix pass that returns the same diagnostics as the one before it did not move
                // the file. Repeating the prompt then costs a full turn to be told the same thing:
                // one Type-C campaign spent eight passes, 22 minutes and $5.31 being told the same
                // unsatisfiable requirement, with the agent itself saying it had stopped editing.
                let lastIssueSignature = issueSignature(validation);
                let stalledPasses = 0;

                for (let fix = 1; fix <= fixIterations; fix++) {
                    attempts += 1;
                    const fixStartedAt = Date.now();
                    const fixResponse = await agent.request(acp.AGENT_METHODS.session_prompt, {
                        sessionId: session.sessionId,
                        prompt: [{
                            type: 'text',
                            text: appendPermissionNotice(buildRetryPrompt(validation, fix), client.getDeniedToolCalls())
                        }]
                    });
                    stopReason = fixResponse.stopReason;
                    addTokens(fixResponse.usage);

                    validation = await options.validate();
                    if (extraValidate) {
                        const fileSet = await extraValidate(client);
                        lastExtraFiles = extraFilesOf(fileSet);
                        validation = mergeValidationResults(validation, fileSet);
                    }
                    attemptLog.push({
                        index: attempts, kind: 'fix', session: retry, stopReason,
                        durationMs: Date.now() - fixStartedAt,
                        issueCount: validation.issues.length, issues: [...validation.issues]
                    });
                    if (validation.ok) break retryLoop;

                    const signature = issueSignature(validation);
                    if (signature === lastIssueSignature) {
                        stalledPasses += 1;
                        if (stalledPasses >= STALLED_FIX_PASSES) {
                            emitRunProgress(
                                options.progress,
                                chalk.dim('[fix]'),
                                chalk.yellow('stalled:'),
                                `${stalledPasses + 1} passes produced identical diagnostics; abandoning this session's fix budget`
                            );
                            break;
                        }
                    } else {
                        stalledPasses = 0;
                        lastIssueSignature = signature;
                    }
                }
            }

            const result = client.getResult();
            return {
                task,
                sessionId: lastSessionId,
                attempts,
                stopReason,
                outputText: result.outputText,
                agentThoughtText: result.thoughtText,
                rawUpdates: result.rawUpdates,
                validation,
                attemptLog,
                extraFiles: [...lastExtraFiles],
                toolCalls: [...(toolHost?.calls() ?? [])],
                deniedToolCalls: client.getDeniedToolCalls(),
                usage: mergeUsage(tokens, client.getReportedUsage()),
                durationMs: Date.now() - startedAtMs
            };
            } finally {
                await closeSessionsQuietly(agent, openedSessions);
            }
        })]);
    } catch (error) {
        // The agent's own log is where a failed launch or a rejected session says what happened,
        // and without `--verbose` nobody has seen it. Attach the tail to the one error that will
        // actually be read rather than leaving the reason on a stream that was never shown.
        const tail = agentLog.tail();
        if (!tail) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message}\n\nLast output from the agent:\n${tail}`);
    } finally {
        processHandle.kill();
        await toolHost?.close();
    }
}

/**
 * Give the agent's `validate` tool the same checks the run itself applies.
 *
 * The host's campaign runner answers only for the documents. The run additionally checks that the
 * declared file set is what appeared on disk — and without this, a run failing on a stray file
 * hands the agent a tool that keeps answering VALID. That is worse than having no tool: the fix
 * prompt says the file set is wrong, the tool says everything is fine, and the agent has nothing
 * it can observe changing. One Type-C campaign spent three attempts and $0.86 in exactly that
 * position, its `validate` reporting `ok` every time while the run failed.
 *
 * The tool's description promises that a VALID answer means the run will pass. This is what makes
 * that true.
 */
function withFileSetCheck(
    toolkit: LanzerToolkit,
    extraValidate: ((client: RecordingClient) => Promise<LanzerAgentValidationResult>) | undefined,
    client: RecordingClient
): LanzerToolkit {
    const validate = toolkit.validate;
    if (!validate || !extraValidate) {
        return toolkit;
    }
    return {
        ...toolkit,
        validate: async () => {
            const result = await validate();
            const fileSet = await extraValidate(client);
            if (fileSet.ok) {
                return result;
            }
            return {
                ...result,
                ok: false,
                workspace: {
                    ok: false,
                    issues: [...(result.workspace?.issues ?? []), ...fileSet.issues]
                }
            };
        }
    };
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
 * Register the client half of the protocol against a {@link RecordingClient}.
 *
 * Handlers are registered by method name rather than by implementing the `Client` interface,
 * which is how ACP 1.x expects a client to be assembled: only the methods listed here are
 * advertised, so a request Lanzer never opted into is refused by the SDK instead of arriving at
 * a stub. The terminal and elicitation methods are deliberately absent — a batch run has no user
 * to elicit from, and it does not offer the agent a terminal.
 */
function buildClientApp(client: RecordingClient): acp.ClientApp {
    return acp
        .client({ name: 'lanzer' })
        .onNotification(acp.CLIENT_METHODS.session_update, ({ params }) => client.sessionUpdate(params))
        .onRequest(acp.CLIENT_METHODS.session_request_permission, ({ params }) => client.requestPermission(params))
        .onRequest(acp.CLIENT_METHODS.fs_read_text_file, ({ params }) => client.readTextFile(params))
        .onRequest(acp.CLIENT_METHODS.fs_write_text_file, ({ params }) => client.writeTextFile(params));
}

/**
 * Open a fresh ACP session and apply per-session configuration (mode, model, effort,
 * provider). Each retry iteration gets one of these so the agent's conversation
 * memory is wiped while the underlying ACP process keeps running.
 */
async function openConfiguredSession(
    agent: acp.ClientContext,
    context: { sessionCwd: string; allowedRoots: string[] },
    options: RunLanzerAgentTaskOptions,
    permissions: LanzerPermissionPolicy,
    toolHost: LanzerToolHost | undefined
): Promise<acp.NewSessionResponse> {
    const tools = allowedClaudeTools(permissions);
    const session = await agent.request(acp.AGENT_METHODS.session_new, {
        cwd: context.sessionCwd,
        additionalDirectories: options.additionalDirectories,
        mcpServers: toolHost ? [toolHost.descriptor] : [],
        // Claude Code reads its per-session options from here. Every other agent ignores the
        // key, which is why this is a hint and not the enforcement — that stays in
        // `RecordingClient.requestPermission`, which all of them go through.
        _meta: {
            claudeCode: {
                options: {
                    permissionMode: permissionModeFor(permissions),
                    // An allowlist, not a deny-list: `tools` replaces the agent's default set
                    // outright, so anything Lanzer did not name is unreachable — including the
                    // harness tools whose ACP kind is indistinguishable from ones the run needs.
                    ...(tools ? { tools } : {})
                }
            }
        }
    });

    if (options.sessionModeId && session.modes) {
        await agent.request(acp.AGENT_METHODS.session_set_mode, {
            sessionId: session.sessionId,
            modeId: options.sessionModeId
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

    return session;
}

async function executeLanzerTaskOverCodex(
    task: LanzerTaskPayload,
    context: {
        sessionCwd: string;
        allowedRoots: string[];
    },
    options: RunLanzerAgentTaskOptions,
    buildRetryPrompt: (validation: LanzerAgentValidationResult | undefined, attempt: number) => string,
    extraValidate?: (_client: RecordingClient) => Promise<LanzerAgentValidationResult>
): Promise<LanzerAgentRunResult> {
    const startedAtMs = Date.now();
    const { fixIterations, retryIterations } = resolveAttemptBudget(options);
    const rawUpdates: LanzerAgentRunUpdate[] = [];
    const sessionId = randomUUID();
    const permissions = options.permissions ?? resolvePermissionPolicy(undefined);
    const client = new RecordingClient(context.allowedRoots, permissions, options.progress);
    const spawnConfig = resolveCodexSpawnConfig(options);
    // Codex over MCP is not an ACP session: there is no permission callback to answer, so the
    // policy can only be expressed through the sandbox Codex is started in — and that sandbox
    // has no setting that separates writing files from running commands. Say so rather than
    // letting a run look policed when the one kind that matters most is not.
    if (!permissions.allowed.has('execute')) {
        emitRunProgress(
            options.progress,
            chalk.dim('[perm]'),
            chalk.yellow('warning:'),
            'the Codex MCP transport cannot refuse shell access separately from file writes; `execute` is not enforced for this run'
        );
    }
    const transport = new StdioClientTransport({
        command: spawnConfig.command,
        args: spawnConfig.args,
        cwd: options.cwd ?? process.cwd(),
        env: sanitizeSpawnEnv({
            ...process.env,
            ...options.env
        }),
        stderr: 'inherit'
    });
    const mcpClient = new McpClient(
        { name: 'lanzer', version: '0.0.1' },
        { capabilities: {} }
    );

    let outputText = '';
    let thoughtText = '';
    let stopReason = 'unknown';
    let validation: LanzerAgentValidationResult | undefined = options.validate
        ? { ok: false, issues: [] }
        : undefined;
    let attempts = 0;

    mcpClient.fallbackNotificationHandler = async (notification) => {
        if (notification.method !== 'codex/event') {
            return;
        }
        const params = notification.params;
        if (!params || typeof params !== 'object' || !('msg' in params)) {
            return;
        }
        const msg = params.msg;
        if (!msg || typeof msg !== 'object' || !('type' in msg) || typeof msg.type !== 'string') {
            return;
        }
        switch (msg.type) {
            case 'agent_message_delta': {
                const delta = 'delta' in msg && typeof msg.delta === 'string' ? msg.delta : '';
                if (delta) {
                    outputText += delta;
                    rawUpdates.push({ kind: 'agent_message_delta', text: delta });
                }
                break;
            }
            case 'agent_reasoning_delta': {
                const delta = 'delta' in msg && typeof msg.delta === 'string' ? msg.delta : '';
                if (delta) {
                    thoughtText += delta;
                    rawUpdates.push({ kind: 'agent_reasoning_delta', text: delta });
                }
                break;
            }
            case 'task_started':
                rawUpdates.push({ kind: 'task_started', status: 'running' });
                break;
            case 'task_complete':
                stopReason = 'end_turn';
                rawUpdates.push({ kind: 'task_complete', status: 'completed' });
                break;
            default:
                rawUpdates.push({ kind: msg.type });
                break;
        }
    };

    try {
        await mcpClient.connect(transport, {
            timeout: 300_000
        });

        // Codex's MCP transport is stateless per call — every prompt starts a fresh
        // conversation. Retry and fix iterations both reduce to "send another prompt";
        // we honour the budgets by flattening the two loops into one with the same
        // total cap of `retryIterations * (1 + fixIterations)` prompts.
        const codexLoop: { kind: 'initial' | 'fix'; fixPass: number }[] = [];
        for (let retry = 0; retry < retryIterations; retry++) {
            codexLoop.push({ kind: 'initial', fixPass: 0 });
            for (let fix = 1; fix <= fixIterations; fix++) {
                codexLoop.push({ kind: 'fix', fixPass: fix });
            }
        }

        for (const step of codexLoop) {
            attempts += 1;
            const promptText = step.kind === 'initial'
                ? task.prompt
                : buildRetryPrompt(validation, step.fixPass);
            const beforeLength = outputText.length;
            const result = await mcpClient.callTool(
                {
                    name: 'codex',
                    arguments: buildCodexToolArguments(task, promptText, options, permissions)
                },
                undefined,
                {
                    timeout: 300_000,
                    resetTimeoutOnProgress: true
                }
            );

            if (outputText.length === beforeLength) {
                outputText += extractCodexToolText(result);
            }
            stopReason = stopReason === 'unknown' ? 'end_turn' : stopReason;

            if (!options.validate) {
                break;
            }

            validation = await options.validate();
            if (extraValidate) {
                validation = mergeValidationResults(validation, await extraValidate(client));
            }
            if (validation.ok) {
                break;
            }
        }

        return {
            task,
            sessionId,
            attempts,
            stopReason,
            outputText,
            agentThoughtText: thoughtText,
            rawUpdates,
            validation,
            attemptLog: [],
            extraFiles: [],
            toolCalls: [],
            deniedToolCalls: client.getDeniedToolCalls(),
            usage: mergeUsage(
                { totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0 },
                client.getReportedUsage()
            ),
            durationMs: Date.now() - startedAtMs
        };
    } finally {
        await mcpClient.close().catch(() => undefined);
    }
}

/**
 * Tell the agent, on a fix pass, what this run refused it.
 *
 * A refusal and a validation failure look identical from the agent's side: something did not
 * work. Left unsaid, it spends the rest of the fix budget reaching for the same blocked tool
 * and reporting the same failure. Naming the closed route is what lets it choose another one —
 * and if there genuinely is no other route, saying so is more useful than a silent retry.
 */
function appendPermissionNotice(
    prompt: string,
    denied: { kind: string; title: string }[]
): string {
    if (denied.length === 0) {
        return prompt;
    }
    const kinds = Array.from(new Set(denied.map((entry) => entry.kind)));
    const examples = Array.from(new Set(denied.map((entry) => entry.title))).slice(0, 5);
    const lines = [
        prompt,
        '',
        `This run's permission policy refused ${denied.length} tool call(s) of kind: ${kinds.join(', ')}.`,
        'Refused calls:'
    ];
    for (const example of examples) {
        lines.push(`  - ${example}`);
    }
    lines.push('These are blocked by configuration, not by a mistake on your part — retrying them will fail the same way.');
    lines.push('Work within the tools you do have. If the task genuinely cannot be completed without one of them, say so instead of retrying.');
    return lines.join('\n');
}

/**
 * How many consecutive identical fix passes before this session's fix budget is abandoned.
 *
 * Two, because one repeat can be an agent that simply needed another attempt, while two says the
 * prompt is no longer telling it anything it has not already failed to act on. The run continues
 * to its next retry, which opens a fresh session — genuinely different conditions, unlike another
 * pass in a conversation that has already stopped converging.
 */
const STALLED_FIX_PASSES = 2;

/** A stable fingerprint of a validation outcome, for spotting a fix pass that changed nothing. */
function issueSignature(validation: LanzerAgentValidationResult | undefined): string {
    if (!validation) return '';
    return [...validation.issues].sort().join('\u0000');
}

/** Combine the additive per-turn token counts with the agent's latest cumulative figures. */
function mergeUsage(
    tokens: { totalTokens: number; inputTokens: number; outputTokens: number; cachedReadTokens: number; cachedWriteTokens: number },
    reported: { context?: { used: number; size: number }; cost?: { amount: number; currency: string } }
): LanzerAgentUsage {
    return {
        ...tokens,
        ...(reported.context ? { contextUsed: reported.context.used, contextSize: reported.context.size } : {}),
        ...(reported.cost ? { costAmount: reported.cost.amount, costCurrency: reported.cost.currency } : {})
    };
}

/** The extra-file list, when the validation came from the file-set check that produces one. */
function extraFilesOf(result: LanzerAgentValidationResult): string[] {
    return 'extraFiles' in result && Array.isArray(result.extraFiles) ? result.extraFiles : [];
}

function mergeValidationResults(
    primary: LanzerAgentValidationResult,
    secondary: LanzerAgentValidationResult
): LanzerAgentValidationResult {
    return {
        ok: primary.ok && secondary.ok,
        issues: [...primary.issues, ...secondary.issues]
    };
}

/**
 * The agent's own name for a tool, when it reports one.
 *
 * Claude Code puts the real name (`Bash`, `Monitor`, `Task`) under `_meta.claudeCode.toolName`;
 * the ACP `title` is a display string that may be the shell command itself. Navigated rather than
 * asserted, because `_meta` is by definition whatever the agent chose to put there.
 */
function claudeToolName(meta: unknown): string | undefined {
    if (!isRecord(meta)) return undefined;
    const claudeCode = meta['claudeCode'];
    if (!isRecord(claudeCode)) return undefined;
    const toolName = claudeCode['toolName'];
    return typeof toolName === 'string' ? toolName : undefined;
}

/** Same progress line shape as {@link RecordingClient.emitProgress}, for events outside a session. */
function emitRunProgress(
    progress: RecordingClientProgress | undefined,
    ...parts: string[]
): void {
    if (!progress) return;
    const stream = progress.stream ?? process.stderr;
    const label = progress.label ? `[${progress.label}] ` : '';
    stream.write(label + parts.filter((part) => part.length > 0).join(' ') + '\n');
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
            ...options.env
        }),
        stdio: ['pipe', 'pipe', 'pipe']
    });
    const launch = new Promise<never>((_resolve, reject) => {
        child.once('error', (error: NodeJS.ErrnoException) => {
            const hint = error.code === 'ENOENT'
                ? ` — no such command. Check LANZER_ACP_COMMAND / LANZER_ACP_ARGS.`
                : '';
            reject(new Error(`Could not start the ACP agent \`${[options.command, ...(options.args ?? [])].join(' ')}\`: ${error.message}${hint}`));
        });
    });
    // Nothing awaits this unless the run does; without a sink an early rejection would surface as
    // an unhandled rejection instead of the error the run loop is about to report.
    launch.catch(() => undefined);
    return { child, launch };
}

function sanitizeSpawnEnv(env: Record<string, string | undefined>): Record<string, string> {
    const sanitized: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (typeof value === 'string') {
            sanitized[key] = value;
        }
    }
    return sanitized;
}

function isCodexProvider(provider: string | undefined): boolean {
    const normalized = provider?.trim().toLowerCase();
    return normalized === 'codex' || normalized === 'openai';
}

function shouldUseCodexMcpTransport(options: RunLanzerAgentTaskOptions): boolean {
    if (!isCodexProvider(options.provider)) {
        return false;
    }
    return !isCodexAcpCommand(options.command, options.args ?? []);
}

function isCodexAcpCommand(command: string | undefined, args: string[]): boolean {
    if (command?.includes('codex-acp')) {
        return true;
    }
    return args.some((arg) => arg.includes('codex-acp'));
}

function resolveCodexSpawnConfig(options: RunLanzerAgentTaskOptions): {
    command: string;
    args: string[];
} {
    if (options.command) {
        return {
            command: options.command,
            args: options.args ?? []
        };
    }
    return {
        command: 'npx',
        args: ['-y', '@openai/codex', 'mcp-server']
    };
}

function buildCodexToolArguments(
    task: LanzerTaskPayload,
    promptText: string,
    options: RunLanzerAgentTaskOptions,
    permissions: LanzerPermissionPolicy
): Record<string, JsonValue> {
    const args: Record<string, JsonValue> = {
        prompt: promptText,
        'base-instructions': buildCodexBaseInstructions(task),
        // Codex's sandbox is the only permission dial this transport has, and it is coarser
        // than the policy: `workspace-write` covers running commands as well as writing files.
        // Withholding `edit` is the one distinction it can honour.
        sandbox: permissions.allowed.has('edit') ? 'workspace-write' : 'read-only',
        'approval-policy': 'never'
    };
    if (options.model) {
        args.model = options.model;
    }
    return args;
}

function buildCodexBaseInstructions(task: LanzerTaskPayload): string {
    const lines = [
        'You are Lanzer’s code-generation agent.',
        'Follow the user-provided generation prompt exactly.',
        'Write the requested files directly to disk.',
        'Do not ask follow-up questions. If a requirement is unclear, make the smallest reasonable assumption consistent with the workspace.'
    ];
    if (task.instructions.length > 0) {
        lines.push('');
        lines.push('Additional execution instructions:');
        for (const instruction of task.instructions) {
            lines.push(`- ${instruction}`);
        }
    }
    return lines.join('\n');
}

function extractCodexToolText(result: CodexCallToolResult): string {
    if (!hasContentBlocks(result)) {
        return '';
    }
    return result.content
        .filter(isTextContentBlock)
        .map((entry) => entry.text)
        .join('\n');
}

function hasContentBlocks(result: CodexCallToolResult): result is CallToolResult {
    return 'content' in result && Array.isArray(result.content);
}

function isTextContentBlock(entry: ContentBlock): entry is Extract<ContentBlock, { type: 'text' }> {
    return entry.type === 'text';
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

function buildRetryPromptForJob(
    job: LanzerGenerationJob,
    validation: LanzerAgentValidationResult | undefined,
    fixPass: number
): string {
    const lines: string[] = [];
    lines.push(`Fix pass ${fixPass}: the previous attempt did not satisfy validation.`);
    lines.push(`Target file: ${job.absoluteOutputPath}`);
    lines.push('Edit the target file in place. Keep parts that already satisfy the original requirements unchanged. Do not regenerate from scratch unless the file is clearly unsalvageable.');
    if (!validation || validation.issues.length === 0) {
        lines.push('No validation details were captured. Produce a corrected file and stop after writing it.');
        return lines.join('\n');
    }
    appendGroupedIssues(lines, validation.issues, 16);
    lines.push('When multiple sites report the same message, treat them as one root cause — apply a single consistent fix everywhere rather than patching each site individually.');
    lines.push('After editing, respond briefly with a status message.');
    return lines.join('\n');
}

function buildRetryPromptForCampaign(
    jobs: LanzerGenerationJob[],
    validation: LanzerAgentValidationResult | undefined,
    fixPass: number
): string {
    const lines: string[] = [];
    lines.push(`Fix pass ${fixPass}: the previous attempt did not satisfy validation.`);
    lines.push('Edit the declared file set in place. Keep parts that already satisfy the original requirements unchanged; do not regenerate files from scratch unless they are clearly unsalvageable.');
    lines.push('Target files in this campaign:');
    for (const job of jobs) {
        lines.push(`- ${job.absoluteOutputPath}`);
    }
    if (!validation || validation.issues.length === 0) {
        lines.push('No validation details were captured. Produce a corrected file set and stop after writing it.');
        return lines.join('\n');
    }
    appendGroupedIssues(lines, validation.issues, 24);
    lines.push('When multiple sites report the same message, treat them as one root cause — apply a single consistent fix everywhere rather than patching each site individually.');
    lines.push('After editing, respond briefly with a status message.');
    return lines.join('\n');
}

/**
 * Format the validator's issue list for a fix prompt: group identical messages and
 * show the call sites under each group. A 30-item diagnostic list with one root
 * cause becomes a single block + 30 locations, which is much easier for the agent
 * to act on than a flat enumeration of the same message repeated.
 *
 * `maxSitesPerGroup` truncates the per-group location lists when a single root
 * cause has produced an unreasonable number of call sites.
 */
function appendGroupedIssues(lines: string[], issues: string[], maxSitesPerGroup: number): void {
    const groups = new Map<string, string[]>();
    const order: string[] = [];
    for (const issue of issues) {
        const split = splitIssueIntoSiteAndMessage(issue);
        const key = split.message;
        if (!groups.has(key)) {
            groups.set(key, []);
            order.push(key);
        }
        groups.get(key)!.push(split.site);
    }

    const distinctMessages = order.length;
    if (distinctMessages === 1 && (groups.get(order[0])?.length ?? 0) > 1) {
        const message = order[0];
        const sites = groups.get(message)!;
        lines.push(`All ${sites.length} reported issues share one root cause:`);
        lines.push(`  ${message}`);
        lines.push('Sites:');
        for (const site of sites.slice(0, maxSitesPerGroup)) {
            lines.push(`  - ${site}`);
        }
        if (sites.length > maxSitesPerGroup) {
            lines.push(`  - ... ${sites.length - maxSitesPerGroup} more site(s) omitted`);
        }
        return;
    }

    lines.push(`Fix the following ${issues.length} issue(s), grouped by message:`);
    for (const message of order) {
        const sites = groups.get(message)!;
        if (sites.length === 1) {
            lines.push(`- ${sites[0]}: ${message}`);
        } else {
            lines.push(`- (${sites.length}×) ${message}`);
            for (const site of sites.slice(0, maxSitesPerGroup)) {
                lines.push(`    at ${site}`);
            }
            if (sites.length > maxSitesPerGroup) {
                lines.push(`    ... ${sites.length - maxSitesPerGroup} more site(s) omitted`);
            }
        }
    }
}

/**
 * Heuristic split of "file:line:col [kind] @ x:y message" style strings into a
 * locator and a normalised message. The validator helpers produce a few different
 * shapes — keep this tolerant rather than tightly coupled to any single one.
 */
function splitIssueIntoSiteAndMessage(issue: string): { site: string; message: string } {
    // Pattern 1: `file://...: [kind] @ line:col message`
    const kindMatch = issue.match(/^(.*?):\s*\[[^\]]+\](?:\s*@\s*(\d+:\d+))?\s*(.*)$/);
    if (kindMatch) {
        const path = kindMatch[1];
        const loc = kindMatch[2];
        const message = kindMatch[3].trim();
        const site = loc ? `${path}:${loc}` : path;
        return { site, message };
    }
    // Pattern 2: `file:line:col message`
    const colonMatch = issue.match(/^(\S+:\d+:\d+)\s+(.*)$/);
    if (colonMatch) {
        return { site: colonMatch[1], message: colonMatch[2].trim() };
    }
    // Fallback: treat the entire string as the message.
    return { site: '(no site)', message: issue.trim() };
}

/**
 * Check the workspace against what the campaign declared.
 *
 * A campaign states what must be true of the result, not an exhaustive manifest of what may exist.
 * Producing a declared target is required. Everything else the agent writes is it solving the
 * problem — a language may need a manifest, a module index, a config file before its own imports
 * resolve, and a campaign author should not have to enumerate those to get a passing run.
 *
 * Support files are not policed at all: they are the project's, and the agent owns the project. It
 * may create, edit or remove them as the language requires, guided by the DSL skill that documents
 * what they should contain. The only failure here is a declared target that never appeared.
 *
 * `strict` additionally fails on files the campaign never mentioned, for a caller that does want an
 * exact manifest.
 */
async function validateCampaignFileSet(
    workspaceRoot: string,
    baseline: WorkspaceSnapshot,
    expectedOutputPaths: string[],
    supportPaths: string[],
    strict: boolean
): Promise<LanzerFileSetResult> {
    const issues: string[] = [];
    const extraFiles: string[] = [];
    const expected = new Set(expectedOutputPaths.map((filePath) => resolve(filePath)));
    const support = new Set(supportPaths.map((filePath) => resolve(filePath)));
    const currentFiles = await listFilesRecursive(workspaceRoot);

    for (const filePath of expected) {
        if (!(await exists(filePath))) {
            issues.push(`Missing required generated file: ${filePath}`);
        }
    }

    for (const filePath of currentFiles) {
        // Support files are declared, so they are never interlopers however they got there.
        if (!baseline.files.has(filePath) && !expected.has(filePath) && !support.has(filePath)) {
            extraFiles.push(filePath);
            if (strict) {
                issues.push(`Unexpected generated file was written outside the declared file set: ${filePath}`);
            }
        }
    }

    return {
        ok: issues.length === 0,
        issues,
        extraFiles
    };
}

async function captureWorkspaceSnapshot(
    workspaceRoot: string
): Promise<WorkspaceSnapshot> {
    const files = await listFilesRecursive(workspaceRoot);
    return { files };
}

async function listFilesRecursive(root: string): Promise<Set<string>> {
    const files = new Set<string>();
    const walk = async (current: string): Promise<void> => {
        let dirEntries;
        try {
            dirEntries = await readdir(current, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of dirEntries) {
            const absolute = resolve(current, entry.name);
            if (entry.isDirectory()) {
                await walk(absolute);
            } else if (entry.isFile()) {
                files.add(absolute);
            }
        }
    };
    await walk(resolve(root));
    return files;
}


async function exists(filePath: string): Promise<boolean> {
    try {
        await access(filePath);
        return true;
    } catch {
        return false;
    }
}
