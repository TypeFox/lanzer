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

/**
 * Validate a Lox campaign built from `files` (alias → path and content), with `support` files
 * written as-is and the given run block, all in a fresh workspace.
 */
async function behaviourOfWorkspace(
    files: Record<string, { path: string; content: string }>,
    support: Record<string, { path: string; content: string }>,
    runBlock: string
): Promise<LanzerCampaignValidationResult> {
    const dir = await mkdtemp(join(tmpdir(), 'lanzer-behaviour-'));
    const workspace = join(dir, 'ws');
    await mkdir(workspace, { recursive: true });
    const campaignFile = join(dir, 'campaign.lanzer');
    await writeFile(campaignFile, [
        `import ${JSON.stringify(LOX_GRAMMAR)}`,
        'campaign multiFile {',
        '    workspace "ws"',
        ...Object.entries(files).map(([alias, file]) => `    file ${alias} at ${JSON.stringify(file.path)} generates LoxProgram {}`),
        ...Object.entries(support).map(([alias, file]) => `    support ${alias} at ${JSON.stringify(file.path)}`),
        `    ${runBlock}`,
        '}'
    ].join('\n'), 'utf8');
    for (const file of [...Object.values(files), ...Object.values(support)]) {
        await writeFile(join(workspace, file.path), file.content, 'utf8');
    }
    const resolved = await resolveLanzerCampaignFile(campaignFile, { validate: true });
    expect(resolved.issues).toEqual([]);
    const { Lanzer } = createLanzerLoxServices(NodeFileSystem);
    return Lanzer.lanzer.CampaignRunner.validateCampaign(resolved.resolvedCampaigns[0].request);
}

describe('running a Lox program that spans files', () => {
    const lib = { path: 'lib.lox', content: 'fun add(a: number, b: number): number { return a + b; }\nclass Counter { n: number }\nvar offset = 10;\nprint "lib loaded";' };

    test('the entry calls functions, classes and variables another file declares', async () => {
        const result = await behaviourOfWorkspace(
            { lib, main: { path: 'main.lox', content: 'var c = Counter(); c.n = add(1, 2); print c.n + offset;' } },
            {},
            'run main { expect output "13" }'
        );
        expect(result.documents.every((document) => document.issues.length === 0)).toBe(true);
        expect(result.behaviour).toMatchObject({ ok: true, runs: [{ entryAlias: 'main', execution: { output: '13\n' } }] });
    });

    test('another file\'s top-level statements are not run, only its declarations', async () => {
        const result = await behaviourOfWorkspace(
            { lib, main: { path: 'main.lox', content: 'print add(1, 2);' } },
            {},
            'run main { expect output "3" expect not output contains "lib loaded" }'
        );
        expect(result.behaviour?.issues).toEqual([]);
    });

    test('a support file can be the entry: a fixed driver calling the generated code', async () => {
        const generated = { lib: { path: 'lib.lox', content: 'fun square(n: number): number { return n * n; }' } };
        const driver = { driver: { path: 'driver.lox', content: 'print square(3);\nprint square(4);' } };
        const passing = await behaviourOfWorkspace(generated, driver, 'run driver { expect output "9\\n16" }');
        expect(passing.behaviour).toMatchObject({ ok: true, runs: [{ entryAlias: 'driver', execution: { output: '9\n16\n' } }] });

        const wrong = await behaviourOfWorkspace(
            { lib: { path: 'lib.lox', content: 'fun square(n: number): number { return n + n; }' } },
            driver,
            'run driver { expect output "9\\n16" }'
        );
        expect(wrong.behaviour?.issues).toEqual([`Run of 'driver': output must be exactly "9\\n16", but was "6\\n8\\n"`]);
    });
});
