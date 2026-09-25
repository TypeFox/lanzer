import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { URI, type LangiumDocument } from 'langium';
import { NodeFileSystem } from 'langium/node';
import type { DefaultSharedModuleContext } from 'langium/lsp';
import { isCampaignFile, type CampaignFile } from '../generated/ast.js';
import { createLanzerServices } from '../lanzer-module.js';
import { diagnosticCode } from '../util/guards.js';

export interface LanzerValidationIssue {
    kind: 'lexer-error' | 'parser-error' | 'diagnostic';
    message: string;
    /** Host-supplied diagnostic code, when the language sets one. See `LanzerDocumentIssue.code`. */
    code?: string;
    severity?: number;
    line?: number;
    character?: number;
}

export interface LoadLanzerDocumentOptions {
    context?: DefaultSharedModuleContext;
    validate?: boolean;
    uri?: string;
}

export interface LanzerDocumentLoadResult {
    document: LangiumDocument;
    /**
     * The parsed campaign, or `undefined` when the source did not parse into one.
     *
     * Langium recovers from most errors and still returns a `CampaignFile`, so this is normally
     * present even for an invalid campaign — `issues` is what says whether it is any good. It is
     * absent only when parsing produced something else entirely, which previously reached callers
     * typed as a campaign and failed on first property access instead of here.
     */
    model: CampaignFile | undefined;
    issues: LanzerValidationIssue[];
}

export async function loadLanzerDocumentFromString(
    source: string,
    options: LoadLanzerDocumentOptions = {}
): Promise<LanzerDocumentLoadResult> {
    const { shared } = createLanzerServices(options.context ?? NodeFileSystem);
    const document = shared.workspace.LangiumDocumentFactory.fromString(
        source,
        URI.parse(options.uri ?? 'memory:/campaign.lanzer')
    );
    shared.workspace.LangiumDocuments.addDocument(document);
    await shared.workspace.DocumentBuilder.build([document], {
        validation: options.validate ?? true
    });

    return {
        document,
        model: isCampaignFile(document.parseResult.value) ? document.parseResult.value : undefined,
        issues: collectIssues(document)
    };
}

export async function loadLanzerDocumentFromFile(
    filePath: string,
    options: Omit<LoadLanzerDocumentOptions, 'uri'> = {}
): Promise<LanzerDocumentLoadResult> {
    const resolvedPath = resolve(filePath);
    const source = await readFile(resolvedPath, 'utf8');
    return loadLanzerDocumentFromString(source, {
        ...options,
        uri: URI.file(resolvedPath).toString()
    });
}

function collectIssues(document: LangiumDocument): LanzerValidationIssue[] {
    const issues: LanzerValidationIssue[] = [];

    for (const error of document.parseResult.lexerErrors) {
        issues.push({
            kind: 'lexer-error',
            message: error.message
        });
    }

    for (const error of document.parseResult.parserErrors) {
        issues.push({
            kind: 'parser-error',
            message: error.message
        });
    }

    for (const diagnostic of document.diagnostics ?? []) {
        const code = diagnosticCode(diagnostic.code);
        issues.push({
            kind: 'diagnostic',
            message: typeof diagnostic.message === 'string' ? diagnostic.message : diagnostic.message.value,
            ...(code ? { code } : {}),
            severity: diagnostic.severity,
            line: diagnostic.range.start.line + 1,
            character: diagnostic.range.start.character + 1
        });
    }

    return issues;
}
