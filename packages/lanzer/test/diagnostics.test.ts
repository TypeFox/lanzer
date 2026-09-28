import { describe, expect, test } from 'vitest';
import type { LanzerAgentRunResult } from '../src/acp/run.js';
import { buildLanzerGenerationJobs } from '../src/campaign/jobs.js';
import { resolveLanzerCampaign } from '../src/campaign/map.js';
import type { LanzerDiagnosticExpectation } from '../src/campaign/model.js';
import { buildLanzerCampaignTask } from '../src/campaign/prompt.js';
import { buildLanzerRunReport } from '../src/report/build.js';
import { renderLanzerRunSummary } from '../src/report/render.js';
import type { LanzerCampaignValidationResult, LanzerDocumentIssue } from '../src/services/types.js';
import {
    compareDiagnostics,
    describeDiagnosticExpectation,
    findUnknownDiagnosticCodes
} from '../src/validations/diagnostic-validations.js';
import { loadCampaign, loadCampaignSpecs, miniCampaign } from './helpers.js';

async function issuesFor(source: string): Promise<string[]> {
    return (await loadCampaign(source)).issues.map((issue) => issue.message);
}

function error(message: string, code?: string): LanzerDocumentIssue {
    return { kind: 'diagnostic', message, severity: 1, ...(code ? { code } : {}) };
}

function warning(message: string, code?: string): LanzerDocumentIssue {
    return { kind: 'diagnostic', message, severity: 2, ...(code ? { code } : {}) };
}

describe('writing diagnostic expectations', () => {
    test('code, message, or both, at every severity, map to the spec', async () => {
        const source = miniCampaign([
            'require Fn',
            'expect error code "DUP"',
            'expect warning message matches "^unused \'\\\\w+\'$"',
            'expect info code "HINTY" message contains "consider"',
            'expect error message "exactly this"'
        ].join('\n'));
        expect(await issuesFor(source)).toEqual([]);
        const [campaign] = await loadCampaignSpecs(source);
        expect(campaign.files[0].diagnostics).toEqual([
            { severity: 'error', code: 'DUP' },
            { severity: 'warning', message: { mode: 'matches', value: "^unused '\\w+'$" } },
            { severity: 'info', code: 'HINTY', message: { mode: 'contains', value: 'consider' } },
            { severity: 'error', message: { mode: 'exact', value: 'exactly this' } }
        ]);
        expect(campaign.files[0].requirements).toHaveLength(1);
    });

    test('an expectation must say what to look for', async () => {
        expect(await issuesFor(miniCampaign('expect error'))).toEqual([
            'Say which error to expect: give a `code`, a `message`, or both.'
        ]);
        expect(await issuesFor(miniCampaign('expect error code " "'))).toEqual(['A diagnostic code must not be empty.']);
    });

    test('a message pattern must compile', async () => {
        expect(await issuesFor(miniCampaign('expect error message matches "("'))).toEqual([
            expect.stringMatching(/^Invalid regular expression: /)
        ]);
    });

    test('a near-miss campaign cannot also run its program', async () => {
        const source = [
            'import "mini.langium"',
            'campaign demo {',
            '    workspace "out"',
            '    file main at "main.mini" generates Module { expect error code "X" }',
            '    run main { expect runs }',
            '}'
        ].join('\n');
        expect(await issuesFor(source)).toEqual([
            "Campaign 'demo' cannot run a program: file 'main' expects diagnostics, so the workspace is invalid on purpose."
        ]);
    });

    test('the new keywords still work as property names in selectors', async () => {
        // Parsed, then rejected only because Mini's `Fn` has no such properties.
        expect(await issuesFor(miniCampaign('require Fn[message="x"][code][error="y"]'))).toEqual([
            "Type 'Fn' has no property 'message'.",
            "Type 'Fn' has no property 'code'.",
            "Type 'Fn' has no property 'error'."
        ]);
    });
});

describe('matching diagnostics', () => {
    const dup: LanzerDiagnosticExpectation = { severity: 'error', code: 'DUP' };

    test('the expected error alone passes, however many times it is reported', () => {
        expect(compareDiagnostics([dup], [error("Duplicate 'x'", 'DUP'), error("Duplicate 'y'", 'DUP')]))
            .toEqual({ missing: [], unexpected: [] });
    });

    test('an extra error fails the file', () => {
        const extra = error('Unknown type', 'TYPE');
        expect(compareDiagnostics([dup], [error("Duplicate 'x'", 'DUP'), extra])).toEqual({ missing: [], unexpected: [extra] });
    });

    test('a missing expectation fails the file', () => {
        expect(compareDiagnostics([dup], [])).toEqual({ missing: [dup], unexpected: [] });
    });

    test('code and message must hold for the same diagnostic', () => {
        const both: LanzerDiagnosticExpectation = {
            severity: 'error',
            code: 'DUP',
            message: { mode: 'matches', value: "^Duplicate identifier '\\w+'$" }
        };
        expect(compareDiagnostics([both], [error("Duplicate identifier 'count'", 'DUP')]).missing).toEqual([]);
        // One diagnostic has the code, another the message: neither is the one asked for.
        const split = [error('Something else', 'DUP'), error("Duplicate identifier 'count'", 'OTHER')];
        expect(compareDiagnostics([both], split)).toEqual({ missing: [both], unexpected: split });
    });

    test('severity has to match', () => {
        const asWarning: LanzerDiagnosticExpectation = { severity: 'warning', code: 'DUP' };
        const issue = error('dup', 'DUP');
        expect(compareDiagnostics([asWarning], [issue])).toEqual({ missing: [asWarning], unexpected: [issue] });
    });

    test('unasked warnings, infos and hints are left alone', () => {
        const issues: LanzerDocumentIssue[] = [
            error('dup', 'DUP'),
            warning('unused'),
            { kind: 'diagnostic', message: 'fyi', severity: 3 },
            { kind: 'diagnostic', message: 'hint', severity: 4 }
        ];
        expect(compareDiagnostics([dup], issues)).toEqual({ missing: [], unexpected: [] });
    });

    test('a parse error is an error, matched like any other', () => {
        const parse: LanzerDocumentIssue = { kind: 'parser-error', message: "Expecting ';'", code: 'PARSE' };
        expect(compareDiagnostics([{ severity: 'error', code: 'PARSE' }], [parse]).missing).toEqual([]);
        expect(compareDiagnostics([dup], [parse]).unexpected).toEqual([parse]);
    });

    test('an expectation reads as a sentence', () => {
        expect(describeDiagnosticExpectation({ severity: 'error', code: 'DUP', message: { mode: 'contains', value: 'twice' } }))
            .toBe('an error with code "DUP" and a message containing "twice"');
        expect(describeDiagnosticExpectation({ severity: 'warning', message: { mode: 'matches', value: '^a$' } }))
            .toBe('a warning with a message matching /^a$/');
    });
});

