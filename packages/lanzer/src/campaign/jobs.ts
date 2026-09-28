import path from 'node:path';
import type {
    LanzerCampaignSpec,
    LanzerCountRequirementSpec,
    LanzerFileSpec,
    LanzerForbidRequirementSpec,
    LanzerPredicate,
    LanzerPseudoClass,
    LanzerRequirementSpec,
    LanzerResolvedCampaign,
    LanzerRunSpec,
    LanzerSelector,
    LanzerSelectorPart,
    LanzerSupportFileSpec,
    LanzerSymbolRequirementSpec
} from './model.js';

export interface LanzerGenerationJob {
    id: string;
    campaignName: string;
    campaignDescription?: string;
    jobIndex: number;
    fileAlias: string;
    rootRule: string;
    description?: string;
    workspaceRoot?: string;
    outputPath: string;
    absoluteOutputPath: string;
    supportFiles: LanzerGenerationSupportFile[];
    siblingGeneratedFiles: LanzerGenerationSiblingFile[];
    requirements: LanzerRequirementSpec[];
    fileRequirements: LanzerRequirementSpec[];
    campaignRequirements: LanzerRequirementSpec[];
    grammarImports: string[];
    grammarBaseDir?: string;
    /** The campaign's `run` blocks, with each entry file's absolute path, for the prompt. */
    runs: LanzerGenerationRun[];
}

export interface LanzerGenerationRun extends LanzerRunSpec {
    absoluteEntryPath: string;
}

export interface LanzerGenerationSupportFile {
    alias: string;
    path: string;
    absolutePath: string;
    description?: string;
}

export interface LanzerGenerationSiblingFile {
    alias: string;
    path: string;
    absolutePath: string;
    rootRule: string;
    description?: string;
}

export interface BuildLanzerGenerationJobsOptions {
    includeUnscopedCampaignRequirements?: boolean;
}

export function buildLanzerGenerationJobs(
    resolved: LanzerResolvedCampaign,
    options: BuildLanzerGenerationJobsOptions = {}
): LanzerGenerationJob[] {
    const campaign = resolved.campaign;
    const workspaceRoot = resolveWorkspaceRoot(campaign);

    return campaign.files.map((file, jobIndex) => {
        const absoluteOutputPath = resolvePath(file.path, workspaceRoot);
        const fileRequirements = file.requirements;
        const campaignRequirements = campaign.requirements.filter((requirement) =>
            appliesToFile(requirement, file.alias, options.includeUnscopedCampaignRequirements ?? true)
        );

        return {
            id: `${campaign.name}:${file.alias}`,
            campaignName: campaign.name,
            campaignDescription: campaign.description,
            jobIndex,
            fileAlias: file.alias,
            rootRule: file.rootRule,
            description: file.description,
            workspaceRoot,
            outputPath: file.path,
            absoluteOutputPath,
            supportFiles: campaign.supportFiles.map((supportFile) => mapSupportFile(supportFile, workspaceRoot)),
            siblingGeneratedFiles: campaign.files
                .filter((sibling) => sibling.alias !== file.alias)
                .map((sibling) => mapSiblingFile(sibling, workspaceRoot)),
            requirements: [...fileRequirements, ...campaignRequirements],
            fileRequirements,
            campaignRequirements,
            grammarImports: campaign.imports,
            grammarBaseDir: campaign.baseDir,
            runs: campaign.runs.map((run) => ({
                ...run,
                absoluteEntryPath: resolvePath(
                    campaign.files.find((candidate) => candidate.alias === run.fileAlias)?.path ?? run.fileAlias,
                    workspaceRoot
                )
            }))
        };
    });
}

export function findLanzerGenerationJob(
    jobs: LanzerGenerationJob[],
    selector: string | undefined
): LanzerGenerationJob | undefined {
    if (!selector) {
        return jobs[0];
    }
    return jobs.find((job) => job.id === selector || job.fileAlias === selector);
}

