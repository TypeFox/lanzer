import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import chalk from 'chalk';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult, ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import type { LanzerGenerationJob } from '../campaign/jobs.js';
import type { LanzerDslSkillReference, LanzerGenerationPolicy } from '../services/types.js';
import {
    buildLanzerAgentTask,
    buildLanzerCampaignTask,
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

export interface LanzerAgentRunResult {
    task: LanzerTaskPayload;
    sessionId: string;
    attempts: number;
    stopReason: string;
    outputText: string;
    agentThoughtText: string;
    rawUpdates: LanzerAgentRunUpdate[];
    validation?: LanzerAgentValidationResult;
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

class RecordingClient implements acp.Client {
    private readonly updates: LanzerAgentRunUpdate[] = [];
    private readonly outputChunks: string[] = [];
    private readonly thoughtChunks: string[] = [];
    private readonly allowedRoots: string[];
    private readonly writtenPaths = new Set<string>();
    private readonly progress?: RecordingClientProgress;
    private readonly toolTitles = new Map<string, string>();
    private readonly toolKinds = new Map<string, string>();
    private agentLineBuf = '';
    private thoughtLineBuf = '';

    constructor(allowedRoots: string[], progress?: RecordingClientProgress) {
        this.allowedRoots = allowedRoots.map((root) => resolve(root));
        this.progress = progress;
    }

    async requestPermission(): Promise<{ outcome: { outcome: 'cancelled' } }> {
        return {
            outcome: { outcome: 'cancelled' }
        };
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
                const toolCallId = (update as { toolCallId?: string }).toolCallId;
                const kindStr = (update as { kind?: string }).kind ?? '';
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
                    const entries = (update as { entries?: { content?: string }[] }).entries ?? [];
                    this.emitProgress(chalk.dim('[plan]'), `${entries.length} entries`);
                }
                return;
            case 'available_commands_update':
            case 'current_mode_update':
            case 'config_option_update':
            case 'session_info_update':
            case 'usage_update':
            case 'user_message_chunk':
                this.updates.push({ kind: update.sessionUpdate });
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

interface WorkspaceSnapshot {
    files: Set<string>;
    supportHashes: Map<string, string | null>;
}

export async function runLanzerAgentTaskOverAcp(
    job: LanzerGenerationJob,
    options: RunLanzerAgentTaskOptions
): Promise<LanzerAgentRunResult> {
    const task = buildLanzerAgentTask(job, options.policy, options.dslSkill);
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
    const task = buildLanzerCampaignTask(jobs, options.policy, options.dslSkill);
    const sessionCwd = jobs[0]?.workspaceRoot ?? options.cwd ?? process.cwd();
    const expectedOutputPaths = jobs.map((job) => resolve(job.absoluteOutputPath));
    const supportPaths = jobs[0]?.supportFiles.map((file) => resolve(file.absolutePath)) ?? [];
    const baselineSnapshot = await captureWorkspaceSnapshot(sessionCwd, supportPaths);
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
        async () => validateCampaignFileSet(sessionCwd, baselineSnapshot, expectedOutputPaths, supportPaths)
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

    // Ensure the session CWD exists before spawning the ACP process.
    // The ACP agent passes this directory as the `cwd` for its internal
    // subprocess (e.g. the Claude native binary). A missing directory causes
    // spawn() to emit ENOENT, which the SDK misattributes as a binary launch
    // failure.
    await mkdir(context.sessionCwd, { recursive: true });

    const processHandle = spawnAcpProcess(options, options.cwd ?? process.cwd());
    const outputStream = Readable.toWeb(processHandle.stdout) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(
        Writable.toWeb(processHandle.stdin),
        outputStream
    );
    const client = new RecordingClient(context.allowedRoots, options.progress);
    const connection = new acp.ClientSideConnection(() => client, stream);
    const { fixIterations, retryIterations } = resolveAttemptBudget(options);

    try {
        await connection.initialize({
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
        let validation: LanzerAgentValidationResult | undefined = options.validate
            ? { ok: false, issues: [] }
            : undefined;

        retryLoop: for (let retry = 1; retry <= retryIterations; retry++) {
            const session = await openConfiguredSession(connection, context, options);
            lastSessionId = session.sessionId;

            attempts += 1;
            const initialResponse = await connection.prompt({
                sessionId: session.sessionId,
                prompt: [{ type: 'text', text: task.prompt }]
            });
            stopReason = initialResponse.stopReason;

            if (!options.validate) {
                break;
            }

            validation = await options.validate();
            if (extraValidate) {
                validation = mergeValidationResults(validation, await extraValidate(client));
            }
            if (validation.ok) break retryLoop;

            for (let fix = 1; fix <= fixIterations; fix++) {
                attempts += 1;
                const fixResponse = await connection.prompt({
                    sessionId: session.sessionId,
                    prompt: [{ type: 'text', text: buildRetryPrompt(validation, fix) }]
                });
                stopReason = fixResponse.stopReason;

                validation = await options.validate();
                if (extraValidate) {
                    validation = mergeValidationResults(validation, await extraValidate(client));
                }
                if (validation.ok) break retryLoop;
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
            validation
        };
    } finally {
        processHandle.kill();
    }
}

/**
 * Open a fresh ACP session and apply per-session configuration (mode, model, effort,
 * provider). Each retry iteration gets one of these so the agent's conversation
 * memory is wiped while the underlying ACP process keeps running.
 */
async function openConfiguredSession(
    connection: acp.ClientSideConnection,
    context: { sessionCwd: string; allowedRoots: string[] },
    options: RunLanzerAgentTaskOptions
): Promise<acp.NewSessionResponse> {
    const session = await connection.newSession({
        cwd: context.sessionCwd,
        additionalDirectories: options.additionalDirectories,
        mcpServers: []
    });

    if (options.sessionModeId && session.modes) {
        await connection.setSessionMode({
            sessionId: session.sessionId,
            modeId: options.sessionModeId
        });
    }

    if (options.model && connection.unstable_setSessionModel) {
        try {
            await connection.unstable_setSessionModel({
                sessionId: session.sessionId,
                modelId: options.model
            });
        } catch {
            await trySetConfigOption(connection, session.sessionId, session.configOptions ?? [], ['model'], options.model);
        }
    }

    if (options.effort) {
        await trySetConfigOption(
            connection,
            session.sessionId,
            session.configOptions ?? [],
            ['thought_level', 'effort', 'reasoning'],
            options.effort
        );
    }

    if (options.provider) {
        await trySetConfigOption(
            connection,
            session.sessionId,
            session.configOptions ?? [],
            ['provider'],
            options.provider
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
    const { fixIterations, retryIterations } = resolveAttemptBudget(options);
    const rawUpdates: LanzerAgentRunUpdate[] = [];
    const sessionId = randomUUID();
    const client = new RecordingClient(context.allowedRoots, options.progress);
    const spawnConfig = resolveCodexSpawnConfig(options);
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
                    arguments: buildCodexToolArguments(task, promptText, options)
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
            validation
        };
    } finally {
        await mcpClient.close().catch(() => undefined);
    }
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

function spawnAcpProcess(options: RunLanzerAgentTaskOptions, cwd: string) {
    return spawn(options.command, options.args ?? [], {
        cwd,
        env: sanitizeSpawnEnv({
            ...process.env,
            ...options.env
        }),
        stdio: ['pipe', 'pipe', 'inherit']
    });
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
    options: RunLanzerAgentTaskOptions
): Record<string, JsonValue> {
    const args: Record<string, JsonValue> = {
        prompt: promptText,
        'base-instructions': buildCodexBaseInstructions(task),
        sandbox: 'workspace-write',
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

async function trySetConfigOption(
    connection: acp.ClientSideConnection,
    sessionId: string,
    configOptions: acp.SessionConfigOption[],
    hintTerms: string[],
    value: string
): Promise<void> {
    const target = configOptions.find((option) => matchesConfigOption(option, hintTerms));
    if (!target) {
        return;
    }

    if (target.type === 'boolean') {
        await connection.setSessionConfigOption({
            sessionId,
            configId: target.id,
            type: 'boolean',
            value: value === 'true'
        });
        return;
    }

    await connection.setSessionConfigOption({
        sessionId,
        configId: target.id,
        value: target.type === 'select' ? matchSelectValue(target, value) ?? value : value
    });
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

async function validateCampaignFileSet(
    workspaceRoot: string,
    baseline: WorkspaceSnapshot,
    expectedOutputPaths: string[],
    supportPaths: string[]
): Promise<LanzerAgentValidationResult> {
    const issues: string[] = [];
    const expected = new Set(expectedOutputPaths.map((filePath) => resolve(filePath)));
    const support = new Set(supportPaths.map((filePath) => resolve(filePath)));
    const currentFiles = await listFilesRecursive(workspaceRoot);

    for (const filePath of expected) {
        if (!(await exists(filePath))) {
            issues.push(`Missing required generated file: ${filePath}`);
        }
    }

    for (const filePath of currentFiles) {
        if (!baseline.files.has(filePath) && !expected.has(filePath)) {
            issues.push(`Unexpected generated file was written outside the declared file set: ${filePath}`);
        }
    }

    for (const supportPath of support) {
        const beforeHash = baseline.supportHashes.get(supportPath) ?? null;
        const afterHash = await hashIfExists(supportPath);
        if (beforeHash !== afterHash) {
            issues.push(`Support file was modified but is not a declared generation target: ${supportPath}`);
        }
    }

    return {
        ok: issues.length === 0,
        issues
    };
}

async function captureWorkspaceSnapshot(
    workspaceRoot: string,
    supportPaths: string[]
): Promise<WorkspaceSnapshot> {
    const files = await listFilesRecursive(workspaceRoot);
    const supportHashes = new Map<string, string | null>();
    for (const supportPath of supportPaths) {
        supportHashes.set(resolve(supportPath), await hashIfExists(supportPath));
    }
    return { files, supportHashes };
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

async function hashIfExists(filePath: string): Promise<string | null> {
    try {
        const content = await readFile(filePath);
        return createHash('sha256').update(content).digest('hex');
    } catch {
        return null;
    }
}

async function exists(filePath: string): Promise<boolean> {
    try {
        await access(filePath);
        return true;
    } catch {
        return false;
    }
}
