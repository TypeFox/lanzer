import {
    runLanzerCampaignTaskOverAcp,
    type LanzerAgentRunResult
} from '../acp/run.js';
import {
    resolvePermissionPolicy,
    type LanzerPermissionPolicy
} from '../acp/permissions.js';
import { formatLanzerIssue } from '../acp/issues.js';
import type { LanzerToolkit } from '../acp/tool-host.js';
import { buildLanzerRunReport } from '../report/build.js';
import type { LanzerCampaignValidationResult } from './types.js';
import { readFile } from 'node:fs/promises';
import { buildLanzerGenerationJobs } from '../campaign/jobs.js';
import type { LanzerResolvedCampaign } from '../campaign/model.js';
import type { LanzerCampaignRunner, LanzerService } from './types.js';

/**
 * ACP transport + retry options for {@link runLanzerCampaign}. This is the subset of the
 * lower-level `RunLanzerAgentTaskOptions` a caller normally configures; the campaign jobs,
 * generation policy, DSL skill, and post-generation validation are derived automatically from
 * the host {@link LanzerService} and {@link LanzerCampaignRunner}.
 */
export interface LanzerAcpOptions {
    /** Executable that speaks the Agent Client Protocol (e.g. `claude-agent-acp`). */
    command: string;
    /** Extra argv passed to the ACP command. */
    args?: string[];
    /** Working directory for the spawned ACP process. Defaults to `process.cwd()`. */
    cwd?: string;
    /** Extra environment for the ACP process, merged over `process.env`. */
    env?: Record<string, string>;
    provider?: string;
    model?: string;
    effort?: string;
    /** Total prompts in one session (initial + fixes). See `RunLanzerAgentTaskOptions`. */
    maxAttempts?: number;
    fixIterations?: number;
    retryIterations?: number;
    /** What the agent may do, by ACP tool kind. Defaults to the generation baseline. */
    permissions?: LanzerPermissionPolicy;
    /** Progress streaming for the run. */
    progress?: {
        label?: string;
        stream?: NodeJS.WritableStream;
        verbose?: boolean;
    };
}

/**
 * Host bindings required to run a campaign: the language's {@link LanzerService} (supplies the
 * generation policy and DSL skill) and its {@link LanzerCampaignRunner} (runs post-generation
 * requirement validation against the produced files).
 */
export interface RunLanzerCampaignDeps<
    TService extends LanzerService = LanzerService,
    TRunner extends LanzerCampaignRunner = LanzerCampaignRunner
> {
    service: TService;
    runner: TRunner;
}

/**
 * **Fast path** for running a single resolved campaign end-to-end.
 *
 * This is the orchestration that every consumer would otherwise hand-roll: it builds the
 * generation jobs, asks the host service for the generation policy and DSL skill, wraps the
 * campaign runner as a post-generation validation callback, and dispatches the work to an agent
 * over ACP (which writes the generated files and re-validates against the campaign requirements).
 *
 * Host-agnostic: the host-language specifics arrive entirely through {@link RunLanzerCampaignDeps}.
 * For the *slow path*, call {@link buildLanzerGenerationJobs} and `runLanzerCampaignTaskOverAcp`
 * directly and assemble these steps yourself.
 *
 * Operates on **one** campaign. Multi-campaign batching and concurrency are deliberately left to
 * the caller (a CLI), so the library does not dictate scheduling policy.
 */
