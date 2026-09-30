import { readFile } from 'node:fs/promises';
import { LANZER_RUN_STAGES, type LanzerRunReport, type LanzerRunStage, type LanzerSuiteReport } from './model.js';

/**
 * Below this many runs of a campaign, its pass rate is flagged: one run flipping moves it by more
 * than 20 points, which is as likely noise as a change in the setup.
 */
export const LANZER_SMALL_SAMPLE_RUNS = 5;

/** How one campaign moved between the two reports. */
export type LanzerCampaignChange = 'improved' | 'regressed' | 'unchanged' | 'added' | 'removed';

export interface LanzerCampaignComparison {
    campaign: string;
    change: LanzerCampaignChange;
    /** Absent when the campaign is not in that report. */
    a?: LanzerCampaignSide;
    b?: LanzerCampaignSide;
    /** `b`'s pass rate minus `a`'s, when both have the campaign. */
    passRateDelta?: number;
}

/** One campaign in one report. */
export interface LanzerCampaignSide {
    total: number;
    succeeded: number;
    passRate: number;
    byStage: Partial<Record<LanzerRunStage, number>>;
    /**
     * Failed `validate` calls in each run, in run order. An agent that checks itself fixes its
     * mistakes before the verdict, so two setups with the same pass rate can differ only here.
     */
    failedChecks: number[];
}

/** One side's totals, per run where a sum would reward whichever side ran more. */
export interface LanzerSuiteSide {
    runs: number;
    succeeded: number;
    passRate: number;
    costPerRun?: number;
    costCurrency?: string;
    durationMsPerRun: number;
    tokensPerRun: number;
}

/** A stage's or a diagnostic code's count, as a count and as a share of that side's runs. */
export interface LanzerCountShift {
    name: string;
    a: number;
    b: number;
    /** Per run, so a report with twice the runs does not look twice as bad. */
    aPerRun: number;
    bPerRun: number;
}

/** A setting that differs between the two reports, with every value each side ran with. */
export interface LanzerSetupDifference {
    setting: string;
    a: string[];
    b: string[];
}

export interface LanzerSuiteComparison {
    a: LanzerSuiteSide;
    b: LanzerSuiteSide;
    /** `b`'s pass rate minus `a`'s, over the campaigns both reports ran. */
    passRateDelta: number;
    campaigns: LanzerCampaignComparison[];
    stages: LanzerCountShift[];
    codes: LanzerCountShift[];
    /** What changed between the two setups. Empty when every recorded setting is the same. */
    setup: LanzerSetupDifference[];
    /** Campaigns with fewer than {@link LANZER_SMALL_SAMPLE_RUNS} runs on either side. */
    smallSamples: { campaign: string; a: number; b: number }[];
}

function describeSide(report: LanzerSuiteReport): LanzerSuiteSide {
    const { summary } = report;
    const runs = summary.total;
    return {
        runs,
        succeeded: summary.succeeded,
        passRate: runs === 0 ? 0 : summary.succeeded / runs,
        ...(summary.totalCostAmount !== undefined && runs > 0 ? { costPerRun: summary.totalCostAmount / runs } : {}),
        ...(summary.costCurrency ? { costCurrency: summary.costCurrency } : {}),
        durationMsPerRun: runs === 0 ? 0 : summary.totalDurationMs / runs,
        tokensPerRun: runs === 0 ? 0 : summary.totalTokens / runs
    };
}

/** Failed `validate` calls per run of each campaign, in run order. */
function failedChecksByCampaign(report: LanzerSuiteReport): Record<string, number[]> {
    const byCampaign: Record<string, number[]> = {};
    for (const run of report.runs) {
        const failed = run.toolCalls.filter((call) => call.tool === 'validate' && !call.ok).length;
        (byCampaign[run.campaign] ??= []).push(failed);
    }
    return byCampaign;
}

function compareCampaign(
    campaign: string,
    a: LanzerSuiteReport['summary']['byCampaign'][string] | undefined,
    b: LanzerSuiteReport['summary']['byCampaign'][string] | undefined,
    failedChecks: { a: number[]; b: number[] }
): LanzerCampaignComparison {
    const side = (counts: typeof a, checks: number[]): LanzerCampaignSide | undefined =>
        counts && { ...counts, passRate: counts.total === 0 ? 0 : counts.succeeded / counts.total, failedChecks: checks };
    const sideA = side(a, failedChecks.a);
    const sideB = side(b, failedChecks.b);
    if (!sideA || !sideB) {
        return { campaign, change: sideA ? 'removed' : 'added', ...(sideA ? { a: sideA } : {}), ...(sideB ? { b: sideB } : {}) };
    }
    const passRateDelta = sideB.passRate - sideA.passRate;
    const change = passRateDelta > 0 ? 'improved' : passRateDelta < 0 ? 'regressed' : 'unchanged';
    return { campaign, change, a: sideA, b: sideB, passRateDelta };
}

