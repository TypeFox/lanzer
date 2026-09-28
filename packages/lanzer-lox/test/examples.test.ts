import { mkdir, writeFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeFileSystem } from 'langium/node';
import { describe, expect, test } from 'vitest';
import {
    buildLanzerGenerationJobs,
    loadLanzerDocumentFromFile,
    resolveLanzerCampaignFile,
    type LanzerCampaignValidationResult
} from 'lanzer';
import { createLanzerLoxServices } from '../src/lox-host.js';

function example(name: string): string {
    return fileURLToPath(new URL(`../examples/${name}`, import.meta.url));
}

/**
 * Write `sources` (by file alias) as the generated files of a shipped example, then run the full
 * campaign check on them — validation, requirements and behaviour — as a generation run would.
 */
async function solve(name: string, sources: Record<string, string>): Promise<LanzerCampaignValidationResult> {
    const resolved = await resolveLanzerCampaignFile(example(name), { validate: true });
    expect(resolved.issues).toEqual([]);
    const [campaign] = resolved.resolvedCampaigns;
    for (const job of buildLanzerGenerationJobs(campaign)) {
        const source = sources[job.fileAlias];
        if (source === undefined) {
            throw new Error(`No source given for ${job.fileAlias} in ${name}`);
        }
        await mkdir(dirname(job.absoluteOutputPath), { recursive: true });
        await writeFile(job.absoluteOutputPath, source, 'utf8');
    }
    return createLanzerLoxServices(NodeFileSystem).Lanzer.lanzer.CampaignRunner.validateCampaign(campaign.request);
}

const FIZZBUZZ_HELPER = 'fun divisibleBy(n: number, d: number): boolean { var r = n; while (r >= d) { r = r - d; } return r == 0; }';

/** A FizzBuzz body; `order` is the divisors checked, first match wins. */
function fizzbuzzProgram(order: [number, string][]): string {
    const branches = order.reduceRight(
        (otherwise, [divisor, word]) => `if (divisibleBy(n, ${divisor})) { print "${word}"; } else { ${otherwise} }`,
        'print n;'
    );
    return [
        FIZZBUZZ_HELPER,
        `fun fizzbuzz(n: number): void { ${branches} }`,
        'var i = 1;',
        'while (i <= 15) { fizzbuzz(i); i = i + 1; }'
    ].join('\n');
}

const GEOMETRY_LIB = [
    'fun square(n: number): number { return n * n; }',
    'fun rectangleArea(w: number, h: number): number { return w * h; }',
    'fun hypotenuseSquared(a: number, b: number): number { return square(a) + square(b); }',
    'fun isRightTriangle(a: number, b: number, c: number): boolean { return hypotenuseSquared(a, b) == square(c); }'
].join('\n');

describe('shipped example campaigns against the Lox grammar', () => {
    test.each(['hello.lanzer', 'classes.lanzer', 'factorial.lanzer', 'fizzbuzz.lanzer', 'geometry.lanzer', 'near-miss.lanzer'])('%s is valid', async (name) => {
        const result = await loadLanzerDocumentFromFile(example(name), { validate: true });
        expect(result.issues).toEqual([]);
    });

    test('invalid-demo.lanzer reports exactly its two deliberate mistakes', async () => {
        const result = await loadLanzerDocumentFromFile(example('invalid-demo.lanzer'), { validate: true });
        expect(result.issues.map((issue) => [issue.line, issue.character, issue.message])).toEqual([
            [11, 17, "Could not resolve reference to AbstractRule named 'NonExistentNode'."],
            [12, 37, "Type 'FunctionDeclaration' has no property 'notAProp'."]
        ]);
    });

    test('factorial.lanzer is met by a correct program, run and all', async () => {
        const result = await solve('factorial.lanzer', {
            mainFile: [
                'fun factorial(n: number): number { if (n <= 1) { return 1; } return n * factorial(n - 1); }',
                'for (var i = 1; i <= 5; i = i + 1) { print factorial(i); }'
            ].join('\n')
        });
        expect(result.campaign?.issues).toEqual([]);
        expect(result.behaviour).toMatchObject({ ok: true, runs: [{ entryAlias: 'mainFile', execution: { output: '1\n2\n6\n24\n120\n' } }] });
        expect(result.ok).toBe(true);
    });

    test('fizzbuzz.lanzer is met by a correct program, every expectation holding', async () => {
        const result = await solve('fizzbuzz.lanzer', { mainFile: fizzbuzzProgram([[15, 'FizzBuzz'], [3, 'Fizz'], [5, 'Buzz']]) });
        expect(result.documents.flatMap((document) => document.issues)).toEqual([]);
        expect(result.campaign?.issues).toEqual([]);
        expect(result.behaviour).toMatchObject({ ok: true, issues: [] });
        expect(result.ok).toBe(true);
    });

    test('fizzbuzz.lanzer fails at behaviour for a near miss that checks 3 before 15', async () => {
        const result = await solve('fizzbuzz.lanzer', { mainFile: fizzbuzzProgram([[3, 'Fizz'], [5, 'Buzz'], [15, 'FizzBuzz']]) });
        expect(result.campaign?.issues).toEqual([]);
        expect(result.behaviour?.issues).toEqual([
            expect.stringMatching(/^Run of 'mainFile': output must be exactly ".*FizzBuzz\\n", but was ".*14\\nFizz\\n"$/),
            expect.stringMatching(/^Run of 'mainFile': output must contain "FizzBuzz", but was /)
        ]);
    });

    test('geometry.lanzer runs its provided driver against a correct library', async () => {
        const result = await solve('geometry.lanzer', { lib: GEOMETRY_LIB });
        expect(result.documents.flatMap((document) => document.issues)).toEqual([]);
        expect(result.behaviour).toMatchObject({
            ok: true,
            runs: [{ entryAlias: 'driver', execution: { output: '9\n10\n25\ntrue\nfalse\n' } }]
        });
    });

    test('geometry.lanzer fails at behaviour when the library computes the wrong thing', async () => {
        const result = await solve('geometry.lanzer', { lib: GEOMETRY_LIB.replace('return n * n;', 'return n + n;') });
        expect(result.campaign?.issues).toEqual([]);
        expect(result.behaviour?.issues).toEqual([
            `Run of 'driver': output must be exactly "9\\n10\\n25\\ntrue\\nfalse\\n", but was "6\\n10\\n14\\nfalse\\nfalse\\n"`
        ]);
    });
});

