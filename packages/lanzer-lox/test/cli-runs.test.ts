import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { LanzerSuiteReport } from 'lanzer';
import { createLoxLanzerCli } from '../src/cli.js';

const LOX_GRAMMAR = fileURLToPath(new URL('../../langium-lox/langium/src/language-server/lox.langium', import.meta.url));
const FAKE_AGENT = fileURLToPath(new URL('../../lanzer/test/fixtures/fake-agent.mjs', import.meta.url));

let dir: string;
let campaignFile: string;
const savedEnv = { ...process.env };

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lanzer-cli-runs-'));
    campaignFile = join(dir, 'campaign.lanzer');
    await writeFile(campaignFile, [
        `import ${JSON.stringify(LOX_GRAMMAR)}`,
        'campaign repeated {',
        '    workspace "ws"',
        '    file main at "main.lox" generates LoxProgram {}',
        '}'
    ].join('\n'), 'utf8');
    process.exitCode = undefined;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
    process.env = { ...savedEnv };
    process.exitCode = undefined;
    vi.restoreAllMocks();
});

/** The suite report `generate` wrote. */
async function readSuite(path: string): Promise<LanzerSuiteReport> {
    const suite: LanzerSuiteReport = JSON.parse(await readFile(path, 'utf8'));
    return suite;
}

/** `lox-lanzer generate` with the fake agent writing `program` in every run's folder. */
async function generate(program: string, ...flags: string[]): Promise<{ exitCode: number | undefined; report: string }> {
    const scriptPath = join(dir, 'script.json');
    await writeFile(scriptPath, JSON.stringify([[{ writeRel: 'main.lox', content: program }]]), 'utf8');
    process.env.LANZER_ACP_ARGS = JSON.stringify([FAKE_AGENT]);
    process.env.FAKE_AGENT_SCRIPT = scriptPath;
    process.env.FAKE_AGENT_LOG = join(dir, 'agent.log');
    const report = join(dir, 'report.json');
    await createLoxLanzerCli().parseAsync([
        'node', 'lox-lanzer', 'generate', campaignFile, '--command', process.execPath, '--quiet', '--report', report, ...flags
    ]);
    const exitCode = typeof process.exitCode === 'number' ? process.exitCode : undefined;
    process.exitCode = undefined;
    return { exitCode, report };
}

describe('generate --runs', () => {
    test('runs the campaign n times and reports each run and the pass rate', async () => {
        const { exitCode, report } = await generate('print 1;', '--runs', '3', '--parallel', '2');
        expect(exitCode).toBeUndefined();
        const suite = await readSuite(report);
        expect(suite.runs.map((run) => run.repetition?.index)).toEqual([1, 2, 3]);
        expect(suite.summary.byCampaign).toEqual({ repeated: { total: 3, succeeded: 3, byStage: {} } });
        for (const run of suite.runs) {
            expect(existsSync(join(run.repetition?.workspace ?? '', 'main.lox'))).toBe(true);
        }
        // The workspace itself is left alone: every run worked in its own copy beside it.
        expect(existsSync(join(dir, 'ws', 'main.lox'))).toBe(false);
    });

    test('fails the command when a campaign passes fewer runs than required', async () => {
        const { exitCode, report } = await generate('var x: string = 1;', '--runs', '2');
        expect(exitCode).toBe(1);
        const suite = await readSuite(report);
        expect(suite.summary.byCampaign.repeated).toEqual({ total: 2, succeeded: 0, byStage: { semantics: 2 } });
    });

    test('--min-pass loosens the rule', async () => {
        const { exitCode } = await generate('var x: string = 1;', '--runs', '2', '--min-pass', '0%');
        expect(exitCode).toBeUndefined();
    });

    test('a malformed --min-pass stops before any run', async () => {
        const { exitCode, report } = await generate('print 1;', '--runs', '2', '--min-pass', 'most');
        expect(exitCode).toBe(1);
        expect(existsSync(report)).toBe(false);
    });

    test('without --runs, generate works in the workspace itself, as before', async () => {
        const { exitCode, report } = await generate('print 1;');
        expect(exitCode).toBeUndefined();
        expect(existsSync(join(dir, 'ws', 'main.lox'))).toBe(true);
        const suite = await readSuite(report);
        expect(suite.runs[0].repetition).toBeUndefined();
    });
});
