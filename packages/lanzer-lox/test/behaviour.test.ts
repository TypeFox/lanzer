import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeFileSystem } from 'langium/node';
import { describe, expect, test } from 'vitest';
import { resolveLanzerCampaignFile, type LanzerCampaignValidationResult } from 'lanzer';
import { createLanzerLoxServices } from '../src/lox-host.js';

const LOX_GRAMMAR = fileURLToPath(new URL('../../langium-lox/langium/src/language-server/lox.langium', import.meta.url));

/** Validate a one-file Lox campaign whose `main.lox` is `program`, with the given run block body. */
async function behaviourOf(program: string, runBlock: string): Promise<LanzerCampaignValidationResult> {
    const dir = await mkdtemp(join(tmpdir(), 'lanzer-behaviour-'));
    const campaignFile = join(dir, 'campaign.lanzer');
    await writeFile(campaignFile, [
        `import ${JSON.stringify(LOX_GRAMMAR)}`,
        'campaign behaviour {',
        '    workspace "ws"',
        '    file main at "main.lox" generates LoxProgram {}',
        `    run main { ${runBlock} }`,
        '}'
    ].join('\n'), 'utf8');
    const resolved = await resolveLanzerCampaignFile(campaignFile, { validate: true });
    expect(resolved.issues).toEqual([]);
    await mkdir(join(dir, 'ws'), { recursive: true });
    await writeFile(join(dir, 'ws', 'main.lox'), program, 'utf8');
    const { Lanzer } = createLanzerLoxServices(NodeFileSystem);
    return Lanzer.lanzer.CampaignRunner.validateCampaign(resolved.resolvedCampaigns[0].request);
}

const COUNTS = 'fun main(): void { for (var i = 1; i <= 3; i = i + 1) { print i; } } main();';

describe('running a generated Lox program', () => {
    test('every kind of expectation can hold at once', async () => {
        const result = await behaviourOf(COUNTS, [
            'expect runs',
            'expect output "1\\n2\\n3\\n"',
            'expect output contains "2"',
            'expect output matches "^1\\\\n2\\\\n3\\\\n$"',
            'expect not output contains "error"'
        ].join(' '));
        expect(result.behaviour).toMatchObject({ ok: true, issues: [] });
        expect(result.behaviour?.runs[0].execution).toMatchObject({ completed: true, output: '1\n2\n3\n', timedOut: false });
        expect(result.ok).toBe(true);
    });

    test('exact output forgives a missing final newline and trailing spaces', async () => {
        const result = await behaviourOf(COUNTS, 'expect output "1  \\n2\\n3"');
        expect(result.behaviour?.ok).toBe(true);
    });

    test('wrong output fails with what was expected and what came out', async () => {
        const result = await behaviourOf(COUNTS, 'expect output "3\\n2\\n1\\n" expect not output contains "2"');
        expect(result.ok).toBe(false);
        expect(result.behaviour?.issues).toEqual([
            `Run of 'main': output must be exactly "3\\n2\\n1\\n", but was "1\\n2\\n3\\n"`,
            `Run of 'main': output must not contain "2", but was "1\\n2\\n3\\n"`
        ]);
    });

    test('a runtime error fails the run, with the output printed before it', async () => {
        const result = await behaviourOf(
            'class Box { n: number } fun main(): void { var b = Box(); print "before"; print b.n + 1; } main();',
            'expect output contains "after"'
        );
        expect(result.behaviour?.runs[0].execution).toMatchObject({ completed: false, timedOut: false, output: 'before\n' });
        expect(result.behaviour?.issues).toEqual([
            expect.stringMatching(/^Run of 'main' stopped on a runtime error: .+\. Output so far: "before\\n"$/)
        ]);
    });

    test('a program that never ends times out', async () => {
        const result = await behaviourOf('fun main(): void { while (true) { } } main();', 'expect runs');
        expect(result.behaviour?.runs[0].execution).toMatchObject({ completed: false, timedOut: true });
        expect(result.behaviour?.issues).toEqual([`Run of 'main' timed out. Output so far: ""`]);
    }, 20_000);

    test('an invalid program is not run', async () => {
        const result = await behaviourOf('fun main(): void { print 1 }', 'expect runs');
        expect(result.ok).toBe(false);
        expect(result.behaviour).toBeUndefined();
    });
});
