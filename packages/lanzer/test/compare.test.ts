import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { LanzerRunConfiguration } from '../src/acp/run.js';
import { buildLanzerSuiteReport } from '../src/report/build.js';
import { compareLanzerSuiteReports, readLanzerSuiteReport, renderLanzerSuiteComparison } from '../src/report/compare.js';
import type { LanzerRunFingerprint, LanzerRunReport, LanzerRunStage } from '../src/report/model.js';

const CONFIGURATION: LanzerRunConfiguration = {
    transport: 'acp',
    command: 'claude-agent-acp',
    args: [],
    agent: { name: 'claude-agent', version: '1.0.0' },
    model: 'sonnet',
    permissionMode: 'acceptEdits',
    allowedToolKinds: ['edit', 'read'],
    fixIterations: 1,
    retryIterations: 1
};

const FINGERPRINT: LanzerRunFingerprint = {
    lanzerVersion: '0.0.1',
    skill: { name: 'write-lox', path: '/skills/write-lox', hash: 'a'.repeat(64) },
    grammars: [{ path: '/grammars/lox.langium', hash: 'b'.repeat(64) }],
    campaign: { path: '/bench/stack.lanzer', hash: 'c'.repeat(64) }
};

/** A run report with only what a comparison reads filled in. */
function run(campaign: string, stage?: LanzerRunStage, overrides: Partial<LanzerRunReport> = {}): LanzerRunReport {
    return {
        campaign,
        ok: stage === undefined,
        ...(stage ? { failedStage: stage } : {}),
        attempts: 1,
        stopReason: 'end_turn',
        durationMs: 10_000,
        sessionId: 's',
        configuration: CONFIGURATION,
        fingerprint: FINGERPRINT,
        files: [],
        issues: { total: 0, byCode: {}, byKind: {} },
        documents: [],
        negativeFiles: [],
        campaignIssues: [],
        workspaceIssues: [],
        behaviourIssues: [],
        extraFiles: [],
        toolCalls: [],
        deniedToolCalls: [],
        usage: { totalTokens: 1000, inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, costAmount: 0.1, costCurrency: 'USD' },
        attemptLog: [],
        events: { compactions: 0, unhandledUpdates: 0 },
        ...overrides
    };
}

function suite(...runs: LanzerRunReport[]) {
    return buildLanzerSuiteReport(runs, '2026-09-30T00:00:00Z');
}

