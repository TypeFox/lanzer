import { NodeFileSystem } from 'langium/node';
import {
    resolveLanzerCampaignFile,
    runLanzerCampaign,
    type LanzerAcpOptions,
    type LanzerAgentRunResult,
    type LanzerCampaignRunner,
    type LanzerService
} from 'lanzer';
import { createLanzerLoxServices } from '../lox-module.js';

export interface RunLoxCampaignResult {
    /** One result per resolved campaign in the file (campaigns run sequentially). */
    runs: LanzerAgentRunResult[];
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
 * Campaigns run **sequentially**; batching/concurrency over multiple files is left to the caller.
 * If the campaign file fails to parse/resolve, this throws with the collected issues.
 */
export async function runLoxCampaignFile(
    campaignFile: string,
    acp: LanzerAcpOptions
): Promise<RunLoxCampaignResult> {
    const resolved = await resolveLanzerCampaignFile(campaignFile, { validate: true });
    if (resolved.issues.length > 0) {
        const detail = resolved.issues.map((issue) => `[${issue.kind}] ${issue.message}`).join('\n');
        throw new Error(`Campaign file is invalid:\n${detail}`);
    }

    const { Lanzer } = createLanzerLoxServices(NodeFileSystem);
    const service: LanzerService = Lanzer.lanzer.Lanzer;
    const runner: LanzerCampaignRunner = Lanzer.lanzer.CampaignRunner;

    const runs: LanzerAgentRunResult[] = [];
    for (const campaign of resolved.resolvedCampaigns) {
        runs.push(await runLanzerCampaign(campaign, { service, runner }, acp));
    }
    return { runs };
}
