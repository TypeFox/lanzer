import type { LanzerAgentRunResult } from '../acp/run.js';
import type { LanzerResolvedCampaign } from '../campaign/model.js';
import { resolveLanzerCampaignFile } from '../campaign/resolve.js';
import { runLanzerCampaign, type LanzerAcpOptions, type RunLanzerCampaignDeps } from './campaign-run.js';
import { runLanzerCampaignRepeatedly, type LanzerRepeatedRunsResult, type LanzerRepeatOptions } from './repeated-runs.js';

export interface RunLanzerCampaignFilesResult {
    /** Every run, in order: one per campaign, or `repeat.runs` per campaign when repeating. */
    runs: LanzerAgentRunResult[];
    /** With repeated runs, each campaign's batch and its pass count. */
    batches?: LanzerRepeatedRunsResult[];
}

/**
 * Run every campaign of several campaign files as one suite, in file order, with a host's services.
 *
 * `createDeps` makes a host's services for one run. It is called afresh for every run: Langium
 * resolves names across every document it has loaded, so two runs, or two campaigns, sharing
 * services could pass on a name only the other defined.
 *
 * Every file is resolved before the first run starts, so a typo in the last file of a suite fails
 * at once rather than after the agent ran for the others; it throws with every file's issues. With
 * `repeat.runs` above one, each campaign runs that many identical times in its own workspace copies
 * (see {@link runLanzerCampaignRepeatedly}).
 */
export async function runLanzerCampaignFiles(
    campaignFiles: string[],
    acp: LanzerAcpOptions,
    createDeps: () => RunLanzerCampaignDeps,
    repeat?: LanzerRepeatOptions
): Promise<RunLanzerCampaignFilesResult> {
    const campaigns: LanzerResolvedCampaign[] = [];
    const problems: string[] = [];
    for (const file of campaignFiles) {
        const resolved = await resolveLanzerCampaignFile(file, { validate: true });
        if (resolved.issues.length > 0) {
            const prefix = campaignFiles.length > 1 ? `${file}: ` : '';
            problems.push(...resolved.issues.map((issue) => `${prefix}[${issue.kind}] ${issue.message}`));
        }
        campaigns.push(...resolved.resolvedCampaigns);
    }
    if (problems.length > 0) {
        throw new Error(`Campaign file is invalid:\n${problems.join('\n')}`);
    }

    if (repeat && repeat.runs > 1) {
        const batches: LanzerRepeatedRunsResult[] = [];
        for (const campaign of campaigns) {
            batches.push(await runLanzerCampaignRepeatedly(campaign, createDeps, acp, repeat));
        }
        return { runs: batches.flatMap((batch) => batch.runs.map((run) => run.result)), batches };
    }

    const runs: LanzerAgentRunResult[] = [];
    for (const campaign of campaigns) {
        runs.push(await runLanzerCampaign(campaign, createDeps(), acp));
    }
    return { runs };
}
