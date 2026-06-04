import type { LanzerDslSkillReference, LanzerGenerationPolicy } from '../services/types.js';
import type { LanzerGenerationJob } from './jobs.js';
import { formatLanzerRequirement } from './jobs.js';

export interface LanzerAgentTaskPayload {
    job: LanzerGenerationJob;
    policy?: LanzerGenerationPolicy;
    dslSkill?: LanzerDslSkillReference;
    instructions: string[];
    prompt: string;
}

export interface LanzerCampaignTaskPayload {
    campaignName: string;
    campaignDescription?: string;
    jobs: LanzerGenerationJob[];
    policy?: LanzerGenerationPolicy;
    dslSkill?: LanzerDslSkillReference;
    instructions: string[];
    prompt: string;
}

export type LanzerTaskPayload = LanzerAgentTaskPayload | LanzerCampaignTaskPayload;

export function buildLanzerAgentTask(
    job: LanzerGenerationJob,
    policy?: LanzerGenerationPolicy,
    dslSkill?: LanzerDslSkillReference
): LanzerAgentTaskPayload {
    const instructions = buildInstructions(job, policy);
    return {
        job,
        policy,
        dslSkill,
        instructions,
        prompt: renderPrompt(job, policy, instructions, dslSkill)
    };
}

export function buildLanzerCampaignTask(
    jobs: LanzerGenerationJob[],
    policy?: LanzerGenerationPolicy,
    dslSkill?: LanzerDslSkillReference
): LanzerCampaignTaskPayload {
    if (jobs.length === 0) {
        throw new Error('Cannot build a Lanzer campaign task without generation jobs.');
    }
    const campaignName = jobs[0].campaignName;
    const campaignDescription = jobs[0].campaignDescription;
    const instructions = buildCampaignInstructions(jobs, policy);
    return {
        campaignName,
        campaignDescription,
        jobs,
        policy,
        dslSkill,
        instructions,
        prompt: renderCampaignPrompt(jobs, policy, instructions, dslSkill)
    };
}

function buildInstructions(job: LanzerGenerationJob, policy?: LanzerGenerationPolicy): string[] {
    const instructions = [
        `Generate the target file for Lanzer job ${job.id}.`,
        `You must create the target file at the requested absolute output path.`,
        `Treat the workspace root and support files as context, not generation targets.`,
        `Prefer satisfying all listed requirements exactly.`,
        `If two requirements conflict, preserve the file-local requirements first and adapt minimally.`
    ];
    if (job.siblingGeneratedFiles.length > 0) {
        instructions.push(
            `You may also create or update sibling generated files declared in this campaign when needed for a valid workspace.`
        );
        instructions.push(
            `Do not invent unrelated project files when the declared campaign files are sufficient.`
        );
    }
    if (policy?.instructions?.length) {
        instructions.push(...policy.instructions);
    }
    return instructions;
}

function buildCampaignInstructions(
    jobs: LanzerGenerationJob[],
    policy?: LanzerGenerationPolicy
): string[] {
    const instructions = [
        `Generate the full declared file set for campaign ${jobs[0].campaignName}.`,
        `You must create or update every generated file listed below in one pass.`,
        `Treat the workspace root and support files as context, not generation targets.`,
        `Prefer satisfying all listed requirements exactly.`,
        `If two requirements conflict, preserve file-local requirements first and adapt minimally.`,
        `Do not invent unrelated project files when the declared campaign files are sufficient.`
    ];
    if (policy?.instructions?.length) {
        instructions.push(...policy.instructions);
    }
    return instructions;
}

