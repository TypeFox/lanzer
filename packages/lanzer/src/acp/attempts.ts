import chalk from 'chalk';
import type { LanzerGenerationJob } from '../campaign/jobs.js';
import type { LanzerTaskPayload } from '../campaign/prompt.js';
import type { LanzerFileSetResult } from './file-set.js';
import { appendGroupedLanzerIssues } from './issues.js';
import { emitRunProgress } from './progress.js';
import type { LanzerAgentUsage, LanzerAgentValidationResult, LanzerAttemptRecord, RunLanzerAgentTaskOptions } from './types.js';

interface AttemptBudget {
    fixIterations: number;
    retryIterations: number;
}

export function resolveAttemptBudget(options: RunLanzerAgentTaskOptions): AttemptBudget {
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

/** How one transport talks to the agent, for {@link runAttemptLoop}. */
export interface AttemptTransport {
    /** Start a fresh conversation — for the first attempt and for each retry — and name it. */
    openSession(): Promise<string>;
    /** Send one prompt in a conversation and wait for the turn to end. */
    prompt(sessionId: string, text: string, kind: 'initial' | 'fix'): Promise<{ stopReason: string }>;
}

interface AttemptLoopOutcome {
    attempts: number;
    stopReason: string;
    lastSessionId: string;
    attemptLog: LanzerAttemptRecord[];
    validation?: LanzerAgentValidationResult;
    extraFiles: string[];
    staleFiles: string[];
}

/**
 * Prompt, validate and fix until the files pass or the budget runs out — for every transport.
 *
 * Each retry opens a fresh conversation and sends the task; within it, each fix pass sends the
 * findings of the last validation. A session whose fix passes stop changing the findings is
 * abandoned for the next retry. The transport decides only how a prompt reaches the agent, so the
 * attempt log, stall detection and file-set findings mean the same thing whichever agent ran.
 */
export async function runAttemptLoop(
    task: LanzerTaskPayload,
    options: RunLanzerAgentTaskOptions,
    transport: AttemptTransport,
    buildRetryPrompt: (validation: LanzerAgentValidationResult | undefined, attempt: number) => string,
    checkFileSet: (() => Promise<LanzerFileSetResult>) | undefined,
    deniedToolCalls: () => { kind: string; title: string }[]
): Promise<AttemptLoopOutcome> {
    const { fixIterations, retryIterations } = resolveAttemptBudget(options);
    const outcome: AttemptLoopOutcome = {
        attempts: 0,
        stopReason: 'unknown',
        lastSessionId: '',
        attemptLog: [],
        validation: options.validate ? { ok: false, issues: [] } : undefined,
        extraFiles: [],
        staleFiles: []
    };

    /** Send one prompt, validate what it left behind, and log both. */
    const attempt = async (sessionId: string, session: number, kind: 'initial' | 'fix', text: string): Promise<LanzerAgentValidationResult | undefined> => {
        outcome.attempts += 1;
        const startedAt = Date.now();
        outcome.stopReason = (await transport.prompt(sessionId, text, kind)).stopReason;
        let validation: LanzerAgentValidationResult | undefined;
        if (options.validate) {
            validation = await options.validate();
            if (checkFileSet) {
                const fileSet = await checkFileSet();
                outcome.extraFiles = fileSet.extraFiles;
                outcome.staleFiles = fileSet.staleFiles;
                validation = mergeValidationResults(validation, fileSet);
            }
            outcome.validation = validation;
        }
        outcome.attemptLog.push({
            index: outcome.attempts, kind, session, stopReason: outcome.stopReason,
            durationMs: Date.now() - startedAt,
            issueCount: validation?.issues.length ?? 0, issues: [...(validation?.issues ?? [])]
        });
        return validation;
    };

    for (let retry = 1; retry <= retryIterations; retry++) {
        const sessionId = await transport.openSession();
        outcome.lastSessionId = sessionId;

        let validation = await attempt(sessionId, retry, 'initial', task.prompt);
        if (!validation || validation.ok) {
            return outcome;
        }

        // A fix pass that returns the same diagnostics as the one before it did not move
        // the file. Repeating the prompt then costs a full turn to be told the same thing:
        // one campaign spent eight passes, 22 minutes and $5.31 being told the same
        // unsatisfiable requirement, with the agent itself saying it had stopped editing.
        let lastIssueSignature = issueSignature(validation);
        let stalledPasses = 0;

        for (let fix = 1; fix <= fixIterations; fix++) {
            const text = appendPermissionNotice(buildRetryPrompt(validation, fix), deniedToolCalls());
            validation = await attempt(sessionId, retry, 'fix', text);
            if (!validation || validation.ok) {
                return outcome;
            }

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
    return outcome;
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
export function mergeUsage(
    tokens: { totalTokens: number; inputTokens: number; outputTokens: number; cachedReadTokens: number; cachedWriteTokens: number },
    reported: { context?: { used: number; size: number }; cost?: { amount: number; currency: string } }
): LanzerAgentUsage {
    return {
        ...tokens,
        ...(reported.context ? { contextUsed: reported.context.used, contextSize: reported.context.size } : {}),
        ...(reported.cost ? { costAmount: reported.cost.amount, costCurrency: reported.cost.currency } : {})
    };
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

export function buildRetryPromptForJob(
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
    appendGroupedLanzerIssues(lines, validation.issues, 16);
    lines.push('When multiple sites report the same message, treat them as one root cause — apply a single consistent fix everywhere rather than patching each site individually.');
    lines.push('After editing, respond briefly with a status message.');
    return lines.join('\n');
}

export function buildRetryPromptForCampaign(
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
    appendGroupedLanzerIssues(lines, validation.issues, 24);
    lines.push('When multiple sites report the same message, treat them as one root cause — apply a single consistent fix everywhere rather than patching each site individually.');
    lines.push('After editing, respond briefly with a status message.');
    return lines.join('\n');
}