describe('near-miss.lanzer', () => {
    const TOTAL = 'fun total(a: number, b: number): number { return a + b; }';

    test('is met by a program making exactly the asked-for mistake', async () => {
        const result = await solve('near-miss.lanzer', { mainFile: `${TOTAL}\nvar label: string = total(1, 2);` });
        expect(result.documents[0]).toMatchObject({
            expectsDiagnostics: true,
            issues: [{ code: 'LOX_TYPE_NOT_ASSIGNABLE', message: "Type 'number' is not assignable to type 'string'." }]
        });
        expect(result.diagnostics).toMatchObject({ ok: true, issues: [], files: [{ fileAlias: 'mainFile', missing: [], unexpected: [] }] });
        expect(result.campaign?.issues).toEqual([]);
        expect(result.ok).toBe(true);
    });

    test('fails when the program is wrong in a second way too', async () => {
        const result = await solve('near-miss.lanzer', { mainFile: `${TOTAL}\nvar label: string = total(1, 2);\nprint missing;` });
        expect(result.ok).toBe(false);
        expect(result.diagnostics?.files[0].missing).toEqual([]);
        expect(result.diagnostics?.issues).toEqual([
            expect.stringMatching(/main\.lox:3:\d+: \[unexpected error\] \[LOX_UNRESOLVED_REFERENCE\] Could not resolve reference/)
        ]);
    });

    test('fails when the program is correct, the mistake missing', async () => {
        const result = await solve('near-miss.lanzer', { mainFile: `${TOTAL}\nvar sum: number = total(1, 2);` });
        expect(result.ok).toBe(false);
        expect(result.diagnostics?.issues).toEqual([
            expect.stringMatching(/main\.lox: \[missing diagnostic\] expected an error with code "LOX_TYPE_NOT_ASSIGNABLE" and a message matching .+, but the language reported none$/)
        ]);
    });

    test('fails when a different mistake stands in for the asked-for one', async () => {
        const result = await solve('near-miss.lanzer', { mainFile: `${TOTAL}\nvar sum: number = total(1);` });
        expect(result.ok).toBe(false);
        expect(result.diagnostics?.files[0].missing).toHaveLength(1);
        expect(result.diagnostics?.files[0].unexpected.map((issue) => issue.code)).toEqual(['LOX_ARITY_MISMATCH']);
    });
});

describe('reference campaigns shipped with the lanzer skill', () => {
    const references = fileURLToPath(new URL('../../../skills/lanzer/references/', import.meta.url));

    test.each(readdirSync(references).filter((name) => name.endsWith('.lanzer')))('%s is valid', async (name) => {
        const result = await loadLanzerDocumentFromFile(join(references, name), { validate: true });
        expect(result.issues).toEqual([]);
    });
});
