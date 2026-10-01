import { NodeFileSystem } from 'langium/node';
import {
    runLanzerCampaignFiles,
    type LanzerAcpOptions,
    type LanzerRepeatOptions,
    type RunLanzerCampaignDeps,
    type RunLanzerCampaignFilesResult
} from 'lanzer';
import { createLanzerLoxServices } from './lox-host.js';
import type { LoxLanzerOptions } from './lox-lanzer-service.js';

/** Every run, and with repeated runs each campaign's batch. See {@link runLanzerCampaignFiles}. */
export type RunLoxCampaignResult = RunLanzerCampaignFilesResult;

/**
 * Lox services for one run. Fresh every time: Langium resolves names across every document it has
 * loaded, so two runs, or two campaigns, sharing services could pass on a name only the other
 * defined.
 */
export function createLoxDeps(options: LoxLanzerOptions = {}): RunLanzerCampaignDeps {
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
 * file, in file order, each run with fresh Lox services. See {@link runLanzerCampaignFiles}.
 */
export async function runLoxCampaignFiles(
    campaignFiles: string[],
    acp: LanzerAcpOptions,
    repeat?: LanzerRepeatOptions,
    options: LoxLanzerOptions = {}
): Promise<RunLoxCampaignResult> {
    return runLanzerCampaignFiles(campaignFiles, acp, () => createLoxDeps(options), repeat);
}
