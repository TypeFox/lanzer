import { dirname, resolve } from 'node:path';
import type { LanzerGenerationJob } from '../campaign/jobs.js';
import {
    buildLanzerAgentTask,
    buildLanzerCampaignTask,
    type LanzerPromptToolNames,
    type LanzerTaskPayload
} from '../campaign/prompt.js';
import { buildRetryPromptForCampaign, buildRetryPromptForJob } from './attempts.js';
import type { FileAccessRoots, RecordingClient } from './client.js';
import { captureWorkspaceSnapshot, validateCampaignFileSet, type LanzerFileSetResult } from './file-set.js';
import type { LanzerToolkit } from './tool-host.js';
import { executeLanzerTaskOverAcp } from './transport-acp.js';
import { executeLanzerTaskOverCodex, shouldUseCodexMcpTransport } from './transport-codex.js';
import type { LanzerAgentRunResult, LanzerAgentValidationResult, RunLanzerAgentTaskOptions } from './types.js';

// The public surface of running an agent, as it was when all of it lived in this file.
export * from './types.js';
export { LanzerRunStageError } from './stages.js';

/**
 * The names the agent will see for Lanzer's tools, so the prompt can point at them.
 *
 * MCP namespaces a client's tools as `mcp__<server>__<tool>`, and the prompt has to use that exact
 * form or the agent looks for something that does not exist. Derived from the toolkit rather than
 * from the running host because the prompt is built before the host is listening — and the names
 * do not depend on the port.
 */
function promptToolNames(toolkit: LanzerToolkit | undefined): LanzerPromptToolNames | undefined {
    if (!toolkit) return undefined;
    return {
        ...(toolkit.validate ? { validate: LANZER_TOOL_PROMPT_NAMES.validate } : {}),
        ...(toolkit.grammarReference ? { grammarReference: LANZER_TOOL_PROMPT_NAMES.grammarReference } : {})
    };
}

/** The toolkit a run actually serves: none over a transport that cannot carry Lanzer's tools. */
function servedToolkit(options: RunLanzerAgentTaskOptions): LanzerToolkit | undefined {
    return lanzerTransportServesTools(options) ? options.toolkit : undefined;
}

/**
 * Whether the agent these settings select can be offered Lanzer's tools.
 *
 * ACP sessions take MCP servers; the Codex MCP transport has no way to hand it one. A prompt that
 * names tools the agent cannot reach costs a turn discovering they are not there.
 */
export function lanzerTransportServesTools(agent: Pick<RunLanzerAgentTaskOptions, 'provider' | 'command' | 'args'>): boolean {
    return !shouldUseCodexMcpTransport(agent);
}

/** Every Lanzer tool by the name the agent sees, as `mcp__lanzer__<tool>`. */
export const LANZER_TOOL_PROMPT_NAMES = {
    validate: 'mcp__lanzer__validate',
    grammarReference: 'mcp__lanzer__grammar_reference'
} as const satisfies Required<LanzerPromptToolNames>;

export async function runLanzerAgentTaskOverAcp(
    job: LanzerGenerationJob,
    options: RunLanzerAgentTaskOptions
): Promise<LanzerAgentRunResult> {
    const task = buildLanzerAgentTask(job, options.policy, options.dslSkill, promptToolNames(servedToolkit(options)));
    const sessionCwd = job.workspaceRoot ?? options.cwd ?? process.cwd();
    // The same file-set check as a campaign run, for the one target. The job's prompt lets the
    // agent create or update the campaign's other generated files, so they are declared, not extra.
    const checkFileSet = await watchFileSet(
        sessionCwd,
        [job.absoluteOutputPath],
        [...job.supportFiles.map((file) => file.absolutePath), ...job.siblingGeneratedFiles.map((file) => file.absolutePath)],
        supportRunEntries(job),
        options.strictFileSet ?? false
    );
    return executeLanzerTask(
        task,
        {
            sessionCwd,
            roots: {
                writable: [
                    sessionCwd,
                    dirname(job.absoluteOutputPath),
                    ...(options.additionalDirectories ?? [])
                ],
                readOnly: options.readOnlyDirectories ?? []
            }
        },
        options,
        (validation, attempt) => buildRetryPromptForJob(job, validation, attempt),
        checkFileSet
    );
}

export async function runLanzerCampaignTaskOverAcp(
    jobs: LanzerGenerationJob[],
    options: RunLanzerAgentTaskOptions
): Promise<LanzerAgentRunResult> {
    const task = buildLanzerCampaignTask(jobs, options.policy, options.dslSkill, promptToolNames(servedToolkit(options)));
    const sessionCwd = jobs[0]?.workspaceRoot ?? options.cwd ?? process.cwd();
    const checkFileSet = await watchFileSet(
        sessionCwd,
        jobs.map((job) => job.absoluteOutputPath),
        jobs[0]?.supportFiles.map((file) => file.absolutePath) ?? [],
        jobs[0] ? supportRunEntries(jobs[0]) : [],
        options.strictFileSet ?? false
    );
    return executeLanzerTask(
        task,
        {
            sessionCwd,
            roots: {
                writable: [sessionCwd, ...(options.additionalDirectories ?? [])],
                readOnly: options.readOnlyDirectories ?? []
            }
        },
        options,
        (validation, attempt) => buildRetryPromptForCampaign(jobs, validation, attempt),
        checkFileSet
    );
}

/**
 * Snapshot the workspace now, and return the check that compares it after each attempt.
 *
 * `targets` must be written during the run. `declared` are the other files the campaign declares,
 * which are never counted as extra however they got there. `runEntries` must end the run exactly
 * as they started it. Both entry points go through this, so a single job and a whole campaign are
 * held to the same file-set rules.
 */
async function watchFileSet(
    workspaceRoot: string,
    targets: string[],
    declared: string[],
    runEntries: string[],
    strict: boolean
): Promise<() => Promise<LanzerFileSetResult>> {
    const expected = targets.map((filePath) => resolve(filePath));
    const baseline = await captureWorkspaceSnapshot(workspaceRoot, expected, runEntries.map((filePath) => resolve(filePath)));
    return () => validateCampaignFileSet(workspaceRoot, baseline, expected, declared.map((filePath) => resolve(filePath)), strict);
}

/**
 * The support files a job's `run` blocks start from.
 *
 * Such a file is the campaign's own driver — a test harness calling the generated code. The agent
 * may manage other support files, but not this one: rewriting the harness is a way to pass the run
 * without the code doing what it checks.
 */
function supportRunEntries(job: LanzerGenerationJob): string[] {
    return job.runs.filter((run) => run.entryKind === 'support').map((run) => run.absoluteEntryPath);
}

/** Run a task over whichever transport the options select: Codex's MCP server, or ACP. */
async function executeLanzerTask(
    task: LanzerTaskPayload,
    context: { sessionCwd: string; roots: FileAccessRoots },
    options: RunLanzerAgentTaskOptions,
    buildRetryPrompt: (validation: LanzerAgentValidationResult | undefined, attempt: number) => string,
    extraValidate?: (client: RecordingClient) => Promise<LanzerFileSetResult>
): Promise<LanzerAgentRunResult> {
    return shouldUseCodexMcpTransport(options)
        ? executeLanzerTaskOverCodex(task, context, options, buildRetryPrompt, extraValidate)
        : executeLanzerTaskOverAcp(task, context, options, buildRetryPrompt, extraValidate);
}
