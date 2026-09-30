import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import { buildLanzerGenerationJobs } from '../src/campaign/jobs.js';
import { resolveLanzerCampaign } from '../src/campaign/map.js';
import type { LanzerCampaignSpec } from '../src/campaign/model.js';
import { getCampaignFileAbsolutePath, getCampaignWorkspaceRoot } from '../src/campaign/paths.js';
import { fixture, loadCampaignSpecs } from './helpers.js';

/** A campaign built in code, with only what path resolution reads. */
function spec(overrides: Partial<LanzerCampaignSpec>): LanzerCampaignSpec {
    return { name: 'demo', imports: [], files: [], supportFiles: [], requirements: [], runs: [], ...overrides };
}

describe('the workspace root', () => {
    test('is the workspace resolved against the base directory', () => {
        expect(getCampaignWorkspaceRoot(spec({ baseDir: '/project/campaigns', workspaceRoot: '../out' }))).toBe('/project/out');
    });

    test('an absolute workspace ignores the base directory', () => {
        expect(getCampaignWorkspaceRoot(spec({ baseDir: '/project/campaigns', workspaceRoot: '/elsewhere/ws' }))).toBe('/elsewhere/ws');
    });

    test('without a base directory it is resolved against the current directory, and is still absolute', () => {
        expect(getCampaignWorkspaceRoot(spec({ workspaceRoot: 'out' }))).toBe(path.resolve(process.cwd(), 'out'));
    });

    test('without a workspace it is the base directory', () => {
        expect(getCampaignWorkspaceRoot(spec({ baseDir: '/project/campaigns' }))).toBe('/project/campaigns');
    });
});

describe('a declared file', () => {
    test('resolves under the workspace root, generated and support alike', () => {
        const campaign = spec({ baseDir: '/project', workspaceRoot: 'ws' });
        expect(getCampaignFileAbsolutePath(campaign, { path: 'src/main.mini' })).toBe('/project/ws/src/main.mini');
        expect(getCampaignFileAbsolutePath(campaign, { path: 'driver.mini' })).toBe('/project/ws/driver.mini');
    });
});

describe('every consumer agrees', () => {
    test('jobs, the validation request and the checks name the same paths for a loaded campaign', async () => {
        const [campaign] = await loadCampaignSpecs([
            'import "mini.langium"',
            'campaign demo {',
            '    workspace "out"',
            '    file main at "src/main.mini" generates Module {}',
            '    support driver at "driver.mini"',
            '    run driver { expect runs }',
            '}'
        ].join('\n'));
        const resolved = resolveLanzerCampaign(campaign);
        const [job] = buildLanzerGenerationJobs(resolved);
        const root = path.join(path.dirname(fixture('inline.lanzer')), 'out');
        const main = path.join(root, 'src/main.mini');
        const driver = path.join(root, 'driver.mini');

        expect(getCampaignWorkspaceRoot(campaign)).toBe(root);
        expect(getCampaignFileAbsolutePath(campaign, campaign.files[0])).toBe(main);
        expect(getCampaignFileAbsolutePath(campaign, campaign.supportFiles[0])).toBe(driver);
        expect(job.workspaceRoot).toBe(root);
        expect(job.absoluteOutputPath).toBe(main);
        expect(job.supportFiles[0].absolutePath).toBe(driver);
        expect(job.runs[0].absoluteEntryPath).toBe(driver);
        expect(resolved.request.documents.map((document) => document.path)).toEqual([driver, main]);
        expect(resolved.request.workspaces[0].uri).toBe(pathToFileURL(root).toString());
    });

    test('a campaign built in code with neither workspace nor base directory resolves against the current directory everywhere', () => {
        const campaign = spec({
            files: [{ alias: 'main', path: 'main.mini', rootRule: 'Module', rootAstType: 'Module', requirements: [], diagnostics: [] }]
        });
        const expected = path.resolve(process.cwd(), 'main.mini');
        const [job] = buildLanzerGenerationJobs(resolveLanzerCampaign(campaign));
        expect(job.absoluteOutputPath).toBe(expected);
        expect(resolveLanzerCampaign(campaign).request.documents[0].path).toBe(expected);
        expect(getCampaignFileAbsolutePath(campaign, campaign.files[0])).toBe(expected);
    });
});
