import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeFileSystem } from 'langium/node';
import { describe, expect, test } from 'vitest';
import { previewLanzerCampaignTask, resolveLanzerCampaignFile, type LanzerResolvedCampaign } from 'lanzer';
import { createLanzerLoxServices } from '../src/lox-host.js';

const LOX_GRAMMAR = fileURLToPath(new URL('../../langium-lox/langium/src/language-server/lox.langium', import.meta.url));

/** A one-file Lox campaign whose `main.lox` must meet the given expectation lines. */
async function negativeCampaign(expectations: string, program?: string): Promise<LanzerResolvedCampaign> {
    const dir = await mkdtemp(join(tmpdir(), 'lanzer-negative-'));
    const campaignFile = join(dir, 'campaign.lanzer');
    await writeFile(campaignFile, [
        `import ${JSON.stringify(LOX_GRAMMAR)}`,
        'campaign negativeFile {',
        '    workspace "ws"',
        `    file main at "main.lox" generates LoxProgram { ${expectations} }`,
        '}'
    ].join('\n'), 'utf8');
    const resolved = await resolveLanzerCampaignFile(campaignFile, { validate: true });
    expect(resolved.issues).toEqual([]);
    if (program !== undefined) {
        await mkdir(join(dir, 'ws'), { recursive: true });
        await writeFile(join(dir, 'ws', 'main.lox'), program, 'utf8');
    }
    return resolved.resolvedCampaigns[0];
}

describe('Lox negative files', () => {
    test('see the warnings an ordinary file is forgiven', async () => {
        const campaign = await negativeCampaign(
            'expect warning code "LOX_INCOMPARABLE_TYPES" message contains "always return"',
            'var same: boolean = 1 == "one";'
        );
        const { CampaignRunner } = createLanzerLoxServices(NodeFileSystem).Lanzer.lanzer;
        const result = await CampaignRunner.validateCampaign(campaign.request);
        expect(result.diagnostics).toMatchObject({ ok: true, issues: [] });
        expect(result.ok).toBe(true);
    });

    test('an ordinary file still passes with that warning', async () => {
        const campaign = await negativeCampaign('', 'var same: boolean = 1 == "one";');
        const { CampaignRunner } = createLanzerLoxServices(NodeFileSystem).Lanzer.lanzer;
        const result = await CampaignRunner.validateCampaign(campaign.request);
        expect(result.documents[0].issues).toEqual([]);
        expect(result.diagnostics).toBeUndefined();
        expect(result.ok).toBe(true);
    });

    test('a code Lox never reports is rejected before any agent starts', async () => {
        const campaign = await negativeCampaign('expect error code "LOX_NO_SUCH_THING"');
        const { Lanzer } = createLanzerLoxServices(NodeFileSystem).Lanzer.lanzer;
        await expect(previewLanzerCampaignTask(campaign, Lanzer)).rejects.toThrow(
            /expects diagnostic code\(s\) the host never reports: LOX_NO_SUCH_THING\. Known codes: LOX_UNRESOLVED_REFERENCE, /
        );
    });

    test('a code Lox reports is accepted', async () => {
        const campaign = await negativeCampaign('expect error code "LOX_TYPE_NOT_ASSIGNABLE"');
        const { Lanzer } = createLanzerLoxServices(NodeFileSystem).Lanzer.lanzer;
        const task = await previewLanzerCampaignTask(campaign, Lanzer);
        expect(task.prompt).toContain('- an error with code "LOX_TYPE_NOT_ASSIGNABLE"');
    });
});
