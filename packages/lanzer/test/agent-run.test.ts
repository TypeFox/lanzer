import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { runLanzerAgentTaskOverAcp, runLanzerCampaignTaskOverAcp, type RunLanzerAgentTaskOptions } from '../src/acp/run.js';
import { resolvePermissionPolicy } from '../src/acp/permissions.js';
import { createLanzerServices } from '../src/lanzer-module.js';
import { previewLanzerCampaignTask, runLanzerCampaign } from '../src/services/campaign-run.js';
import { DefaultLanzerService } from '../src/services/default-services.js';
import type { LanzerDslSkillReference, LanzerGenerationPolicy } from '../src/services/types.js';
import type { LanzerResolvedCampaign } from '../src/campaign/model.js';
import { buildLanzerGenerationJobs, type LanzerGenerationJob } from '../src/campaign/jobs.js';
import { resolveLanzerCampaign } from '../src/campaign/map.js';
import { isRecord } from '../src/util/guards.js';
import { fixture, loadCampaignSpecs } from './helpers.js';

type Step = { write: string; content?: string } | { read: string } | { tool: string } | { exit: number };

interface LogEntry {
    op: string;
    ok: boolean;
    path?: string;
    tool?: string;
    session?: number;
    error?: string;
    content?: string;
    text?: string;
    mode?: string;
    meta?: string;
}

/** One line of the fake agent's log, checked rather than asserted into shape. */
function toLogEntry(line: string): LogEntry {
    const value: unknown = JSON.parse(line);
    if (!isRecord(value) || typeof value.op !== 'string' || typeof value.ok !== 'boolean') {
        throw new Error(`Unexpected fake agent log line: ${line}`);
    }
    const text = (key: string): string | undefined => (typeof value[key] === 'string' ? value[key] : undefined);
    return {
        op: value.op,
        ok: value.ok,
        path: text('path'),
        tool: text('tool'),
        session: typeof value.session === 'number' ? value.session : undefined,
        error: text('error'),
        content: text('content'),
        text: text('text'),
        mode: text('mode'),
        meta: text('meta')
    };
}

let dir: string;
let workspace: string;
let outside: string;
let job: LanzerGenerationJob;
let resolved: LanzerResolvedCampaign;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lanzer-agent-'));
    workspace = join(dir, 'ws');
    outside = join(dir, 'outside');
    await mkdir(workspace, { recursive: true });
    await mkdir(outside, { recursive: true });
    const [campaign] = await loadCampaignSpecs([
        'import "mini.langium"',
        'campaign demo {',
        `    workspace ${JSON.stringify(workspace)}`,
        '    file main at "main.mini" generates Module {}',
        '}'
    ].join('\n'));
    resolved = resolveLanzerCampaign(campaign);
    [job] = buildLanzerGenerationJobs(resolved);
});

/** Run the fake agent through one prompt per script entry, and return what it logged. */
async function runFakeAgent(
    script: Step[][],
    options: Partial<RunLanzerAgentTaskOptions> = {}
): Promise<{ log: LogEntry[]; run: Awaited<ReturnType<typeof runLanzerCampaignTaskOverAcp>> }> {
    const scriptPath = join(dir, 'script.json');
    const logPath = join(dir, 'agent.log');
    await writeFile(scriptPath, JSON.stringify(script), 'utf8');
    await writeFile(logPath, '', 'utf8');
    const run = await runLanzerCampaignTaskOverAcp([job], {
        command: process.execPath,
        args: [fixture('fake-agent.mjs')],
        maxAttempts: script.length,
        validate: async () => ({ ok: true, issues: [] }),
        ...options,
        env: { FAKE_AGENT_SCRIPT: scriptPath, FAKE_AGENT_LOG: logPath, ...options.env }
    });
    const log = (await readFile(logPath, 'utf8')).split('\n').filter(Boolean).map(toLogEntry);
    return { log, run };
}

