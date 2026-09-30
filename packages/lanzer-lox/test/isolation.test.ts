import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeFileSystem } from 'langium/node';
import { describe, expect, test } from 'vitest';
import { resolveLanzerCampaign, resolveLanzerCampaignFile, type LanzerResolvedCampaign } from 'lanzer';
import { createLanzerLoxServices } from '../src/lox-host.js';

const LOX_GRAMMAR = fileURLToPath(new URL('../../langium-lox/langium/src/language-server/lox.langium', import.meta.url));

/** The same one-file campaign, moved into `workspace`, with `program` as its generated file. */
async function runIn(campaign: LanzerResolvedCampaign, workspace: string, program: string): Promise<LanzerResolvedCampaign> {
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'main.lox'), program, 'utf8');
    return resolveLanzerCampaign({ ...campaign.campaign, workspaceRoot: workspace });
}

describe('validating several runs of one campaign', () => {
    test('shares names between runs when they share services, which is why each run gets its own', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'lanzer-isolation-'));
        const campaignFile = join(dir, 'campaign.lanzer');
        await writeFile(campaignFile, [
            `import ${JSON.stringify(LOX_GRAMMAR)}`,
            'campaign isolated {',
            '    workspace "ws"',
            '    file main at "main.lox" generates LoxProgram {}',
            '}'
        ].join('\n'), 'utf8');
        const [campaign] = (await resolveLanzerCampaignFile(campaignFile, { validate: true })).resolvedCampaigns;

        // Run 1 defines helper(); run 2 calls it without defining it, which is an error on its own.
        const first = await runIn(campaign, join(dir, 'run-1'), 'fun helper(): number { return 1; }');
        const second = await runIn(campaign, join(dir, 'run-2'), 'var x: number = helper();');

        const shared = createLanzerLoxServices(NodeFileSystem).Lanzer.lanzer.CampaignRunner;
        expect((await shared.validateCampaign(first.request)).ok).toBe(true);
        // Wrongly accepted: helper() resolves to run 1's file, still loaded in the same workspace.
        expect((await shared.validateCampaign(second.request)).ok).toBe(true);

        const fresh = createLanzerLoxServices(NodeFileSystem).Lanzer.lanzer.CampaignRunner;
        const alone = await fresh.validateCampaign(second.request);
        expect(alone.ok).toBe(false);
        expect(alone.documents[0].issues).toContainEqual(expect.objectContaining({ code: 'LOX_UNRESOLVED_REFERENCE' }));
    });
});
