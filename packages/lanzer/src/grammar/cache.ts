import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { GrammarAST } from 'langium';
import { generateCustomBnf } from './bnf-generator.js';

export interface EnsureLanzerGrammarReferenceOptions {
    grammar: GrammarAST.Grammar;
    grammarFilePath: string;
    cacheRoot?: string;
}

export async function ensureLanzerGrammarReferenceFile(
    options: EnsureLanzerGrammarReferenceOptions
): Promise<string> {
    const cacheRoot = resolve(options.cacheRoot ?? '.lanzer/grammar-cache');
    const stem = buildGrammarCacheStem(options.grammar, options.grammarFilePath);
    const outputPath = join(cacheRoot, `${stem}.bnf`);
    const content = generateCustomBnf([options.grammar]);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, content, 'utf8');
    return outputPath;
}

function buildGrammarCacheStem(grammar: GrammarAST.Grammar, grammarFilePath: string): string {
    const rawName = grammar.name?.trim() || basename(grammarFilePath, extname(grammarFilePath)) || 'grammar';
    const safeName = rawName
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
    const digest = createHash('sha1').update(resolve(grammarFilePath)).digest('hex').slice(0, 10);
    return `${safeName || 'grammar'}-${digest}`;
}
