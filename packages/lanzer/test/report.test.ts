import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import type { LanzerAgentRunResult, LanzerRunConfiguration } from '../src/acp/run.js';
import { buildLanzerGenerationJobs, type LanzerGenerationJob } from '../src/campaign/jobs.js';
import { resolveLanzerCampaign } from '../src/campaign/map.js';
import { buildLanzerCampaignTask } from '../src/campaign/prompt.js';
import { buildLanzerRunReport, buildLanzerSuiteReport } from '../src/report/build.js';
import { renderLanzerRunSummary } from '../src/report/render.js';
import type { LanzerCampaignValidationResult, LanzerDocumentIssue } from '../src/services/types.js';
import { loadCampaignSpecs, miniCampaign } from './helpers.js';

let writtenJob: LanzerGenerationJob;
let missingJob: LanzerGenerationJob;

beforeAll(async () => {
    const [campaign] = await loadCampaignSpecs(miniCampaign('require Fn'));
    const [job] = buildLanzerGenerationJobs(resolveLanzerCampaign(campaign));
    const dir = await mkdtemp(join(tmpdir(), 'lanzer-report-'));
    writtenJob = { ...job, absoluteOutputPath: join(dir, 'main.mini') };
    missingJob = { ...job, absoluteOutputPath: join(dir, 'never-written.mini') };
    await writeFile(writtenJob.absoluteOutputPath, 'fn main() { return; }', 'utf8');
});

function run(job: LanzerGenerationJob, overrides: Partial<LanzerAgentRunResult> = {}): LanzerAgentRunResult {
    return {
        task: buildLanzerCampaignTask([job]),
        sessionId: 'session',
        attempts: 1,
        stopReason: 'end_turn',
        outputText: '',
        agentThoughtText: '',
        rawUpdates: [],
        toolCalls: [],
        deniedToolCalls: [],
        usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0 },
        durationMs: 0,
        attemptLog: [],
        extraFiles: [],
        staleFiles: [],
        ...overrides
    };
}

function verdict(
    issues: LanzerDocumentIssue[] = [],
    extra: Partial<LanzerCampaignValidationResult> = {}
): LanzerCampaignValidationResult {
    const campaignIssues = extra.campaign?.issues ?? [];
    const workspaceIssues = extra.workspace?.issues ?? [];
    const behaviourIssues = extra.behaviour?.issues ?? [];
    return {
        ok: issues.length === 0 && campaignIssues.length === 0 && workspaceIssues.length === 0 && behaviourIssues.length === 0,
        documents: [{ uri: 'file:///main.mini', issues }],
        ...extra
    };
}

async function stageOf(
    job: LanzerGenerationJob,
    validation: LanzerCampaignValidationResult | undefined,
    overrides: Partial<LanzerAgentRunResult> = {},
    fileSetIssues: string[] = []
) {
    const report = await buildLanzerRunReport({ campaign: 'demo', jobs: [job], run: run(job, overrides), validation, fileSetIssues });
    return report.failedStage;
}

describe('failed stage', () => {
    test('a clean run has none', async () => {
        const report = await buildLanzerRunReport({ campaign: 'demo', jobs: [writtenJob], run: run(writtenJob), validation: verdict() });
        expect(report.ok).toBe(true);
        expect(report.failedStage).toBeUndefined();
        expect(report.files).toEqual([{ path: writtenJob.absoluteOutputPath, exists: true, bytes: 21 }]);
    });

    test('an unfinished turn comes first', async () => {
        expect(await stageOf(missingJob, verdict(), { stopReason: 'max_tokens' })).toBe('turn');
    });

    test('a missing file is no_output', async () => {
        expect(await stageOf(missingJob, verdict())).toBe('no_output');
    });

    test('a target left unchanged from before the run is no_output too', async () => {
        expect(await stageOf(writtenJob, verdict(), { staleFiles: [writtenJob.absoluteOutputPath] })).toBe('no_output');
    });

    test('a parse error is syntax, even when a diagnostic is also present', async () => {
        expect(await stageOf(writtenJob, verdict([
            { kind: 'diagnostic', message: 'bad type' },
            { kind: 'parser-error', message: 'unexpected token' }
        ]))).toBe('syntax');
    });

    test('a diagnostic alone is semantics', async () => {
        expect(await stageOf(writtenJob, verdict([{ kind: 'diagnostic', message: 'bad type' }]))).toBe('semantics');
    });

    test('unmet requirements on valid files are requirements', async () => {
        expect(await stageOf(writtenJob, verdict([], { campaign: { ok: false, issues: ['Required selector did not match any node'] } }))).toBe('requirements');
    });

    test('a program that runs wrongly is behaviour, but only once requirements hold', async () => {
        const behaviour = { ok: false, runs: [], issues: ["Run of 'main': output must be exactly \"1\", but was \"2\""] };
        expect(await stageOf(writtenJob, verdict([], { behaviour }))).toBe('behaviour');
        expect(await stageOf(writtenJob, verdict([], { behaviour, campaign: { ok: false, issues: ['unmet'] } }))).toBe('requirements');
    });

    test('workspace and file-set findings are scope', async () => {
        expect(await stageOf(writtenJob, verdict([], { workspace: { ok: false, issues: ['stray'] } }))).toBe('scope');
        expect(await stageOf(writtenJob, verdict(), {}, ['Unexpected generated file'])).toBe('scope');
    });

    test('a failure supplied by the caller wins', async () => {
        const report = await buildLanzerRunReport({
            campaign: 'demo',
            jobs: [writtenJob],
            run: run(writtenJob),
            failure: { stage: 'launch', message: 'no such command' }
        });
        expect(report.failedStage).toBe('launch');
    });
});

