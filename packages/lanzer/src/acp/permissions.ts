/**
 * What a Lanzer generation run is allowed to let the agent do.
 *
 * Keyed on ACP's `ToolKind` rather than on tool names. Tool names are the agent's own
 * vocabulary — Claude's `Bash`/`Edit`/`WebFetch` have nothing in common with Codex's or
 * Gemini's — and Lanzer picks its agent at runtime from `LANZER_ACP_COMMAND`. A policy
 * written against one agent's names would silently enforce nothing under another, which
 * is worse than having no policy at all because it still reads as enforced. `ToolKind` is
 * part of the protocol, so every ACP agent populates it.
 */

/** The complete `ToolKind` enum, as published by ACP. */
export const LANZER_TOOL_KINDS = [
    'read',
    'edit',
    'delete',
    'move',
    'search',
    'execute',
    'think',
    'fetch',
    'switch_mode',
    'other'
] as const;

export type LanzerToolKind = (typeof LANZER_TOOL_KINDS)[number];

/**
 * What generating files actually requires, and nothing else.
 *
 * `edit` is the job itself; `read`/`search` are how the agent finds the grammar reference and
 * support files; `think` is free. `other` is here because it is where agents put skill loading
 * and MCP tools — and a campaign prompt asks the agent to load the host's DSL skill by name
 * (see `renderPrompt`), so denying `other` would deny something Lanzer itself requested.
 *
 * Everything omitted — `execute`, `delete`, `move`, `fetch`, `switch_mode` — is refused unless
 * an operator names it. `execute` is the one that matters most: {@link assertAllowedPath} confines
 * the agent's file access to the campaign's roots, but only for reads and writes routed through
 * the client. An agent that shells out steps around that check entirely, so shell access is what
 * turns the roots from a boundary into a suggestion.
 */
export const LANZER_BASELINE_TOOL_KINDS: readonly LanzerToolKind[] = [
    'read',
    'edit',
    'search',
    'think',
    'other'
];

export interface LanzerPermissionPolicy {
    /** Tool kinds the agent may use. Anything absent is refused. */
    readonly allowed: ReadonlySet<LanzerToolKind>;
    /** Entries in the spec that name no known tool kind, kept so a caller can report a typo. */
    readonly unknownEntries: readonly string[];
    /** Whether an operator named these kinds, or they came from {@link LANZER_BASELINE_TOOL_KINDS}. */
    readonly source: 'baseline' | 'explicit';
    /**
     * Whether a tool kind this build has never heard of is allowed through.
     *
     * Only `all` sets this. Listing kinds by name is a statement about the ones that exist now
     * and cannot be a decision about the ones that do not, so a newer protocol's kind is refused;
     * `all` is the operator saying they want no policy at all, and it would be a poor escape
     * hatch if it still held something back.
     */
    readonly allowUnknownKinds: boolean;
}

/**
 * Read a policy out of a `LANZER_ACP_ALLOW`-style spec.
 *
 * An absent or blank spec yields the baseline. A present one is taken literally: the listed
 * kinds are allowed and every other kind is refused, so narrowing needs no separate deny list.
 * `all` (or `*`) opts into everything.
 *
 * Unrecognised entries are collected rather than dropped. A spec of `exec` would otherwise be
 * indistinguishable from one that deliberately withheld `execute`, and the agent would fail in
 * a way that looks like a model problem instead of a typo.
 */
export function resolvePermissionPolicy(spec: string | undefined): LanzerPermissionPolicy {
    const entries = (spec ?? '')
        .split(/[,\s]+/)
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0);

    if (entries.length === 0) {
        return {
            allowed: new Set(LANZER_BASELINE_TOOL_KINDS),
            unknownEntries: [],
            source: 'baseline',
            allowUnknownKinds: false
        };
    }

    if (entries.some((entry) => entry === 'all' || entry === '*')) {
        return {
            allowed: new Set(LANZER_TOOL_KINDS),
            unknownEntries: [],
            source: 'explicit',
            allowUnknownKinds: true
        };
    }

    const allowed = new Set<LanzerToolKind>();
    const unknownEntries: string[] = [];
    for (const entry of entries) {
        const kind = LANZER_TOOL_KINDS.find((candidate) => candidate === entry);
        if (kind) {
            allowed.add(kind);
        } else {
            unknownEntries.push(entry);
        }
    }

    return { allowed, unknownEntries, source: 'explicit', allowUnknownKinds: false };
}

/** Allow everything. The escape hatch behind `--allow-all`. */
export function permissiveLanzerPolicy(): LanzerPermissionPolicy {
    return {
        allowed: new Set(LANZER_TOOL_KINDS),
        unknownEntries: [],
        source: 'explicit',
        allowUnknownKinds: true
    };
}

/**
 * Whether a tool call may proceed.
 *
 * A call that states no kind is `other`, which is what ACP defaults it to. A call that states a
 * kind this build does not know is refused instead — unless the policy is `all`. Such a kind can
 * only come from a protocol newer than the one Lanzer was compiled against, and folding it into
 * `other` would quietly admit every future tool kind on the strength of a decision made before it
 * existed. See {@link LanzerPermissionPolicy.allowUnknownKinds}.
 */
