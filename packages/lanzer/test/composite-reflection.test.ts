import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { createLangiumGrammarServices, interpretAstReflection } from 'langium/grammar';
import { EmptyFileSystem, type GrammarAST } from 'langium';
import { parseHelper } from 'langium/test';
import { CompositeAstReflection } from '../src/grammar/composite-reflection.js';
import { fixture } from './helpers.js';

async function grammar(name: string): Promise<GrammarAST.Grammar> {
    const services = createLangiumGrammarServices(EmptyFileSystem).grammar;
    const document = await parseHelper<GrammarAST.Grammar>(services)(readFileSync(fixture(name), 'utf8'));
    return document.parseResult.value;
}

describe('composite reflection over two grammars', () => {
    test('a type both declare is answered by the first, without mixing in the second', async () => {
        const reflection = new CompositeAstReflection([
            interpretAstReflection(await grammar('mini.langium')),
            interpretAstReflection(await grammar('other.langium'))
        ]);
        const properties = Object.keys(reflection.getTypeMetaData('Fn').properties);
        expect(properties).toEqual(expect.arrayContaining(['name', 'params', 'body']));
        expect(properties).not.toContain('label');
        expect(reflection.getAllTypes()).toEqual(expect.arrayContaining(['Fn', 'Module', 'Doc']));
        expect(reflection.isSubtype('Call', 'Stmt')).toBe(true);
    });
});
