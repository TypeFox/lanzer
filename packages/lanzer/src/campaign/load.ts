import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { URI, type LangiumDocument } from 'langium';
import { NodeFileSystem } from 'langium/node';
import type { DefaultSharedModuleContext } from 'langium/lsp';
import type { CampaignFile } from '../generated/ast.js';
import { createLanzerServices } from '../lanzer-module.js';

export interface LanzerValidationIssue {
    kind: 'lexer-error' | 'parser-error' | 'diagnostic';
    message: string;
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
    model: CampaignFile;
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
        model: document.parseResult.value as CampaignFile,
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
        issues.push({
            kind: 'diagnostic',
            message: diagnostic.message,
            severity: diagnostic.severity,
            line: diagnostic.range.start.line + 1,
            character: diagnostic.range.start.character + 1
        });
    }

    return issues;
}