function shifts(a: Record<string, number>, b: Record<string, number>, runsA: number, runsB: number, order?: readonly string[]): LanzerCountShift[] {
    const names = new Set([...Object.keys(a), ...Object.keys(b)]);
    const list = Array.from(names, (name) => ({
        name,
        a: a[name] ?? 0,
        b: b[name] ?? 0,
        aPerRun: runsA === 0 ? 0 : (a[name] ?? 0) / runsA,
        bPerRun: runsB === 0 ? 0 : (b[name] ?? 0) / runsB
    }));
    if (order) {
        return list.sort((x, y) => order.indexOf(x.name) - order.indexOf(y.name));
    }
    // Largest movement first, then by name, so the same two reports always print the same order.
    return list.sort((x, y) => Math.abs(y.bPerRun - y.aPerRun) - Math.abs(x.bPerRun - x.aPerRun) || x.name.localeCompare(y.name));
}

/** Short enough to read in a table, long enough not to collide by accident. */
function shortHash(hash: string | undefined): string {
    return hash ? hash.slice(0, 12) : '(unreadable)';
}

/**
 * Each setting a run records, as the text two runs would differ by. A setting a report does not
 * record at all reads as `(not recorded)`, so an older report compares rather than failing.
 */
function describeSetup(run: LanzerRunReport): Record<string, string> {
    const configuration = run.configuration;
    const fingerprint = run.fingerprint;
    const notRecorded = '(not recorded)';
    const skill = fingerprint?.skill;
    return {
        agent: configuration?.agent ? `${configuration.agent.name} ${configuration.agent.version}` : notRecorded,
        command: configuration ? [configuration.command, ...configuration.args].join(' ') : notRecorded,
        model: configuration ? configuration.model ?? '(agent default)' : notRecorded,
        effort: configuration ? configuration.effort ?? '(agent default)' : notRecorded,
        'permission mode': configuration ? configuration.permissionMode ?? '(none)' : notRecorded,
        'allowed tool kinds': configuration ? configuration.allowedToolKinds.join(',') : notRecorded,
        'attempt budget': configuration ? `${configuration.fixIterations} fix, ${configuration.retryIterations} retry` : notRecorded,
        skill: !fingerprint ? notRecorded : skill ? `${skill.name ?? skill.path ?? '(unnamed)'} ${shortHash(skill.hash)}` : '(none)',
        'skill path': !fingerprint ? notRecorded : skill?.path ?? '(none)',
        grammars: fingerprint ? fingerprint.grammars.map((grammar) => `${grammar.path.split(/[\\/]/).pop()} ${shortHash(grammar.hash)}`).join(', ') : notRecorded,
        'lanzer version': fingerprint?.lanzerVersion ?? notRecorded
    };
}

/**
 * Every setting on which the two reports' runs differ.
 *
 * Collected as sets per side, not compared run by run: a report may mix setups on purpose, and
 * what matters is whether the two sides ran with anything the other did not. Campaign files are
 * compared per campaign name, since two suites legitimately hold different campaigns.
 */
function compareSetup(a: LanzerSuiteReport, b: LanzerSuiteReport): LanzerSetupDifference[] {
    const collect = (report: LanzerSuiteReport): Map<string, Set<string>> => {
        const settings = new Map<string, Set<string>>();
        const add = (setting: string, value: string) => {
            let values = settings.get(setting);
            if (!values) settings.set(setting, (values = new Set()));
            values.add(value);
        };
        for (const run of report.runs) {
            for (const [setting, value] of Object.entries(describeSetup(run))) add(setting, value);
            const campaign = run.fingerprint?.campaign;
            add(`campaign ${run.campaign}`, campaign ? shortHash(campaign.hash) : '(not recorded)');
        }
        return settings;
    };
    const settingsA = collect(a);
    const settingsB = collect(b);
    const differences: LanzerSetupDifference[] = [];
    for (const [setting, valuesA] of settingsA) {
        const valuesB = settingsB.get(setting);
        // A campaign only one side ran is reported as added or removed, not as a setup change.
        if (!valuesB) continue;
        const same = valuesA.size === valuesB.size && [...valuesA].every((value) => valuesB.has(value));
        if (!same) differences.push({ setting, a: [...valuesA].sort(), b: [...valuesB].sort() });
    }
    return differences;
}

