import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { hashDirectory, type LanzerSuiteComparison, type LanzerSuiteReport } from 'lanzer';
import { createLoxLanzerCli } from '../src/cli.js';

const LOX_GRAMMAR = fileURLToPath(new URL('../../langium-lox/langium/src/language-server/lox.langium', import.meta.url));
const FAKE_AGENT = fileURLToPath(new URL('../../lanzer/test/fixtures/fake-agent.mjs', import.meta.url));
const WRITE_LOX = fileURLToPath(new URL('../../../skills/write-lox', import.meta.url));

let dir: string;
let suiteDir: string;
const savedEnv = { ...process.env };

/** A campaign asking for one `main.lox` in its own workspace. */
function campaign(name: string): string {
    return [
        `import ${JSON.stringify(LOX_GRAMMAR)}`,
        `campaign ${name} {`,
        `    workspace "${name}-ws"`,
        '    file main at "main.lox" generates LoxProgram {}',
        '}'
    ].join('\n');
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lanzer-bench-cli-'));
    suiteDir = join(dir, 'suite');
    await mkdir(suiteDir);
    await writeFile(join(suiteDir, 'alpha.lanzer'), campaign('alpha'), 'utf8');
    await writeFile(join(suiteDir, 'beta.lanzer'), campaign('beta'), 'utf8');
    process.exitCode = undefined;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
    process.env = { ...savedEnv };
    process.exitCode = undefined;
    vi.restoreAllMocks();
});

async function cli(...args: string[]): Promise<number | undefined> {
    await createLoxLanzerCli().parseAsync(['node', 'lox-lanzer', ...args]);
    const exitCode = typeof process.exitCode === 'number' ? process.exitCode : undefined;
    process.exitCode = undefined;
    return exitCode;
}

/**
 * `generate` over `paths` with the fake agent writing `program` as every campaign's `main.lox`.
 * Each run starts its own agent process, so the one-prompt script serves every campaign.
 */
async function generate(program: string, report: string, ...args: string[]): Promise<number | undefined> {
    const scriptPath = join(dir, 'script.json');
    await writeFile(scriptPath, JSON.stringify([[{ writeRel: 'main.lox', content: program }]]), 'utf8');
    process.env.LANZER_ACP_ARGS = JSON.stringify([FAKE_AGENT]);
    process.env.FAKE_AGENT_SCRIPT = scriptPath;
    process.env.FAKE_AGENT_LOG = join(dir, 'agent.log');
    return cli('generate', ...args, '--command', process.execPath, '--quiet', '--report', report);
}

async function readSuite(path: string): Promise<LanzerSuiteReport> {
    return JSON.parse(await readFile(path, 'utf8'));
}

/** Everything the command printed to stdout, as one string. */
function printed(): string {
    return vi.mocked(console.log).mock.calls.map((call) => call.join(' ')).join('\n');
}

describe('generate over a suite', () => {
    test('runs every campaign of a folder into one report', async () => {
        const report = join(dir, 'report.json');
        expect(await generate('print 1;', report, suiteDir)).toBeUndefined();
        const suite = await readSuite(report);
        expect(suite.runs.map((run) => run.campaign)).toEqual(['alpha', 'beta']);
        expect(suite.summary).toMatchObject({ total: 2, succeeded: 2 });
        expect(existsSync(join(suiteDir, 'alpha-ws', 'main.lox'))).toBe(true);
        expect(existsSync(join(suiteDir, 'beta-ws', 'main.lox'))).toBe(true);
    });

    test('mixes files and folders, running a campaign named twice once', async () => {
        const report = join(dir, 'report.json');
        await generate('print 1;', report, join(suiteDir, 'beta.lanzer'), suiteDir);
        expect((await readSuite(report)).runs.map((run) => run.campaign)).toEqual(['beta', 'alpha']);
    });

    test('repeats every campaign of the suite with --runs', async () => {
        const report = join(dir, 'report.json');
        await generate('print 1;', report, suiteDir, '--runs', '2');
        expect((await readSuite(report)).summary.byCampaign).toEqual({
            alpha: { total: 2, succeeded: 2, byStage: {} },
            beta: { total: 2, succeeded: 2, byStage: {} }
        });
    });

    test('fails when one campaign of the suite fails', async () => {
        const report = join(dir, 'report.json');
        expect(await generate('var x: string = 1;', report, suiteDir)).toBe(1);
        expect((await readSuite(report)).summary.byStage).toEqual({ semantics: 2 });
    });

    test('stops before any run on a missing path', async () => {
        const report = join(dir, 'report.json');
        expect(await generate('print 1;', report, suiteDir, join(dir, 'typo.lanzer'))).toBe(1);
        expect(existsSync(report)).toBe(false);
        expect(existsSync(join(dir, 'agent.log'))).toBe(false);
    });

    test('stops before any run when a later campaign file is invalid', async () => {
        await writeFile(join(suiteDir, 'gamma.lanzer'), campaign('gamma').replace('LoxProgram', 'NoSuchRule'), 'utf8');
        await expect(generate('print 1;', join(dir, 'report.json'), suiteDir)).rejects.toThrow(/gamma\.lanzer: .*NoSuchRule/);
        expect(existsSync(join(dir, 'agent.log'))).toBe(false);
    });
});

