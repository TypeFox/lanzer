import { resolve } from 'node:path';
import type { LangiumDocument } from 'langium';
import type { LanzerCampaignSpec, LanzerExpectation, LanzerOutputMatchMode, LanzerRunSpec } from '../campaign/model.js';
import type {
    LanzerBehaviourValidationResult,
    LanzerExecutionResult,
    LanzerRunOutcome,
    LanzerService
} from '../services/types.js';
import { getCampaignFileAbsolutePath } from './requirement-validations.js';

/** How much of an output a finding quotes; enough to see what went wrong, not a whole log. */
const QUOTED_OUTPUT_LIMIT = 400;

/**
 * Run each of the campaign's `run` blocks and check what the program did.
 *
 * Returns `undefined` for a campaign with no `run` blocks. A host that cannot execute its language
 * fails every run rather than skipping it: a campaign that asks for behaviour and gets none checked
 * would otherwise pass on structure alone, which is exactly what `run` exists to prevent.
 */
export async function validateBehaviour(
    campaign: LanzerCampaignSpec,
    documents: LangiumDocument[],
    execute: LanzerService['execute']
): Promise<LanzerBehaviourValidationResult | undefined> {
    if (campaign.runs.length === 0) {
        return undefined;
    }
    const runs: LanzerRunOutcome[] = [];
    for (const run of campaign.runs) {
        runs.push(await checkRun(campaign, run, documents, execute));
    }
    const issues = runs.flatMap((run) => run.failures);
    return { ok: issues.length === 0, runs, issues };
}

async function checkRun(
    campaign: LanzerCampaignSpec,
    run: LanzerRunSpec,
    documents: LangiumDocument[],
    execute: LanzerService['execute']
): Promise<LanzerRunOutcome> {
    const fail = (failure: string): LanzerRunOutcome => ({ fileAlias: run.fileAlias, failures: [failure] });

    if (!execute) {
        return fail(`Cannot check run '${run.fileAlias}': the host language does not run programs.`);
    }
    const file = campaign.files.find((candidate) => candidate.alias === run.fileAlias);
    const entryPath = file ? resolve(getCampaignFileAbsolutePath(campaign, file)) : undefined;
    const entry = documents.find((document) => resolve(document.uri.fsPath) === entryPath);
    if (!entry) {
        return fail(`Cannot run '${run.fileAlias}': its file was not generated.`);
    }

    let execution: LanzerExecutionResult;
    try {
        execution = await execute(entry, documents);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return fail(`Running '${run.fileAlias}' failed in the host language: ${reason}`);
    }

    // Every expectation implies the program finished: output checks on a crashed run would only
    // repeat the crash in other words, so they wait until it runs through.
    if (!execution.completed) {
        const why = execution.timedOut ? 'timed out' : `stopped on a runtime error: ${execution.error ?? 'unknown error'}`;
        return {
            fileAlias: run.fileAlias,
            execution,
            failures: [`Run of '${run.fileAlias}' ${why}. Output so far: ${quote(execution.output)}`]
        };
    }

    const failures = run.expectations
        .map((expectation) => checkExpectation(run.fileAlias, expectation, execution.output))
        .filter((failure): failure is string => failure !== undefined);
    return { fileAlias: run.fileAlias, execution, failures };
}

/** The failure an expectation reports for this output, or `undefined` when it holds. */
function checkExpectation(alias: string, expectation: LanzerExpectation, output: string): string | undefined {
    if (expectation.kind === 'runs') {
        return undefined;
    }
    const holds = outputMatches(expectation.mode, expectation.value, output);
    if (holds !== expectation.negated) {
        return undefined;
    }
    const must = expectation.negated ? 'must not' : 'must';
    const wanted = {
        exact: `${must} be exactly ${quote(expectation.value)}`,
        contains: `${must} contain ${quote(expectation.value)}`,
        matches: `${must} match /${expectation.value}/`
    }[expectation.mode];
    return `Run of '${alias}': output ${wanted}, but was ${quote(output)}`;
}

function outputMatches(mode: LanzerOutputMatchMode, expected: string, output: string): boolean {
    const actual = normaliseLineEndings(output);
    switch (mode) {
        case 'exact':
            return normaliseForExact(actual) === normaliseForExact(normaliseLineEndings(expected));
        case 'contains':
            return actual.includes(normaliseLineEndings(expected));
        case 'matches':
            return new RegExp(expected).test(actual);
    }
}

function normaliseLineEndings(text: string): string {
    return text.replace(/\r\n?/g, '\n');
}

/**
 * Exact comparison forgives what nobody means: trailing spaces on a line and trailing blank lines.
 * `print` adding a final newline, or not, is not a behaviour anyone writes a campaign about.
 */
function normaliseForExact(text: string): string {
    return text.split('\n').map((line) => line.trimEnd()).join('\n').replace(/\n+$/, '');
}

function quote(text: string): string {
    const shown = text.length > QUOTED_OUTPUT_LIMIT ? `${text.slice(0, QUOTED_OUTPUT_LIMIT)}…` : text;
    return JSON.stringify(shown);
}