describe('file access during a run', () => {
    test('the agent writes the target inside the workspace', async () => {
        const { log, run } = await runFakeAgent([[{ write: job.absoluteOutputPath, content: 'fn main() { return; }' }]]);
        expect(log).toEqual([expect.objectContaining({ op: 'write', ok: true })]);
        expect(run.validation?.ok).toBe(true);
    });

    test('the launch directory is not writable, and outside the workspace is refused', async () => {
        const { log } = await runFakeAgent([[
            { write: job.absoluteOutputPath, content: 'x' },
            { write: join(process.cwd(), 'lanzer-should-not-exist.txt'), content: 'x' },
            { write: join(outside, 'escape.txt'), content: 'x' },
            { read: join(outside, 'escape.txt') }
        ]]);
        expect(log.map((entry) => [entry.op, entry.ok])).toEqual([['write', true], ['write', false], ['write', false], ['read', false]]);
        expect(log[1].error).toContain('ACP file write denied');
    });

    test('a symlink inside the workspace is judged by where it leads', async () => {
        await symlink(outside, join(workspace, 'link'));
        const { log } = await runFakeAgent([[
            { write: job.absoluteOutputPath, content: 'x' },
            { write: join(workspace, 'link', 'escape.txt'), content: 'x' }
        ]]);
        expect(log.map((entry) => entry.ok)).toEqual([true, false]);
    });

    test('read-only directories can be read but not written', async () => {
        await writeFile(join(outside, 'reference.txt'), 'grammar', 'utf8');
        const { log } = await runFakeAgent([[
            { write: job.absoluteOutputPath, content: 'x' },
            { read: join(outside, 'reference.txt') },
            { write: join(outside, 'reference.txt'), content: 'changed' }
        ]], { readOnlyDirectories: [outside] });
        expect(log.map((entry) => [entry.op, entry.ok])).toEqual([['write', true], ['read', true], ['write', false]]);
        expect(log[1].content).toBe('grammar');
        expect(await readFile(join(outside, 'reference.txt'), 'utf8')).toBe('grammar');
    });
});

