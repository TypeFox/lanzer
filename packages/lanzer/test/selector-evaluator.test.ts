import { beforeAll, describe, expect, test } from 'vitest';
import type { AstNode, AstReflection } from 'langium';
import { evaluateSelector } from '../src/validations/selector-evaluator.js';
import { loadCampaignSpecs, miniCampaign, parseMini } from './helpers.js';

const PROGRAM = `
fn main() { call helper; call helper; return; }
fn helper(a, b) { return; }
class Box { fn open() { return; } }
`;

let root: AstNode;
let reflection: AstReflection;

beforeAll(async () => {
    const parsed = await parseMini(PROGRAM);
    expect(parsed.parserErrors).toBe(0);
    root = parsed.root;
    reflection = parsed.reflection;
});

/** How many nodes of the program the selector in `require <selector>` matches. */
async function count(selector: string): Promise<number> {
    const [campaign] = await loadCampaignSpecs(miniCampaign(`require ${selector}`));
    const requirement = campaign.files[0].requirements[0];
    return evaluateSelector(requirement.selector, root, reflection).length;
}

describe('selector evaluation', () => {
    test('a bare type matches at any depth', async () => {
        expect(await count('Fn')).toBe(3);
    });

    test('a leading > matches only direct children of the root', async () => {
        expect(await count('> Fn')).toBe(2);
    });

    test.each([
        ['Fn[name="main"]', 1],
        ['Fn[name!="main"]', 2],
        ['Fn[name^="he"]', 1],
        ['Fn[name$="en"]', 1],
        ['Fn[name*="elp"]', 1]
    ])('value predicate %s', async (selector, expected) => {
        expect(await count(selector)).toBe(expected);
    });

    test('a presence predicate on a list requires it to be non-empty', async () => {
        expect(await count('Fn[params]')).toBe(1);
    });

    test('a cross-reference predicate follows the reference', async () => {
        expect(await count('Call[callee->Fn[name="helper"]]')).toBe(2);
        expect(await count('Call[callee->Fn[name="main"]]')).toBe(0);
    });

    test('a value predicate on a reference compares its text', async () => {
        expect(await count('Call[callee="helper"]')).toBe(2);
    });

    test('combinators narrow by containment', async () => {
        expect(await count('Cls > Fn')).toBe(1);
        expect(await count('Cls >> Ret')).toBe(1);
        expect(await count('Fn > Param')).toBe(2);
    });

    test(':has and :not test the subtree of each candidate', async () => {
        expect(await count('Fn:has(Call)')).toBe(1);
        expect(await count('Fn:not(Call)')).toBe(2);
        expect(await count('Fn:has(> Param)')).toBe(1);
    });
});