describe('compareLanzerSuiteReports', () => {
    test('reports each campaign as improved, regressed, unchanged, added or removed', () => {
        const a = suite(run('stack', 'syntax'), run('math'), run('shapes', 'semantics'), run('dropped'));
        const b = suite(run('stack'), run('math', 'behaviour'), run('shapes', 'semantics'), run('added'));
        const comparison = compareLanzerSuiteReports(a, b);
        expect(Object.fromEntries(comparison.campaigns.map((campaign) => [campaign.campaign, campaign.change]))).toEqual({
            added: 'added',
            dropped: 'removed',
            math: 'regressed',
            shapes: 'unchanged',
            stack: 'improved'
        });
        expect(comparison.campaigns.find((campaign) => campaign.campaign === 'stack')?.passRateDelta).toBe(1);
    });

    test('computes the pass-rate delta over the campaigns both reports ran', () => {
        // `added` passing in b is not the setup getting better: only `stack` counts, 1/2 → 2/2.
        const a = suite(run('stack'), run('stack', 'syntax'));
        const b = suite(run('stack'), run('stack'), run('added'));
        expect(compareLanzerSuiteReports(a, b).passRateDelta).toBe(0.5);
    });

    test('gives cost, time and tokens per run, so a larger report does not look worse', () => {
        const a = suite(run('stack'));
        const b = suite(
            run('stack', undefined, { durationMs: 20_000, usage: { ...run('x').usage, costAmount: 0.3, totalTokens: 3000 } }),
            run('stack', undefined, { durationMs: 20_000, usage: { ...run('x').usage, costAmount: 0.1, totalTokens: 1000 } })
        );
        const { a: sideA, b: sideB } = compareLanzerSuiteReports(a, b);
        expect(sideA).toMatchObject({ runs: 1, costPerRun: 0.1, durationMsPerRun: 10_000, tokensPerRun: 1000 });
        expect(sideB).toMatchObject({ runs: 2, costPerRun: 0.2, durationMsPerRun: 20_000, tokensPerRun: 2000 });
    });

    test('shifts failures between stages, per run, in pipeline order', () => {
        const a = suite(run('stack', 'syntax'), run('stack', 'syntax'));
        const b = suite(run('stack', 'semantics'), run('stack'));
        expect(compareLanzerSuiteReports(a, b).stages).toEqual([
            { name: 'syntax', a: 2, b: 0, aPerRun: 1, bPerRun: 0 },
            { name: 'semantics', a: 0, b: 1, aPerRun: 0, bPerRun: 0.5 }
        ]);
    });

    test('names what changed between the setups, and nothing when the setup is the same', () => {
        const same = compareLanzerSuiteReports(suite(run('stack')), suite(run('stack', 'syntax')));
        expect(same.setup).toEqual([]);

        const newSkill = { ...FINGERPRINT, skill: { ...FINGERPRINT.skill, hash: 'd'.repeat(64) } };
        const changed = compareLanzerSuiteReports(
            suite(run('stack')),
            suite(run('stack', undefined, { fingerprint: newSkill, configuration: { ...CONFIGURATION, model: 'opus' } }))
        );
        expect(changed.setup).toEqual([
            { setting: 'model', a: ['sonnet'], b: ['opus'] },
            { setting: 'skill', a: [`write-lox ${'a'.repeat(12)}`], b: [`write-lox ${'d'.repeat(12)}`] }
        ]);
    });

    test('notices the host policy changing while the skill stays the same', () => {
        const before = { ...FINGERPRINT, promptHash: 'p'.repeat(64), policyHash: 'q'.repeat(64) };
        const after = { ...FINGERPRINT, promptHash: 'r'.repeat(64), policyHash: 's'.repeat(64) };
        const comparison = compareLanzerSuiteReports(
            suite(run('stack', undefined, { fingerprint: before })),
            suite(run('stack', undefined, { fingerprint: after }))
        );
        expect(comparison.setup).toEqual([
            { setting: 'host policy', a: ['q'.repeat(12)], b: ['s'.repeat(12)] },
            { setting: 'prompt stack', a: ['p'.repeat(12)], b: ['r'.repeat(12)] }
        ]);
    });

    test('notices one side running isolated', () => {
        const comparison = compareLanzerSuiteReports(
            suite(run('stack', undefined, { configuration: { ...CONFIGURATION, isolated: false } })),
            suite(run('stack', undefined, { configuration: { ...CONFIGURATION, isolated: true } }))
        );
        expect(comparison.setup).toEqual([{ setting: 'isolated', a: ['no'], b: ['yes'] }]);
    });

    test('notices a campaign file edited between the two reports', () => {
        const edited = { ...FINGERPRINT, campaign: { path: '/bench/stack.lanzer', hash: 'e'.repeat(64) } };
        const comparison = compareLanzerSuiteReports(suite(run('stack')), suite(run('stack', undefined, { fingerprint: edited })));
        expect(comparison.setup).toEqual([{ setting: 'campaign stack', a: ['c'.repeat(12)], b: ['e'.repeat(12)] }]);
    });

    test('compares a report from before fingerprints, marking what it did not record', () => {
        const old = suite(run('stack', undefined, { fingerprint: undefined }));
        const setup = compareLanzerSuiteReports(old, suite(run('stack'))).setup;
        expect(setup.find((difference) => difference.setting === 'skill')).toEqual({
            setting: 'skill', a: ['(not recorded)'], b: [`write-lox ${'a'.repeat(12)}`]
        });
    });

    test('flags campaigns with fewer than five runs on either side', () => {
        const five = Array.from({ length: 5 }, () => run('stack'));
        const comparison = compareLanzerSuiteReports(suite(...five, run('math')), suite(...five, run('math'), run('math')));
        expect(comparison.smallSamples).toEqual([{ campaign: 'math', a: 1, b: 2 }]);
    });
});

