import { mkdir, mkdtemp, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeFileSystem } from 'langium/node';
import { describe, expect, test } from 'vitest';
import { resolveLanzerCampaignFile, runLanzerCampaign, type LanzerAcpOptions } from 'lanzer';
import { createLanzerLoxServices } from '../src/lox-host.js';

const LOX_GRAMMAR = fileURLToPath(new URL('../../langium-lox/langium/src/language-server/lox.langium', import.meta.url));

/** A campaign in a fresh directory declaring `a.lox` and `b.lox`, of which only `a.lox` exists. */
async function halfWrittenCampaign() {
    const dir = await mkdtemp(join(tmpdir(), 'lanzer-missing-'));
    const campaignFile = join(dir, 'campaign.lanzer');
    await writeFile(campaignFile, [
        `import ${JSON.stringify(LOX_GRAMMAR)}`,
        'campaign halfWritten {',
        '    workspace "ws"',
        '    file a at "a.lox" generates LoxProgram { require FunctionDeclaration }',
        '    file b at "b.lox" generates LoxProgram { require FunctionDeclaration }',
        '}'
    ].join('\n'), 'utf8');
    const resolved = await resolveLanzerCampaignFile(campaignFile, { validate: true });
    expect(resolved.issues).toEqual([]);
    const [campaign] = resolved.resolvedCampaigns;
    const workspace = join(dir, 'ws');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'a.lox'), 'fun main(): void { print 1; }', 'utf8');
    return { campaign, missing: join(workspace, 'b.lox') };
}

describe('a declared file the agent never wrote', () => {
    test('is reported by the campaign runner rather than thrown', async () => {
        const { campaign, missing } = await halfWrittenCampaign();
        const { Lanzer } = createLanzerLoxServices(NodeFileSystem);

        const result = await Lanzer.lanzer.CampaignRunner.validateCampaign(campaign.request);

        expect(result.ok).toBe(false);
        expect(result.documents.map((document) => document.uri)).toEqual([expect.stringMatching(/a\.lox$/)]);
        expect(result.campaign?.issues).toEqual([
            `Generated file for 'b' was not found, or is not a document of the target language: ${missing}`
        ]);
    });
});

describe('a declared file removed between two validations', () => {
    test('is not validated from the copy loaded the first time', async () => {
        const { campaign, missing } = await halfWrittenCampaign();
        const { Lanzer } = createLanzerLoxServices(NodeFileSystem);
        const runner = Lanzer.lanzer.CampaignRunner;

        await writeFile(missing, 'fun main(): void { print 2; }', 'utf8');
        const first = await runner.validateCampaign(campaign.request);
        expect(first.ok).toBe(true);

        await unlink(missing);
        const second = await runner.validateCampaign(campaign.request);
        expect(second.ok).toBe(false);
        expect(second.documents).toHaveLength(1);
        expect(second.campaign?.issues).toEqual([
            `Generated file for 'b' was not found, or is not a document of the target language: ${missing}`
        ]);
    });
});

describe('a run that ends before producing a result', () => {
    async function runWith(acp: LanzerAcpOptions) {
        const { campaign } = await halfWrittenCampaign();
        const { Lanzer } = createLanzerLoxServices(NodeFileSystem);
        return runLanzerCampaign(campaign, { service: Lanzer.lanzer.Lanzer, runner: Lanzer.lanzer.CampaignRunner }, acp);
    }

    test('an agent command that does not exist is reported as launch', async () => {
        const run = await runWith({ command: '/nonexistent/lanzer-test-agent' });
        expect(run.report).toMatchObject({ ok: false, failedStage: 'launch' });
        expect(run.report?.failureMessage).toContain('no such command');
        expect(run.validation?.ok).toBe(false);
    });

    test('an agent that exits before the handshake is reported as session', async () => {
        const run = await runWith({ command: process.execPath, args: ['-e', ''] });
        expect(run.report).toMatchObject({ ok: false, failedStage: 'session' });
        expect(run.report?.failureMessage).toBeTruthy();
    });
});
