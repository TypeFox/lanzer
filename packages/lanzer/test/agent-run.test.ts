import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { runLanzerCampaignTaskOverAcp, type RunLanzerAgentTaskOptions } from '../src/acp/run.js';
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
        text: text('text')
    };
}

let dir: string;
let workspace: string;
let outside: string;
let job: LanzerGenerationJob;

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
    [job] = buildLanzerGenerationJobs(resolveLanzerCampaign(campaign));
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
        env: { FAKE_AGENT_SCRIPT: scriptPath, FAKE_AGENT_LOG: logPath },
        maxAttempts: script.length,
        validate: async () => ({ ok: true, issues: [] }),
        ...options
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