describe('failed checks during the run', () => {
    /** A `validate` call record: failed or passed. */
    const check = (ok: boolean) => ({ tool: 'validate', startedAtMs: 0, durationMs: 1, ok, codes: [], issueCount: ok ? 0 : 1 });
    /** A passing run whose agent checked itself: `failed` failed calls, then a passing one. */
    const struggled = (campaign: string, failed: number) =>
        run(campaign, undefined, { toolCalls: [...Array.from({ length: failed }, () => check(false)), check(true)] });

    test('are counted per run, in run order, for each campaign', () => {
        const comparison = compareLanzerSuiteReports(
            suite(struggled('math', 8), struggled('math', 3), struggled('stack', 0)),
            suite(struggled('math', 0), struggled('math', 1), struggled('stack', 0))
        );
        const math = comparison.campaigns.find((campaign) => campaign.campaign === 'math');
        expect(math?.a?.failedChecks).toEqual([8, 3]);
        expect(math?.b?.failedChecks).toEqual([0, 1]);
        // Same pass rate: the checks are where the two setups differ.
        expect(math?.change).toBe('unchanged');
    });

    test('get a column, one entry per run, when any run of either side had one', () => {
        const text = renderLanzerSuiteComparison(compareLanzerSuiteReports(
            suite(struggled('math', 8), struggled('stack', 0)),
            suite(struggled('math', 0), struggled('stack', 0))
        ));
        expect(text).toMatch(/campaign\s+a\s+b\s+change\s+failed checks per run/);
        expect(text).toMatch(/math\s+1\/1\s+1\/1\s+unchanged ±0 pts\s+8 → 0/);
        expect(text).toMatch(/stack\s+1\/1\s+1\/1\s+unchanged ±0 pts\s+0 → 0/);
    });

    test('get no column when no run had one', () => {
        const text = renderLanzerSuiteComparison(compareLanzerSuiteReports(suite(struggled('stack', 0)), suite(struggled('stack', 0))));
        expect(text).not.toContain('failed checks');
    });
});

describe('cost, time and tokens per campaign', () => {
    /** A run of `campaign` that took `seconds` and cost `cost`. */
    const timed = (campaign: string, seconds: number, cost: number, stage?: LanzerRunStage) =>
        run(campaign, stage, { durationMs: seconds * 1000, usage: { ...run('x').usage, costAmount: cost, totalTokens: seconds * 1000 } });

    test('are given per run as mean and sample standard deviation', () => {
        const comparison = compareLanzerSuiteReports(
            suite(timed('math', 10, 0.1), timed('math', 30, 0.3), timed('stack', 5, 0.05)),
            suite(timed('math', 20, 0.2), timed('math', 20, 0.2), timed('stack', 5, 0.05))
        );
        const math = comparison.campaigns.find((campaign) => campaign.campaign === 'math');
        expect(math?.a?.durationMsPerRun.mean).toBe(20_000);
        expect(math?.a?.durationMsPerRun.stddev).toBeCloseTo(Math.SQRT2 * 10_000);
        expect(math?.a?.costPerRun?.mean).toBeCloseTo(0.2);
        // Same mean, no spread: the totals alone would call these two sides identical.
        expect(math?.b?.durationMsPerRun).toEqual({ mean: 20_000, stddev: 0 });
        expect(math?.b?.tokensPerRun).toEqual({ mean: 20_000, stddev: 0 });
    });

    test('have no spread for a single run, and no cost when none was reported', () => {
        const unpriced = run('stack', undefined, { usage: { ...run('x').usage, costAmount: undefined } });
        const [stack] = compareLanzerSuiteReports(suite(unpriced), suite(unpriced)).campaigns;
        expect(stack.a?.durationMsPerRun).toEqual({ mean: 10_000, stddev: 0 });
        expect(stack.a).not.toHaveProperty('costPerRun');
    });

    test('are printed as a table, one row per campaign', () => {
        const text = renderLanzerSuiteComparison(compareLanzerSuiteReports(
            suite(timed('math', 10, 0.1), timed('math', 30, 0.3)),
            suite(timed('math', 20, 0.2), timed('math', 20, 0.2))
        ));
        expect(text).toContain('per run, by campaign (mean ± sd):');
        expect(text).toMatch(/math\s+0\.200 ± 0\.141\s+0\.200 ± 0\.000\s+20\.0s ± 14\.1s\s+20\.0s ± 0\.0s\s+20k ± 14k\s+20k ± 0k/);
    });
});