function renderPrompt(
    job: LanzerGenerationJob,
    policy: LanzerGenerationPolicy | undefined,
    instructions: string[],
    dslSkill: LanzerDslSkillReference | undefined
): string {
    const lines: string[] = [];
    lines.push(`Campaign: ${job.campaignName}`);
    if (job.campaignDescription) {
        lines.push(`Campaign description: ${job.campaignDescription}`);
    }
    lines.push(`Generation job: ${job.fileAlias}`);
    lines.push(`Target root rule: ${job.rootRule}`);
    if (job.description) {
        lines.push(`Target description: ${job.description}`);
    }
    if (policy?.summary) {
        lines.push(`Host policy summary: ${policy.summary}`);
    }
    if (job.workspaceRoot) {
        lines.push(`Workspace root: ${job.workspaceRoot}`);
    }
    if (policy?.grammarReferencePath) {
        lines.push(`Read the grammar reference from this absolute path before generating: ${policy.grammarReferencePath}`);
    }
    if (dslSkill?.name) {
        lines.push(`Use the installed agent skill named "${dslSkill.name}" before generating.`);
        lines.push('Use that skill alongside the grammar reference to understand host-specific language usage and idioms.');
    }
    if (dslSkill?.path) {
        lines.push(`Installed skill location hint: ${dslSkill.path}`);
    }
    lines.push(`You must write the primary generated file to this absolute path: ${job.absoluteOutputPath}`);
    if (job.siblingGeneratedFiles.length > 0) {
        lines.push('You may also create or update other declared generated files listed below if needed for correctness.');
    }
    lines.push('After writing the required file set, respond briefly with a status message.');

    if (instructions.length > 0) {
        lines.push('Execution instructions:');
        for (const instruction of instructions) {
            lines.push(`- ${instruction}`);
        }
    }

    if (policy?.requiredPractices?.length) {
        lines.push('Required practices:');
        for (const practice of policy.requiredPractices) {
            lines.push(`- ${practice}`);
        }
    }

    if (policy?.discouragedPractices?.length) {
        lines.push('Discouraged practices:');
        for (const practice of policy.discouragedPractices) {
            lines.push(`- ${practice}`);
        }
    }

    if (policy?.forbiddenPractices?.length) {
        lines.push('Forbidden practices:');
        for (const practice of policy.forbiddenPractices) {
            lines.push(`- ${practice}`);
        }
    }

    if (job.supportFiles.length > 0) {
        lines.push('Support files available for reading:');
        for (const file of job.supportFiles) {
            lines.push(`- ${file.alias}: ${file.absolutePath}${file.description ? ` (${file.description})` : ''}`);
        }
    }

    if (policy?.referenceFiles?.length) {
        lines.push('Host reference files available for reading:');
        for (const file of policy.referenceFiles) {
            lines.push(`- ${file.label}: ${file.path}${file.description ? ` (${file.description})` : ''}`);
        }
    }

    if (job.siblingGeneratedFiles.length > 0) {
        lines.push('Other declared generated files in this campaign:');
        for (const file of job.siblingGeneratedFiles) {
            lines.push(`- ${file.alias}: ${file.absolutePath} [${file.rootRule}]`);
        }
    }

    if (job.fileRequirements.length > 0 || job.campaignRequirements.length > 0) {
        appendSelectorSyntaxReference(lines);
    }

    if (job.fileRequirements.length > 0) {
        lines.push('File-local requirements:');
        for (const requirement of job.fileRequirements) {
            lines.push(`- ${formatLanzerRequirementForJob(requirement, job.fileAlias)}`);
        }
    }

    if (job.campaignRequirements.length > 0) {
        lines.push('Campaign requirements applying to this file:');
        for (const requirement of job.campaignRequirements) {
            lines.push(`- ${formatLanzerRequirementForJob(requirement, job.fileAlias)}`);
        }
    }

    lines.push('Generate a concrete file that fits the host language and the surrounding workspace.');
    return lines.join('\n');
}