export async function runLanzerCampaign(
    resolved: LanzerResolvedCampaign,
    deps: RunLanzerCampaignDeps,
    acp: LanzerAcpOptions
): Promise<LanzerAgentRunResult> {
    const jobs = buildLanzerGenerationJobs(resolved);
    if (jobs.length === 0) {
        throw new Error('Campaign produced no generation jobs.');
    }

    const policy = await deps.service.getGenerationPolicy(jobs[0]);
    const dslSkill = await deps.service.dslSkill(jobs[0]);

    // The agent gets the campaign runner itself, not a copy of it. `validate` below flattens the
    // same result into the strings a fix prompt needs; the toolkit hands over the structured form.
    // One implementation, so the agent's answer and Lanzer's verdict cannot disagree.
    const toolkit: LanzerToolkit = {
        validate: () => deps.runner.validateCampaign(resolved.request),
        grammarReference: async () => {
            const path = policy?.grammarReferencePath;
            if (!path) return undefined;
            try {
                return await readFile(path, 'utf8');
            } catch {
                // The reference is an optimisation for the agent, not a precondition for the run.
                return undefined;
            }
        }
    };

    // The flattened form below feeds fix prompts; the structured form feeds the report. Captured
    // from the same call so the report describes the verdict the run actually acted on, and does
    // not pay for a second validation pass to find out.
    let lastVerdict: LanzerCampaignValidationResult | undefined;
    /** The flattened form of `lastVerdict` alone, so findings added downstream can be told apart. */
    let lastVerdictIssues: string[] = [];

    const validate = async () => {
        const result = await deps.runner.validateCampaign(resolved.request);
        lastVerdict = result;
        const issues: string[] = [];
        for (const doc of result.documents) {
            for (const issue of doc.issues) {
                issues.push(formatLanzerIssue({ uri: doc.uri, ...issue }));
            }
        }
        for (const issue of result.campaign?.issues ?? []) issues.push(issue);
        for (const issue of result.workspace?.issues ?? []) issues.push(issue);
        lastVerdictIssues = [...issues];
        return { ok: result.ok, issues };
    };

    const run = await runLanzerCampaignTaskOverAcp(jobs, {
        command: acp.command,
        args: acp.args,
        cwd: acp.cwd,
        env: acp.env,
        provider: acp.provider,
        model: acp.model,
        effort: acp.effort,
        maxAttempts: acp.maxAttempts,
        fixIterations: acp.fixIterations,
        retryIterations: acp.retryIterations,
        permissions: acp.permissions,
        toolkit,
        policy,
        dslSkill,
        validate,
        progress: acp.progress
    });

    // The campaign runner is not the only judge: `runLanzerCampaignTaskOverAcp` additionally checks
    // that the declared file set is exactly what appeared on disk, and merges that into the run's
    // own verdict. Reporting only the runner's structured result made a run that failed on a stray
    // file read as a clean pass — the generated files really were valid, and the finding that sank
    // the run lived somewhere the report never looked.
    const fileSetIssues = (run.validation?.issues ?? []).filter(
        (issue) => !lastVerdictIssues.includes(issue)
    );

    run.report = await buildLanzerRunReport({
        campaign: resolved.campaign.name,
        jobs,
        run,
        validation: lastVerdict,
        fileSetIssues,
        extraFiles: run.extraFiles,
        ok: run.validation?.ok
    });
    return run;
}

/**
 * Resolve {@link LanzerAcpOptions} from the conventional `LANZER_ACP_*` environment variables,
 * applying `overrides` on top. This defines the env contract once so every CLI shares it:
 *
 * - `LANZER_ACP_COMMAND` (default `claude-agent-acp`)
 * - `LANZER_ACP_ARGS` (JSON array string, e.g. `'["-y","@zed-industries/codex-acp"]'`)
 * - `LANZER_ACP_PROVIDER`, `LANZER_ACP_MODEL`, `LANZER_ACP_EFFORT`
 * - `LANZER_ACP_MAX_ATTEMPTS` (integer, default 2)
 * - `LANZER_ACP_ALLOW` (comma-separated ACP tool kinds, or `all`)
 *
 * `LANZER_ACP_ALLOW` is read literally: naming any kind means the run is limited to exactly
 * those, so widening and narrowing use the same one setting. Leaving it out is what selects the
 * generation baseline — an operator never acquires the shell by saying nothing.
 *
 * Load the `.env` file however you prefer before calling this — e.g. `node --env-file=.env ...`.
 */
export function resolveAcpOptionsFromEnv(overrides: Partial<LanzerAcpOptions> = {}): LanzerAcpOptions {
    const env = process.env;
    let args: string[] | undefined;
    if (env.LANZER_ACP_ARGS) {
        try {
            const parsed = JSON.parse(env.LANZER_ACP_ARGS);
            if (Array.isArray(parsed)) args = parsed.map(String);
        } catch {
            // Ignore malformed LANZER_ACP_ARGS; fall back to no extra args.
        }
    }
    const maxAttemptsRaw = env.LANZER_ACP_MAX_ATTEMPTS;
    const maxAttempts = maxAttemptsRaw ? Number.parseInt(maxAttemptsRaw, 10) : undefined;

    return {
        command: env.LANZER_ACP_COMMAND ?? 'claude-agent-acp',
        args,
        provider: env.LANZER_ACP_PROVIDER,
        model: env.LANZER_ACP_MODEL,
        effort: env.LANZER_ACP_EFFORT,
        maxAttempts: Number.isFinite(maxAttempts) ? maxAttempts : undefined,
        permissions: resolvePermissionPolicy(env.LANZER_ACP_ALLOW),
        ...overrides
    };
}
