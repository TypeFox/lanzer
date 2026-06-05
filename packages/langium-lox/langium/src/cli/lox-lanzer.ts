import { Command } from 'commander';
import {
    buildLanzerAgentTask,
    buildLanzerGenerationJobs,
    findLanzerGenerationJob,
    loadLanzerDocumentFromFile,
    resolveAcpOptionsFromEnv,
    resolveLanzerCampaignFile
} from 'lanzer';
import { runLoxCampaignFile } from '../language-server/lanzer/run-campaign.js';

/** Validate a campaign file and print the result (mirrors `lanzer validate`). */
async function validateAction(fileName: string, options: { json?: boolean }): Promise<void> {
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
        console.log(`Lanzer campaign is valid: ${result.document.uri.toString()}`);
        return;
    }
    console.error(`Lanzer campaign is invalid: ${result.document.uri.toString()}`);
    for (const issue of result.issues) {
        const location = issue.line !== undefined && issue.character !== undefined
            ? ` @ ${issue.line}:${issue.character}`
            : '';
        console.error(`- [${issue.kind}]${location} ${issue.message}`);
    }
    process.exitCode = 1;
}

/** Resolve a campaign into concrete generation jobs (mirrors `lanzer plan`). */
async function planAction(
    fileName: string,
    options: { json?: boolean; prompt?: boolean; job?: string }
): Promise<void> {
    const result = await resolveLanzerCampaignFile(fileName, { validate: true });
    if (result.issues.length > 0) {
        console.error(`Lanzer campaign is invalid: ${result.document.uri.toString()}`);
        for (const issue of result.issues) {
            console.error(`- [${issue.kind}] ${issue.message}`);
        }
        process.exitCode = 1;
        return;
    }
    const jobs = result.resolvedCampaigns.flatMap((campaign) => buildLanzerGenerationJobs(campaign));
    const selected = options.job
        ? [findLanzerGenerationJob(jobs, options.job)].filter((job): job is NonNullable<typeof job> => Boolean(job))
        : jobs;
    if (options.job && selected.length === 0) {
        console.error(`Generation job not found: ${options.job}`);
        process.exitCode = 1;
        return;
    }
    if (options.json) {
        console.log(JSON.stringify({
            ok: true,
            uri: result.document.uri.toString(),
            jobs: selected.map((job) => options.prompt ? buildLanzerAgentTask(job) : job)
        }, null, 2));
        return;
    }
    console.log(`Lanzer campaign planned successfully: ${result.document.uri.toString()}`);
    for (const job of selected) {
        console.log(`${job.id} -> ${job.absoluteOutputPath}`);
        console.log(`  root rule: ${job.rootRule}`);
        if (job.workspaceRoot) console.log(`  workspace: ${job.workspaceRoot}`);
        if (job.requirements.length > 0) console.log(`  requirements: ${job.requirements.length}`);
        if (options.prompt) {
            console.log('\nPrompt');
            console.log(buildLanzerAgentTask(job).prompt);
            console.log('');
        }
    }
}

/**
 * Prebuilt CLI for driving Lanzer campaigns that target the Lox grammar.
 *
 * `generate` is the headline command: it runs a `.lanzer` campaign through an agent over ACP
 * using the Lox-aware services (Lox generation policy + the `write-lox` skill + post-generation
 * requirement validation). `validate` and `plan` re-expose the corresponding `lanzer` library
 * actions for convenience so this is a single tool.
 *
 * ACP transport is configured from the `LANZER_ACP_*` environment variables (see `.env.copy`).
 * Load your `.env` before invoking, e.g. `node --env-file=.env ./bin/lox-lanzer.js generate ...`.
 */
export function createLoxLanzerCli(): Command {
    const program = new Command();
    program
        .name('lox-lanzer')
        .description('Run, validate, and plan Lanzer campaigns targeting the Lox grammar.');

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
        .option('--prompt', 'include the agent-facing prompt preview')
        .option('--job <selector>', 'select one job by id or file alias')
        .description('resolve a valid .lanzer campaign into concrete generation jobs')
        .action(planAction);

    program
        .command('generate')
        .argument('<file>', 'Lanzer campaign file')
        .option('--command <bin>', 'override the ACP command (else LANZER_ACP_COMMAND)')
        .option('--model <model>', 'override the model (else LANZER_ACP_MODEL)')
        .option('--max-attempts <n>', 'override prompts per session (else LANZER_ACP_MAX_ATTEMPTS)')
        .option('--quiet', 'suppress per-event progress output')
        .description('run a .lanzer campaign through an agent to generate the target .lox file(s)')
        .action(async (file: string, options: { command?: string; model?: string; maxAttempts?: string; quiet?: boolean }) => {
            const acp = resolveAcpOptionsFromEnv({
                ...(options.command ? { command: options.command } : {}),
                ...(options.model ? { model: options.model } : {}),
                ...(options.maxAttempts ? { maxAttempts: Number.parseInt(options.maxAttempts, 10) } : {}),
                ...(options.quiet ? {} : { progress: { label: 'lox', verbose: false } })
            });

            const { runs } = await runLoxCampaignFile(file, acp);
            let failed = 0;
            for (const run of runs) {
                const label = 'campaignName' in run.task ? run.task.campaignName : 'campaign';
                const ok = run.validation?.ok ?? true;
                if (!ok) {
                    failed += 1;
                    console.error(`✗ ${label} — requirements not satisfied:`);
                    for (const issue of run.validation?.issues ?? []) {
                        console.error(`  - ${issue}`);
                    }
                } else {
                    console.log(`✓ ${label} — generated and validated`);
                }
            }
            if (failed > 0) process.exitCode = 1;
        });

    return program;
}
