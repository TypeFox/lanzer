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
    /** Absent when no run of the campaign reported a cost. */
    costPerRun?: LanzerSpread;
    durationMsPerRun: LanzerSpread;
    tokensPerRun: LanzerSpread;
    /**
     * Some runs passed and some failed. Identical runs disagreeing means the campaign's
     * instructions or checks leave room for chance, and its pass rate is a coin weighted by it.
     */
    flaky: boolean;
}

/**
 * A mean and how far single runs stray from it: the sample standard deviation, 0 for one run. A
 * total alone cannot tell three similar runs from one expensive run and two cheap ones.
 */
export interface LanzerSpread {
    mean: number;
    stddev: number;
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

/** What each run of a campaign cost and how it went, in run order. */
interface CampaignRuns {
    failedChecks: number[];
    costs: number[];
    durations: number[];
    tokens: number[];
}

/** Each campaign's runs, measured one by one, in run order. */
function runsByCampaign(report: LanzerSuiteReport): Record<string, CampaignRuns> {
    const byCampaign: Record<string, CampaignRuns> = {};
    for (const run of report.runs) {
        const runs = (byCampaign[run.campaign] ??= { failedChecks: [], costs: [], durations: [], tokens: [] });
        runs.failedChecks.push(run.toolCalls.filter((call) => call.tool === 'validate' && !call.ok).length);
        if (run.usage.costAmount !== undefined) runs.costs.push(run.usage.costAmount);
        runs.durations.push(run.durationMs);
        runs.tokens.push(run.usage.totalTokens);
    }
    return byCampaign;
}

/** Mean and sample standard deviation; one value has no spread, and none gives zeroes. */
export function spreadOf(values: number[]): LanzerSpread {
    if (values.length === 0) return { mean: 0, stddev: 0 };
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    if (values.length === 1) return { mean, stddev: 0 };
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
    return { mean, stddev: Math.sqrt(variance) };
}

function describeCampaignSide(counts: LanzerSuiteReport['summary']['byCampaign'][string], runs: CampaignRuns | undefined): LanzerCampaignSide {
    const measured = runs ?? { failedChecks: [], costs: [], durations: [], tokens: [] };
    return {
        ...counts,
        passRate: counts.total === 0 ? 0 : counts.succeeded / counts.total,
        failedChecks: measured.failedChecks,
        ...(measured.costs.length > 0 ? { costPerRun: spreadOf(measured.costs) } : {}),
        durationMsPerRun: spreadOf(measured.durations),
        tokensPerRun: spreadOf(measured.tokens),
        flaky: counts.succeeded > 0 && counts.succeeded < counts.total
    };
}

function compareCampaign(
    campaign: string,
    a: LanzerSuiteReport['summary']['byCampaign'][string] | undefined,
    b: LanzerSuiteReport['summary']['byCampaign'][string] | undefined,
    runs: { a: CampaignRuns | undefined; b: CampaignRuns | undefined }
): LanzerCampaignComparison {
    const sideA = a && describeCampaignSide(a, runs.a);
    const sideB = b && describeCampaignSide(b, runs.b);
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
        'lanzer version': fingerprint?.lanzerVersion ?? notRecorded,
        'host policy': fingerprint?.policyHash ? shortHash(fingerprint.policyHash) : !fingerprint?.promptHash ? notRecorded : '(none)',
        isolated: configuration?.isolated === undefined ? notRecorded : configuration.isolated ? 'yes' : 'no'
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
            // Per campaign, like the file: the prompt carries the campaign's own text. A change here
            // with the campaign file unchanged is the host's advice or Lanzer's template moving.
            add(`prompt ${run.campaign}`, run.fingerprint?.promptHash ? shortHash(run.fingerprint.promptHash) : '(not recorded)');
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
    const runsA = runsByCampaign(a);
    const runsB = runsByCampaign(b);
    const campaigns = names.map((name) =>
        compareCampaign(name, a.summary.byCampaign[name], b.summary.byCampaign[name], { a: runsA[name], b: runsB[name] }));

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

/** `to` against `from` in percent, signed; empty when `from` is zero and a ratio means nothing. */
function relativeChange(from: number, to: number): string {
    if (from === 0) return '';
    const change = Math.round(((to - from) / from) * 100);
    return `${change > 0 ? '+' : change < 0 ? '−' : '±'}${Math.abs(change)}%`;
}

function formatSeconds(ms: number): string {
    return `${(ms / 1000).toFixed(1)}s`;
}

function formatStages(byStage: Partial<Record<LanzerRunStage, number>> | undefined): string {
    const entries = Object.entries(byStage ?? {});
    return entries.length === 0 ? '' : ` (${entries.map(([stage, count]) => `${count}× ${stage}`).join(', ')})`;
}

/**
 * Rows as aligned columns, two spaces apart, the first row a header. `right` names the columns
 * holding numbers, which read best right-aligned. Any number of columns, so a comparison of more
 * than two reports needs no other layout.
 */
function renderTable(rows: string[][], right: ReadonlySet<number> = new Set()): string[] {
    const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => (row[column] ?? '').length)));
    return rows.map((row) =>
        `  ${row.map((cell, column) => (right.has(column) ? cell.padStart(widths[column]) : cell.padEnd(widths[column]))).join('  ')}`.trimEnd()
    );
}

