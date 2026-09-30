import type { LanzerToolCallRecord } from '../acp/tool-host.js';
import type { LanzerAgentUsage, LanzerAttemptRecord, LanzerRunConfiguration } from '../acp/run.js';
import type { LanzerDiagnosticsOutcome, LanzerDocumentIssue } from '../services/types.js';

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
    'diagnostics',
    'requirements',
    'behaviour',
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
    diagnostics: 'a negative file is not rejected the way the campaign expects',
    requirements: 'the files are valid but the campaign requirements are unmet',
    behaviour: 'the program runs, but not the way the campaign expects',
    scope: 'files outside the declared set were written or modified'
};

export interface LanzerReportFile {
    path: string;
    exists: boolean;
    bytes?: number;
}

export interface LanzerIssueTally {
    total: number;
    /**
     * Occurrences per diagnostic code. Uncoded issues are counted under `(uncoded)`. A negative
     * file's expected diagnostics are left out: they are the file working, not a failure.
     */
    byCode: Record<string, number>;
    byKind: Record<string, number>;
}

/** Every diagnostic on one document, kept in full — counts say how much, these say what. */
export interface LanzerReportDocument {
    uri: string;
    issues: LanzerDocumentIssue[];
    /**
     * Set for a negative file: its issues are what it was meant to be rejected with, judged by
     * {@link LanzerRunReport.negativeFiles}, not failures in themselves.
     */
    expectsDiagnostics?: boolean;
}

/** A file or folder a run depended on, with a SHA-256 of its content when it could be read. */
export interface LanzerFingerprintEntry {
    path: string;
    hash?: string;
}

/**
 * What a run measured, beyond the agent's configuration: enough to say whether two reports were
 * produced by the same skill, grammar and campaign, or which of them changed.
 */
export interface LanzerRunFingerprint {
    lanzerVersion: string;
    /**
     * The DSL skill the agent was pointed at. Its hash covers every file in the skill's folder; a
     * skill given by name alone has neither.
     */
    skill?: { name?: string; path?: string; hash?: string };
    /** The grammars the campaign imports. */
    grammars: LanzerFingerprintEntry[];
    /** The campaign file itself. */
    campaign?: LanzerFingerprintEntry;
    /**
     * SHA-256 of the prompt the agent was first sent, with the workspace path replaced by
     * `<workspace>` so identical runs in different folders agree. Its text is in
     * {@link LanzerSuiteReport.prompts} under this hash.
     */
    promptHash?: string;
    /**
     * SHA-256 of the host's generation policy: the language advice the prompt carries besides the
     * skill. Kept apart from the prompt's hash, which also moves whenever the campaign is edited.
     */
    policyHash?: string;
    /** `minimal` when the run kept only the grammar reference of the host's policy. */
    policyMode?: 'full' | 'minimal';
}

export interface LanzerRunReport {
    campaign: string;
    ok: boolean;
    /** Set when this is one of several identical runs: which one, of how many, and where it ran. */
    repetition?: { index: number; total: number; workspace: string };
    /** Absent when the run succeeded. */
    failedStage?: LanzerRunStage;
    failedStageDescription?: string;
    /** What went wrong, for a run that ended before producing a result (`launch`, `session`, `turn`). */
    failureMessage?: string;
    attempts: number;
    stopReason: string;
    durationMs: number;
    sessionId: string;
    /** Which agent ran, how it was configured, and the permission mode it ran in. */
    configuration?: LanzerRunConfiguration;
    /** What the run measured: Lanzer version, DSL skill, grammars and campaign, with content hashes. */
    fingerprint?: LanzerRunFingerprint;
    /**
     * The prompt's text, as hashed. Moved into {@link LanzerSuiteReport.prompts} when a suite
     * report is built, so a written report holds each prompt once.
     */
    prompt?: string;
    files: LanzerReportFile[];
    issues: LanzerIssueTally;
    /**
     * The diagnostics themselves, with position and code.
     *
     * The tally answers "how many and of what kind"; this answers "which line". A report that only
     * counted them could tell you a run failed with three `LOX_TYPE_NOT_ASSIGNABLE` and not where.
     */
    documents: LanzerReportDocument[];
    /** Each negative file: what it had to be rejected with, what was missing, what came out instead. */
    negativeFiles: LanzerDiagnosticsOutcome[];
    /** Requirement and workspace failures, which are Lanzer's own rather than the language's. */
    campaignIssues: string[];
    workspaceIssues: string[];
    /** What running the entry files showed that the `run` blocks did not expect. */
    behaviourIssues: string[];
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
    /**
     * Files the agent read or searched outside the workspace, the skill, the grammar reference and
     * the reference files. Not a failure: a sign the prompt left the agent something to look for.
     * Absent in reports from before it was recorded.
     */
    outsideReads?: { path: string; via: string }[];
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
    /**
     * Per campaign: how many runs, how many passed, and where the rest failed. With repeated runs
     * this is each campaign's pass rate.
     */
    byCampaign: Record<string, { total: number; succeeded: number; byStage: Partial<Record<LanzerRunStage, number>> }>;
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
    /**
     * Each distinct prompt the runs were sent, by {@link LanzerRunFingerprint.promptHash}. Stored
     * once rather than per run, so two reports whose hashes differ can be diffed.
     */
    prompts?: Record<string, string>;
}
