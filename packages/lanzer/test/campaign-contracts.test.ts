import { describe, expect, test } from 'vitest';
import { buildLanzerGenerationJobs } from '../src/campaign/jobs.js';
import { resolveLanzerCampaign } from '../src/campaign/map.js';
import { buildLanzerCampaignTask } from '../src/campaign/prompt.js';
import { validateRequirementsAgainstDocuments } from '../src/validations/requirement-validations.js';
import { loadCampaign, loadCampaignSpecs, parseMiniDocument } from './helpers.js';

function campaign(body: string[]): string {
    return ['import "mini.langium"', 'campaign demo {', '    workspace "out"', ...body, '}'].join('\n');
}

async function messages(source: string): Promise<string[]> {
    return (await loadCampaign(source)).issues.map((issue) => issue.message);
}

describe('generates', () => {
    test('must name a rule the grammar declares', async () => {
        expect(await messages(campaign(['file main at "main.mini" generates Nope {}']))).toEqual([
            expect.stringContaining("Could not resolve reference to AbstractRule named 'Nope'")
        ]);
    });

    test('must be a type the entry rule can produce', async () => {
        expect(await messages(campaign(['file main at "main.mini" generates Module {}']))).toEqual([]);
        expect(await messages(campaign(['file main at "main.mini" generates Fn {}']))).toEqual([
            "'Fn' cannot be the root of a generated file: the host language parses every file from its entry rule 'Module'."
        ]);
    });

    test('a generated root of another type is reported at validation time', async () => {
        const [spec] = await loadCampaignSpecs(campaign(['file main at "main.mini" generates Module {}']));
        const { document, reflection } = await parseMiniDocument('fn main() { return; }', spec.files[0].path, spec);
        const mismatched = { ...spec, files: [{ ...spec.files[0], rootRule: 'Cls', rootAstType: 'Cls' }] };
        expect(validateRequirementsAgainstDocuments(mismatched, [document], reflection).issues).toEqual([
            expect.stringMatching(/^Generated file for 'main' parsed as 'Module', but the campaign declares it generates 'Cls'/)
        ]);
        expect(validateRequirementsAgainstDocuments(spec, [document], reflection).ok).toBe(true);
    });
});

describe('in, inside a file block', () => {
    const twoFiles = (requirement: string) => campaign([
        `    file a at "a.mini" generates Module { ${requirement} }`,
        '    file b at "b.mini" generates Module {}'
    ]);

    test('naming its own file is allowed', async () => {
        expect(await messages(twoFiles('require Fn in a'))).toEqual([]);
    });

    test('naming another file is rejected, since it would still check this one', async () => {
        expect(await messages(twoFiles('require Fn in b'))).toEqual([
            "A requirement inside file 'a' always applies to 'a'; declare it at campaign level to target 'b'."
        ]);
    });
});

describe('campaign requirements in the prompt', () => {
    test('scoped ones are listed under their file, unscoped ones once for the whole set', async () => {
        const [spec] = await loadCampaignSpecs(campaign([
            '    file a at "a.mini" generates Module {}',
            '    file b at "b.mini" generates Module {}',
            '    min 3 Fn',
            '    forbid Cls in b'
        ]));
        const prompt = buildLanzerCampaignTask(buildLanzerGenerationJobs(resolveLanzerCampaign(spec))).prompt;

        const wide = prompt.indexOf('Campaign-wide requirements, checked across all generated files together');
        expect(wide).toBeGreaterThan(-1);
        expect(prompt.slice(wide)).toContain('- MUST contain at least 3 node(s) matching Fn.');
        // Listed once, not repeated under each file as though each had to meet it alone.
        expect(prompt.match(/at least 3 node\(s\) matching Fn/g)).toHaveLength(1);
        expect(prompt).toMatch(/- b -> .*\n {2}campaign requirements applying to this file:\n {2}- MUST NOT contain Cls\./);
    });
});