describe('the session permission mode', () => {
    const CLAUDE_MODES = JSON.stringify(['default', 'acceptEdits', 'plan', 'auto']);

    async function sessionSetup(options: Partial<RunLanzerAgentTaskOptions>) {
        const { log, run } = await runFakeAgent([[]], options);
        const session = log.find((entry) => entry.op === 'session');
        return {
            meta: session?.meta ? JSON.parse(session.meta) : undefined,
            modes: log.filter((entry) => entry.op === 'mode').map((entry) => entry.mode),
            configuration: run.configuration
        };
    }

    test('a run that may write switches to acceptEdits, and never allows bypass', async () => {
        const { meta, modes, configuration } = await sessionSetup({ env: { FAKE_AGENT_MODES: CLAUDE_MODES } });
        expect(modes).toEqual(['acceptEdits']);
        expect(configuration?.permissionMode).toBe('acceptEdits');
        // The adapter ignores a mode sent in `_meta`, so none is; bypass is refused there instead.
        expect(meta.claudeCode.options).toMatchObject({ allowDangerouslySkipPermissions: false });
        expect(meta.claudeCode.options).not.toHaveProperty('permissionMode');
    });

    test('a read-only run stays in default, which asks', async () => {
        const { modes, configuration } = await sessionSetup({
            env: { FAKE_AGENT_MODES: JSON.stringify(['auto', 'default', 'acceptEdits']) },
            permissions: resolvePermissionPolicy('read')
        });
        expect(modes).toEqual(['default']);
        expect(configuration?.permissionMode).toBe('default');
    });

    test('nothing is sent when the session already opens in that mode', async () => {
        const { modes } = await sessionSetup({ env: { FAKE_AGENT_MODES: JSON.stringify(['acceptEdits', 'default']) } });
        expect(modes).toEqual([]);
    });

    test('an agent that does not offer the mode is left alone', async () => {
        const { modes, configuration } = await sessionSetup({ env: { FAKE_AGENT_MODES: JSON.stringify(['ask', 'code']) } });
        expect(modes).toEqual([]);
        // Recorded as it is: the mode the session opened in, not the one the policy wanted.
        expect(configuration?.permissionMode).toBe('ask');
    });

    test('the run records the agent, its settings and a missing mode as they were', async () => {
        const { configuration } = await sessionSetup({ model: 'fast', effort: 'low', fixIterations: 1, retryIterations: 2 });
        expect(configuration).toEqual({
            transport: 'acp',
            command: process.execPath,
            args: [fixture('fake-agent.mjs')],
            agent: { name: 'fake-agent', version: '1.2.3' },
            model: 'fast',
            effort: 'low',
            allowedToolKinds: ['edit', 'other', 'read', 'search', 'think'],
            toolAllowlist: expect.arrayContaining(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill']),
            fixIterations: 1,
            retryIterations: 2
        });
        // The fake agent offers no modes here, so there is no mode to record.
        expect(configuration).not.toHaveProperty('permissionMode');
    });

    test('an explicit session mode wins over the policy', async () => {
        const { modes } = await sessionSetup({ env: { FAKE_AGENT_MODES: CLAUDE_MODES }, sessionModeId: 'plan' });
        expect(modes).toEqual(['plan']);
    });
});

describe('declared targets that predate the run', () => {
    test('an untouched pre-existing target fails as stale', async () => {
        await writeFile(job.absoluteOutputPath, 'fn old() { return; }', 'utf8');
        const { run } = await runFakeAgent([[]]);
        expect(run.staleFiles).toEqual([job.absoluteOutputPath]);
        expect(run.validation?.ok).toBe(false);
        expect(run.validation?.issues).toEqual([
            `Required generated file was not written during this run (unchanged since before it started): ${job.absoluteOutputPath}`
        ]);
    });

    test('a pre-existing target the agent rewrites is fine', async () => {
        await writeFile(job.absoluteOutputPath, 'fn old() { return; }', 'utf8');
        await new Promise((resolve) => setTimeout(resolve, 20));
        const { run } = await runFakeAgent([[{ write: job.absoluteOutputPath, content: 'fn main() { return; }' }]]);
        expect(run.staleFiles).toEqual([]);
        expect(run.validation?.ok).toBe(true);
    });
});

describe('the DSL skill', () => {
    /** A service with no grammar policy and a skill in a directory of its own, outside the workspace. */
    class SkillOnlyService extends DefaultLanzerService {
        constructor(private readonly skill: LanzerDslSkillReference) {
            const { shared, Lanzer } = createLanzerServices(EmptyFileSystem);
            super(shared, Lanzer);
        }
        override async getGenerationPolicy(): Promise<LanzerGenerationPolicy | undefined> {
            return undefined;
        }
        override async dslSkill(): Promise<LanzerDslSkillReference | undefined> {
            return this.skill;
        }
    }

    test('is named by location in the prompt, and readable but not writable during the run', async () => {
        const skillDir = join(outside, 'mini-skill');
        const skillFile = join(skillDir, 'SKILL.md');
        await mkdir(skillDir, { recursive: true });
        await writeFile(skillFile, '# Writing Mini', 'utf8');
        const scriptPath = join(dir, 'script.json');
        const logPath = join(dir, 'agent.log');
        await writeFile(scriptPath, JSON.stringify([[
            { read: skillFile },
            { write: job.absoluteOutputPath, content: 'fn main() { return; }' },
            { write: skillFile, content: 'changed' }
        ]]), 'utf8');
        await writeFile(logPath, '', 'utf8');

        const service = new SkillOnlyService({ name: 'write-mini', path: skillDir });
        const run = await runLanzerCampaign(resolved, {
            service,
            runner: { validateCampaign: async () => ({ ok: true, documents: [] }) }
        }, {
            command: process.execPath,
            args: [fixture('fake-agent.mjs')],
            env: { FAKE_AGENT_SCRIPT: scriptPath, FAKE_AGENT_LOG: logPath },
            maxAttempts: 1
        });

        expect(run.task.prompt).toContain(`Use the installed agent skill named "write-mini" before generating.`);
        expect(run.task.prompt).toContain(`If that skill is not available to you, read ${skillFile} directly`);
        const log = (await readFile(logPath, 'utf8')).split('\n').filter(Boolean).map(toLogEntry);
        expect(log.map((entry) => [entry.op, entry.ok])).toEqual([['read', true], ['write', true], ['write', false]]);
        expect(await readFile(skillFile, 'utf8')).toBe('# Writing Mini');
        expect(run.report?.ok).toBe(true);

        // What `plan --prompt` shows is exactly what the agent was sent.
        expect((await previewLanzerCampaignTask(resolved, service)).prompt).toBe(run.task.prompt);
    });
});

describe('Lanzer tools across sessions', () => {
    test('a retry session can still call the tools the first session used', async () => {
        const { log, run } = await runFakeAgent([[{ tool: 'validate' }], [{ tool: 'validate' }]], {
            maxAttempts: undefined,
            fixIterations: 0,
            retryIterations: 2,
            validate: async () => ({ ok: false, issues: ['still failing'] }),
            toolkit: { validate: async () => ({ ok: false, documents: [] }) }
        });
        expect(log.map((entry) => [entry.session, entry.ok, entry.error])).toEqual([[1, true, undefined], [2, true, undefined]]);
        expect(log[1].text).toContain('INVALID');
        expect(run.toolCalls).toHaveLength(2);
    });
});

describe('mid-run validate failures', () => {
    test('a failed check keeps what it reported, and a passing one keeps nothing', async () => {
        let calls = 0;
        // The target is written first: until it exists, Lanzer's own file-set check fails every call.
        const write = { write: job.absoluteOutputPath, content: 'fn main() { return; }' };
        const { run } = await runFakeAgent([[write, { tool: 'validate' }, { tool: 'validate' }]], {
            toolkit: {
                validate: async () => (++calls === 1
                    ? {
                        ok: false,
                        documents: [{
                            uri: 'file:///ws/main.mini',
                            issues: [{ kind: 'diagnostic', message: "Type 'number' is not assignable to type 'string'.", code: 'TYPE', line: 3, character: 5 }]
                        }],
                        behaviour: { ok: false, issues: ["Run of 'main' timed out"], runs: [] }
                    }
                    : { ok: true, documents: [] })
            }
        });
        expect(run.toolCalls.map((call) => call.ok)).toEqual([false, true]);
        expect(run.toolCalls[0].issues).toEqual([
            { source: 'document', uri: 'file:///ws/main.mini', line: 3, character: 5, code: 'TYPE', message: "Type 'number' is not assignable to type 'string'." },
            { source: 'behaviour', message: "Run of 'main' timed out" }
        ]);
        expect(run.toolCalls[0].issueCount).toBe(2);
        expect(run.toolCalls[1].issues).toBeUndefined();
    });

    test('keeps the first 50 issues of a call and counts the rest', async () => {
        const { run } = await runFakeAgent([[{ write: job.absoluteOutputPath, content: 'fn main() { return; }' }, { tool: 'validate' }]], {
            toolkit: {
                validate: async () => ({
                    ok: false,
                    documents: [],
                    campaign: { ok: false, issues: Array.from({ length: 60 }, (_, i) => `requirement ${i + 1} unmet`) }
                })
            }
        });
        const [call] = run.toolCalls;
        expect(call.issues).toHaveLength(50);
        expect(call.issues?.[0]).toEqual({ source: 'requirement', message: 'requirement 1 unmet' });
        expect(call.issuesOmitted).toBe(10);
        expect(call.issueCount).toBe(60);
    });
});

describe('the Codex MCP transport', () => {
    /** Run the fake Codex server, one script entry per call; return the prompts it received. */
    async function runFakeCodex(
        script: { path: string; content?: string }[][],
        validate: RunLanzerAgentTaskOptions['validate'],
        options: Partial<RunLanzerAgentTaskOptions> = {}
    ) {
        const scriptPath = join(dir, 'codex-script.json');
        const logPath = join(dir, 'codex.log');
        await writeFile(scriptPath, JSON.stringify(script), 'utf8');
        await writeFile(logPath, '', 'utf8');
        const run = await runLanzerCampaignTaskOverAcp([job], {
            provider: 'codex',
            command: process.execPath,
            args: [fixture('fake-codex.mjs')],
            env: { FAKE_CODEX_SCRIPT: scriptPath, FAKE_CODEX_LOG: logPath },
            validate,
            toolkit: { validate: async () => ({ ok: true, documents: [] }) },
            ...options
        });
        const prompts = (await readFile(logPath, 'utf8')).split('\n').filter(Boolean).map((line) => {
            const entry: unknown = JSON.parse(line);
            return isRecord(entry) && typeof entry.prompt === 'string' ? entry.prompt : '';
        });
        return { run, prompts };
    }

    test('runs the same attempt loop: log, file set, token totals, and a fix prompt that carries the task', async () => {
        let validations = 0;
        const { run, prompts } = await runFakeCodex(
            [[], [{ path: job.absoluteOutputPath, content: 'fn main() { return; }' }, { path: join(workspace, 'notes.txt'), content: 'extra' }]],
            async () => (++validations === 1 ? { ok: false, issues: ['[diagnostic] Missing main'] } : { ok: true, issues: [] }),
            { fixIterations: 2, retryIterations: 1 }
        );

        expect(run.validation?.ok).toBe(true);
        expect(run.attemptLog.map((attempt) => [attempt.kind, attempt.session, attempt.issueCount])).toEqual([['initial', 1, 2], ['fix', 1, 0]]);
        expect(run.extraFiles).toEqual([join(workspace, 'notes.txt')]);
        expect(run.usage).toMatchObject({ totalTokens: 220, inputTokens: 200, outputTokens: 20 });
        // Every Codex call is a fresh conversation, so the fix pass restates the task.
        expect(prompts).toHaveLength(2);
        expect(prompts[1].startsWith(run.task.prompt)).toBe(true);
        expect(prompts[1]).toContain('Fix pass 1');
    });

    test('does not offer Lanzer tools it cannot serve', async () => {
        const { run } = await runFakeCodex([[{ path: job.absoluteOutputPath, content: 'x' }]], async () => ({ ok: true, issues: [] }));
        expect(run.task.prompt).not.toContain('mcp__lanzer__');
    });

    test('abandons fix passes that stop changing the findings', async () => {
        const { run } = await runFakeCodex(
            [[{ path: job.absoluteOutputPath, content: 'x' }]],
            async () => ({ ok: false, issues: ['[diagnostic] the same thing'] }),
            { fixIterations: 6, retryIterations: 1 }
        );
        expect(run.attemptLog.map((attempt) => attempt.kind)).toEqual(['initial', 'fix', 'fix']);
    });
});

describe('a support file that a run starts from', () => {
    /** A campaign whose run starts from a provided driver; returns its job and the driver's path. */
    async function driverCampaign() {
        const [campaign] = await loadCampaignSpecs([
            'import "mini.langium"',
            'campaign driven {',
            `    workspace ${JSON.stringify(workspace)}`,
            '    file main at "main.mini" generates Module {}',
            '    support driver at "driver.mini"',
            '    run driver { expect runs }',
            '}'
        ].join('\n'));
        const [drivenJob] = buildLanzerGenerationJobs(resolveLanzerCampaign(campaign));
        const driverPath = join(workspace, 'driver.mini');
        await writeFile(driverPath, 'fn main() { call helper; }', 'utf8');
        return { drivenJob, driverPath };
    }

    async function runWith(drivenJob: LanzerGenerationJob, script: Step[][]) {
        const scriptPath = join(dir, 'driver-script.json');
        const logPath = join(dir, 'driver-agent.log');
        await writeFile(scriptPath, JSON.stringify(script), 'utf8');
        await writeFile(logPath, '', 'utf8');
        return runLanzerCampaignTaskOverAcp([drivenJob], {
            command: process.execPath,
            args: [fixture('fake-agent.mjs')],
            env: { FAKE_AGENT_SCRIPT: scriptPath, FAKE_AGENT_LOG: logPath },
            maxAttempts: 1,
            validate: async () => ({ ok: true, issues: [] })
        });
    }

    test('left as provided, the run is not failed on its account', async () => {
        const { drivenJob } = await driverCampaign();
        const run = await runWith(drivenJob, [[{ write: drivenJob.absoluteOutputPath, content: 'fn helper() { return; }' }]]);
        expect(run.validation).toEqual({ ok: true, issues: [] });
    });

    test('rewritten by the agent, it fails the run', async () => {
        const { drivenJob, driverPath } = await driverCampaign();
        const run = await runWith(drivenJob, [[
            { write: drivenJob.absoluteOutputPath, content: 'fn helper() { return; }' },
            { write: driverPath, content: 'fn main() { return; }' }
        ]]);
        expect(run.validation?.ok).toBe(false);
        expect(run.validation?.issues).toEqual([
            `A run starts from ${driverPath}, which the campaign provides; it must not be changed, but it was changed during this run.`
        ]);
    });
});

describe('a single-job run', () => {
    /** Run one job through the single-job entry point, with the fake agent following `script`. */
    async function runSingle(target: LanzerGenerationJob, script: Step[][], options: Partial<RunLanzerAgentTaskOptions> = {}) {
        const scriptPath = join(dir, 'single-script.json');
        const logPath = join(dir, 'single-agent.log');
        await writeFile(scriptPath, JSON.stringify(script), 'utf8');
        await writeFile(logPath, '', 'utf8');
        return runLanzerAgentTaskOverAcp(target, {
            command: process.execPath,
            args: [fixture('fake-agent.mjs')],
            env: { FAKE_AGENT_SCRIPT: scriptPath, FAKE_AGENT_LOG: logPath },
            maxAttempts: 1,
            validate: async () => ({ ok: true, issues: [] }),
            ...options
        });
    }

    test('writing its target passes', async () => {
        const run = await runSingle(job, [[{ write: job.absoluteOutputPath, content: 'fn main() { return; }' }]]);
        expect(run.validation).toEqual({ ok: true, issues: [] });
    });

    test('a target never written fails as missing', async () => {
        const run = await runSingle(job, [[]]);
        expect(run.validation).toEqual({ ok: false, issues: [`Missing required generated file: ${job.absoluteOutputPath}`] });
    });

    test('an untouched pre-existing target fails as stale', async () => {
        await writeFile(job.absoluteOutputPath, 'fn old() { return; }', 'utf8');
        const run = await runSingle(job, [[]]);
        expect(run.staleFiles).toEqual([job.absoluteOutputPath]);
        expect(run.validation?.issues).toEqual([
            `Required generated file was not written during this run (unchanged since before it started): ${job.absoluteOutputPath}`
        ]);
    });

    /** The target plus one file nobody declared. */
    const withExtraFile = (): Step[][] => [[
        { write: job.absoluteOutputPath, content: 'fn main() { return; }' },
        { write: join(workspace, 'notes.txt'), content: 'x' }
    ]];

    test('an extra file is reported without failing the run', async () => {
        const run = await runSingle(job, withExtraFile());
        expect(run.extraFiles).toEqual([join(workspace, 'notes.txt')]);
        expect(run.validation?.ok).toBe(true);
    });

    test('an extra file fails the run when the file set is strict', async () => {
        const run = await runSingle(job, withExtraFile(), { strictFileSet: true });
        expect(run.validation?.issues).toEqual([
            `Unexpected generated file was written outside the declared file set: ${join(workspace, 'notes.txt')}`
        ]);
    });

    test("the campaign's other generated files are declared, not extra", async () => {
        const [campaign] = await loadCampaignSpecs([
            'import "mini.langium"',
            'campaign pair {',
            `    workspace ${JSON.stringify(workspace)}`,
            '    file main at "main.mini" generates Module {}',
            '    file lib at "lib.mini" generates Module {}',
            '}'
        ].join('\n'));
        const [mainJob, libJob] = buildLanzerGenerationJobs(resolveLanzerCampaign(campaign));
        const run = await runSingle(mainJob, [[
            { write: mainJob.absoluteOutputPath, content: 'fn main() { return; }' },
            { write: libJob.absoluteOutputPath, content: 'fn helper() { return; }' }
        ]]);
        expect(run.extraFiles).toEqual([]);
        expect(run.validation?.ok).toBe(true);
    });

    test('a support file a run starts from, rewritten by the agent, fails the run', async () => {
        const [campaign] = await loadCampaignSpecs([
            'import "mini.langium"',
            'campaign driven {',
            `    workspace ${JSON.stringify(workspace)}`,
            '    file main at "main.mini" generates Module {}',
            '    support driver at "driver.mini"',
            '    run driver { expect runs }',
            '}'
        ].join('\n'));
        const [drivenJob] = buildLanzerGenerationJobs(resolveLanzerCampaign(campaign));
        const driverPath = join(workspace, 'driver.mini');
        await writeFile(driverPath, 'fn main() { call helper; }', 'utf8');
        const run = await runSingle(drivenJob, [[
            { write: drivenJob.absoluteOutputPath, content: 'fn helper() { return; }' },
            { write: driverPath, content: 'fn main() { return; }' }
        ]]);
        expect(run.validation?.issues).toEqual([
            `A run starts from ${driverPath}, which the campaign provides; it must not be changed, but it was changed during this run.`
        ]);
    });
});

describe('a run whose agent never starts', () => {
    /** A service with no policy and no skill, so nothing runs before the launch. */
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

    test('still reports how it was configured, from its options alone', async () => {
        const service = new BareService();
        const run = await runLanzerCampaign(resolved, {
            service,
            runner: { validateCampaign: async () => ({ ok: true, documents: [] }) }
        }, {
            command: join(dir, 'no-such-agent'),
            model: 'fast',
            maxAttempts: 1
        });
        expect(run.report?.failedStage).toBe('launch');
        expect(run.report?.configuration).toMatchObject({
            transport: 'acp',
            command: join(dir, 'no-such-agent'),
            model: 'fast',
            fixIterations: 0,
            retryIterations: 1
        });
        // Nothing the agent would have said: it never answered.
        expect(run.report?.configuration).not.toHaveProperty('agent');
        expect(run.report?.configuration).not.toHaveProperty('permissionMode');
    });
});