/**
 * Compare two suite reports: `a` is the baseline, `b` the candidate.
 *
 * Gives the raw numbers and what changed between the setups, and flags campaigns with too few
 * runs to read much into. It does not claim significance: with the sample sizes agent runs
 * usually have, a test would mostly say "not enough runs", which the flag already does plainly.
 */
export function compareLanzerSuiteReports(a: LanzerSuiteReport, b: LanzerSuiteReport): LanzerSuiteComparison {
    const sideA = describeSide(a);
    const sideB = describeSide(b);
    const names = Array.from(new Set([...Object.keys(a.summary.byCampaign), ...Object.keys(b.summary.byCampaign)])).sort();
    const checksA = failedChecksByCampaign(a);
    const checksB = failedChecksByCampaign(b);
    const campaigns = names.map((name) =>
        compareCampaign(name, a.summary.byCampaign[name], b.summary.byCampaign[name], { a: checksA[name] ?? [], b: checksB[name] ?? [] }));

    // Over the campaigns both ran: a campaign added to the suite is not the setup getting better.
    const shared = campaigns.filter((campaign) => campaign.a && campaign.b);
    const rate = (pick: 'a' | 'b') => {
        const total = shared.reduce((sum, campaign) => sum + (campaign[pick]?.total ?? 0), 0);
        const succeeded = shared.reduce((sum, campaign) => sum + (campaign[pick]?.succeeded ?? 0), 0);
        return total === 0 ? 0 : succeeded / total;
    };

    return {
        a: sideA,
        b: sideB,
        passRateDelta: rate('b') - rate('a'),
        campaigns,
        stages: shifts(a.summary.byStage, b.summary.byStage, sideA.runs, sideB.runs, LANZER_RUN_STAGES),
        codes: shifts(a.summary.byCode, b.summary.byCode, sideA.runs, sideB.runs),
        setup: compareSetup(a, b),
        smallSamples: shared
            .filter((campaign) => (campaign.a?.total ?? 0) < LANZER_SMALL_SAMPLE_RUNS || (campaign.b?.total ?? 0) < LANZER_SMALL_SAMPLE_RUNS)
            .map((campaign) => ({ campaign: campaign.campaign, a: campaign.a?.total ?? 0, b: campaign.b?.total ?? 0 }))
    };
}

/** Whether a parsed JSON value has the shape of a suite report, for a clear error on a wrong file. */
export function isLanzerSuiteReport(value: unknown): value is LanzerSuiteReport {
    if (typeof value !== 'object' || value === null || !('runs' in value) || !('summary' in value)) return false;
    const { runs, summary } = value;
    return Array.isArray(runs)
        && typeof summary === 'object' && summary !== null
        && 'byCampaign' in summary && typeof summary.byCampaign === 'object' && summary.byCampaign !== null;
}

/** Read a suite report `generate` wrote, or say plainly why the file is not one. */
export async function readLanzerSuiteReport(fileName: string): Promise<LanzerSuiteReport> {
    const text = await readFile(fileName, 'utf8');
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error(`${fileName} is not JSON: pass a report file written by generate.`);
    }
    if (!isLanzerSuiteReport(parsed)) {
        throw new Error(`${fileName} is not a Lanzer suite report: pass a report file written by generate.`);
    }
    return parsed;
}

const MAX_LISTED_CODES = 10;

function percent(share: number): string {
    return `${Math.round(share * 100)}%`;
}

function signedPoints(delta: number): string {
    const points = Math.round(delta * 100);
    return `${points > 0 ? '+' : points < 0 ? '−' : '±'}${Math.abs(points)} pts`;
}

function formatRatio(from: number, to: number, format: (n: number) => string): string {
    if (from === 0) return `${format(from)} → ${format(to)}`;
    const change = Math.round(((to - from) / from) * 100);
    return `${format(from)} → ${format(to)} (${change > 0 ? '+' : change < 0 ? '−' : '±'}${Math.abs(change)}%)`;
}

function formatSeconds(ms: number): string {
    return `${(ms / 1000).toFixed(1)}s`;
}

function formatStages(byStage: Partial<Record<LanzerRunStage, number>> | undefined): string {
    const entries = Object.entries(byStage ?? {});
    return entries.length === 0 ? '' : ` (${entries.map(([stage, count]) => `${count}× ${stage}`).join(', ')})`;
}

