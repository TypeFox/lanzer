import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeFileSystem } from 'langium/node';
import { describe, expect, test } from 'vitest';
import { buildLanzerGenerationJobs, loadLanzerDocumentFromFile, resolveLanzerCampaignFile } from 'lanzer';
import { createLanzerLoxServices } from '../src/lox-host.js';

function example(name: string): string {
    return fileURLToPath(new URL(`../examples/${name}`, import.meta.url));
}

describe('shipped example campaigns against the Lox grammar', () => {
    test.each(['hello.lanzer', 'classes.lanzer', 'factorial.lanzer'])('%s is valid', async (name) => {
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
        const resolved = await resolveLanzerCampaignFile(example('factorial.lanzer'), { validate: true });
        const [campaign] = resolved.resolvedCampaigns;
        const [job] = buildLanzerGenerationJobs(campaign);
        await mkdir(dirname(job.absoluteOutputPath), { recursive: true });
        await writeFile(job.absoluteOutputPath, [
            'fun factorial(n: number): number { if (n <= 1) { return 1; } return n * factorial(n - 1); }',
            'for (var i = 1; i <= 5; i = i + 1) { print factorial(i); }'
        ].join('\n'), 'utf8');

        const result = await createLanzerLoxServices(NodeFileSystem).Lanzer.lanzer.CampaignRunner.validateCampaign(campaign.request);
        expect(result.campaign?.issues).toEqual([]);
        expect(result.behaviour).toMatchObject({ ok: true, runs: [{ entryAlias: 'mainFile', execution: { output: '1\n2\n6\n24\n120\n' } }] });
        expect(result.ok).toBe(true);
    });
});
