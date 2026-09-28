import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import type {
    Campaign,
    CampaignFile,
    CountRequirement,
    DiagnosticExpectation,
    Expectation,
    FileSpec,
    ForbidRequirement,
    Predicate,
    PseudoClass,
    RunSpec,
    Selector,
    SelectorPart,
    SupportFileSpec,
    SymbolRequirement
} from '../generated/ast.js';
import { isSupportFileSpec } from '../generated/ast.js';
import type { LanzerDocumentSpec, LanzerWorkspaceFolder } from '../services/types.js';
import { astTypeOfRule, UNRESOLVED_AST_TYPE } from '../grammar/ast-type.js';
import { asLiteral } from '../util/guards.js';
import {
    LANZER_COMBINATORS,
    LANZER_DIAGNOSTIC_SEVERITIES,
    LANZER_OUTPUT_MATCH_MODES,
    LANZER_PSEUDO_CLASS_KINDS,
    LANZER_VALUE_PREDICATE_OPS
} from './model.js';
import type {
    LanzerCampaignSpec,
    LanzerCountRequirementSpec,
    LanzerCrossRefPredicate,
    LanzerDiagnosticExpectation,
    LanzerExpectation,
    LanzerFileSpec as LanzerRuntimeFileSpec,
    LanzerForbidRequirementSpec,
    LanzerPredicate,
    LanzerPresencePredicate,
    LanzerPseudoClass,
    LanzerRequirementSpec,
    LanzerResolvedCampaign,
    LanzerRunSpec,
    LanzerSelector,
    LanzerSelectorPart,
    LanzerSupportFileSpec as LanzerRuntimeSupportFileSpec,
    LanzerSymbolRequirementSpec,
    LanzerValuePredicate
} from './model.js';

export interface MapLanzerCampaignFileOptions {
    sourceUri?: string;
    baseDir?: string;
}

export interface ResolveLanzerCampaignOptions {
    workspaceName?: string;
    workspaceUri?: string;
}

export function mapLanzerCampaignFile(
    model: CampaignFile,
    options: MapLanzerCampaignFileOptions = {}
): LanzerCampaignSpec[] {
    const baseDir = options.baseDir ?? inferBaseDir(options.sourceUri);
    const imports = model.imports.map((imp) => imp.path);
    return model.campaigns.map((campaign) => mapCampaign(campaign, {
        sourceUri: options.sourceUri,
        baseDir,
        imports
    }));
}

interface MapCampaignContext extends MapLanzerCampaignFileOptions {
    imports?: string[];
}

export function mapCampaign(
    campaign: Campaign,
    options: MapCampaignContext = {}
): LanzerCampaignSpec {
    return {
        name: campaign.name,
        description: campaign.description,
        sourceUri: options.sourceUri,
        baseDir: options.baseDir ?? inferBaseDir(options.sourceUri),
        workspaceRoot: campaign.workspaceRoot,
        imports: options.imports ?? [],
        files: campaign.files.map((file) => mapFile(file)),
        supportFiles: campaign.supportFiles.map((file) => mapSupportFile(file)),
        requirements: campaign.requirements.map((requirement) => mapRequirement(requirement)),
        runs: campaign.runs.map((run) => mapRun(run))
    };
}

export function resolveLanzerCampaign(
    campaign: LanzerCampaignSpec,
    options: ResolveLanzerCampaignOptions = {}
): LanzerResolvedCampaign {
    const workspaceUri = options.workspaceUri ?? resolveWorkspaceUri(campaign);
    const workspaceBaseDir = resolveWorkspaceBaseDir(campaign);
    const workspaces: LanzerWorkspaceFolder[] = [{
        name: options.workspaceName ?? campaign.name,
        uri: workspaceUri
    }];
    const documents: LanzerDocumentSpec[] = [
        ...campaign.supportFiles.map((file) => ({
            path: resolveDocumentPath(file.path, workspaceBaseDir),
            description: file.description
        })),
        ...campaign.files.map((file) => ({
            path: resolveDocumentPath(file.path, workspaceBaseDir),
            description: file.description
        }))
    ];

    return {
        campaign,
        request: {
            workspaces,
            documents,
            validate: true,
            campaign
        }
    };
}

