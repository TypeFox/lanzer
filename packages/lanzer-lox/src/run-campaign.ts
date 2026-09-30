import { NodeFileSystem } from 'langium/node';
import {
    resolveLanzerCampaignFile,
    runLanzerCampaign,
    runLanzerCampaignRepeatedly,
    type LanzerAcpOptions,
    type LanzerAgentRunResult,
    type LanzerRepeatedRunsResult,
    type LanzerRepeatOptions,
    type LanzerResolvedCampaign,
    type RunLanzerCampaignDeps
} from 'lanzer';
import { createLanzerLoxServices } from './lox-host.js';
import type { LoxLanzerOptions } from './lox-lanzer-service.js';

export interface RunLoxCampaignResult {
    /** Every run, in order: one per campaign, or `repeat.runs` per campaign when repeating. */
    runs: LanzerAgentRunResult[];
    /** With repeated runs, each campaign's batch and its pass count. */
    batches?: LanzerRepeatedRunsResult[];
}

/**
 * Lox services for one run. Fresh every time: Langium resolves names across every document it has
 * loaded, so two runs, or two campaigns, sharing services could pass on a name only the other
 * defined.
 */
function createLoxDeps(options: LoxLanzerOptions = {}): RunLanzerCampaignDeps {
    const { Lanzer } = createLanzerLoxServices(NodeFileSystem, options);
    return { service: Lanzer.lanzer.Lanzer, runner: Lanzer.lanzer.CampaignRunner };
}

/**
 * **Lox fast path.** Resolve a `.lanzer` campaign file and run each campaign it declares against
 * an agent over ACP, using the Lox-aware Lanzer services.
 *
 * This is the one-call convenience a Lox CLI plugs into: it builds the combined
 * {@link createLanzerLoxServices} container (so the Lox generation policy and the `write-lox`
 * skill are applied, and generated `.lox` files are validated against the campaign requirements
 * by the Lox campaign runner), then delegates the per-campaign orchestration to the host-agnostic
 * {@link runLanzerCampaign}.
 *
 * Campaigns run **sequentially**, each with fresh Lox services. With `repeat.runs` above one, each
 * campaign runs that many identical times in its own workspace copies (see
 * {@link runLanzerCampaignRepeatedly}), `repeat.parallel` at a time.
 * If the campaign file fails to parse/resolve, this throws with the collected issues.
 */
export async function runLoxCampaignFile(
    campaignFile: string,
    acp: LanzerAcpOptions,
    repeat?: LanzerRepeatOptions,
    options?: LoxLanzerOptions
): Promise<RunLoxCampaignResult> {
    return runLoxCampaignFiles([campaignFile], acp, repeat, options);
}

/**
 * {@link runLoxCampaignFile} over several campaign files, as one suite: every campaign of every
 * file, in file order.
 *
 * Every file is resolved before the first run starts, so a typo in the last file of a suite fails
 * at once rather than after the agent runs for the others. It throws with every file's issues.
 */
export async function runLoxCampaignFiles(
    campaignFiles: string[],
    acp: LanzerAcpOptions,
    repeat?: LanzerRepeatOptions,
    options: LoxLanzerOptions = {}
): Promise<RunLoxCampaignResult> {
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

    const createDeps = () => createLoxDeps(options);
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
