import type { LanzerTaskPayload } from '../campaign/prompt.js';
import type { LanzerRunReport } from '../report/model.js';
import type { LanzerDslSkillReference, LanzerGenerationPolicy } from '../services/types.js';
import type { LanzerPermissionPolicy } from './permissions.js';
import type { LanzerToolCallRecord, LanzerToolkit } from './tool-host.js';

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
    /** Directories the agent may read and write in, beyond the workspace. */
    additionalDirectories?: string[];
    /**
     * Directories the agent may read but not write: the grammar reference, reference files, the
     * DSL skill. Lanzer points the agent at these, so it has to be able to open them — and nothing
     * it is sent to read is something it should change.
     */
    readOnlyDirectories?: string[];
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
    /**
     * Run the agent without the user's own setup: for Claude, no user, project or local settings,
     * so no `CLAUDE.md` or `AGENTS.md` instructions (Claude loads the latter where a project has no
     * `CLAUDE.md`), installed skills, hooks or plugins beyond what Lanzer passes.
     *
     * Off by default. For real generation a user wants their own setup used; a benchmark wants the
     * skill under test to be the only one the agent sees. Codex offers no such switch here, and it
     * reads `AGENTS.md` regardless, so a Codex run that asks for it is recorded as not isolated.
     */
    isolated?: boolean;
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

/**
 * How a run was configured, and what the agent said it was.
 *
 * Recorded so a report can be read on its own and compared with another: the same campaign passing
 * under one model and failing under another is only visible when the report says which was which.
 */
export interface LanzerRunConfiguration {
    /** How Lanzer talked to the agent: ACP, or Codex's MCP server. */
    transport: 'acp' | 'codex-mcp';
    command: string;
    args: string[];
    /** The agent's name and version, as it reported them on connecting. Absent if it did not. */
    agent?: { name: string; version: string };
    model?: string;
    effort?: string;
    /**
     * The permission mode the session ran in: the one Lanzer set (the agent accepted the request),
     * or the one it opened in when that was already right. For Codex, the sandbox it was started
     * in. Absent when the agent offers no modes.
     */
    permissionMode?: string;
    /** The ACP tool kinds the policy allowed. */
    allowedToolKinds: string[];
    /** The built-in tools Claude was limited to, when the policy named some. */
    toolAllowlist?: string[];
    fixIterations: number;
    retryIterations: number;
    /**
     * Whether the agent ran without the user's own setup. False when it was not asked for, and when
     * it was but the transport cannot do it (Codex). Absent in reports from before it existed.
     */
    isolated?: boolean;
    /**
     * Whether the agent was offered Lanzer's tools (`validate`, `grammar_reference`). Never over
     * Codex's transport, and not when the run opted out. Absent in reports from before it existed.
     */
    lanzerTools?: boolean;
    /**
     * SHA-256 of the evaluation-mode instruction an isolated run appends to the agent's system
     * prompt. The run's prompt hash does not cover it, and a change to its wording changes the run.
     */
    evaluationPromptHash?: string;
}

export interface LanzerAgentRunResult {
    task: LanzerTaskPayload;
    /** How the run was configured. Absent only on a result built by hand. */
    configuration?: LanzerRunConfiguration;
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
    /**
     * Files the agent read or searched outside the workspace and the directories it was pointed
     * at. Absent on a result built by hand.
     */
    outsideReads?: { path: string; via: string }[];
    /** Tokens, context and cost, as far as the agent reported them. */
    usage: LanzerAgentUsage;
    /** Wall-clock time for the whole run, including agent startup and validation. */
    durationMs: number;
    /** Every prompt sent and the validation that followed it, in order. */
    attemptLog: LanzerAttemptRecord[];
    /** Files produced beyond the campaign's declared set. Not a failure unless `strictFileSet`. */
    extraFiles: string[];
    /**
     * Declared targets that already existed when the run started and were never rewritten.
     *
     * Their content predates the run, so a passing validation of them says nothing about what the
     * agent did. The run fails on them, as it would on a target that was never written.
     */
    staleFiles: string[];
    /**
     * Structured outcome of the run, attached by {@link runLanzerCampaign}.
     *
     * Absent when the lower-level entry points are called directly, because the report needs the
     * host's structured verdict and only the campaign-level orchestration has one.
     */
    report?: LanzerRunReport;
}