describe('the run configuration', () => {
    const configuration: LanzerRunConfiguration = {
        transport: 'acp',
        command: 'npx',
        args: ['claude-agent-acp'],
        agent: { name: '@agentclientprotocol/claude-agent-acp', version: '0.82.0' },
        model: 'sonnet',
        effort: 'medium',
        permissionMode: 'acceptEdits',
        allowedToolKinds: ['edit', 'other', 'read', 'search', 'think'],
        toolAllowlist: ['Read', 'Write'],
        fixIterations: 1,
        retryIterations: 1
    };

    test('is copied into the report and summarised on one line', async () => {
        const report = await buildLanzerRunReport({ campaign: 'demo', jobs: [writtenJob], run: run(writtenJob, { configuration }), validation: verdict() });
        expect(report.configuration).toEqual(configuration);
        expect(renderLanzerRunSummary(report)).toContain(
            'agent: @agentclientprotocol/claude-agent-acp 0.82.0, model sonnet, effort medium, mode acceptEdits'
        );
    });

    test('names the command when the agent did not say who it is, and the sandbox for Codex', async () => {
        const codex: LanzerRunConfiguration = {
            transport: 'codex-mcp', command: 'npx', args: ['-y', '@openai/codex', 'mcp-server'],
            permissionMode: 'workspace-write', allowedToolKinds: ['edit', 'read'], fixIterations: 2, retryIterations: 1
        };
        const report = await buildLanzerRunReport({ campaign: 'demo', jobs: [writtenJob], run: run(writtenJob, { configuration: codex }), validation: verdict() });
        expect(renderLanzerRunSummary(report)).toContain('agent: npx -y @openai/codex mcp-server, sandbox workspace-write');
    });

    test('a hand-built result without one gives a report without one', async () => {
        const report = await buildLanzerRunReport({ campaign: 'demo', jobs: [writtenJob], run: run(writtenJob), validation: verdict() });
        expect(report).not.toHaveProperty('configuration');
        expect(renderLanzerRunSummary(report)).not.toContain('agent:');
    });
});

describe('the agent\'s own validate checks in the run summary', () => {
    const check = (ok: boolean, issueCount: number) => ({ tool: 'validate', startedAtMs: 0, durationMs: 1, ok, codes: [], issueCount });

    test('are listed in order when any failed, even on a passing run', async () => {
        const toolCalls = [check(false, 3), check(false, 1), check(true, 0)];
        const report = await buildLanzerRunReport({ campaign: 'demo', jobs: [writtenJob], run: run(writtenJob, { toolCalls }), validation: verdict() });
        expect(report.ok).toBe(true);
        expect(renderLanzerRunSummary(report)).toContain('  validate: ✗3 ✗1 ok');
    });

    test('are not listed when every check passed', async () => {
        const report = await buildLanzerRunReport({ campaign: 'demo', jobs: [writtenJob], run: run(writtenJob, { toolCalls: [check(true, 0)] }), validation: verdict() });
        expect(renderLanzerRunSummary(report)).not.toContain('validate:');
    });
});

describe('prompts in the suite report', () => {
    test('are stored once per hash, and taken off the runs', async () => {
        const fingerprint = { lanzerVersion: '0.0.1', grammars: [], promptHash: 'h1' };
        const reports = await Promise.all([1, 2].map(() =>
            buildLanzerRunReport({ campaign: 'demo', jobs: [writtenJob], run: run(writtenJob), validation: verdict(), fingerprint, prompt: 'Write <workspace>/main.mini.' })));
        expect(reports[0].prompt).toBe('Write <workspace>/main.mini.');
        const suite = buildLanzerSuiteReport(reports, 'now');
        expect(suite.prompts).toEqual({ h1: 'Write <workspace>/main.mini.' });
        expect(suite.runs.map((entry) => 'prompt' in entry)).toEqual([false, false]);
        expect(suite.runs[0].fingerprint?.promptHash).toBe('h1');
    });

    test('are absent from a suite whose runs recorded none', async () => {
        const report = await buildLanzerRunReport({ campaign: 'demo', jobs: [writtenJob], run: run(writtenJob), validation: verdict() });
        expect(buildLanzerSuiteReport([report], 'now')).not.toHaveProperty('prompts');
    });
});
