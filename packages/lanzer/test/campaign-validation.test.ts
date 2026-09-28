import { describe, expect, test } from 'vitest';
import { loadCampaign, loadCampaignSpecs, miniCampaign } from './helpers.js';

/** The messages of every issue a campaign with these requirement lines produces. */
async function issuesFor(requirements: string): Promise<string[]> {
    const loaded = await loadCampaign(miniCampaign(requirements));
    return loaded.issues.map((issue) => issue.message);
}

describe('campaign authoring validation', () => {
    test('a well-formed campaign has no issues', async () => {
        expect(await issuesFor([
            'require Fn[name="main"]',
            'min 2 Fn',
            'forbid Cls >> Call[callee->Fn[name="main"]]',
            'require Fn:has(> Param)'
        ].join('\n'))).toEqual([]);
    });

    test('an unknown type does not resolve', async () => {
        expect(await issuesFor('require Nope')).toEqual([
            expect.stringContaining("Could not resolve reference to AbstractRule named 'Nope'")
        ]);
    });

    test('an unknown property is reported', async () => {
        expect(await issuesFor('require Fn[nope="x"]')).toEqual(["Type 'Fn' has no property 'nope'."]);
    });

    test('-> is only allowed on cross-references', async () => {
        expect(await issuesFor('require Fn[name->Fn]')).toEqual([
            "Property 'name' on 'Fn' is not a cross-reference; '->' is not allowed."
        ]);
    });

    test('a cross-reference target must fit the reference type', async () => {
        expect(await issuesFor('require Call[callee->Cls]')).toEqual([
            "Cross-reference 'callee' targets 'Fn', not 'Cls'."
        ]);
    });

    test('an impossible containment chain is reported', async () => {
        expect(await issuesFor('require Param > Fn')).toEqual([
            "'Fn' is not reachable as a direct child of 'Param' in the imported grammar."
        ]);
    });

    test('count requirements must be positive', async () => {
        expect(await issuesFor('min 0 Fn')).toEqual(['Count requirements must be strictly positive.']);
    });

    test('duplicate file aliases and paths are reported', async () => {
        const loaded = await loadCampaign([
            'import "mini.langium"',
            'campaign demo {',
            '    workspace "out"',
            '    file a at "a.mini" generates Module {}',
            '    file a at "a.mini" generates Module {}',
            '}'
        ].join('\n'));
        expect(loaded.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
            "Duplicate file alias 'a' in campaign 'demo'.",
            "Duplicate file path a.mini in campaign 'demo'."
        ]));
    });
});

describe('campaign mapping', () => {
    test('maps files, paths and selectors to specs', async () => {
        const [campaign] = await loadCampaignSpecs(miniCampaign('require Fn[name="main"] > Param'));
        expect(campaign.name).toBe('demo');
        expect(campaign.imports).toEqual(['mini.langium']);
        expect(campaign.workspaceRoot).toBe('out');
        expect(campaign.files).toHaveLength(1);
        const [file] = campaign.files;
        expect(file).toMatchObject({ alias: 'main', path: 'main.mini', rootRule: 'Module' });
        expect(file.requirements).toEqual([{
            kind: 'symbol',
            fileAlias: undefined,
            selector: {
                leadingCombinator: undefined,
                combinators: ['>'],
                parts: [
                    {
                        rule: 'Fn',
                        astType: 'Fn',
                        predicates: [{ kind: 'value', property: 'name', op: '=', value: 'main' }],
                        pseudos: []
                    },
                    { rule: 'Param', astType: 'Param', predicates: [], pseudos: [] }
                ]
            }
        }]);
    });
});
