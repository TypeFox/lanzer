import type { LanzerToolCallRecord } from '../acp/tool-host.js';
import type { LanzerAgentUsage, LanzerAttemptRecord } from '../acp/run.js';
import type { LanzerDocumentIssue } from '../services/types.js';

/**
 * The ordered stages a generation run passes through.
 *
 * Ordering is the whole point: each stage can only be reached once the previous one succeeded, so
 * the *first* stage that fails is where the agent actually failed — and that is a far more
 * actionable answer than a list of messages. A run failing at `syntax` says the grammar reference
 * is not landing; at `semantics`, that the DSL skill is too weak; at `requirements`, that the
 * campaign's selectors are hard to satisfy. The same message list cannot tell those apart.
 */
export const LANZER_RUN_STAGES = [
    'launch',
    'session',
    'turn',
    'no_output',
    'syntax',
    'semantics',
    'requirements',
    'scope'
] as const;

export type LanzerRunStage = (typeof LANZER_RUN_STAGES)[number];

/** One-line explanations, for a report a human reads rather than greps. */
export const LANZER_RUN_STAGE_DESCRIPTIONS: Readonly<Record<LanzerRunStage, string>> = {
    launch: 'the agent process could not be started',
    session: 'the agent refused to open or configure a session',
    turn: 'the agent stopped before finishing its turn',
    no_output: 'a required file was never written',
    syntax: 'a generated file does not parse',
    semantics: 'a generated file parses but the language rejects it',
    requirements: 'the files are valid but the campaign requirements are unmet',
    scope: 'files outside the declared set were written or modified'
};

export interface LanzerReportFile {
    path: string;
    exists: boolean;
    bytes?: number;
}

export interface LanzerIssueTally {
    total: number;
    /** Occurrences per diagnostic code. Uncoded issues are counted under `(uncoded)`. */
    byCode: Record<string, number>;
    byKind: Record<string, number>;
}

/** Every diagnostic on one document, kept in full — counts say how much, these say what. */
export interface LanzerReportDocument {
    uri: string;
    issues: LanzerDocumentIssue[];
}

export interface LanzerRunReport {
    campaign: string;
    ok: boolean;
    /** Absent when the run succeeded. */
    failedStage?: LanzerRunStage;
    failedStageDescription?: string;
    /** What went wrong, for a run that ended before producing a result (`launch`, `session`, `turn`). */
    failureMessage?: string;
    attempts: number;
    stopReason: string;
    durationMs: number;
    sessionId: string;
    files: LanzerReportFile[];
    issues: LanzerIssueTally;
    /**
     * The diagnostics themselves, with position and code.
     *
     * The tally answers "how many and of what kind"; this answers "which line". A report that only
     * counted them could tell you a run failed with three `LOX_TYPE_NOT_ASSIGNABLE` and not where.
     */
    documents: LanzerReportDocument[];
    /** Requirement and workspace failures, which are Lanzer's own rather than the language's. */
    campaignIssues: string[];
    workspaceIssues: string[];
    /**
     * Files the agent produced that the campaign did not declare.
     *
     * Information, not a failure — a campaign says what must be true, not everything that may
     * exist, and a language often needs a manifest beside its sources. Recorded so a run that
     * produced twelve unexpected files is visible, and so a future strict mode has something to
     * act on. Set `strictFileSet` to fail on these instead.
     */
    extraFiles: string[];
    toolCalls: LanzerToolCallRecord[];
    deniedToolCalls: { kind: string; title: string }[];
    usage: LanzerAgentUsage;
    /** Each prompt and the validation that followed, so the trajectory is visible, not just the end. */
    attemptLog: LanzerAttemptRecord[];
    events: { compactions: number; unhandledUpdates: number };
}

export interface LanzerSuiteSummary {
    total: number;
    succeeded: number;
    failed: number;
    /** How many runs failed at each stage. Stages nothing failed at are omitted. */
    byStage: Partial<Record<LanzerRunStage, number>>;
    /** Diagnostic code occurrences across every run. */
    byCode: Record<string, number>;
    totalDurationMs: number;
    totalCostAmount?: number;
    costCurrency?: string;
    totalTokens: number;
    toolCalls: number;
}

export interface LanzerSuiteReport {
    generatedAt: string;
    summary: LanzerSuiteSummary;
    runs: LanzerRunReport[];
}
