import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { URI, type AstNode, type AstReflection, type GrammarAST } from 'langium';
import { createServicesForGrammar } from 'langium/grammar';
import { parseHelper } from 'langium/test';
import { loadLanzerDocumentFromString, type LanzerDocumentLoadResult } from '../src/campaign/load.js';
import { mapLanzerCampaignFile } from '../src/campaign/map.js';
import type { LanzerCampaignSpec } from '../src/campaign/model.js';

/** Absolute path of a file under `test/fixtures`. */
export function fixture(name: string): string {
    return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

/**
 * A working Mini language, built from `fixtures/mini.langium` at runtime.
 *
 * Interpreting the grammar rather than generating a parser keeps the tests free of build output:
 * the grammar the campaign imports is the very grammar the parsed programs come from.
 */
export async function parseMini(text: string): Promise<{
    root: AstNode;
    reflection: AstReflection;
    grammar: GrammarAST.Grammar;
    parserErrors: number;
}> {
    const services = await createServicesForGrammar({ grammar: readFileSync(fixture('mini.langium'), 'utf8') });
    const document = await parseHelper(services)(text);
    return {
        root: document.parseResult.value,
        reflection: services.shared.AstReflection,
        grammar: services.Grammar,
        parserErrors: document.parseResult.parserErrors.length
    };
}

/**
 * Load campaign source as though it were a file in `test/fixtures`, so `import "mini.langium"`
 * resolves against the fixture grammar.
 */
export async function loadCampaign(source: string): Promise<LanzerDocumentLoadResult> {
    return loadLanzerDocumentFromString(source, { uri: URI.file(fixture('inline.lanzer')).toString() });
}

/** A one-file Mini campaign around the given requirement lines. */
export function miniCampaign(requirements: string): string {
    return [
        'import "mini.langium"',
        'campaign demo {',
        '    workspace "out"',
        '    file main at "main.mini" generates Module {',
        requirements,
        '    }',
        '}'
    ].join('\n');
}

/** Load a campaign and map it to specs, failing loudly if it did not load cleanly. */
export async function loadCampaignSpecs(source: string): Promise<LanzerCampaignSpec[]> {
    const loaded = await loadCampaign(source);
    if (!loaded.model || loaded.issues.length > 0) {
        throw new Error(`Campaign did not load cleanly: ${loaded.issues.map((issue) => issue.message).join('; ')}`);
    }
    return mapLanzerCampaignFile(loaded.model, { sourceUri: loaded.document.uri.toString() });
}
