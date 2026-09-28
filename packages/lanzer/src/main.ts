import chalk from 'chalk';
import { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as url from 'node:url';
import { NodeFileSystem } from 'langium/node';
import { buildLanzerGenerationJobs, findLanzerGenerationJob } from './campaign/jobs.js';
import { loadLanzerDocumentFromFile } from './campaign/load.js';
import { resolveLanzerCampaignFile } from './campaign/resolve.js';
import { createLanzerServices } from './lanzer-module.js';
import { previewLanzerCampaignTask } from './services/campaign-run.js';
import { DefaultLanzerService } from './services/default-services.js';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const packagePath = path.resolve(__dirname, '..', 'package.json');
const packageContent = await fs.readFile(packagePath, 'utf-8');

export async function validateAction(fileName: string, options: { json?: boolean }): Promise<void> {
    const result = await loadLanzerDocumentFromFile(fileName, { validate: true });

    if (options.json) {
        console.log(JSON.stringify({
            ok: result.issues.length === 0,
            uri: result.document.uri.toString(),
            issueCount: result.issues.length,
            issues: result.issues
        }, null, 2));
        return;
    }

    if (result.issues.length === 0) {
        console.log(chalk.green(`Lanzer campaign is valid: ${result.document.uri.toString()}`));
        return;
    }

    console.log(chalk.red(`Lanzer campaign is invalid: ${result.document.uri.toString()}`));
    for (const issue of result.issues) {
        const location = issue.line !== undefined && issue.character !== undefined
            ? ` @ ${issue.line}:${issue.character}`
            : '';
        console.log(chalk.red(`- [${issue.kind}]${location} ${issue.message}`));
    }
    process.exitCode = 1;
}

export async function planAction(
    fileName: string,
    options: { json?: boolean; prompt?: boolean; job?: string }
): Promise<void> {
    const result = await resolveLanzerCampaignFile(fileName, { validate: true });
    if (result.issues.length > 0) {
        if (options.json) {
            console.log(JSON.stringify({
                ok: false,
                uri: result.document.uri.toString(),
                issues: result.issues
            }, null, 2));
        } else {
            console.log(chalk.red(`Lanzer campaign is invalid: ${result.document.uri.toString()}`));
            for (const issue of result.issues) {
                const location = issue.line !== undefined && issue.character !== undefined
                    ? ` @ ${issue.line}:${issue.character}`
                    : '';
                console.log(chalk.red(`- [${issue.kind}]${location} ${issue.message}`));
            }
        }
        process.exitCode = 1;
        return;
    }

    const jobs = result.resolvedCampaigns.flatMap((campaign) => buildLanzerGenerationJobs(campaign));
    const selectedJobs = options.job
        ? [findLanzerGenerationJob(jobs, options.job)].filter((job): job is NonNullable<typeof job> => Boolean(job))
        : jobs;

    if (options.job && selectedJobs.length === 0) {
        console.log(chalk.red(`Generation job not found: ${options.job}`));
        process.exitCode = 1;
        return;
    }

    // The prompt is per campaign — `generate` sends one for the whole file set — so it is previewed
    // once for each campaign the selected jobs belong to. This generic CLI has no host language, so
    // it previews without a host's policy or DSL skill; a host's own CLI previews with them.
    const prompts = options.prompt ? await previewPrompts(result.resolvedCampaigns, selectedJobs.map((job) => job.campaignName)) : [];

    if (options.json) {
        console.log(JSON.stringify({
            ok: true,
            uri: result.document.uri.toString(),
            jobs: selectedJobs,
            ...(options.prompt ? { prompts } : {})
        }, null, 2));
        return;
    }

    console.log(chalk.green(`Lanzer campaign planned successfully: ${result.document.uri.toString()}`));
    for (const job of selectedJobs) {
        console.log(chalk.cyan(`${job.id} -> ${job.absoluteOutputPath}`));
        console.log(`  root rule: ${job.rootRule}`);
        if (job.workspaceRoot) {
            console.log(`  workspace: ${job.workspaceRoot}`);
        }
        if (job.requirements.length > 0) {
            console.log(`  requirements: ${job.requirements.length}`);
        }
    }
    for (const { campaign, prompt } of prompts) {
        console.log('');
        console.log(chalk.cyan(`Prompt for campaign ${campaign}`) + chalk.dim(' (no host language: its generation policy and DSL skill are not included)'));
        console.log(prompt);
    }
}

async function previewPrompts(
    campaigns: Awaited<ReturnType<typeof resolveLanzerCampaignFile>>['resolvedCampaigns'],
    campaignNames: string[]
): Promise<{ campaign: string; prompt: string }[]> {
    const { shared, Lanzer } = createLanzerServices(NodeFileSystem);
    const service = new DefaultLanzerService(shared, Lanzer);
    const wanted = new Set(campaignNames);
    const prompts: { campaign: string; prompt: string }[] = [];
    for (const campaign of campaigns.filter((resolved) => wanted.has(resolved.campaign.name))) {
        prompts.push({ campaign: campaign.campaign.name, prompt: (await previewLanzerCampaignTask(campaign, service)).prompt });
    }
    return prompts;
}

export default function main(): void {
    const program = new Command();
    program.version(JSON.parse(packageContent).version);

    program
        .command('validate')
        .argument('<file>', 'Lanzer campaign file')
        .option('--json', 'print validation result as JSON')
        .description('validate a .lanzer campaign file')
        .action(validateAction);

    program
        .command('plan')
        .argument('<file>', 'Lanzer campaign file')
        .option('--json', 'print generation jobs as JSON')
        .option('--prompt', 'include the ACP-facing prompt preview')
        .option('--job <selector>', 'select one job by id or file alias')
        .description('resolve a valid .lanzer campaign into concrete generation jobs')
        .action(planAction);

    program.parse(process.argv);
}
