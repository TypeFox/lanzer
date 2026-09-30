import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { resolveLanzerCampaign } from '../src/campaign/map.js';
import type { LanzerResolvedCampaign } from '../src/campaign/model.js';
import { createLanzerServices } from '../src/lanzer-module.js';
import { buildLanzerSuiteReport } from '../src/report/build.js';
import { renderLanzerSuiteSummary } from '../src/report/render.js';
import type { RunLanzerCampaignDeps } from '../src/services/campaign-run.js';
import { DefaultLanzerService } from '../src/services/default-services.js';
import {
    mapWithConcurrency,
    meetsMinPass,
    parseMinPass,
    runLanzerCampaignRepeatedly
} from '../src/services/repeated-runs.js';
import type {
    LanzerCampaignRunRequest,
    LanzerCampaignValidationResult,
    LanzerDslSkillReference,
    LanzerGenerationPolicy
} from '../src/services/types.js';
import { fixture, loadCampaignSpecs } from './helpers.js';

/** A service with no policy and no skill: nothing but the run itself. */
class BareService extends DefaultLanzerService {
    constructor() {
        const { shared, Lanzer } = createLanzerServices(EmptyFileSystem);
        super(shared, Lanzer);
    }
    override async getGenerationPolicy(): Promise<LanzerGenerationPolicy | undefined> {
        return undefined;
    }
    override async dslSkill(): Promise<LanzerDslSkillReference | undefined> {
        return undefined;
    }
}

let dir: string;
let workspace: string;
let resolved: LanzerResolvedCampaign;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lanzer-repeat-'));
    workspace = join(dir, 'ws');
    await mkdir(workspace, { recursive: true });
    // Context every run should see, and an earlier answer no run should.
    await writeFile(join(workspace, 'context.mini'), 'fn context() { return; }', 'utf8');
    await writeFile(join(workspace, 'main.mini'), 'fn earlier() { return; }', 'utf8');
    const [campaign] = await loadCampaignSpecs([
        'import "mini.langium"',
        'campaign demo {',
        `    workspace ${JSON.stringify(workspace)}`,
        '    file main at "main.mini" generates Module {}',
        '    support context at "context.mini"',
        '}'
    ].join('\n'));
    resolved = resolveLanzerCampaign(campaign);
});

/** Script the fake agent to write the target in whichever run folder it was started in. */
async function agentThatWritesTheTarget() {
    const scriptPath = join(dir, 'script.json');
    await writeFile(scriptPath, JSON.stringify([[{ writeRel: 'main.mini', content: 'fn main() { return; }' }]]), 'utf8');
    return {
        command: process.execPath,
        args: [fixture('fake-agent.mjs')],
        env: { FAKE_AGENT_SCRIPT: scriptPath, FAKE_AGENT_LOG: join(dir, 'agent.log') },
        maxAttempts: 1
    };
}

/**
 * Fresh deps per run, as the real CLI makes them, recording each run's request. Run `failing`
 * reports an unmet requirement; the rest pass.
 */
function depsFactory(failing?: number) {
    const requests: LanzerCampaignRunRequest[] = [];
    const create = (): RunLanzerCampaignDeps => {
        const run = requests.length + 1;
        return {
            service: new BareService(),
            runner: {
                validateCampaign: async (request): Promise<LanzerCampaignValidationResult> => {
                    if (!requests.includes(request)) requests.push(request);
                    return run === failing
                        ? { ok: false, documents: [], campaign: { ok: false, issues: ['Required selector did not match'] } }
                        : { ok: true, documents: [] };
                }
            }
        };
    };
    return { create, requests };
}

