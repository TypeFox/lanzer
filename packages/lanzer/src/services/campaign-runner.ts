import type { LangiumDocument } from 'langium';
import type { LangiumServices, LangiumSharedServices } from 'langium/lsp';
import { diagnosticCode } from '../util/guards.js';
import { validateBehaviour } from '../validations/behaviour-validations.js';
import { findNegativeFileDocuments, validateDiagnostics } from '../validations/diagnostic-validations.js';
import type {
    LanzerCampaignRunRequest,
    LanzerCampaignRunner,
    LanzerCampaignValidationResult,
    LanzerDocumentIssue,
    LanzerDocumentResult,
    LanzerServices
} from './types.js';

/**
 * Default campaign runner that reuses the host language's real Langium workspace services.
 *
 * Lanzer intentionally does not recreate or approximate the host service graph. The host owns
 * service construction and workspace semantics; Lanzer only orchestrates document loading and
 * validation through that surface.
 */
export class DefaultLanzerCampaignRunner<
    TShared extends LangiumSharedServices = LangiumSharedServices,
    TLanguage extends LangiumServices = LangiumServices
> implements LanzerCampaignRunner<TShared, TLanguage> {
    constructor(private readonly services: LanzerServices<TShared, TLanguage>) {}

    async validateCampaign(request: LanzerCampaignRunRequest): Promise<LanzerCampaignValidationResult> {
        const lanzer = this.services.lanzer.Lanzer;
        await lanzer.initializeWorkspace(request.workspaces);
        const documents = await lanzer.loadDocuments(request.documents);
        await lanzer.buildDocuments(documents, {
            validation: request.validate ?? true
        });

        const collected = documents.map((document) => this.collectDocumentResult(document));
        // A negative file keeps every issue it produced: those are what its expectations are
        // matched against, warnings included. Any other file must come out clean, by the host's
        // measure of clean.
        const negativeFiles = request.campaign ? findNegativeFileDocuments(request.campaign, documents) : new Map();
        const results = collected.map((result, index): LanzerDocumentResult => negativeFiles.has(index)
            ? { ...result, expectsDiagnostics: true }
            : { ...result, issues: result.issues.filter((issue) => this.failsCleanFile(issue)) });
        const diagnostics = request.campaign ? validateDiagnostics(request.campaign, documents, results) : undefined;
        const workspace = await lanzer.validateWorkspace(request, documents);
        const campaign = await lanzer.validateCampaignResult(request, documents);
        const valid =
            results.every((result) => result.expectsDiagnostics || result.issues.length === 0) &&
            (diagnostics?.ok ?? true) &&
            (workspace?.ok ?? true) &&
            (campaign?.ok ?? true);

        // Only a program that is already valid is run: one that does not parse or type-check has
        // nothing to say about behaviour, and running it would only restate those findings.
        const behaviour = valid && request.campaign
            ? await validateBehaviour(request.campaign, documents, lanzer.execute?.bind(lanzer))
            : undefined;

        return {
            ok: valid && (behaviour?.ok ?? true),
            documents: results,
            workspace,
            campaign,
            ...(diagnostics ? { diagnostics } : {}),
            ...(behaviour ? { behaviour } : {})
        };
    }

    /**
     * Whether an issue on an ordinary file makes it unacceptable. Every issue does by default; a
     * host that tolerates warnings in generated code narrows this rather than dropping them in
     * {@link collectDocumentResult}, which would hide them from negative files expecting one.
     */
    protected failsCleanFile(_issue: LanzerDocumentIssue): boolean {
        return true;
    }

    protected collectDocumentResult(document: LangiumDocument): LanzerDocumentResult {
        const issues: LanzerDocumentIssue[] = [];

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

        return {
            uri: document.uri.toString(),
            issues
        };
    }
}
