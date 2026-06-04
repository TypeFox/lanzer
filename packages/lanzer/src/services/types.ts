import type {
    LangiumDocument,
    Module
} from 'langium';
import type { LanzerGenerationJob } from '../campaign/jobs.js';
import type { LanzerCampaignSpec } from '../campaign/model.js';
import type {
    LangiumServices,
    LangiumSharedServices,
    PartialLangiumServices
} from 'langium/lsp';

export interface LanzerWorkspaceFolder {
    name: string;
    uri: string;
}

export interface LanzerDocumentSpec {
    path: string;
    content?: string;
    description?: string;
}

export interface LanzerDocumentValidationOptions {
    validation?: boolean;
}

export interface LanzerDocumentIssue {
    kind: 'lexer-error' | 'parser-error' | 'diagnostic';
    message: string;
    severity?: number;
    line?: number;
    character?: number;
}

export interface LanzerDocumentResult {
    uri: string;
    issues: LanzerDocumentIssue[];
}

export interface LanzerWorkspaceValidationResult {
    ok: boolean;
    issues: string[];
}

export interface LanzerCampaignCheckValidationResult {
    ok: boolean;
    issues: string[];
}

export interface LanzerCampaignValidationResult {
    ok: boolean;
    documents: LanzerDocumentResult[];
    workspace?: LanzerWorkspaceValidationResult;
    campaign?: LanzerCampaignCheckValidationResult;
}

export interface LanzerGenerationPolicyReferenceFile {
    label: string;
    path: string;
    description?: string;
}

export interface LanzerGenerationPolicy {
    summary?: string;
    grammarReferencePath?: string;
    instructions?: string[];
    requiredPractices?: string[];
    discouragedPractices?: string[];
    forbiddenPractices?: string[];
    referenceFiles?: LanzerGenerationPolicyReferenceFile[];
}

export interface LanzerDslSkillReference {
    name?: string;
    path?: string;
}

export interface LanzerService<
    TShared extends LangiumSharedServices = LangiumSharedServices,
    TLanguage extends LangiumServices = LangiumServices
> {
    readonly shared: TShared;
    readonly language: TLanguage;
    initializeWorkspace(workspaces: LanzerWorkspaceFolder[]): Promise<void>;
    loadDocuments(specs: LanzerDocumentSpec[]): Promise<LangiumDocument[]>;
    buildDocuments(
        documents: LangiumDocument[],
        options?: LanzerDocumentValidationOptions
    ): Promise<void>;
    validateWorkspace(
        request: LanzerCampaignRunRequest,
        documents: LangiumDocument[]
    ): Promise<LanzerWorkspaceValidationResult | undefined>;
    validateCampaignResult(
        request: LanzerCampaignRunRequest,
        documents: LangiumDocument[]
    ): Promise<LanzerCampaignCheckValidationResult | undefined>;
    getGenerationPolicy(job: LanzerGenerationJob): Promise<LanzerGenerationPolicy | undefined>;
    dslSkill(job: LanzerGenerationJob): Promise<LanzerDslSkillReference | undefined>;
}

export interface LanzerCampaignRunRequest {
    workspaces: LanzerWorkspaceFolder[];
    documents: LanzerDocumentSpec[];
    validate?: boolean;
    /**
     * Resolved campaign spec, when available. When present, the campaign runner can run
     * post-generation requirement validation against the parsed AST of the generated files.
     */
    campaign?: LanzerCampaignSpec;
}

export interface LanzerCampaignRunner<
    TShared extends LangiumSharedServices = LangiumSharedServices,
    TLanguage extends LangiumServices = LangiumServices
> {
    validateCampaign(request: LanzerCampaignRunRequest): Promise<LanzerCampaignValidationResult>;
}

export type LanzerAddedServices<
    TShared extends LangiumSharedServices = LangiumSharedServices,
    TLanguage extends LangiumServices = LangiumServices
> = {
    lanzer: {
        Lanzer: LanzerService<TShared, TLanguage>;
        CampaignRunner: LanzerCampaignRunner<TShared, TLanguage>;
    };
};

export type PartialLanzerAddedServices<
    TShared extends LangiumSharedServices = LangiumSharedServices,
    TLanguage extends LangiumServices = LangiumServices
> = {
    lanzer?: Partial<LanzerAddedServices<TShared, TLanguage>['lanzer']>;
};

export type LanzerServices<
    TShared extends LangiumSharedServices = LangiumSharedServices,
    TLanguage extends LangiumServices = LangiumServices
> = TLanguage & LanzerAddedServices<TShared, TLanguage>;

export type LanzerModule<
    TShared extends LangiumSharedServices = LangiumSharedServices,
    TLanguage extends LangiumServices = LangiumServices
> = Module<
    TLanguage & LanzerAddedServices<TShared, TLanguage>,
    PartialLangiumServices & PartialLanzerAddedServices<TShared, TLanguage>
>;