describe('repeated runs', () => {
    test('each run works in its own copy of the workspace, without the earlier answer', async () => {
        const deps = depsFactory();
        const runsRoot = join(dir, 'runs');
        const batch = await runLanzerCampaignRepeatedly(resolved, deps.create, await agentThatWritesTheTarget(), { runs: 3, runsRoot });

        expect(batch.runs.map((run) => run.workspace)).toEqual([1, 2, 3].map((i) => join(runsRoot, `run-${i}`)));
        for (const run of batch.runs) {
            // The support file came along; the agent's target is its own, not the earlier answer.
            expect(await readFile(join(run.workspace, 'context.mini'), 'utf8')).toBe('fn context() { return; }');
            expect(await readFile(join(run.workspace, 'main.mini'), 'utf8')).toBe('fn main() { return; }');
            expect(run.result.task.prompt).toContain(join(run.workspace, 'main.mini'));
        }
        // The original workspace is untouched.
        expect(await readFile(join(workspace, 'main.mini'), 'utf8')).toBe('fn earlier() { return; }');
        expect(existsSync(join(workspace, 'run-1'))).toBe(false);
    });

    test('each run is validated by its own services, against its own folder', async () => {
        const deps = depsFactory();
        const batch = await runLanzerCampaignRepeatedly(resolved, deps.create, await agentThatWritesTheTarget(), { runs: 2, runsRoot: join(dir, 'runs') });
        expect(deps.requests).toHaveLength(2);
        expect(deps.requests.map((request) => request.documents.map((document) => document.path))).toEqual(
            batch.runs.map((run) => [join(run.workspace, 'context.mini'), join(run.workspace, 'main.mini')])
        );
    });

    test('every run keeps its own report, numbered, and the summary gives the pass rate', async () => {
        const batch = await runLanzerCampaignRepeatedly(resolved, depsFactory(2).create, await agentThatWritesTheTarget(), { runs: 3, runsRoot: join(dir, 'runs') });
        expect({ passed: batch.passed, total: batch.total }).toEqual({ passed: 2, total: 3 });
        expect(batch.runs.map((run) => run.result.report?.repetition)).toEqual(
            batch.runs.map((run) => ({ index: run.index, total: 3, workspace: run.workspace }))
        );
        expect(batch.runs.map((run) => run.result.report?.ok)).toEqual([true, false, true]);

        const suite = buildLanzerSuiteReport(batch.runs.flatMap((run) => (run.result.report ? [run.result.report] : [])), 'now');
        expect(suite.summary.byCampaign).toEqual({ demo: { total: 3, succeeded: 2, byStage: { requirements: 1 } } });
        const text = renderLanzerSuiteSummary(suite);
        expect(text).toContain('2/3 run(s) succeeded, 1 failed');
        expect(text).toContain('demo: 2/3 passed (1× requirements)');
    });

    test('runs in parallel still each get their own folder', async () => {
        const batch = await runLanzerCampaignRepeatedly(resolved, depsFactory().create, await agentThatWritesTheTarget(), { runs: 4, parallel: 2, runsRoot: join(dir, 'runs') });
        expect(batch.passed).toBe(4);
        expect(new Set(batch.runs.map((run) => run.workspace)).size).toBe(4);
    });

    test('by default the runs go beside the workspace, never inside it', async () => {
        const batch = await runLanzerCampaignRepeatedly(resolved, depsFactory().create, await agentThatWritesTheTarget(), { runs: 1 });
        expect(batch.runs[0].workspace.startsWith(`${workspace}.runs/`)).toBe(true);
    });
});

describe('the concurrency limit', () => {
    test('never has more than the limit in flight, and keeps the results in order', async () => {
        let inFlight = 0;
        let most = 0;
        const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
            inFlight += 1;
            most = Math.max(most, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 5 + (item % 3) * 5));
            inFlight -= 1;
            return item * 10;
        });
        expect(most).toBe(3);
        expect(results).toEqual([10, 20, 30, 40, 50, 60, 70]);
    });
});

describe('the pass rule', () => {
    test('defaults to every run', () => {
        expect(parseMinPass(undefined)).toBe(1);
        expect(meetsMinPass(3, 3, 1)).toBe(true);
        expect(meetsMinPass(2, 3, 1)).toBe(false);
    });

    test('takes a fraction or a percentage', () => {
        expect(meetsMinPass(2, 3, parseMinPass('2/3'))).toBe(true);
        expect(meetsMinPass(1, 3, parseMinPass('2/3'))).toBe(false);
        expect(meetsMinPass(7, 10, parseMinPass('66%'))).toBe(true);
        expect(meetsMinPass(6, 10, parseMinPass('66%'))).toBe(false);
        expect(meetsMinPass(0, 5, parseMinPass('0%'))).toBe(true);
    });

    test('refuses anything else', () => {
        for (const bad of ['3/2', 'two', '150%', '1/0', '']) {
            expect(() => parseMinPass(bad)).toThrow(/--min-pass must be/);
        }
    });
});