/** A spread as `mean ± sd`, in one unit. */
function formatSpread(spread: LanzerSpread | undefined, format: (n: number) => string): string {
    return spread ? `${format(spread.mean)} ± ${format(spread.stddev)}` : '—';
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

    const currency = b.costCurrency ?? a.costCurrency ?? '';
    const cost = (n: number | undefined) => (n === undefined ? '(not reported)' : `${n.toFixed(4)} ${currency}`.trim());
    const tokens = (n: number) => Math.round(n).toLocaleString('en-US');
    const perRun: string[][] = [
        ['', 'a', 'b', 'change'],
        ['pass rate', `${a.succeeded}/${a.runs} (${percent(a.passRate)})`, `${b.succeeded}/${b.runs} (${percent(b.passRate)})`, signedPoints(comparison.passRateDelta)]
    ];
    if (a.costPerRun !== undefined || b.costPerRun !== undefined) {
        perRun.push(['cost per run', cost(a.costPerRun), cost(b.costPerRun), a.costPerRun !== undefined && b.costPerRun !== undefined ? relativeChange(a.costPerRun, b.costPerRun) : '']);
    }
    perRun.push(['time per run', formatSeconds(a.durationMsPerRun), formatSeconds(b.durationMsPerRun), relativeChange(a.durationMsPerRun, b.durationMsPerRun)]);
    perRun.push(['tokens per run', tokens(a.tokensPerRun), tokens(b.tokensPerRun), relativeChange(a.tokensPerRun, b.tokensPerRun)]);
    lines.push(...renderTable(perRun, new Set([1, 2, 3])));
    // Said only when it matters: a campaign one side ran alone would otherwise move the headline.
    if (comparison.campaigns.some((campaign) => !campaign.a || !campaign.b)) {
        lines.push('  the pass-rate change counts only the campaigns both reports ran');
    }
    lines.push('');

    lines.push('by campaign:');
    const outcome = (counts: LanzerCampaignComparison['a']) => (counts ? `${counts.succeeded}/${counts.total}${formatStages(counts.byStage)}` : '—');
    const checks = (counts: LanzerCampaignComparison['a']) => (counts ? counts.failedChecks.join(',') || '—' : '—');
    // Per run rather than summed: one run with 14 failed checks and two with none is a different
    // story from three runs with five each. The column is left out when no run had any.
    const showChecks = comparison.campaigns.some((campaign) =>
        [...(campaign.a?.failedChecks ?? []), ...(campaign.b?.failedChecks ?? [])].some((count) => count > 0));
    const outcomes: string[][] = [['campaign', 'a', 'b', 'change', ...(showChecks ? ['failed checks per run'] : [])]];
    for (const campaign of comparison.campaigns) {
        const change = campaign.passRateDelta !== undefined ? `${campaign.change} ${signedPoints(campaign.passRateDelta)}` : campaign.change;
        outcomes.push([campaign.campaign, outcome(campaign.a), outcome(campaign.b), change, ...(showChecks ? [`${checks(campaign.a)} → ${checks(campaign.b)}`] : [])]);
    }
    lines.push(...renderTable(outcomes));
    lines.push('');

    lines.push('per run, by campaign (mean ± sd):');
    const costs: string[][] = [['campaign', 'cost a', 'cost b', 'time a', 'time b', 'tokens a', 'tokens b']];
    const money = (n: number) => n.toFixed(3);
    const seconds = (n: number) => `${(n / 1000).toFixed(1)}s`;
    const thousands = (n: number) => `${Math.round(n / 1000)}k`;
    for (const campaign of comparison.campaigns) {
        costs.push([
            campaign.campaign,
            formatSpread(campaign.a?.costPerRun, money),
            formatSpread(campaign.b?.costPerRun, money),
            formatSpread(campaign.a?.durationMsPerRun, seconds),
            formatSpread(campaign.b?.durationMsPerRun, seconds),
            formatSpread(campaign.a?.tokensPerRun, thousands),
            formatSpread(campaign.b?.tokensPerRun, thousands)
        ]);
    }
    lines.push(...renderTable(costs, new Set([1, 2, 3, 4, 5, 6])));

    const stages = comparison.stages.filter((stage) => stage.a > 0 || stage.b > 0);
    if (stages.length > 0) {
        lines.push('');
        lines.push('failures by stage (share of runs):');
        lines.push(...renderTable([
            ['stage', 'a', 'b'],
            ...stages.map((stage) => [stage.name, `${stage.a} (${percent(stage.aPerRun)})`, `${stage.b} (${percent(stage.bPerRun)})`])
        ], new Set([1, 2])));
    }

    const codes = comparison.codes.filter((code) => code.a !== code.b);
    if (codes.length > 0) {
        lines.push('');
        lines.push('diagnostic codes that moved (occurrences per run):');
        lines.push(...renderTable([
            ['code', 'a', 'b'],
            ...codes.slice(0, MAX_LISTED_CODES).map((code) => [code.name, code.aPerRun.toFixed(2), code.bPerRun.toFixed(2)])
        ], new Set([1, 2])));
        if (codes.length > MAX_LISTED_CODES) lines.push(`  … ${codes.length - MAX_LISTED_CODES} more (see --json)`);
    }

    const flaky = comparison.campaigns.filter((campaign) => campaign.a?.flaky || campaign.b?.flaky);
    if (flaky.length > 0) {
        lines.push('');
        lines.push('flaky — identical runs split between pass and fail, so chance moves these pass rates:');
        for (const campaign of flaky) {
            const sides = [campaign.a?.flaky ? `a ${outcome(campaign.a)}` : '', campaign.b?.flaky ? `b ${outcome(campaign.b)}` : ''].filter(Boolean);
            lines.push(`  ${campaign.campaign}: ${sides.join(', ')}`);
        }
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