export function resolveLanzerCampaigns(
    campaigns: LanzerCampaignSpec[],
    options: ResolveLanzerCampaignOptions = {}
): LanzerResolvedCampaign[] {
    return campaigns.map((campaign) => resolveLanzerCampaign(campaign, options));
}

function mapFile(file: FileSpec): LanzerRuntimeFileSpec {
    return {
        alias: file.name,
        path: file.path,
        rootRule: file.rootRule.ref?.name ?? file.rootRule.$refText,
        rootAstType: astTypeOfRule(file.rootRule.ref),
        description: file.description,
        requirements: file.requirements.map((requirement) => mapRequirement(requirement)),
        diagnostics: file.diagnostics.map((expectation) => mapDiagnosticExpectation(expectation))
    };
}

function mapDiagnosticExpectation(expectation: DiagnosticExpectation): LanzerDiagnosticExpectation {
    return {
        severity: asLiteral(expectation.severity, LANZER_DIAGNOSTIC_SEVERITIES) ?? 'error',
        ...(expectation.code !== undefined ? { code: expectation.code } : {}),
        ...(expectation.message !== undefined
            ? {
                message: {
                    // No mode keyword is an exact comparison, as for output checks.
                    mode: asLiteral(expectation.messageMode, LANZER_OUTPUT_MATCH_MODES) ?? 'exact',
                    value: expectation.message
                }
            }
            : {})
    };
}

function mapSupportFile(file: SupportFileSpec): LanzerRuntimeSupportFileSpec {
    return {
        alias: file.name,
        path: file.path,
        description: file.description
    };
}

function mapRequirement(
    requirement: SymbolRequirement | CountRequirement | ForbidRequirement
): LanzerRequirementSpec {
    switch (requirement.$type) {
        case 'SymbolRequirement':
            return mapSymbolRequirement(requirement);
        case 'CountRequirement':
            return mapCountRequirement(requirement);
        case 'ForbidRequirement':
            return mapForbidRequirement(requirement);
        default: {
            const exhaustive: never = requirement;
            throw new Error(`Unsupported requirement type: ${String(exhaustive)}`);
        }
    }
}

function mapSymbolRequirement(requirement: SymbolRequirement): LanzerSymbolRequirementSpec {
    return {
        kind: 'symbol',
        selector: mapSelector(requirement.selector),
        fileAlias: requirement.file?.ref?.name
    };
}

function mapCountRequirement(requirement: CountRequirement): LanzerCountRequirementSpec {
    return {
        kind: 'count',
        selector: mapSelector(requirement.selector),
        count: requirement.count,
        fileAlias: requirement.file?.ref?.name
    };
}

function mapForbidRequirement(requirement: ForbidRequirement): LanzerForbidRequirementSpec {
    return {
        kind: 'forbid',
        selector: mapSelector(requirement.selector),
        fileAlias: requirement.file?.ref?.name
    };
}

function mapSelector(selector: Selector): LanzerSelector {
    return {
        leadingCombinator: asLiteral(selector.leadingCombinator, LANZER_COMBINATORS),
        parts: selector.parts.map((part) => mapSelectorPart(part)),
        // One combinator sits between each pair of parts, so this array has to stay the same
        // length as `parts` — a value the model no longer lists cannot simply be dropped. It
        // falls back to the direct-child combinator, the stricter of the two: a requirement that
        // should have matched then fails and is reported, rather than passing on a selector
        // nobody meant to write.
        combinators: selector.combinators.map(
            (combinator) => asLiteral(combinator, LANZER_COMBINATORS) ?? '>'
        )
    };
}