describe('flaky campaigns', () => {
    test('are those whose runs split between pass and fail, on either side', () => {
        const comparison = compareLanzerSuiteReports(
            suite(run('math'), run('math', 'syntax'), run('stack'), run('stack')),
            suite(run('math'), run('math'), run('stack', 'syntax'), run('stack', 'syntax'))
        );
        const flaky = Object.fromEntries(comparison.campaigns.map((campaign) => [campaign.campaign, [campaign.a?.flaky, campaign.b?.flaky]]));
        // Always failing is not flaky: the runs agree.
        expect(flaky).toEqual({ math: [true, false], stack: [false, false] });
        const text = renderLanzerSuiteComparison(comparison);
        const section = text.slice(text.indexOf('flaky —')).split('\n\n')[0];
        expect(section).toContain('  math: a 1/2 (1× syntax)');
        expect(section).not.toContain('stack');
    });

    test('get no section when every campaign\'s runs agree', () => {
        expect(renderLanzerSuiteComparison(compareLanzerSuiteReports(suite(run('math')), suite(run('math', 'syntax'))))).not.toContain('flaky');
    });
});

describe('renderLanzerSuiteComparison', () => {
    test('prints the setup change, rates, per-campaign lines, stage shifts and the small-sample note', () => {
        const newSkill = { ...FINGERPRINT, skill: { ...FINGERPRINT.skill, hash: 'd'.repeat(64) } };
        const a = suite(run('stack', 'syntax', { issues: { total: 2, byCode: { LOX_PARSER_ERROR: 2 }, byKind: {} } }), run('math'));
        const b = suite(run('stack', undefined, { fingerprint: newSkill }), run('math', undefined, { fingerprint: newSkill }));
        const text = renderLanzerSuiteComparison(compareLanzerSuiteReports(a, b), { a: 'v1.json', b: 'v2.json' });
        expect(text).toContain(`skill: write-lox ${'a'.repeat(12)} → write-lox ${'d'.repeat(12)}`);
        expect(text).toMatch(/pass rate\s+1\/2 \(50%\)\s+2\/2 \(100%\)\s+\+50 pts/);
        expect(text).toMatch(/cost per run\s+0\.1000 USD\s+0\.1000 USD\s+±0%/);
        expect(text).toMatch(/stack\s+0\/1 \(1× syntax\)\s+1\/1\s+improved \+100 pts/);
        expect(text).toMatch(/syntax\s+1 \(50%\)\s+0 \(0%\)/);
        expect(text).toMatch(/LOX_PARSER_ERROR\s+1\.00\s+0\.00/);
        // Both reports ran the same campaigns, so the headline needs no caveat.
        expect(text).not.toContain('counts only the campaigns both reports ran');
        expect(text).toContain('rerun both setups with --runs');
    });

    test('says so when the setups are the same', () => {
        const text = renderLanzerSuiteComparison(compareLanzerSuiteReports(suite(run('stack')), suite(run('stack'))));
        expect(text).toContain('the same in both — differences below are run-to-run variation');
    });
});

describe('readLanzerSuiteReport', () => {
    test('reads a report and rejects files that are not one', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'lanzer-compare-'));
        const good = join(dir, 'good.json');
        await writeFile(good, JSON.stringify(suite(run('stack'))), 'utf8');
        await writeFile(join(dir, 'other.json'), '{"ok": true}', 'utf8');
        await writeFile(join(dir, 'broken.json'), 'not json', 'utf8');
        expect((await readLanzerSuiteReport(good)).runs).toHaveLength(1);
        await expect(readLanzerSuiteReport(join(dir, 'other.json'))).rejects.toThrow(/is not a Lanzer suite report/);
        await expect(readLanzerSuiteReport(join(dir, 'broken.json'))).rejects.toThrow(/is not JSON/);
    });
});
