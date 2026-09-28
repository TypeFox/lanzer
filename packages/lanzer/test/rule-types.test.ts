import { beforeAll, describe, expect, test } from 'vitest';
import type { AstNode, AstReflection } from 'langium';
import { evaluateSelector } from '../src/validations/selector-evaluator.js';
import { loadCampaign, loadCampaignSpecs, parseMini } from './helpers.js';

/** A Shapes campaign around the given requirement lines. */
function shapes(requirements: string): string {
    return [
        'import "shapes.langium"',
        'campaign demo {',
        '    workspace "out"',
        `    file main at "main.shapes" generates Doc { ${requirements} }`,
        '}'
    ].join('\n');
}

async function issuesFor(requirements: string): Promise<string[]> {
    return (await loadCampaign(shapes(requirements))).issues.map((issue) => issue.message);
}

describe('what a rule name means in a selector', () => {
    test('R returns Union: {infer R} means R, not the union', async () => {
        expect(await issuesFor('require Var[name="x"]')).toEqual([]);
        const [campaign] = await loadCampaignSpecs(shapes('require Var'));
        expect(campaign.files[0].requirements[0].selector.parts[0].astType).toBe('Var');
    });

    test('a rule whose body creates a type of its own name means that type', async () => {
        const [campaign] = await loadCampaignSpecs(shapes('require Add'));
        expect(campaign.files[0].requirements[0].selector.parts[0].astType).toBe('Add');
    });

    test('a union alias and a union rule are types to select by', async () => {
        expect(await issuesFor('require Named')).toEqual([]);
        expect((await loadCampaign([
            'import "mini.langium"',
            'campaign demo {',
            '    workspace "out"',
            '    file main at "main.mini" generates Module { require Stmt }',
            '}'
        ].join('\n'))).issues).toEqual([]);
    });
});

describe('reachability through actions and narrowed rules', () => {
    test('a slot assigned from R returns Union: {infer R} holds R only', async () => {
        expect(await issuesFor('require Fun > Var')).toEqual([]);
        expect(await issuesFor('require Var > Fun')).toEqual([
            "'Fun' is not reachable as a direct child of 'Var' in the imported grammar."
        ]);
    });

    test('an action wrapping current contains the operand, not the other way round', async () => {
        expect(await issuesFor('require Add > Num')).toEqual([]);
        expect(await issuesFor('require Num > Add')).toEqual([
            "'Add' is not reachable as a direct child of 'Num' in the imported grammar."
        ]);
    });

    test('expressions do not reach declarations', async () => {
        expect(await issuesFor('require Var >> Num')).toEqual([]);
        expect(await issuesFor('require Add >> Var')).toEqual([
            "'Var' is not reachable as a descendant of 'Add' in the imported grammar."
        ]);
    });
});

describe('evaluation over a Shapes program', () => {
    let root: AstNode;
    let reflection: AstReflection;

    beforeAll(async () => {
        const parsed = await parseMini('var x = 1 + 2 fun f { var y = x }', 'shapes');
        expect(parsed.parserErrors).toBe(0);
        root = parsed.root;
        reflection = parsed.reflection;
    });

    async function count(selector: string): Promise<number> {
        const [campaign] = await loadCampaignSpecs(shapes(`require ${selector}`));
        return evaluateSelector(campaign.files[0].requirements[0].selector, root, reflection).length;
    }

    test.each([
        ['Var', 2],
        ['Named', 3],
        ['Fun > Var', 1],
        ['Add > Num', 2],
        ['Ref[target->Var[name="x"]]', 1]
    ])('%s', async (selector, expected) => {
        expect(await count(selector)).toBe(expected);
    });
});
