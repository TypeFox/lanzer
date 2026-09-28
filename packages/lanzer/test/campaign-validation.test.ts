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

describe('campaigns importing more than one grammar', () => {
    /** Mini and Other both declare `Fn`: Mini's has `params`, Other's has `label`. */
    const twoGrammars = (requirement: string) => [
        'import "mini.langium"',
        'import "other.langium"',
        'campaign demo {',
        '    workspace "out"',
        `    file main at "main.mini" generates Module { ${requirement} }`,
        '}'
    ].join('\n');

    test('a type both declare means the first import\'s type, as references resolve it', async () => {
        expect((await loadCampaign(twoGrammars('require Fn[params]'))).issues).toEqual([]);
    });

    test('properties of the later import\'s same-named type are not mixed in', async () => {
        expect((await loadCampaign(twoGrammars('require Fn[label]'))).issues.map((issue) => issue.message))
            .toEqual(["Type 'Fn' has no property 'label'."]);
    });

    test('types only the later import declares are still known', async () => {
        expect((await loadCampaign(twoGrammars('require Doc'))).issues).toEqual([]);
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

    test('a value that itself begins and ends with quotes keeps them', async () => {
        const [campaign] = await loadCampaignSpecs([
            'import "mini.langium"',
            'campaign demo {',
            '    description "\\"quoted\\""',
            '    workspace "out"',
            '    file main at "main.mini" generates Module { require Fn[name="\'x\'"] }',
            '}'
        ].join('\n'));
        expect(campaign.description).toBe('"quoted"');
        const [requirement] = campaign.files[0].requirements;
        expect(requirement.selector.parts[0].predicates).toEqual([{ kind: 'value', property: 'name', op: '=', value: "'x'" }]);
    });
});