describe('codes the host does not report', () => {
    test('are found before a run, once each', async () => {
        const [campaign] = await loadCampaignSpecs(miniCampaign('expect error code "NOPE" expect error code "OK" expect warning code "NOPE"'));
        expect(findUnknownDiagnosticCodes(campaign, ['OK'])).toEqual(['NOPE']);
        expect(findUnknownDiagnosticCodes(campaign, ['OK', 'NOPE'])).toEqual([]);
    });
});

describe('reporting a near-miss', () => {
    async function reportFor(validation: LanzerCampaignValidationResult) {
        const [campaign] = await loadCampaignSpecs(miniCampaign('expect error code "DUP"'));
        const jobs = buildLanzerGenerationJobs(resolveLanzerCampaign(campaign));
        const run: LanzerAgentRunResult = {
            task: buildLanzerCampaignTask(jobs),
            sessionId: 's',
            attempts: 1,
            stopReason: 'end_turn',
            outputText: '',
            agentThoughtText: '',
            rawUpdates: [],
            toolCalls: [],
            deniedToolCalls: [],
            usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0 },
            durationMs: 0,
            attemptLog: [],
            extraFiles: [],
            staleFiles: []
        };
        // The written file does not matter here; point the job at this test so it exists.
        const existing = jobs.map((job) => ({ ...job, absoluteOutputPath: new URL(import.meta.url).pathname }));
        return buildLanzerRunReport({ campaign: 'demo', jobs: existing, run, validation, ok: validation.ok });
    }

    const expected = error("Duplicate 'x'", 'DUP');

    test('expected diagnostics are the file working, not a semantics failure', async () => {
        const report = await reportFor({
            ok: true,
            documents: [{ uri: 'file:///out/main.mini', issues: [expected], expectsDiagnostics: true }],
            diagnostics: {
                ok: true,
                files: [{ fileAlias: 'main', uri: 'file:///out/main.mini', expected: ['an error with code "DUP"'], missing: [], unexpected: [] }],
                issues: []
            }
        });
        expect(report.ok).toBe(true);
        expect(report.issues.total).toBe(0);
        // The intended diagnostic is still in the report, marked so it does not read as a failure.
        expect(report.documents).toEqual([{ uri: 'file:///out/main.mini', issues: [expected], expectsDiagnostics: true }]);
        expect(renderLanzerRunSummary(report)).toContain('near-miss out/main.mini: rejected as expected');
    });

    test('a mismatch fails at the diagnostics stage, listing expected, missing and unexpected', async () => {
        const stray = { ...error('Unknown type', 'TYPE'), line: 3, character: 5 };
        const report = await reportFor({
            ok: false,
            documents: [{ uri: 'file:///out/main.mini', issues: [stray], expectsDiagnostics: true }],
            diagnostics: {
                ok: false,
                files: [{
                    fileAlias: 'main',
                    uri: 'file:///out/main.mini',
                    expected: ['an error with code "DUP"'],
                    missing: ['an error with code "DUP"'],
                    unexpected: [stray]
                }],
                issues: ['a', 'b']
            }
        });
        expect(report.failedStage).toBe('diagnostics');
        expect(report.issues.byCode).toEqual({ TYPE: 1 });
        const text = renderLanzerRunSummary(report);
        expect(text).toContain('near-miss out/main.mini: not rejected as expected');
        expect(text).toContain('expected: an error with code "DUP"');
        expect(text).toContain('missing: an error with code "DUP"');
        expect(text).toContain('unexpected:3:5: [TYPE] Unknown type');
    });
});

describe('the prompt for a near-miss', () => {
    test('asks for exactly the listed mistake', async () => {
        const [campaign] = await loadCampaignSpecs(miniCampaign('require Fn\nexpect error code "DUP" message contains "twice"'));
        const { prompt } = buildLanzerCampaignTask(buildLanzerGenerationJobs(resolveLanzerCampaign(campaign)));
        expect(prompt).toContain('this file is a deliberate near-miss');
        expect(prompt).toContain('- an error with code "DUP" and a message containing "twice"');
        expect(prompt).toContain('Introduce exactly the mistake that causes these and nothing else');
    });

    test('says nothing about diagnostics for an ordinary campaign', async () => {
        const [campaign] = await loadCampaignSpecs(miniCampaign('require Fn'));
        const { prompt } = buildLanzerCampaignTask(buildLanzerGenerationJobs(resolveLanzerCampaign(campaign)));
        expect(prompt).not.toContain('near-miss');
    });
});
