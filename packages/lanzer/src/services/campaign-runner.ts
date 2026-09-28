import type { LangiumDocument } from 'langium';
import type { LangiumServices, LangiumSharedServices } from 'langium/lsp';
import { diagnosticCode } from '../util/guards.js';
import { validateBehaviour } from '../validations/behaviour-validations.js';
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

        const results = documents.map((document) => this.collectDocumentResult(document));
        const workspace = await lanzer.validateWorkspace(request, documents);
        const campaign = await lanzer.validateCampaignResult(request, documents);
        const valid =
            results.every((result) => result.issues.length === 0) &&
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
            ...(behaviour ? { behaviour } : {})
        };
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
