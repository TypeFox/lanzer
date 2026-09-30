import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import chalk from 'chalk';
import { isRecord } from '../util/guards.js';
import { isInteractiveOnlyTool, isToolKindAllowed, type LanzerPermissionPolicy } from './permissions.js';
import type { RecordingClientProgress } from './progress.js';
import type { LanzerAgentRunUpdate } from './types.js';

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
export class RecordingClient {
    private readonly updates: LanzerAgentRunUpdate[] = [];
    private readonly outputChunks: string[] = [];
    private readonly thoughtChunks: string[] = [];
    private readonly writableRoots: string[];
    private readonly readableRoots: string[];
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
        roots: FileAccessRoots,
        permissions: LanzerPermissionPolicy,
        progress?: RecordingClientProgress
    ) {
        this.writableRoots = roots.writable.map(canonicalPath);
        this.readableRoots = [...this.writableRoots, ...roots.readOnly.map(canonicalPath)];
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
        const filePath = this.assertAllowedPath(params.path, this.readableRoots, 'read');
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
        const filePath = this.assertAllowedPath(params.path, this.writableRoots, 'write');
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

    /**
     * Resolve a path the agent asked for, refusing it unless it lies inside one of `roots`.
     *
     * Compared after resolving symlinks, so a link inside the workspace that points out of it is
     * judged by where it leads, not by where it sits.
     */
    private assertAllowedPath(filePath: string, roots: string[], access: 'read' | 'write'): string {
        const resolvedPath = resolve(filePath);
        const canonical = canonicalPath(resolvedPath);
        if (!roots.some((root) => isWithin(root, canonical))) {
            // A request error rather than a plain one: the SDK sends a plain error to the agent as
            // "Internal error", which tells it nothing about trying another path.
            throw acp.RequestError.invalidParams(
                { path: resolvedPath },
                `ACP file ${access} denied for path outside the allowed directories: ${resolvedPath}`
            );
        }
        return resolvedPath;
    }
}

/** Where the agent may read, and the narrower set where it may also write. */
export interface FileAccessRoots {
    writable: string[];
    readOnly: string[];
}

/** Whether `path` is `root` or lies beneath it. Both are expected to be canonical. */
function isWithin(root: string, path: string): boolean {
    const rel = relative(root, path);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The path with every symlink resolved, for a path that may not exist yet.
 *
 * A file the agent is about to create has no real path of its own, so the nearest existing
 * ancestor is resolved and the rest appended — which still catches a symlinked directory on the way.
 */
function canonicalPath(path: string): string {
    const absolute = resolve(path);
    try {
        return realpathSync.native(absolute);
    } catch {
        const parent = dirname(absolute);
        return parent === absolute ? absolute : join(canonicalPath(parent), basename(absolute));
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
export function buildClientApp(client: RecordingClient): acp.ClientApp {
    return acp
        .client({ name: 'lanzer' })
        .onNotification(acp.CLIENT_METHODS.session_update, ({ params }) => client.sessionUpdate(params))
        .onRequest(acp.CLIENT_METHODS.session_request_permission, ({ params }) => client.requestPermission(params))
        .onRequest(acp.CLIENT_METHODS.fs_read_text_file, ({ params }) => client.readTextFile(params))
        .onRequest(acp.CLIENT_METHODS.fs_write_text_file, ({ params }) => client.writeTextFile(params));
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
