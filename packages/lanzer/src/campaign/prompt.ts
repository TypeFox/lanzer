import { join } from 'node:path';
import type { LanzerDslSkillReference, LanzerGenerationPolicy } from '../services/types.js';
import type { LanzerGenerationJob, LanzerGenerationRun } from './jobs.js';
import { describeDiagnosticExpectation } from '../validations/diagnostic-validations.js';
import type { LanzerDiagnosticExpectation, LanzerRequirementSpec } from './model.js';
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

/**
 * Names of the tools Lanzer serves during a run, for the prompt to point at.
 *
 * Passed in rather than assumed: a run without a toolkit must not be told to call tools that are
 * not there, which reads to the agent as a broken environment and costs a turn to discover.
 */
export interface LanzerPromptToolNames {
    validate?: string;
    grammarReference?: string;
}

/**
 * Point the agent at the DSL skill, by name and by location.
 *
 * The name works when the agent has the skill installed where it looks for skills; the location
 * works everywhere, including for agents with no skill system and for a skill shipped in the host's
 * repository rather than installed. Giving only the name sends the agent looking for something it
 * may not have.
 */
function appendSkillInstructions(lines: string[], dslSkill: LanzerDslSkillReference | undefined): void {
    if (dslSkill?.name) {
        lines.push(`Use the installed agent skill named "${dslSkill.name}" before generating.`);
    }
    if (dslSkill?.path) {
        const skillFile = join(dslSkill.path, 'SKILL.md');
        lines.push(dslSkill.name
            ? `If that skill is not available to you, read ${skillFile} directly, with the files it refers to in ${dslSkill.path}.`
            : `Read the DSL skill at ${skillFile} before generating, with the files it refers to in ${dslSkill.path}.`);
    }
    if (dslSkill?.name || dslSkill?.path) {
        lines.push('Use that skill alongside the grammar reference to understand host-specific language usage and idioms.');
    }
}

/**
 * Tell the agent the tools exist and when to reach for them.
 *
 * Registering a tool is not enough on its own — an agent that is not told to check its work has no
 * reason to, and will write the file and stop. Naming `validate` as the same check the run is
 * graded by is what turns it from an option into the obvious last step.
 */
function appendToolInstructions(lines: string[], tools: LanzerPromptToolNames | undefined): void {
    if (!tools?.validate && !tools?.grammarReference) {
        return;
    }
    lines.push('');
    lines.push('Tools available to you for this task:');
    if (tools.grammarReference) {
        lines.push(`- \`${tools.grammarReference}\` returns the target language's full grammar. Consult it before writing syntax you are unsure of.`);
    }
    if (tools.validate) {
        lines.push(`- \`${tools.validate}\` checks the files you have written: parse errors, language diagnostics, and whether the campaign requirements are satisfied.`);
        lines.push(`  It runs the exact check this task is graded by, so treat a VALID result as done and anything else as work remaining.`);
        lines.push(`  Call it after writing the file set, fix whatever it reports, and call it again. Do not finish while it still reports problems.`);
    }
}

export function buildLanzerAgentTask(
    job: LanzerGenerationJob,
    policy?: LanzerGenerationPolicy,
    dslSkill?: LanzerDslSkillReference,
    tools?: LanzerPromptToolNames
): LanzerAgentTaskPayload {
    const instructions = buildInstructions(job, policy);
    return {
        job,
        policy,
        dslSkill,
        instructions,
        prompt: renderPrompt(job, policy, instructions, dslSkill, tools)
    };
}

export function buildLanzerCampaignTask(
    jobs: LanzerGenerationJob[],
    policy?: LanzerGenerationPolicy,
    dslSkill?: LanzerDslSkillReference,
    tools?: LanzerPromptToolNames
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
        prompt: renderCampaignPrompt(jobs, policy, instructions, dslSkill, tools)
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
    dslSkill: LanzerDslSkillReference | undefined,
    tools: LanzerPromptToolNames | undefined
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
    appendSkillInstructions(lines, dslSkill);
    lines.push(`You must write the primary generated file to this absolute path: ${job.absoluteOutputPath}`);
    if (job.siblingGeneratedFiles.length > 0) {
        lines.push('You may also create or update other declared generated files listed below if needed for correctness.');
    }
    appendToolInstructions(lines, tools);
    lines.push('');
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
        lines.push('Support files — the project\'s own non-generated files, yours to manage:');
        for (const file of job.supportFiles) {
            lines.push(`- ${file.alias}: ${file.absolutePath}${file.description ? ` (${file.description})` : ''}`);
        }
        lines.push('Read them for context, and create, update or remove them as the project requires — the DSL skill describes what each should contain.');
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

    const { scoped, campaignWide } = splitCampaignRequirements(job);
    if (scoped.length > 0) {
        lines.push('Campaign requirements applying to this file:');
        for (const requirement of scoped) {
            lines.push(`- ${formatLanzerRequirementForJob(requirement, job.fileAlias)}`);
        }
    }
    appendCampaignWideRequirements(lines, campaignWide);
    appendExpectedDiagnostics(lines, job.diagnostics, '');
    appendBehaviourChecks(lines, job.runs);

    lines.push('Generate a concrete file that fits the host language and the surrounding workspace.');
    return lines.join('\n');
}