function mapSelectorPart(part: SelectorPart): LanzerSelectorPart {
    const ruleNode = part.rule?.ref;
    return {
        rule: part.rule?.ref?.name ?? part.rule?.$refText ?? UNRESOLVED_AST_TYPE,
        astType: astTypeOfRule(ruleNode),
        predicates: part.predicates.map((predicate) => mapPredicate(predicate)),
        pseudos: part.pseudos.map((pseudo) => mapPseudoClass(pseudo))
    };
}

function mapPredicate(predicate: Predicate): LanzerPredicate {
    if (predicate.targetRule) {
        const targetNode = predicate.targetRule.ref;
        const crossRef: LanzerCrossRefPredicate = {
            kind: 'crossRef',
            property: predicate.property,
            targetRule: predicate.targetRule.ref?.name ?? predicate.targetRule.$refText ?? UNRESOLVED_AST_TYPE,
            targetAstType: astTypeOfRule(targetNode),
            nestedPredicates: predicate.nestedPredicates.map((nested) => mapPredicate(nested))
        };
        return crossRef;
    }
    if (predicate.op) {
        const value: LanzerValuePredicate = {
            kind: 'value',
            property: predicate.property,
            op: asLiteral(predicate.op, LANZER_VALUE_PREDICATE_OPS) ?? '=',
            value: predicate.value ?? ''
        };
        return value;
    }
    const presence: LanzerPresencePredicate = {
        kind: 'presence',
        property: predicate.property
    };
    return presence;
}

function mapRun(run: RunSpec): LanzerRunSpec {
    return {
        entryAlias: run.entry.ref?.name ?? run.entry.$refText,
        entryKind: isSupportFileSpec(run.entry.ref) ? 'support' : 'generated',
        expectations: run.expectations.map((expectation) => mapExpectation(expectation))
    };
}

function mapExpectation(expectation: Expectation): LanzerExpectation {
    if (expectation.runs) {
        return { kind: 'runs' };
    }
    return {
        kind: 'output',
        // No mode keyword is an exact comparison; the grammar only admits the other two.
        mode: asLiteral(expectation.mode, LANZER_OUTPUT_MATCH_MODES) ?? 'exact',
        value: expectation.value ?? '',
        negated: expectation.negated
    };
}

function mapPseudoClass(pseudo: PseudoClass): LanzerPseudoClass {
    return {
        kind: asLiteral(pseudo.kind, LANZER_PSEUDO_CLASS_KINDS) ?? 'has',
        selector: mapSelector(pseudo.selector)
    };
}

function inferBaseDir(sourceUri: string | undefined): string | undefined {
    if (!sourceUri || !sourceUri.startsWith('file:')) {
        return undefined;
    }
    return path.dirname(fileURLToPath(sourceUri));
}

function resolveWorkspaceUri(campaign: LanzerCampaignSpec): string {
    const workspaceBaseDir = resolveWorkspaceBaseDir(campaign);
    if (workspaceBaseDir) {
        return pathToFileUri(workspaceBaseDir);
    }
    if (campaign.baseDir) {
        return pathToFileUri(campaign.baseDir);
    }
    if (campaign.sourceUri?.startsWith('file:')) {
        return pathToFileUri(path.dirname(fileURLToPath(campaign.sourceUri)));
    }
    return 'memory:/';
}

function resolveWorkspaceBaseDir(campaign: LanzerCampaignSpec): string | undefined {
    if (campaign.workspaceRoot) {
        return resolveDocumentPath(campaign.workspaceRoot, campaign.baseDir);
    }
    return campaign.baseDir;
}

function resolveDocumentPath(filePath: string, baseDir: string | undefined): string {
    return baseDir ? path.resolve(baseDir, filePath) : filePath;
}

function pathToFileUri(filePath: string): string {
    return pathToFileURL(path.resolve(filePath)).toString();
}
