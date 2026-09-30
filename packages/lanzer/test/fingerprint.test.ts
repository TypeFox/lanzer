import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, test } from 'vitest';
import { collectLanzerCampaignFiles } from '../src/campaign/suite.js';
import type { LanzerCampaignSpec } from '../src/campaign/model.js';
import { fingerprintLanzerRun, getLanzerVersion, hashDirectory, normalisePrompt } from '../src/report/fingerprint.js';

let dir: string;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lanzer-fingerprint-'));
});

async function skill(name: string, files: Record<string, string>): Promise<string> {
    const root = join(dir, name);
    for (const [path, content] of Object.entries(files)) {
        await mkdir(join(root, path, '..'), { recursive: true });
        await writeFile(join(root, path), content, 'utf8');
    }
    return root;
}

describe('hashDirectory', () => {
    test('is the same for the same content, wherever the folder is', async () => {
        const files = { 'SKILL.md': '# write-lox', 'references/grammar.md': 'grammar' };
        expect(await hashDirectory(await skill('one', files))).toBe(await hashDirectory(await skill('two', files)));
    });

    test('changes when a file is edited, added or renamed', async () => {
        const root = await skill('skill', { 'SKILL.md': '# write-lox', 'references/grammar.md': 'grammar' });
        const hashes = [await hashDirectory(root)];
        await writeFile(join(root, 'SKILL.md'), '# write-lox v2', 'utf8');
        hashes.push(await hashDirectory(root));
        await writeFile(join(root, 'references', 'semantics.md'), 'semantics', 'utf8');
        hashes.push(await hashDirectory(root));
        await rename(join(root, 'references', 'semantics.md'), join(root, 'references', 'rules.md'));
        hashes.push(await hashDirectory(root));
        expect(new Set(hashes).size).toBe(4);
    });

    test('is undefined for a folder that does not exist', async () => {
        expect(await hashDirectory(join(dir, 'missing'))).toBeUndefined();
    });
});

describe('fingerprintLanzerRun', () => {
    test('records the Lanzer version, the skill, each grammar and the campaign file, with hashes', async () => {
        const skillRoot = await skill('write-lox', { 'SKILL.md': '# write-lox' });
        await writeFile(join(dir, 'lang.langium'), 'grammar Lang', 'utf8');
        await writeFile(join(dir, 'bench.lanzer'), 'campaign c {}', 'utf8');
        const campaign: LanzerCampaignSpec = {
            name: 'c',
            baseDir: dir,
            sourceUri: pathToFileURL(join(dir, 'bench.lanzer')).toString(),
            imports: ['lang.langium', 'missing.langium'],
            files: [],
            supportFiles: [],
            requirements: [],
            runs: []
        };
        const fingerprint = await fingerprintLanzerRun(campaign, { name: 'write-lox', path: skillRoot });
        expect(fingerprint).toEqual({
            lanzerVersion: getLanzerVersion(),
            skill: { name: 'write-lox', path: skillRoot, hash: await hashDirectory(skillRoot) },
            grammars: [
                { path: join(dir, 'lang.langium'), hash: expect.stringMatching(/^[0-9a-f]{64}$/) },
                // Recorded without a hash rather than left out: the campaign did import it.
                { path: join(dir, 'missing.langium') }
            ],
            campaign: { path: join(dir, 'bench.lanzer'), hash: expect.stringMatching(/^[0-9a-f]{64}$/) }
        });
        expect(getLanzerVersion()).toMatch(/^\d+\.\d+\.\d+/);
    });

    test('has no skill entry when the host offers no skill', async () => {
        const campaign: LanzerCampaignSpec = { name: 'c', baseDir: dir, imports: [], files: [], supportFiles: [], requirements: [], runs: [] };
        expect(await fingerprintLanzerRun(campaign, undefined)).toEqual({ lanzerVersion: getLanzerVersion(), grammars: [] });
    });
});

describe('collectLanzerCampaignFiles', () => {
    test('expands folders into their own .lanzer files, sorted, and keeps files as given', async () => {
        await mkdir(join(dir, 'suite', 'workspace'), { recursive: true });
        await writeFile(join(dir, 'suite', 'b.lanzer'), '', 'utf8');
        await writeFile(join(dir, 'suite', 'a.lanzer'), '', 'utf8');
        await writeFile(join(dir, 'suite', 'notes.md'), '', 'utf8');
        // A workspace's own .lanzer file is not part of the suite.
        await writeFile(join(dir, 'suite', 'workspace', 'nested.lanzer'), '', 'utf8');
        await writeFile(join(dir, 'extra.lanzer'), '', 'utf8');
        expect(await collectLanzerCampaignFiles([join(dir, 'extra.lanzer'), join(dir, 'suite'), join(dir, 'suite', 'a.lanzer')])).toEqual([
            join(dir, 'extra.lanzer'),
            join(dir, 'suite', 'a.lanzer'),
            join(dir, 'suite', 'b.lanzer')
        ]);
    });

    test('refuses a missing path and a folder with no campaigns', async () => {
        await mkdir(join(dir, 'empty'));
        await expect(collectLanzerCampaignFiles([join(dir, 'nope.lanzer')])).rejects.toThrow(/No such campaign file or folder/);
        await expect(collectLanzerCampaignFiles([join(dir, 'empty')])).rejects.toThrow(/No \.lanzer campaign files in/);
    });
});

describe('the prompt and host policy in the fingerprint', () => {
    const campaign: LanzerCampaignSpec = { name: 'c', imports: [], files: [], supportFiles: [], requirements: [], runs: [] };

    test('are hashed when given, and left out when not', async () => {
        const fingerprint = await fingerprintLanzerRun(campaign, undefined, { prompt: 'Write main.mini.', policy: { instructions: ['Be typed.'] } });
        expect(fingerprint.promptHash).toMatch(/^[0-9a-f]{64}$/);
        expect(fingerprint.policyHash).toMatch(/^[0-9a-f]{64}$/);
        const bare = await fingerprintLanzerRun(campaign, undefined);
        expect(bare).not.toHaveProperty('promptHash');
        expect(bare).not.toHaveProperty('policyHash');
    });

    test('hash the policy by content, not by key order', async () => {
        const one = await fingerprintLanzerRun(campaign, undefined, { policy: { summary: 's', instructions: ['a', 'b'] } });
        const other = await fingerprintLanzerRun(campaign, undefined, { policy: { instructions: ['a', 'b'], summary: 's', referenceFiles: undefined } });
        const edited = await fingerprintLanzerRun(campaign, undefined, { policy: { summary: 's', instructions: ['a', 'c'] } });
        expect(one.policyHash).toBe(other.policyHash);
        expect(one.policyHash).not.toBe(edited.policyHash);
    });

    test('normalisePrompt replaces every mention of the workspace, so identical runs in different folders agree', () => {
        const run1 = normalisePrompt('Write /runs/run-1/main.lox and read /runs/run-1/driver.lox.', '/runs/run-1');
        const run2 = normalisePrompt('Write /runs/run-2/main.lox and read /runs/run-2/driver.lox.', '/runs/run-2');
        expect(run1).toBe('Write <workspace>/main.lox and read <workspace>/driver.lox.');
        expect(run2).toBe(run1);
        expect(normalisePrompt('unchanged', undefined)).toBe('unchanged');
    });
});
