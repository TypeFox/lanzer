import { describe, expect, test } from 'vitest';
import { buildLanzerGenerationJobs } from '../src/campaign/jobs.js';
import { resolveLanzerCampaign } from '../src/campaign/map.js';
import { buildLanzerCampaignTask } from '../src/campaign/prompt.js';
import type { LanzerExecutionResult } from '../src/services/types.js';
import { validateBehaviour } from '../src/validations/behaviour-validations.js';
import { loadCampaign, loadCampaignSpecs, parseMiniDocument } from './helpers.js';

function campaignWithRun(runBlock: string): string {
    return [
        'import "mini.langium"',
        'campaign demo {',
        '    workspace "out"',
        '    file main at "main.mini" generates Module {}',
        `    ${runBlock}`,
        '}'
    ].join('\n');
}

async function messages(runBlock: string): Promise<string[]> {
    return (await loadCampaign(campaignWithRun(runBlock))).issues.map((issue) => issue.message);
}

describe('run blocks in a campaign', () => {
    test('map to specs with every expectation kind', async () => {
        const [campaign] = await loadCampaignSpecs(campaignWithRun(
            'run main { expect runs expect output "ok" expect output contains "o" expect not output matches "^x" }'
        ));
        expect(campaign.runs).toEqual([{
            fileAlias: 'main',
            expectations: [
                { kind: 'runs' },
                { kind: 'output', mode: 'exact', value: 'ok', negated: false },
                { kind: 'output', mode: 'contains', value: 'o', negated: false },
                { kind: 'output', mode: 'matches', value: '^x', negated: true }
            ]
        }]);
    });

    test('must name a declared file', async () => {
        expect(await messages('run nope { expect runs }')).toEqual([
            expect.stringContaining("Could not resolve reference to FileSpec named 'nope'")
        ]);
    });

    test('reject a pattern that is not a regular expression', async () => {
        expect(await messages('run main { expect output matches "(" }')).toEqual([
            expect.stringMatching(/^Invalid regular expression: /)
        ]);
    });

    test('warn about checks against the empty string', async () => {
        const loaded = await loadCampaign(campaignWithRun('run main { expect output contains "" }'));
        expect(loaded.issues).toEqual([expect.objectContaining({ severity: 2, message: 'Every output contains the empty string, so this check always passes.' })]);
    });

    test('are stated to the agent in the campaign prompt', async () => {
        const [campaign] = await loadCampaignSpecs(campaignWithRun('run main { expect output "1\\n2" expect not output contains "x" }'));
        const prompt = buildLanzerCampaignTask(buildLanzerGenerationJobs(resolveLanzerCampaign(campaign))).prompt;
        expect(prompt).toContain('Behaviour checks — once the files are valid, Lanzer runs each program below and checks what it prints:');
        expect(prompt).toMatch(/- run main \(.*main\.mini\):\n {2}- MUST run to completion, without a runtime error or timeout\.\n {2}- output MUST be exactly "1\\n2"/);
        expect(prompt).toContain('  - output MUST NOT contain "x".');
    });
});

describe('checking behaviour', () => {
    const ran = (output: string): LanzerExecutionResult => ({ completed: true, output, timedOut: false, durationMs: 1 });

    async function check(runBlock: string, execute?: (entry: unknown) => Promise<LanzerExecutionResult>, generated = true) {
        const [campaign] = await loadCampaignSpecs(campaignWithRun(runBlock));
        const documents = generated ? [(await parseMiniDocument('fn main() { return; }', 'main.mini', campaign)).document] : [];
        return validateBehaviour(campaign, documents, execute);
    }

    test('a campaign without run blocks has no behaviour verdict', async () => {
        const [campaign] = await loadCampaignSpecs(campaignWithRun(''));
        expect(await validateBehaviour(campaign, [], async () => ran(''))).toBeUndefined();
    });

    test('a host that cannot run programs fails the run instead of skipping it', async () => {
        expect((await check('run main { expect runs }'))?.issues).toEqual([
            "Cannot check run 'main': the host language does not run programs."
        ]);
    });

    test('an entry file that was never generated is reported', async () => {
        expect((await check('run main { expect runs }', async () => ran(''), false))?.issues).toEqual([
            "Cannot run 'main': its file was not generated."
        ]);
    });

    test('the host throwing is reported, not thrown', async () => {
        const result = await check('run main { expect runs }', async () => {
            throw new Error('interpreter crashed');
        });
        expect(result?.issues).toEqual(["Running 'main' failed in the host language: interpreter crashed"]);
    });

    test('the entry passed to the host is the run block\'s file', async () => {
        let seen: unknown;
        await check('run main { expect runs }', async (entry) => {
            seen = entry;
            return ran('');
        });
        expect(seen).toMatchObject({ uri: expect.objectContaining({ path: expect.stringMatching(/\/out\/main\.mini$/) }) });
    });

    // Every expectation kind, plain and negated, both holding and failing, against one output.
    const OUTPUT = '1\n2\n3\n';
    const SHOWN = JSON.stringify(OUTPUT);
    test.each([
        ['expect runs', undefined],
        ['expect output "1\\n2\\n3"', undefined],
        ['expect output "3\\n2\\n1"', `output must be exactly "3\\n2\\n1"`],
        ['expect not output "3\\n2\\n1"', undefined],
        ['expect not output "1\\n2\\n3\\n"', `output must not be exactly "1\\n2\\n3\\n"`],
        ['expect output contains "2"', undefined],
        ['expect output contains "9"', 'output must contain "9"'],
        ['expect not output contains "9"', undefined],
        ['expect not output contains "2"', 'output must not contain "2"'],
        ['expect output matches "^1\\n2"', undefined],
        ['expect output matches "^2"', 'output must match /^2/'],
        ['expect not output matches "^2"', undefined],
        ['expect not output matches "^1"', 'output must not match /^1/']
    ])('%s', async (clause, failure) => {
        const result = await check(`run main { ${clause} }`, async () => ran(OUTPUT));
        expect(result?.issues).toEqual(failure ? [`Run of 'main': ${failure}, but was ${SHOWN}`] : []);
        expect(result?.ok).toBe(failure === undefined);
    });

    test('a run that does not complete fails once, and its output checks are not evaluated', async () => {
        const result = await check('run main { expect runs expect output "never" expect output contains "x" }', async () => ({
            completed: false, output: 'partial\n', error: 'boom', timedOut: false, durationMs: 1
        }));
        expect(result?.issues).toEqual([`Run of 'main' stopped on a runtime error: boom. Output so far: "partial\\n"`]);
    });

    test('a timed-out run is reported as a timeout, not an error', async () => {
        const result = await check('run main { expect runs }', async () => ({ completed: false, output: '', timedOut: true, durationMs: 5000 }));
        expect(result?.issues).toEqual([`Run of 'main' timed out. Output so far: ""`]);
    });

    test('long output is quoted only in part', async () => {
        const result = await check('run main { expect output "short" }', async () => ran('x'.repeat(1000)));
        expect(result?.issues[0]).toMatch(/but was "x{400}…"$/);
    });
});
