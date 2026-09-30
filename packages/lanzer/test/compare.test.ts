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

describe('renderLanzerSuiteComparison', () => {
    test('prints the setup change, rates, per-campaign lines, stage shifts and the small-sample note', () => {
        const newSkill = { ...FINGERPRINT, skill: { ...FINGERPRINT.skill, hash: 'd'.repeat(64) } };
        const a = suite(run('stack', 'syntax', { issues: { total: 2, byCode: { LOX_PARSER_ERROR: 2 }, byKind: {} } }), run('math'));
        const b = suite(run('stack', undefined, { fingerprint: newSkill }), run('math', undefined, { fingerprint: newSkill }));
        const text = renderLanzerSuiteComparison(compareLanzerSuiteReports(a, b), { a: 'v1.json', b: 'v2.json' });
        expect(text).toContain(`skill: write-lox ${'a'.repeat(12)} → write-lox ${'d'.repeat(12)}`);
        expect(text).toContain('pass rate: 1/2 (50%) → 2/2 (100%), +50 pts on shared campaigns');
        expect(text).toContain('cost per run: 0.1000 USD → 0.1000 USD (±0%)');
        expect(text).toMatch(/stack\s+0\/1 \(1× syntax\) → 1\/1  improved, \+100 pts/);
        expect(text).toContain('syntax        1 (50%) → 0 (0%)');
        expect(text).toContain('LOX_PARSER_ERROR: 1.00 → 0.00');
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
