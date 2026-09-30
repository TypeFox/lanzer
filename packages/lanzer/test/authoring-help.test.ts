import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { describeSelectableTypes, loadGrammarsFor, renderSelectableTypes } from '../src/grammar/type-catalog.js';
import { editDistance, nearestName } from '../src/util/suggest.js';
import { fixture, loadCampaign, miniCampaign } from './helpers.js';

async function messagesFor(source: string): Promise<string[]> {
    return (await loadCampaign(source)).issues.map((issue) => issue.message);
}

function shapesCampaign(requirement: string): string {
    return ['import "shapes.langium"', 'campaign shapes {', '    workspace "out"', '    file main at "main.shapes" generates Doc {', `        ${requirement}`, '    }', '}'].join('\n');
}

describe('suggesting a name', () => {
    test('counts a swapped pair of letters as one slip', () => {
        expect(editDistance('nmae', 'name')).toBe(1);
        expect(editDistance('kitten', 'sitting')).toBe(3);
    });

    test('offers the nearest close name, ignoring case', () => {
        expect(nearestName('FuncDeclaration', ['FunctionDeclaration', 'Parameter'])).toBe('FunctionDeclaration');
        expect(nearestName('fn', ['Fn', 'Cls'])).toBe('Fn');
        expect(nearestName('nmae', ['name', 'body'])).toBe('name');
    });

    test('offers nothing for a different word', () => {
        expect(nearestName('code', ['body', 'name'])).toBeUndefined();
        expect(nearestName('nope', ['name'])).toBeUndefined();
        expect(nearestName('Fn', ['Fn'])).toBeUndefined();
    });
});

describe('did-you-mean in campaign validation', () => {
    test('an unknown type names the nearest one', async () => {
        expect(await messagesFor(miniCampaign('require Fnn'))).toEqual([
            "Could not resolve reference to AbstractRule named 'Fnn'. Did you mean 'Fn'?"
        ]);
        expect(await messagesFor(shapesCampaign('require Ad'))).toEqual([
            "Could not resolve reference to AbstractRule named 'Ad'. Did you mean 'Add'?"
        ]);
    });

    test('an unknown type far from every name gets no guess', async () => {
        expect(await messagesFor(miniCampaign('require Nope'))).toEqual([
            "Could not resolve reference to AbstractRule named 'Nope'."
        ]);
    });

    test('an unknown property names the nearest one, including those of subtypes', async () => {
        expect(await messagesFor(miniCampaign('require Fn[nmae="main"]'))).toEqual([
            "Type 'Fn' has no property 'nmae'. Did you mean 'name'?"
        ]);
        expect(await messagesFor(shapesCampaign('require Named[vaule]'))).toEqual([
            "Type 'Named' has no property 'vaule'. Did you mean 'value'?"
        ]);
    });

    test('a > that could be >> says so, and names what lies between', async () => {
        expect(await messagesFor(miniCampaign('require Module > Ret'))).toEqual([
            "'Ret' is not reachable as a direct child of 'Module' in the imported grammar. It is a descendant, though, via 'Fn': use '>>'."
        ]);
        expect(await messagesFor(shapesCampaign('require Doc > Num'))).toEqual([
            "'Num' is not reachable as a direct child of 'Doc' in the imported grammar. It is a descendant, though, via 'Var': use '>>'."
        ]);
    });

    test('a > that could not be >> either gets no hint', async () => {
        expect(await messagesFor(miniCampaign('require Param > Fn'))).toEqual([
            "'Fn' is not reachable as a direct child of 'Param' in the imported grammar."
        ]);
    });
});

describe('listing the selectable types', () => {
    test('describes names, kinds, properties, cross-references, subtypes and direct children', async () => {
        const types = describeSelectableTypes(await loadGrammarsFor(fixture('mini.langium')));
        const byName = new Map(types.map((type) => [type.name, type]));
        expect(byName.get('Module')).toMatchObject({ kind: 'entry rule', properties: [{ name: 'classes' }, { name: 'functions' }], children: ['Cls', 'Fn'] });
        expect(byName.get('Call')?.properties).toEqual([{ name: 'callee', crossReference: 'Fn' }]);
        expect(byName.get('Stmt')?.subtypes).toEqual(['Call', 'Ret']);
        expect(byName.get('ID')?.kind).toBe('terminal');
    });

    test('says when a name matches nodes of another type', async () => {
        const types = describeSelectableTypes(await loadGrammarsFor(fixture('shapes.langium')));
        const add = types.find((type) => type.name === 'Add');
        const primary = types.find((type) => type.name === 'Primary');
        expect(primary).toMatchObject({ kind: 'parser rule', astType: 'Expr' });
        expect(add?.kind).toBe('parser rule');
        expect(renderSelectableTypes(types)).toContain("Primary  (parser rule, matches 'Expr' nodes)");
    });

    test('reads the grammars a campaign imports', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'lanzer-types-'));
        const campaign = join(dir, 'campaign.lanzer');
        await writeFile(campaign, `import ${JSON.stringify(fixture('mini.langium'))}\ncampaign c { workspace "ws" file m at "m.mini" generates Module {} }`, 'utf8');
        const names = describeSelectableTypes(await loadGrammarsFor(campaign)).map((type) => type.name);
        expect(names).toEqual(expect.arrayContaining(['Module', 'Fn', 'Call', 'Stmt']));
    });
});
