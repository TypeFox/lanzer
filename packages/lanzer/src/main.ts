import chalk from 'chalk';
import { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as url from 'node:url';
import { buildLanzerGenerationJobs, findLanzerGenerationJob } from './campaign/jobs.js';
import { loadLanzerDocumentFromFile } from './campaign/load.js';
import { buildLanzerAgentTask } from './campaign/prompt.js';
import { resolveLanzerCampaignFile } from './campaign/resolve.js';

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

    if (options.json) {
        console.log(JSON.stringify({
            ok: true,
            uri: result.document.uri.toString(),
            jobs: selectedJobs.map((job) => options.prompt ? buildLanzerAgentTask(job) : job)
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
        if (options.prompt) {
            const task = buildLanzerAgentTask(job);
            console.log('');
            console.log('Prompt');
            console.log(task.prompt);
            console.log('');
        }
    }
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
