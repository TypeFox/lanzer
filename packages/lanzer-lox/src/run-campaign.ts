import { NodeFileSystem } from 'langium/node';
import {
    resolveLanzerCampaignFile,
    runLanzerCampaign,
    runLanzerCampaignRepeatedly,
    type LanzerAcpOptions,
    type LanzerAgentRunResult,
    type LanzerRepeatedRunsResult,
    type LanzerRepeatOptions,
    type RunLanzerCampaignDeps
} from 'lanzer';
import { createLanzerLoxServices } from './lox-host.js';

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
function createLoxDeps(): RunLanzerCampaignDeps {
    const { Lanzer } = createLanzerLoxServices(NodeFileSystem);
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
    repeat?: LanzerRepeatOptions
): Promise<RunLoxCampaignResult> {
    const resolved = await resolveLanzerCampaignFile(campaignFile, { validate: true });
    if (resolved.issues.length > 0) {
        const detail = resolved.issues.map((issue) => `[${issue.kind}] ${issue.message}`).join('\n');
        throw new Error(`Campaign file is invalid:\n${detail}`);
    }

    if (repeat && repeat.runs > 1) {
        const batches: LanzerRepeatedRunsResult[] = [];
        for (const campaign of resolved.resolvedCampaigns) {
            batches.push(await runLanzerCampaignRepeatedly(campaign, createLoxDeps, acp, repeat));
        }
        return { runs: batches.flatMap((batch) => batch.runs.map((run) => run.result)), batches };
    }

    const runs: LanzerAgentRunResult[] = [];
    for (const campaign of resolved.resolvedCampaigns) {
        runs.push(await runLanzerCampaign(campaign, createLoxDeps(), acp));
    }
    return { runs };
}
