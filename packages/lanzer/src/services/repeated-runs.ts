import { cp, mkdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { LanzerAgentRunResult } from '../acp/run.js';
import { resolveLanzerCampaign } from '../campaign/map.js';
import type { LanzerResolvedCampaign } from '../campaign/model.js';
import { getCampaignFileAbsolutePath, getCampaignWorkspaceRoot } from '../campaign/paths.js';
import { runLanzerCampaign, type LanzerAcpOptions, type RunLanzerCampaignDeps } from './campaign-run.js';

/** How to repeat a campaign, for {@link runLanzerCampaignRepeatedly}. */
export interface LanzerRepeatOptions {
    /** How many identical runs. */
    runs: number;
    /** How many may be in flight at once. Defaults to one, i.e. one after another. */
    parallel?: number;
    /**
     * The folder the run folders go in. Defaults to `<workspace>.runs/<timestamp>`, beside the
     * workspace rather than in it, so a batch never copies an earlier batch into itself.
     */
    runsRoot?: string;
}

/** One of the repeated runs: which it was, where it worked, and how it went. */
export interface LanzerRepeatedRun {
    /** 1-based. */
    index: number;
    /** The run's own copy of the workspace, kept for inspection. */
    workspace: string;
    result: LanzerAgentRunResult;
}

export interface LanzerRepeatedRunsResult {
    campaign: string;
    /** In run order, whatever order they finished in. */
    runs: LanzerRepeatedRun[];
    passed: number;
    total: number;
}

/**
 * Run the same campaign `runs` times, each in its own copy of the workspace, and count the passes.
 *
 * The point is reliability: one pass says little about an agent that fails one time in three.
 * So every run gets the identical prompt, and nothing is varied between them.
 *
 * Isolation has two halves:
 * - **Files.** Each run works in a copy of the workspace without the campaign's declared generated
 *   files, so it starts clean and cannot read another run's answer. A failed run's files stay put.
 * - **Validation.** Each run gets fresh host services from `createDeps`. Langium resolves names
 *   across every document it has loaded, so runs sharing services could pass on a function only a
 *   different run defined.
 */
export async function runLanzerCampaignRepeatedly(
    resolved: LanzerResolvedCampaign,
    createDeps: () => RunLanzerCampaignDeps,
    acp: LanzerAcpOptions,
    repeat: LanzerRepeatOptions
): Promise<LanzerRepeatedRunsResult> {
    const total = Math.max(Math.floor(repeat.runs), 1);
    const campaign = resolved.campaign;
    const workspace = getCampaignWorkspaceRoot(campaign);
    const runsRoot = resolve(repeat.runsRoot ?? `${workspace}.runs/${new Date().toISOString().replace(/[:.]/g, '-')}`);
    const targets = new Set(campaign.files.map((file) => getCampaignFileAbsolutePath(campaign, file)));

    const runs = await mapWithConcurrency(
        Array.from({ length: total }, (_, i) => i + 1),
        repeat.parallel ?? 1,
        async (index): Promise<LanzerRepeatedRun> => {
            const runWorkspace = join(runsRoot, `run-${index}`);
            await copyWorkspaceWithout(workspace, runWorkspace, targets);
            const runResolved = resolveLanzerCampaign({ ...campaign, workspaceRoot: runWorkspace });
            const label = acp.progress?.label ? `${acp.progress.label} ${index}/${total}` : `${index}/${total}`;
            const result = await runLanzerCampaign(runResolved, createDeps(), {
                ...acp,
                ...(acp.progress ? { progress: { ...acp.progress, label } } : {})
            });
            if (result.report) {
                result.report.repetition = { index, total, workspace: runWorkspace };
            }
            return { index, workspace: runWorkspace, result };
        }
    );

    return {
        campaign: campaign.name,
        runs,
        passed: runs.filter((run) => run.result.report?.ok ?? run.result.validation?.ok ?? false).length,
        total
    };
}

/**
 * Copy `from` to `to`, leaving out `excluded` files. A workspace that does not exist yet is fine:
 * the run starts from an empty folder, as a first run in a fresh workspace would.
 */
async function copyWorkspaceWithout(from: string, to: string, excluded: Set<string>): Promise<void> {
    await mkdir(to, { recursive: true });
    const source = await stat(from).catch(() => undefined);
    if (!source?.isDirectory()) {
        return;
    }
    await cp(from, to, { recursive: true, filter: (path) => !excluded.has(resolve(path)) });
}

/**
 * `fn` over `items`, at most `limit` at a time, with results in the items' order.
 *
 * Exported for its tests: the limit is the one thing the runs themselves cannot show.
 */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index]);
        }
    };
    const workers = Math.min(Math.max(Math.floor(limit), 1), items.length);
    await Promise.all(Array.from({ length: workers }, () => worker()));
    return results;
}

/**
 * The share of runs that must pass, from `--min-pass`: `k/n` (e.g. `2/3`) or a percentage
 * (e.g. `66%`). Absent means all of them.
 */
export function parseMinPass(text: string | undefined): number {
    if (text === undefined) {
        return 1;
    }
    const trimmed = text.trim();
    const fraction = /^(\d+)\s*\/\s*(\d+)$/.exec(trimmed);
    if (fraction && Number(fraction[2]) > 0 && Number(fraction[1]) <= Number(fraction[2])) {
        return Number(fraction[1]) / Number(fraction[2]);
    }
    const percent = /^(\d+(?:\.\d+)?)\s*%$/.exec(trimmed);
    if (percent && Number(percent[1]) <= 100) {
        return Number(percent[1]) / 100;
    }
    throw new Error(`--min-pass must be k/n (e.g. 2/3) or a percentage (e.g. 66%), not "${text}"`);
}

/** Whether `passed` of `total` runs meets a required share, as {@link parseMinPass} gives it. */
export function meetsMinPass(passed: number, total: number, share: number): boolean {
    // Rounded up, so `2/3` of 3 runs needs 2, and a share of 1 needs every run. The epsilon keeps
    // floating-point shares like 2/3 * 3 from landing just above a whole number.
    return passed >= Math.ceil(share * total - 1e-9);
}
