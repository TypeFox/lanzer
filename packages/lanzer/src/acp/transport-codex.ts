import { randomUUID } from 'node:crypto';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult, ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import chalk from 'chalk';
import type { LanzerTaskPayload } from '../campaign/prompt.js';
import { isRecord } from '../util/guards.js';
import { mergeUsage, runAttemptLoop } from './attempts.js';
import { RecordingClient, type FileAccessRoots } from './client.js';
import { describeRunConfiguration } from './configuration.js';
import type { LanzerFileSetResult } from './file-set.js';
import { resolvePermissionPolicy, type LanzerPermissionPolicy } from './permissions.js';
import { emitRunProgress } from './progress.js';
import { sanitizeSpawnEnv } from './spawn-env.js';
import { atStage, type StageTracker } from './stages.js';
import type { LanzerAgentRunResult, LanzerAgentRunUpdate, LanzerAgentUsage, LanzerAgentValidationResult, LanzerRunConfiguration, RunLanzerAgentTaskOptions } from './types.js';

type JsonScalar = string | number | boolean | null;
type JsonValue = JsonScalar | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };
type CodexCallToolResult = Awaited<ReturnType<McpClient['callTool']>>;

export async function executeLanzerTaskOverCodex(
    task: LanzerTaskPayload,
    context: {
        sessionCwd: string;
        roots: FileAccessRoots;
    },
    options: RunLanzerAgentTaskOptions,
    buildRetryPrompt: (validation: LanzerAgentValidationResult | undefined, attempt: number) => string,
    extraValidate?: (_client: RecordingClient) => Promise<LanzerFileSetResult>
): Promise<LanzerAgentRunResult> {
    const startedAtMs = Date.now();
    const rawUpdates: LanzerAgentRunUpdate[] = [];
    const permissions = options.permissions ?? resolvePermissionPolicy(undefined);
    const client = new RecordingClient(context.roots, permissions, options.progress);
    const spawnConfig = resolveCodexSpawnConfig(options);
    const stage: StageTracker = {};
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
    if (options.toolkit) {
        emitRunProgress(
            options.progress,
            chalk.dim('[tools]'),
            chalk.yellow('warning:'),
            'Lanzer tools are not served over the Codex MCP transport; the prompt does not offer them'
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
    /** Codex restates its running totals on each `token_count`, so the latest one is the run's. */
    let tokens = { totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0 };

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
            case 'token_count':
                tokens = codexTokenTotals(msg) ?? tokens;
                rawUpdates.push({ kind: 'token_count' });
                break;
            case 'task_started':
                rawUpdates.push({ kind: 'task_started', status: 'running' });
                break;
            case 'task_complete':
                rawUpdates.push({ kind: 'task_complete', status: 'completed' });
                break;
            default:
                rawUpdates.push({ kind: msg.type });
                break;
        }
    };

    try {
        await atStage(stage, 'launch', () => mcpClient.connect(transport, {
            timeout: 300_000
        }));
        const server = mcpClient.getServerVersion();
        const configuration: LanzerRunConfiguration = {
            ...describeRunConfiguration(options, 'codex-mcp'),
            ...(server ? { agent: { name: server.name, version: server.version } } : {}),
            permissionMode: codexSandbox(permissions)
        };

        const outcome = await runAttemptLoop(task, options, {
            // Every call is its own conversation, so a session is only a label for the attempt log.
            openSession: async () => randomUUID(),
            prompt: async (_sessionId, text, kind) => {
                // With no conversation to remember it, a fix pass has to carry the task it fixes;
                // diagnostics alone leave the agent without the requirements they refer to.
                const promptText = kind === 'fix' ? `${task.prompt}\n\n${text}` : text;
                const beforeLength = outputText.length;
                const result = await atStage(stage, 'turn', () => mcpClient.callTool(
                    {
                        name: 'codex',
                        arguments: buildCodexToolArguments(task, promptText, options, permissions)
                    },
                    undefined,
                    {
                        timeout: 300_000,
                        resetTimeoutOnProgress: true
                    }
                ));
                if (outputText.length === beforeLength) {
                    outputText += extractCodexToolText(result);
                }
                return { stopReason: 'end_turn' };
            }
        }, buildRetryPrompt, extraValidate ? () => extraValidate(client) : undefined, () => client.getDeniedToolCalls());

        return {
            task,
            configuration,
            sessionId: outcome.lastSessionId,
            attempts: outcome.attempts,
            stopReason: outcome.stopReason,
            outputText,
            agentThoughtText: thoughtText,
            rawUpdates,
            validation: outcome.validation,
            attemptLog: outcome.attemptLog,
            extraFiles: outcome.extraFiles,
            staleFiles: outcome.staleFiles,
            toolCalls: [],
            deniedToolCalls: client.getDeniedToolCalls(),
            outsideReads: client.getOutsideReads(),
            usage: mergeUsage(tokens, client.getReportedUsage()),
            durationMs: Date.now() - startedAtMs
        };
    } finally {
        await mcpClient.close().catch(() => undefined);
    }
}

/**
 * The running token totals from a Codex `token_count` event, when it carries them.
 *
 * Read defensively: the event is Codex's own, outside any protocol Lanzer is built against, and a
 * shape that does not match leaves the totals as they were rather than guessing.
 */
function codexTokenTotals(msg: object): LanzerAgentUsage | undefined {
    const info = 'info' in msg && isRecord(msg.info) ? msg.info : undefined;
    const total = info && isRecord(info.total_token_usage) ? info.total_token_usage : undefined;
    if (!total) {
        return undefined;
    }
    const count = (key: string): number => (typeof total[key] === 'number' ? total[key] : 0);
    return {
        totalTokens: count('total_tokens'),
        inputTokens: count('input_tokens'),
        outputTokens: count('output_tokens'),
        cachedReadTokens: count('cached_input_tokens'),
        cachedWriteTokens: 0
    };
}

export function isCodexProvider(provider: string | undefined): boolean {
    const normalized = provider?.trim().toLowerCase();
    return normalized === 'codex' || normalized === 'openai';
}

export function shouldUseCodexMcpTransport(options: Pick<RunLanzerAgentTaskOptions, 'provider' | 'command' | 'args'>): boolean {
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
        sandbox: codexSandbox(permissions),
        'approval-policy': 'never'
    };
    if (options.model) {
        args.model = options.model;
    }
    return args;
}

/** The Codex sandbox a policy maps to: the only permission setting this transport has. */
function codexSandbox(permissions: LanzerPermissionPolicy): 'workspace-write' | 'read-only' {
    return permissions.allowed.has('edit') ? 'workspace-write' : 'read-only';
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