export function isToolKindAllowed(
    policy: LanzerPermissionPolicy,
    kind: string | null | undefined
): boolean {
    if (kind === null || kind === undefined || kind.length === 0) {
        return policy.allowed.has('other');
    }
    const resolved = LANZER_TOOL_KINDS.find((candidate) => candidate === kind);
    if (resolved === undefined) {
        return policy.allowUnknownKinds;
    }
    return policy.allowed.has(resolved);
}

/** Render the allowed kinds for a log line, in the enum's own order so runs read consistently. */
export function describePermissionPolicy(policy: LanzerPermissionPolicy): string {
    const allowed = LANZER_TOOL_KINDS.filter((kind) => policy.allowed.has(kind));
    return allowed.length > 0 ? allowed.join(', ') : 'nothing';
}

/**
 * Tool names to *offer* Claude Code, per allowed kind.
 *
 * An allowlist rather than a deny-list, and the difference is not stylistic. Withholding by name
 * can only exclude what someone thought to name: a run with `execute` denied still reached a shell
 * through `Monitor`, and spawned sub-agents through `Task`, because both report as `other`/`think`
 * — the same kinds skill loading needs — and neither was on any deny-list. Naming what may be used
 * closes the whole surface instead of the part already known about. Verified: with the list below
 * an agent explicitly told to call `Monitor` and `Task` invokes nothing.
 *
 * `think` maps to no tool: thinking is not one. `other` maps to skill loading only — deliberately
 * not the harness tools that also land in that bucket.
 *
 * Names as of the Claude Code build `claude-agent-acp` 0.82.0 ships (agent SDK 0.3.280), where
 * `NotebookRead`, `BashOutput` and `KillShell` no longer exist.
 */
const CLAUDE_TOOLS_BY_KIND: Readonly<Record<LanzerToolKind, readonly string[]>> = {
    read: ['Read'],
    edit: ['Write', 'Edit', 'NotebookEdit'],
    delete: [],
    move: [],
    search: ['Glob', 'Grep'],
    execute: ['Bash'],
    think: [],
    fetch: ['WebFetch', 'WebSearch'],
    switch_mode: [],
    other: ['Skill']
};

/**
 * Tools that belong to an interactive session, never to an unattended generation run.
 *
 * These are withheld regardless of the policy, because ACP's `kind` cannot tell them apart from
 * things the run genuinely needs. Every one of them reports as `other` or `think` — the same
 * buckets as loading the DSL skill — so a policy keyed on kind either admits all of them or breaks
 * skill loading.
 *
 * They are not hypothetical. In one campaign run the agent used `Monitor` to execute
 * `rm -f module.json …` while `execute` was denied, spawned sub-agents through `Task` to research
 * the failure, and called `ScheduleWakeup` to defer work past the end of the run — the three
 * together turning a single campaign into 10 attempts, 22 minutes and $5.31. A batch run has no
 * user to ask, no next turn to wake into, and no reason to delegate.
 *
 * `Agent` is what `Task` is called now; `Workflow` fans out sub-agents too, the worktree tools move
 * the session out of the workspace it was given, and `RemoteTrigger` and `PushNotification` reach
 * past the run. `Task` stays because `claude-agent-acp` 0.82.0 still reports sub-agent calls under
 * either name; every other entry is a current Claude Code tool.
 */
const INTERACTIVE_ONLY_TOOLS = [
    'Agent',
    'Workflow',
    'EnterWorktree',
    'ExitWorktree',
    'RemoteTrigger',
    'PushNotification',
    'Task',
    'Monitor',
    'ScheduleWakeup',
    'ListAgents',
    'SendMessage',
    'AskUserQuestion',
    'TaskOutput',
    'TaskStop',
    'CronCreate',
    'CronDelete',
    'CronList'
];

/**
 * The built-in tools the agent may use, given the policy.
 *
 * Returns `undefined` for a fully permissive policy, which leaves the agent on its own default
 * tool set — `--allow-all` means "no policy", and quietly capping the tool list would be a policy.
 */
export function allowedClaudeTools(policy: LanzerPermissionPolicy): string[] | undefined {
    if (policy.allowUnknownKinds && LANZER_TOOL_KINDS.every((kind) => policy.allowed.has(kind))) {
        return undefined;
    }
    const allowed: string[] = [];
    for (const kind of LANZER_TOOL_KINDS) {
        if (!policy.allowed.has(kind)) continue;
        allowed.push(...CLAUDE_TOOLS_BY_KIND[kind]);
    }
    return allowed;
}

/** Whether a tool is one an unattended run never offers, whatever its ACP kind says. */
export function isInteractiveOnlyTool(toolName: string | null | undefined): boolean {
    return typeof toolName === 'string' && INTERACTIVE_ONLY_TOOLS.includes(toolName);
}

/**
 * The Claude Code permission mode to open the session in.
 *
 * `acceptEdits` when the campaign may write, so the agent is not stopped for approval on every
 * file it was sent here to produce; the shell is unaffected by it and still reaches the callback.
 *
 * Never `bypassPermissions`: it stops the agent from asking at all, which would leave the policy
 * enforced by nothing while still appearing to be configured.
 */
export function permissionModeFor(policy: LanzerPermissionPolicy): 'acceptEdits' | 'default' {
    return policy.allowed.has('edit') ? 'acceptEdits' : 'default';
}
