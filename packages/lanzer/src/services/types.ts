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
    /**
     * Stable identifier for *what kind of thing went wrong*, for grouping failures across runs.
     *
     * Taken from the host's own diagnostic when it sets one. Most Langium languages do not — it is
     * optional in LSP and `langium-cli` does not scaffold it — so a host integration can assign
     * codes instead by overriding {@link LanzerCampaignRunner.collectDocumentResult}, without the
     * language itself being touched. Absent when neither supplies one, in which case the message
     * is all there is to group by.
     */
    code?: string;
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
    /**
     * What running the campaign's entry files produced, checked against its `run` blocks.
     *
     * Absent when the campaign has no `run` blocks, and when the files are not yet valid — a
     * program that does not parse or type-check is not run.
     */
    behaviour?: LanzerBehaviourValidationResult;
}

/**
 * What a host needs to run a campaign's program.
 *
 * A request object rather than positional arguments, so that what a run can be given — arguments,
 * stdin, environment — can grow without breaking a host that implemented it before.
 */
export interface LanzerExecutionRequest {
    /** Absolute path of the workspace the program was generated into; a compiled host builds this. */
    workspaceRoot: string;
    /** The declared file the program is run from. */
    entry: LanzerExecutionEntry;
    /** Every loaded host-language document in the workspace: generated files and support files. */
    documents: LangiumDocument[];
}

export interface LanzerExecutionEntry {
    alias: string;
    kind: 'generated' | 'support';
    /** Absolute path on disk; always set, whatever language the entry is in. */
    path: string;
    /** The entry as a parsed document, when it is written in the host language. */
    document?: LangiumDocument;
}

/** One run of a program, as the host language reports it. */
export interface LanzerExecutionResult {
    /** The program finished on its own: no runtime error, no timeout. */
    completed: boolean;
    /** Everything the program printed, in order. */
    output: string;
    /** The runtime error, when it stopped on one. */
    error?: string;
    timedOut: boolean;
    durationMs: number;
}

/** A `run` block's outcome: what the program did, and which expectations it missed. */
export interface LanzerRunOutcome {
    entryAlias: string;
    /** Absent when the program could not be run at all (see `failures`). */
    execution?: LanzerExecutionResult;
    failures: string[];
}

export interface LanzerBehaviourValidationResult {
    ok: boolean;
    runs: LanzerRunOutcome[];
    /** Every run's failures, flattened, for fix prompts and the `validate` tool. */
    issues: string[];
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
    /**
     * Run the campaign's program from `request.entry`, with the whole workspace available: an
     * interpreter runs the entry with the other documents' definitions in scope; a compiled
     * language builds `request.workspaceRoot` and runs its main. Optional: a host that cannot run
     * its language leaves it out, and a campaign with `run` blocks then fails at the `behaviour`
     * stage rather than passing unchecked.
     *
     * The code is agent-generated and untrusted. The host bounds it — time, output, and whatever
     * its language could reach outside the process.
     */
    execute?(request: LanzerExecutionRequest): Promise<LanzerExecutionResult>;
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
