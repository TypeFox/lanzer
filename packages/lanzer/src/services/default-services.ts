import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ensureLanzerGrammarReferenceFile } from '../grammar/cache.js';
import { CompositeAstReflection } from '../grammar/composite-reflection.js';
import {
    GrammarAST,
    URI,
    type AstReflection,
    type LangiumDocument
} from 'langium';
import { interpretAstReflection } from 'langium/grammar';
import type { LangiumServices, LangiumSharedServices } from 'langium/lsp';
import type { LanzerGenerationJob } from '../campaign/jobs.js';
import type { LanzerCampaignSpec } from '../campaign/model.js';
import { validateRequirementsAgainstDocuments } from '../validations/requirement-validations.js';
import type {
    LanzerCampaignCheckValidationResult,
    LanzerCampaignRunRequest,
    LanzerDslSkillReference,
    LanzerDocumentSpec,
    LanzerDocumentValidationOptions,
    LanzerGenerationPolicy,
    LanzerService,
    LanzerWorkspaceValidationResult,
    LanzerWorkspaceFolder
} from './types.js';

export class DefaultLanzerService<
    TShared extends LangiumSharedServices = LangiumSharedServices,
    TLanguage extends LangiumServices = LangiumServices
> implements LanzerService<TShared, TLanguage> {
    private readonly grammarPolicyCache = new Map<string, Promise<string | undefined>>();

    constructor(
        readonly shared: TShared,
        readonly language: TLanguage
    ) {}

    async initializeWorkspace(_workspaces: LanzerWorkspaceFolder[]): Promise<void> {}

    async loadDocuments(specs: LanzerDocumentSpec[]): Promise<LangiumDocument[]> {
        const documents: LangiumDocument[] = [];

        for (const spec of specs) {
            const uri = URI.file(resolve(spec.path));
            if (!this.shared.ServiceRegistry.hasServices(uri)) {
                continue;
            }
            if (spec.content !== undefined) {
                const document = this.shared.workspace.LangiumDocumentFactory.fromString(
                    spec.content,
                    uri
                );
                this.shared.workspace.LangiumDocuments.addDocument(document);
                documents.push(document);
                continue;
            }

            // A declared file the agent never wrote, or has since removed. It is not an error to
            // load: the requirement check reports it by alias, and the run report as `no_output`.
            // A copy left in the store from an earlier pass would validate content that is gone.
            if (!(await this.shared.workspace.FileSystemProvider.exists(uri))) {
                if (this.shared.workspace.LangiumDocuments.hasDocument(uri)) {
                    await this.shared.workspace.DocumentBuilder.update([], [uri]);
                }
                continue;
            }

            // During an ACP generation session the agent's intermediate edits populate the
            // document store. If a cached version exists, tell the builder the file changed on
            // disk so it re-reads the final content before validation.
            if (this.shared.workspace.LangiumDocuments.hasDocument(uri)) {
                await this.shared.workspace.DocumentBuilder.update([uri], []);
            }
            const document = await this.shared.workspace.LangiumDocuments.getOrCreateDocument(uri);
            documents.push(document);
        }

        return documents;
    }

    async buildDocuments(
        documents: LangiumDocument[],
        options: LanzerDocumentValidationOptions = {}
    ): Promise<void> {
        await this.shared.workspace.DocumentBuilder.build(documents, {
            validation: options.validation ?? true
        });
    }

    async validateWorkspace(
        _request: LanzerCampaignRunRequest,
        _documents: LangiumDocument[]
    ): Promise<LanzerWorkspaceValidationResult> {
        return {
            ok: true,
            issues: []
        };
    }

    async validateCampaignResult(
        request: LanzerCampaignRunRequest,
        documents: LangiumDocument[]
    ): Promise<LanzerCampaignCheckValidationResult> {
        if (!request.campaign) {
            return { ok: true, issues: [] };
        }
        const reflection = await this.buildHostReflection(request.campaign);
        if (!reflection) {
            return {
                ok: false,
                issues: ['Cannot validate requirements: imported host grammar(s) could not be loaded.']
            };
        }
        return validateRequirementsAgainstDocuments(request.campaign, documents, reflection);
    }

    async getGenerationPolicy(job: LanzerGenerationJob): Promise<LanzerGenerationPolicy | undefined> {
        if (job.grammarImports.length === 0) return undefined;

        let pending = this.grammarPolicyCache.get(job.campaignName);
        if (!pending) {
            pending = this.resolveGrammarReferencePath(job);
            this.grammarPolicyCache.set(job.campaignName, pending);
        }

        const grammarReferencePath = await pending;
        // The default service is host-agnostic: it only supplies the grammar reference. Any
        // language-specific guidance (required/forbidden practices, dialect notes, etc.) belongs in
        // a host's own LanzerService override — see LoxLanzerService.getGenerationPolicy.
        return grammarReferencePath ? { grammarReferencePath } : undefined;
    }

    private async resolveGrammarReferencePath(job: LanzerGenerationJob): Promise<string | undefined> {
        const grammars = await this.loadImportedGrammars({
            name: job.campaignName,
            imports: job.grammarImports,
            baseDir: job.grammarBaseDir,
            files: [],
            supportFiles: [],
            requirements: []
        });

        if (grammars.length === 0) return undefined;

        const grammarFilePath = resolve(job.grammarBaseDir ?? process.cwd(), job.grammarImports[0]);
        return ensureLanzerGrammarReferenceFile({
            grammar: grammars[0],
            grammarFilePath
        });
    }

    async dslSkill(_job: LanzerGenerationJob): Promise<LanzerDslSkillReference | undefined> {
        return undefined;
    }

    protected async buildHostReflection(campaign: LanzerCampaignSpec): Promise<AstReflection | undefined> {
        const grammars = await this.loadImportedGrammars(campaign);
        if (grammars.length === 0) {
            return undefined;
        }
        if (grammars.length === 1) {
            return interpretAstReflection(grammars[0]);
        }
        return new CompositeAstReflection(grammars.map((grammar) => interpretAstReflection(grammar)));
    }

    protected async loadImportedGrammars(campaign: LanzerCampaignSpec): Promise<GrammarAST.Grammar[]> {
        const baseDir = campaign.baseDir ?? process.cwd();
        const documents: LangiumDocument[] = [];
        for (const importPath of campaign.imports) {
            const absolute = resolve(baseDir, importPath);
            const uri = URI.file(absolute);
            let document = this.shared.workspace.LangiumDocuments.getDocument(uri);
            if (!document) {
                try {
                    const text = readFileSync(absolute, 'utf8');
                    document = this.shared.workspace.LangiumDocuments.createDocument(uri, text);
                } catch {
                    continue;
                }
            }
            documents.push(document);
        }
        if (documents.length > 0) {
            await this.shared.workspace.DocumentBuilder.build(documents, { validation: false });
        }
        const grammars: GrammarAST.Grammar[] = [];
        for (const document of documents) {
            const value = document.parseResult.value;
            if (GrammarAST.isGrammar(value)) {
                grammars.push(value);
            }
        }
        return grammars;
    }
}

export type LanzerDefaultServiceDependencies<
    TShared extends LangiumSharedServices = LangiumSharedServices,
    TLanguage extends LangiumServices = LangiumServices
> = {
    shared: TShared;
    language: TLanguage;
};