describe('the fingerprint in the report', () => {
    test('records the skill, grammar and campaign file with content hashes, and the Lanzer version', async () => {
        const report = join(dir, 'report.json');
        // Named explicitly: the default lookup walks up from the campaign, and this one is in a
        // temporary folder outside the repository.
        await generate('print 1;', report, join(suiteDir, 'alpha.lanzer'), '--skill', WRITE_LOX);
        const [run] = (await readSuite(report)).runs;
        expect(run.fingerprint).toEqual({
            lanzerVersion: expect.stringMatching(/^\d+\.\d+\.\d+/),
            skill: { name: 'write-lox', path: WRITE_LOX, hash: await hashDirectory(WRITE_LOX) },
            grammars: [{ path: LOX_GRAMMAR, hash: expect.stringMatching(/^[0-9a-f]{64}$/) }],
            campaign: { path: join(suiteDir, 'alpha.lanzer'), hash: expect.stringMatching(/^[0-9a-f]{64}$/) },
            promptHash: expect.stringMatching(/^[0-9a-f]{64}$/),
            policyHash: expect.stringMatching(/^[0-9a-f]{64}$/)
        });
        expect(run.configuration?.agent).toEqual({ name: 'fake-agent', version: '1.2.3' });
    });

    test('stores the prompt once, with the workspace path left out, however many runs share it', async () => {
        const report = join(dir, 'report.json');
        await generate('print 1;', report, join(suiteDir, 'alpha.lanzer'), '--runs', '2');
        const suite = await readSuite(report);
        const [first, second] = suite.runs;
        // Each run had its own workspace folder, yet both were sent the same prompt.
        expect(first.repetition?.workspace).not.toBe(second.repetition?.workspace);
        expect(first.fingerprint?.promptHash).toBe(second.fingerprint?.promptHash);
        const prompt = suite.prompts?.[first.fingerprint?.promptHash ?? ''];
        expect(Object.keys(suite.prompts ?? {})).toHaveLength(1);
        expect(prompt).toContain('<workspace>/main.lox');
        expect(prompt).not.toContain(first.repetition?.workspace ?? '');
        expect(first).not.toHaveProperty('prompt');
    });

    test('--isolated is recorded in the configuration, and in compare when only one side had it', async () => {
        const plain = join(dir, 'plain.json');
        const isolated = join(dir, 'isolated.json');
        await generate('print 1;', plain, join(suiteDir, 'alpha.lanzer'));
        await generate('print 1;', isolated, join(suiteDir, 'alpha.lanzer'), '--isolated');
        expect((await readSuite(plain)).runs[0].configuration?.isolated).toBe(false);
        expect((await readSuite(isolated)).runs[0].configuration?.isolated).toBe(true);
        vi.mocked(console.log).mockClear();
        await cli('compare', plain, isolated);
        expect(printed()).toContain('isolated: no → yes');
    });

    test('--skill points the run at another skill folder, and its hash says it differs', async () => {
        const edited = join(dir, 'write-lox-v2');
        await cp(WRITE_LOX, edited, { recursive: true });
        await writeFile(join(edited, 'SKILL.md'), `${await readFile(join(edited, 'SKILL.md'), 'utf8')}\nOne more rule.\n`, 'utf8');
        const report = join(dir, 'report.json');
        await generate('print 1;', report, join(suiteDir, 'alpha.lanzer'), '--skill', edited);
        const [run] = (await readSuite(report)).runs;
        expect(run.fingerprint?.skill?.path).toBe(edited);
        expect(run.fingerprint?.skill?.hash).toBe(await hashDirectory(edited));
        expect(run.fingerprint?.skill?.hash).not.toBe(await hashDirectory(WRITE_LOX));
    });

    test('--skill without a SKILL.md stops before any run', async () => {
        const report = join(dir, 'report.json');
        expect(await generate('print 1;', report, suiteDir, '--skill', dir)).toBe(1);
        expect(existsSync(report)).toBe(false);
    });
});

describe('compare', () => {
    test('reads two generate reports and prints what changed', async () => {
        const before = join(dir, 'before.json');
        const after = join(dir, 'after.json');
        await generate('var x: string = 1;', before, suiteDir);
        await generate('print 1;', after, suiteDir);

        vi.mocked(console.log).mockClear();
        expect(await cli('compare', before, after)).toBeUndefined();
        const text = printed();
        expect(text).toContain('the same in both');
        expect(text).toMatch(/pass rate\s+0\/2 \(0%\)\s+2\/2 \(100%\)\s+\+100 pts/);
        expect(text).toMatch(/alpha\s+0\/1 \(1× semantics\)\s+1\/1\s+improved \+100 pts/);
        expect(text).toContain('small samples');
    });

    test('--json prints the comparison as data', async () => {
        const report = join(dir, 'report.json');
        await generate('print 1;', report, suiteDir);
        vi.mocked(console.log).mockClear();
        await cli('compare', report, report, '--json');
        const comparison: LanzerSuiteComparison = JSON.parse(printed());
        expect(comparison.passRateDelta).toBe(0);
        expect(comparison.campaigns.map((campaign) => campaign.change)).toEqual(['unchanged', 'unchanged']);
    });

    test('refuses a file that is not a report', async () => {
        await writeFile(join(dir, 'other.json'), '{}', 'utf8');
        expect(await cli('compare', join(dir, 'other.json'), join(dir, 'other.json'))).toBe(1);
        expect(vi.mocked(console.error)).toHaveBeenCalledWith(expect.stringMatching(/is not a Lanzer suite report/));
    });
});