function mapSupportFile(file: LanzerSupportFileSpec, workspaceRoot: string | undefined): LanzerGenerationSupportFile {
    return {
        alias: file.alias,
        path: file.path,
        absolutePath: resolvePath(file.path, workspaceRoot),
        description: file.description
    };
}

function mapSiblingFile(file: LanzerFileSpec, workspaceRoot: string | undefined): LanzerGenerationSiblingFile {
    return {
        alias: file.alias,
        path: file.path,
        absolutePath: resolvePath(file.path, workspaceRoot),
        rootRule: file.rootRule,
        description: file.description
    };
}

function resolveWorkspaceRoot(campaign: LanzerCampaignSpec): string | undefined {
    if (campaign.workspaceRoot) {
        return resolvePath(campaign.workspaceRoot, campaign.baseDir);
    }
    return campaign.baseDir;
}

function resolvePath(filePath: string, root: string | undefined): string {
    return root ? path.resolve(root, filePath) : filePath;
}

function appliesToFile(
    requirement: LanzerRequirementSpec,
    fileAlias: string,
    includeUnscopedCampaignRequirements: boolean
): boolean {
    const targetAlias = getRequirementFileAlias(requirement);
    if (!targetAlias) {
        return includeUnscopedCampaignRequirements;
    }
    return targetAlias === fileAlias;
}

function getRequirementFileAlias(requirement: LanzerRequirementSpec): string | undefined {
    switch (requirement.kind) {
        case 'symbol':
        case 'count':
        case 'forbid':
            return requirement.fileAlias;
        default: {
            const exhaustive: never = requirement;
            return exhaustive;
        }
    }
}

export function formatLanzerRequirement(requirement: LanzerRequirementSpec): string {
    switch (requirement.kind) {
        case 'symbol':
            return formatSymbolRequirement(requirement);
        case 'count':
            return formatCountRequirement(requirement);
        case 'forbid':
            return formatForbidRequirement(requirement);
        default: {
            const exhaustive: never = requirement;
            return String(exhaustive);
        }
    }
}

function formatSymbolRequirement(requirement: LanzerSymbolRequirementSpec): string {
    return `MUST contain ${renderSelector(requirement.selector)}${formatFileScope(requirement.fileAlias)}.`;
}

function formatCountRequirement(requirement: LanzerCountRequirementSpec): string {
    return `MUST contain at least ${requirement.count} node(s) matching ${renderSelector(requirement.selector)}${formatFileScope(requirement.fileAlias)}.`;
}

function formatForbidRequirement(requirement: LanzerForbidRequirementSpec): string {
    return `MUST NOT contain ${renderSelector(requirement.selector)}${formatFileScope(requirement.fileAlias)}.`;
}

function formatFileScope(fileAlias: string | undefined): string {
    return fileAlias ? ` in ${fileAlias}` : '';
}

export function renderSelector(selector: LanzerSelector): string {
    const buffer: string[] = [];
    if (selector.leadingCombinator) {
        buffer.push(selector.leadingCombinator);
    }
    selector.parts.forEach((part, index) => {
        if (index > 0) {
            buffer.push(selector.combinators[index - 1]);
        }
        buffer.push(renderSelectorPart(part));
    });
    return buffer.join(' ');
}

function renderSelectorPart(part: LanzerSelectorPart): string {
    const predicates = part.predicates.map(renderPredicate).join('');
    const pseudos = part.pseudos.map(renderPseudoClass).join('');
    return `${part.rule}${predicates}${pseudos}`;
}

function renderPredicate(predicate: LanzerPredicate): string {
    switch (predicate.kind) {
        case 'presence':
            return `[${predicate.property}]`;
        case 'value':
            return `[${predicate.property}${predicate.op}"${predicate.value}"]`;
        case 'crossRef': {
            const nested = predicate.nestedPredicates.map(renderPredicate).join('');
            return `[${predicate.property}->${predicate.targetRule}${nested}]`;
        }
        default: {
            const exhaustive: never = predicate;
            return String(exhaustive);
        }
    }
}

function renderPseudoClass(pseudo: LanzerPseudoClass): string {
    return `:${pseudo.kind}(${renderSelector(pseudo.selector)})`;
}
