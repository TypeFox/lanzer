import { stat } from 'node:fs/promises';
import type { LanzerAgentRunResult } from '../acp/run.js';
import type { LanzerGenerationJob } from '../campaign/jobs.js';
import type { LanzerCampaignValidationResult } from '../services/types.js';
import {
    LANZER_RUN_STAGE_DESCRIPTIONS,
    type LanzerIssueTally,
    type LanzerReportFile,
    type LanzerRunReport,
    type LanzerRunStage,
    type LanzerSuiteReport,
    type LanzerSuiteSummary
} from './model.js';

/** Issues with no code are still counted, under a name that reads as a gap rather than a code. */
const UNCODED = '(uncoded)';

export interface BuildLanzerRunReportInput {
    campaign: string;
    jobs: LanzerGenerationJob[];
    run: LanzerAgentRunResult;
    /** The structured verdict from the host's campaign runner. Absent when the run never validated. */
    validation?: LanzerCampaignValidationResult;
    /**
     * Findings the run added on top of the campaign runner's verdict — currently the declared
     * file-set check. Kept separate because they are about the workspace, not about any document.
     */
    fileSetIssues?: string[];
    /** Files produced beyond the declared set. Reported, not failed on — see `strictFileSet`. */
    extraFiles?: string[];
    /**
     * The run's own final verdict, which is the authoritative one.
     *
     * The campaign runner answers only "are these documents acceptable"; the run also asks whether
     * the file set is what the campaign declared. When they disagree, this is the answer that
     * decided the run's exit code, and the report has to agree with it.
     */
    ok?: boolean;
    /** Set when the run threw before producing a result — a launch or session failure. */
    failure?: { stage: LanzerRunStage; message: string };
}

async function describeFiles(jobs: LanzerGenerationJob[]): Promise<LanzerReportFile[]> {
    return Promise.all(
        jobs.map(async (job) => {
            try {
                const stats = await stat(job.absoluteOutputPath);
                return { path: job.absoluteOutputPath, exists: true, bytes: stats.size };
            } catch {
                return { path: job.absoluteOutputPath, exists: false };
            }
        })
    );
}

function tallyIssues(validation: LanzerCampaignValidationResult | undefined): LanzerIssueTally {
    const tally: LanzerIssueTally = { total: 0, byCode: {}, byKind: {} };
    for (const document of validation?.documents ?? []) {
        for (const issue of document.issues) {
            tally.total += 1;
            const code = issue.code ?? UNCODED;
            tally.byCode[code] = (tally.byCode[code] ?? 0) + 1;
            tally.byKind[issue.kind] = (tally.byKind[issue.kind] ?? 0) + 1;
        }
    }
    return tally;
}

/**
 * Decide where the run failed.
 *
 * Walks the pipeline in order and stops at the first thing that did not hold, so the answer names
 * the earliest cause rather than the loudest symptom — a file that never parsed will also fail its
 * requirements, and reporting `requirements` for it would send someone to fix the wrong thing.
 */
function determineFailedStage(
    run: LanzerAgentRunResult,
    files: LanzerReportFile[],
    validation: LanzerCampaignValidationResult | undefined,
    fileSetIssues: string[],
    ok: boolean | undefined
): LanzerRunStage | undefined {
    if (run.stopReason !== 'end_turn' && run.stopReason !== 'unknown') {
        return 'turn';
    }
    // A target that predates the run and was never rewritten is as unwritten as a missing one.
    if (files.some((file) => !file.exists) || run.staleFiles.length > 0) {
        return 'no_output';
    }
    const issues = (validation?.documents ?? []).flatMap((document) => document.issues);
    if (issues.some((issue) => issue.kind === 'lexer-error' || issue.kind === 'parser-error')) {
        return 'syntax';
    }
    if (issues.some((issue) => issue.kind === 'diagnostic')) {
        return 'semantics';
    }
    if ((validation?.campaign?.issues.length ?? 0) > 0) {
        return 'requirements';
    }
    if ((validation?.workspace?.issues.length ?? 0) > 0) {
        return 'scope';
    }
    // Reached when the documents are all acceptable but the file set is not — a file written
    // outside the declared set, or a support file edited. `no_output` is checked first above, so
    // anything left here is about writing too much rather than too little.
    if (fileSetIssues.length > 0) {
        return 'scope';
    }
    if (ok === false) {
        return 'requirements';
    }
    return validation && !validation.ok ? 'requirements' : undefined;
}

export async function buildLanzerRunReport(input: BuildLanzerRunReportInput): Promise<LanzerRunReport> {
    const { campaign, jobs, run, validation } = input;
    const fileSetIssues = input.fileSetIssues ?? [];
    const files = await describeFiles(jobs);
    const stage = input.failure?.stage ?? determineFailedStage(run, files, validation, fileSetIssues, input.ok);
    const kinds = run.rawUpdates.map((update) => update.kind);

    return {
        campaign,
        ok: stage === undefined,
        ...(stage ? { failedStage: stage, failedStageDescription: LANZER_RUN_STAGE_DESCRIPTIONS[stage] } : {}),
        ...(input.failure ? { failureMessage: input.failure.message } : {}),
        attempts: run.attempts,
        stopReason: run.stopReason,
        durationMs: run.durationMs,
        sessionId: run.sessionId,
        files,
        issues: tallyIssues(validation),
        documents: (validation?.documents ?? []).map((document) => ({
            uri: document.uri,
            issues: document.issues
        })),
        campaignIssues: validation?.campaign?.issues ?? [],
        workspaceIssues: [...(validation?.workspace?.issues ?? []), ...fileSetIssues],
        extraFiles: input.extraFiles ?? [],
        toolCalls: run.toolCalls,
        deniedToolCalls: run.deniedToolCalls,
        usage: run.usage,
        attemptLog: run.attemptLog,
        events: {
            compactions: kinds.filter((kind) => kind === 'compaction_update').length,
            unhandledUpdates: kinds.filter((kind) => kind === 'unhandled_session_update').length
        }
    };
}

export function summariseLanzerRuns(runs: LanzerRunReport[]): LanzerSuiteSummary {
    const byStage: Partial<Record<LanzerRunStage, number>> = {};
    const byCode: Record<string, number> = {};
    let totalCostAmount: number | undefined;
    let costCurrency: string | undefined;
    let totalTokens = 0;
    let totalDurationMs = 0;
    let toolCalls = 0;

    for (const run of runs) {
        if (run.failedStage) byStage[run.failedStage] = (byStage[run.failedStage] ?? 0) + 1;
        for (const [code, count] of Object.entries(run.issues.byCode)) {
            byCode[code] = (byCode[code] ?? 0) + count;
        }
        totalDurationMs += run.durationMs;
        totalTokens += run.usage.totalTokens;
        toolCalls += run.toolCalls.length;
        if (run.usage.costAmount !== undefined) {
            totalCostAmount = (totalCostAmount ?? 0) + run.usage.costAmount;
            costCurrency = run.usage.costCurrency ?? costCurrency;
        }
    }

    return {
        total: runs.length,
        succeeded: runs.filter((run) => run.ok).length,
        failed: runs.filter((run) => !run.ok).length,
        byStage,
        byCode,
        totalDurationMs,
        ...(totalCostAmount !== undefined ? { totalCostAmount } : {}),
        ...(costCurrency ? { costCurrency } : {}),
        totalTokens,
        toolCalls
    };
}

export function buildLanzerSuiteReport(runs: LanzerRunReport[], generatedAt: string): LanzerSuiteReport {
    return { generatedAt, summary: summariseLanzerRuns(runs), runs };
}