/** The comparison as the block `compare` prints: `a` is the baseline, `b` the candidate. */
export function renderLanzerSuiteComparison(comparison: LanzerSuiteComparison, labels: { a: string; b: string } = { a: 'a', b: 'b' }): string {
    const { a, b } = comparison;
    const lines: string[] = [];
    lines.push(`a: ${labels.a}`);
    lines.push(`b: ${labels.b}`);
    lines.push('');

    lines.push('setup:');
    if (comparison.setup.length === 0) {
        lines.push('  the same in both — differences below are run-to-run variation');
    }
    for (const difference of comparison.setup) {
        lines.push(`  ${difference.setting}: ${difference.a.join(' | ')} → ${difference.b.join(' | ')}`);
    }
    lines.push('');

    lines.push(`pass rate: ${a.succeeded}/${a.runs} (${percent(a.passRate)}) → ${b.succeeded}/${b.runs} (${percent(b.passRate)}), ${signedPoints(comparison.passRateDelta)} on shared campaigns`);
    if (a.costPerRun !== undefined || b.costPerRun !== undefined) {
        const currency = b.costCurrency ?? a.costCurrency ?? '';
        const cost = (n: number | undefined) => (n === undefined ? '(not reported)' : `${n.toFixed(4)} ${currency}`.trim());
        lines.push(`cost per run: ${a.costPerRun !== undefined && b.costPerRun !== undefined ? formatRatio(a.costPerRun, b.costPerRun, cost) : `${cost(a.costPerRun)} → ${cost(b.costPerRun)}`}`);
    }
    lines.push(`time per run: ${formatRatio(a.durationMsPerRun, b.durationMsPerRun, formatSeconds)}`);
    lines.push(`tokens per run: ${formatRatio(a.tokensPerRun, b.tokensPerRun, (n) => Math.round(n).toLocaleString('en-US'))}`);
    lines.push('');

    lines.push('by campaign:');
    const width = Math.max(...comparison.campaigns.map((campaign) => campaign.campaign.length), 0);
    for (const campaign of comparison.campaigns) {
        const side = (counts: LanzerCampaignComparison['a']) => (counts ? `${counts.succeeded}/${counts.total}${formatStages(counts.byStage)}` : '—');
        const delta = campaign.passRateDelta !== undefined ? `, ${signedPoints(campaign.passRateDelta)}` : '';
        lines.push(`  ${campaign.campaign.padEnd(width)}  ${side(campaign.a)} → ${side(campaign.b)}  ${campaign.change}${delta}`);
        // Per run rather than summed: one run with 14 failed checks and two with none is a
        // different story from three runs with five each.
        const checks = (counts: LanzerCampaignComparison['a']) => (counts ? counts.failedChecks.join(',') || '—' : '—');
        if ([...(campaign.a?.failedChecks ?? []), ...(campaign.b?.failedChecks ?? [])].some((count) => count > 0)) {
            lines.push(`  ${''.padEnd(width)}  failed checks per run: ${checks(campaign.a)} → ${checks(campaign.b)}`);
        }
    }

    const stages = comparison.stages.filter((stage) => stage.a > 0 || stage.b > 0);
    if (stages.length > 0) {
        lines.push('');
        lines.push('failures by stage (per run):');
        for (const stage of stages) {
            lines.push(`  ${stage.name.padEnd(12)}  ${stage.a} (${percent(stage.aPerRun)}) → ${stage.b} (${percent(stage.bPerRun)})`);
        }
    }

    const codes = comparison.codes.filter((code) => code.a !== code.b);
    if (codes.length > 0) {
        lines.push('');
        lines.push('diagnostic codes that moved (occurrences per run):');
        for (const code of codes.slice(0, MAX_LISTED_CODES)) {
            lines.push(`  ${code.name}: ${code.aPerRun.toFixed(2)} → ${code.bPerRun.toFixed(2)}`);
        }
        if (codes.length > MAX_LISTED_CODES) lines.push(`  … ${codes.length - MAX_LISTED_CODES} more (see --json)`);
    }

    if (comparison.smallSamples.length > 0) {
        lines.push('');
        lines.push(`small samples — fewer than ${LANZER_SMALL_SAMPLE_RUNS} runs, so one run flipping moves the rate by 20+ points:`);
        for (const sample of comparison.smallSamples) {
            lines.push(`  ${sample.campaign}: ${sample.a} run(s) → ${sample.b} run(s)`);
        }
        lines.push('  rerun both setups with --runs to tell a change from noise');
    }

    return lines.join('\n');
}