function renderCampaignPrompt(
    jobs: LanzerGenerationJob[],
    policy: LanzerGenerationPolicy | undefined,
    instructions: string[],
    dslSkill: LanzerDslSkillReference | undefined,
    tools: LanzerPromptToolNames | undefined
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
    appendSkillInstructions(lines, dslSkill);
    lines.push('You must write the following generated files in this run:');
    for (const job of jobs) {
        lines.push(`- ${job.fileAlias}: ${job.absoluteOutputPath} [${job.rootRule}]`);
    }
    appendToolInstructions(lines, tools);
    lines.push('');
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
        lines.push('Support files — the project\'s own non-generated files, yours to manage:');
        for (const file of supportFiles) {
            lines.push(`- ${file.alias}: ${file.absolutePath}${file.description ? ` (${file.description})` : ''}`);
        }
        lines.push('Read them for context, and create, update or remove them as the project requires — the DSL skill describes what each should contain.');
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
        const { scoped } = splitCampaignRequirements(job);
        if (scoped.length > 0) {
            lines.push('  campaign requirements applying to this file:');
            for (const requirement of scoped) {
                lines.push(`  - ${formatLanzerRequirementForJob(requirement, job.fileAlias)}`);
            }
        }
        appendExpectedDiagnostics(lines, job.diagnostics, '  ');
    }
    appendCampaignWideRequirements(lines, splitCampaignRequirements(firstJob).campaignWide);
    appendBehaviourChecks(lines, firstJob.runs);

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

/**
 * A job's campaign requirements, split by how they are checked.
 *
 * One naming a file is checked against that file alone. One naming none is checked against every
 * generated file together — a `min 3 Fn` is met by two in one file and one in another — so listing
 * it under a single file would misstate the contract.
 */
function splitCampaignRequirements(job: LanzerGenerationJob): {
    scoped: LanzerRequirementSpec[];
    campaignWide: LanzerRequirementSpec[];
} {
    return {
        scoped: job.campaignRequirements.filter((requirement) => requirement.fileAlias !== undefined),
        campaignWide: job.campaignRequirements.filter((requirement) => requirement.fileAlias === undefined)
    };
}

function appendCampaignWideRequirements(lines: string[], requirements: LanzerRequirementSpec[]): void {
    if (requirements.length === 0) {
        return;
    }
    lines.push('Campaign-wide requirements, checked across all generated files together (any file may satisfy them, and `MUST NOT` applies to every file):');
    for (const requirement of requirements) {
        lines.push(`- ${formatLanzerRequirement(requirement)}`);
    }
}

/**
 * What a near-miss file must be rejected with.
 *
 * An agent's every instinct is to write valid code, so the contract is stated as the goal rather
 * than as a list of findings: one deliberate mistake, the file otherwise correct, and no second
 * error to muddy what the file tests.
 */
function appendExpectedDiagnostics(lines: string[], diagnostics: LanzerDiagnosticExpectation[], indent: string): void {
    if (diagnostics.length === 0) {
        return;
    }
    lines.push(`${indent}expected diagnostics — this file is a deliberate near-miss. The language MUST report:`);
    for (const expectation of diagnostics) {
        lines.push(`${indent}- ${describeDiagnosticExpectation(expectation)}`);
    }
    lines.push(`${indent}Introduce exactly the mistake that causes these and nothing else: the file must still satisfy its requirements, be otherwise correct, and produce no other error. Every other generated file must stay valid. Validation treats these diagnostics as the goal: do not fix them.`);
}

/**
 * The programs Lanzer will run, and what each must print.
 *
 * Stated up front, with the expected output in full: the agent is graded on it, and a contract it
 * can only discover by failing it costs a turn per clause. Every run must first finish on its own,
 * so that is stated for each, whatever else it expects.
 */
function appendBehaviourChecks(lines: string[], runs: LanzerGenerationRun[]): void {
    if (runs.length === 0) {
        return;
    }
    lines.push('Behaviour checks — once the files are valid, Lanzer runs each program below and checks what it prints:');
    for (const run of runs) {
        // A support entry is the campaign's own driver: the agent must not rewrite it to pass.
        const entry = run.entryKind === 'support' ? 'support file, provided — do not change it' : 'generated file';
        lines.push(`- run from ${run.entryAlias} (${entry}, ${run.absoluteEntryPath}):`);
        lines.push('  - MUST run to completion, without a runtime error or timeout.');
        for (const expectation of run.expectations) {
            if (expectation.kind === 'output') {
                const must = expectation.negated ? 'MUST NOT' : 'MUST';
                const clause = {
                    exact: `output ${must} be exactly ${JSON.stringify(expectation.value)} (trailing whitespace and blank lines are ignored)`,
                    contains: `output ${must} contain ${JSON.stringify(expectation.value)}`,
                    matches: `output ${must} match the regular expression /${expectation.value}/`
                }[expectation.mode];
                lines.push(`  - ${clause}.`);
            }
        }
    }
    lines.push('Produce this behaviour by computing it, as the description asks — not by printing the expected text directly.');
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
