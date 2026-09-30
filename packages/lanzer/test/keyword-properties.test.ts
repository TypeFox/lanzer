import { AstUtils, GrammarAST } from 'langium';
import { describe, expect, test } from 'vitest';
import { LanzerGrammar } from '../src/generated/grammar.js';
import { loadCampaign, miniCampaign } from './helpers.js';

/** Every word keyword of the Lanzer grammar, read from the generated grammar itself. */
function lanzerKeywords(): string[] {
    const words = AstUtils.streamAst(LanzerGrammar())
        .filter(GrammarAST.isKeyword)
        .map((keyword) => keyword.value)
        .filter((value) => /^[a-z]+$/i.test(value))
        .toArray();
    return Array.from(new Set(words)).sort();
}

describe('campaign keywords as selector property names', () => {
    test('properties named file, output, not and run can be selected', async () => {
        const loaded = await loadCampaign([
            'import "keywords.langium"',
            'campaign keywords {',
            '    workspace "out"',
            '    file main at "main.kw" generates Doc {',
            '        require Thing[file="x"]',
            '        require Thing[output="done"]',
            '        require Thing[not]',
            '        require Thing[run->Thing[file]]',
            '    }',
            '}'
        ].join('\n'));
        expect(loaded.issues).toEqual([]);
    });

    test('every keyword of the Lanzer grammar parses as a property name', async () => {
        const keywords = lanzerKeywords();
        // A sanity floor: the list is read, not empty, and has the ones this ticket was about.
        expect(keywords).toEqual(expect.arrayContaining(['file', 'in', 'min', 'not', 'has', 'run', 'expect', 'output', 'message']));
        for (const keyword of keywords) {
            const loaded = await loadCampaign(miniCampaign(`require Fn[${keyword}]`));
            // Mini's Fn has no such property, so validation may object; the parser must not.
            const syntax = loaded.issues.filter((issue) => issue.kind !== 'diagnostic');
            expect({ keyword, syntax }).toEqual({ keyword, syntax: [] });
        }
    });
});