function renderCampaignPrompt(
    jobs: LanzerGenerationJob[],
    policy: LanzerGenerationPolicy | undefined,
    instructions: string[],
    dslSkill: LanzerDslSkillReference | undefined
): string {
    const firstJob = jobs[0];
    const lines: string[] = [];
    lines.push(`Campaign: ${firstJob.campaignName}`);
    if (firstJob.campaignDescription) {
        lines.push(`Campaign description: ${firstJob.campaignDescription}`);
    }
    lines.push(`Generation mode: full campaign`);
    if (policy?.summary) {
        lines.push(`Host policy summary: ${policy.summary}`);
    }
    if (firstJob.workspaceRoot) {
        lines.push(`Workspace root: ${firstJob.workspaceRoot}`);
    }
    if (policy?.grammarReferencePath) {
        lines.push(`Read the grammar reference from this absolute path before generating: ${policy.grammarReferencePath}`);
    }
    if (dslSkill?.name) {
        lines.push(`Use the installed agent skill named "${dslSkill.name}" before generating.`);
        lines.push('Use that skill alongside the grammar reference to understand host-specific language usage and idioms.');
    }
    if (dslSkill?.path) {
        lines.push(`Installed skill location hint: ${dslSkill.path}`);
    }
    lines.push('You must write the following generated files in this run:');
    for (const job of jobs) {
        lines.push(`- ${job.fileAlias}: ${job.absoluteOutputPath} [${job.rootRule}]`);
    }
    lines.push('After writing the required file set, respond briefly with a status message.');

    if (instructions.length > 0) {
        lines.push('Execution instructions:');
        for (const instruction of instructions) {
            lines.push(`- ${instruction}`);
        }
    }

    if (policy?.requiredPractices?.length) {
        lines.push('Required practices:');
        for (const practice of policy.requiredPractices) {
            lines.push(`- ${practice}`);
        }
    }

    if (policy?.discouragedPractices?.length) {
        lines.push('Discouraged practices:');
        for (const practice of policy.discouragedPractices) {
            lines.push(`- ${practice}`);
        }
    }

    if (policy?.forbiddenPractices?.length) {
        lines.push('Forbidden practices:');
        for (const practice of policy.forbiddenPractices) {
            lines.push(`- ${practice}`);
        }
    }

    const supportFiles = jobs[0].supportFiles;
    if (supportFiles.length > 0) {
        lines.push('Support files available for reading:');
        for (const file of supportFiles) {
            lines.push(`- ${file.alias}: ${file.absolutePath}${file.description ? ` (${file.description})` : ''}`);
        }
    }

    if (policy?.referenceFiles?.length) {
        lines.push('Host reference files available for reading:');
        for (const file of policy.referenceFiles) {
            lines.push(`- ${file.label}: ${file.path}${file.description ? ` (${file.description})` : ''}`);
        }
    }

    const hasAnyRequirements = jobs.some((job) => job.fileRequirements.length > 0 || job.campaignRequirements.length > 0);
    if (hasAnyRequirements) {
        appendSelectorSyntaxReference(lines);
    }

    lines.push('Per-file generation targets:');
    for (const job of jobs) {
        lines.push(`- ${job.fileAlias} -> ${job.absoluteOutputPath} [${job.rootRule}]`);
        if (job.description) {
            lines.push(`  description: ${job.description}`);
        }
        if (job.fileRequirements.length > 0) {
            lines.push('  file-local requirements:');
            for (const requirement of job.fileRequirements) {
                lines.push(`  - ${formatLanzerRequirementForJob(requirement, job.fileAlias)}`);
            }
        }
        if (job.campaignRequirements.length > 0) {
            lines.push('  campaign requirements applying to this file:');
            for (const requirement of job.campaignRequirements) {
                lines.push(`  - ${formatLanzerRequirementForJob(requirement, job.fileAlias)}`);
            }
        }
    }

    lines.push('Generate a coherent concrete file set that fits the host language and the surrounding workspace.');
    return lines.join('\n');
}

/**
 * Inline reference for the selector syntax that requirements use. Lives in Lanzer (not in
 * any host policy) because the syntax itself is host-agnostic: the same rules apply
 * whichever `.langium` grammar the campaign imports.
 */
function appendSelectorSyntaxReference(lines: string[]): void {
    lines.push('Selector syntax used in the requirements below:');
    lines.push('- A capitalised name (e.g. `FnDecl`) matches AST nodes of that type. The type names correspond to non-terminal productions in the grammar reference file linked above; consult it to learn the concrete surface syntax for each rule.');
    lines.push('- `Type[prop="value"]` filters by a property\'s string value. Other operators: `!=` not equal, `^=` starts-with, `$=` ends-with, `*=` contains.');
    lines.push('- `Type[prop]` requires the property to be present (non-empty).');
    lines.push('- `Type[prop->TargetType[...]]` follows a cross-reference: the named property must resolve to a `TargetType` node, optionally further filtered by nested predicates.');
    lines.push('- `A > B` — B must be a direct child of A in the parsed AST.');
    lines.push('- `A >> B` — B must appear somewhere inside A at any depth.');
    lines.push('- `A:has(<inner>)` — A must contain a subtree matching the inner selector.');
    lines.push('- `A:not(<inner>)` — A must contain no subtree matching the inner selector.');
    lines.push('- Inside `:has(...)` and `:not(...)` a leading `>` restricts the inner match to direct children of A; without a leading combinator, the inner selector matches at any depth.');
    lines.push('Each requirement is one of three contracts: `MUST contain <selector>`, `MUST contain at least N node(s) matching <selector>`, or `MUST NOT contain <selector>`. Generate code whose parsed AST satisfies every contract. After the file is written, Lanzer parses it with the host language and rejects the result if any contract is violated.');
}

function formatLanzerRequirementForJob(
    requirement: Parameters<typeof formatLanzerRequirement>[0],
    fileAlias: string
): string {
    const formatted = formatLanzerRequirement(requirement);
    const scoped = ` in ${fileAlias}.`;
    if (formatted.endsWith(scoped)) {
        return formatted.slice(0, -scoped.length) + '.';
    }
    return formatted;
}
