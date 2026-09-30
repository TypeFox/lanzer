import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { NodeFileSystem } from 'langium/node';
import {
    buildLanzerGenerationJobs,
    describePermissionPolicy,
    findLanzerGenerationJob,
    loadLanzerDocumentFromFile,
    buildLanzerSuiteReport,
    collectLanzerCampaignFiles,
    compareLanzerSuiteReports,
    describeSelectableTypes,
    lanzerTransportServesTools,
    loadGrammarsFor,
    meetsMinPass,
    parseMinPass,
    permissiveLanzerPolicy,
    previewLanzerCampaignTask,
    readLanzerSuiteReport,
    renderLanzerSuiteComparison,
    renderLanzerRunSummary,
    renderLanzerSuiteSummary,
    renderSelectableTypes,
    resolveAcpOptionsFromEnv,
    resolveLanzerCampaignFile,
    resolvePermissionPolicy,
    type LanzerSuiteReport
} from 'lanzer';
import { createLanzerLoxServices } from './lox-host.js';
import { runLoxCampaignFiles } from './run-campaign.js';

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
    options: { json?: boolean; prompt?: boolean; job?: string; skill?: string | false; policy?: string }
): Promise<void> {
    if (options.policy !== undefined && options.policy !== 'full' && options.policy !== 'minimal') {
        console.error(`--policy must be full or minimal, not "${options.policy}"`);
        process.exitCode = 1;
        return;
    }
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
    // One prompt per campaign — `generate` sends one for the whole file set — built with the Lox
    // policy and `write-lox` skill exactly as `generate` builds it.
    const prompts: { campaign: string; prompt: string }[] = [];
    if (options.prompt) {
        const service = createLanzerLoxServices(NodeFileSystem, { skillPath: options.skill || undefined }).Lanzer.lanzer.Lanzer;
        const agent = resolveAcpOptionsFromEnv({
            ...(options.policy === 'minimal' ? { policyMode: 'minimal' as const } : {}),
            ...(options.skill === false ? { noSkill: true } : {})
        });
        const wanted = new Set(selected.map((job) => job.campaignName));
        for (const campaign of result.resolvedCampaigns.filter((resolved) => wanted.has(resolved.campaign.name))) {
            prompts.push({ campaign: campaign.campaign.name, prompt: (await previewLanzerCampaignTask(campaign, service, agent)).prompt });
        }
    }

    if (options.json) {
        console.log(JSON.stringify({
            ok: true,
            uri: result.document.uri.toString(),
            jobs: selected,
            ...(options.prompt ? { prompts } : {})
        }, null, 2));
        return;
    }
    console.log(`Lanzer campaign planned successfully: ${result.document.uri.toString()}`);
    for (const job of selected) {
        console.log(`${job.id} -> ${job.absoluteOutputPath}`);
        console.log(`  root rule: ${job.rootRule}`);
        if (job.workspaceRoot) console.log(`  workspace: ${job.workspaceRoot}`);
        if (job.requirements.length > 0) console.log(`  requirements: ${job.requirements.length}`);
    }
    for (const { campaign, prompt } of prompts) {
        console.log(`\nPrompt for campaign ${campaign}`);
        console.log(prompt);
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
        .option('--skill <dir>', 'preview with this write-lox skill folder instead of the default one')
        .option('--no-skill', 'preview with no DSL skill')
        .option('--policy <mode>', 'preview with the full (default) or minimal host policy')
        .description('resolve a valid .lanzer campaign into concrete generation jobs')
        .action(planAction);

    program
        .command('types')
        .argument('<file>', 'a .lanzer campaign (its imported grammars) or a .langium grammar')
        .option('--json', 'print the types as JSON')
        .description('list the type names a selector can use, with their properties, subtypes and direct children')
        .action(async (file: string, options: { json?: boolean }) => {
            const grammars = await loadGrammarsFor(file);
            if (grammars.length === 0) {
                console.error(`No grammar found for ${file}: pass a .langium grammar, or a .lanzer campaign that imports one.`);
                process.exitCode = 1;
                return;
            }
            const types = describeSelectableTypes(grammars);
            console.log(options.json ? JSON.stringify(types, null, 2) : renderSelectableTypes(types));
        });

    program
        .command('generate')
        .argument('<files...>', 'Lanzer campaign files, or folders of them: several run as one suite with one report')
        .option('--command <bin>', 'override the ACP command (else LANZER_ACP_COMMAND)')
        .option('--model <model>', 'override the model (else LANZER_ACP_MODEL)')
        .option('--max-attempts <n>', 'override prompts per session (else LANZER_ACP_MAX_ATTEMPTS)')
        .option('--allow <kinds>', 'ACP tool kinds the agent may use, comma-separated, or "all" (else LANZER_ACP_ALLOW)')
        .option('--allow-all', 'shorthand for --allow all; lets the agent run shell commands and reach the network')
        .option('--report <path>', 'where to write the JSON run report (default: .lanzer/reports/<campaign>-<time>.json)')
        .option('--no-report', 'do not write a JSON run report')
        .option('--verbose', 'show what the agent is doing: commands it runs, files it touches, and its narration')
        .option('--quiet', 'suppress per-event progress output entirely')
        .option('--runs <n>', 'run each campaign n identical times, each in its own copy of the workspace, and report the pass rate')
        .option('--parallel <k>', 'with --runs, run at most k at once (default 1)')
        .option('--min-pass <share>', 'the share of runs each campaign must pass for a zero exit code: k/n (e.g. 2/3) or a percentage (default: all)')
        .option('--skill <dir>', 'use this write-lox skill folder instead of the default one, e.g. to benchmark a new version of it')
        .option('--no-skill', 'offer the agent no DSL skill, as a baseline to measure a skill against')
        .option('--policy <mode>', "how much of the Lox host's language advice the prompt carries: full (default) or minimal (the grammar reference only)")
        .option('--isolated', "run the agent without your own setup (CLAUDE.md/AGENTS.md, settings, skills, hooks), for benchmarks (else LANZER_ACP_ISOLATED)")
        .description('run .lanzer campaigns through an agent to generate the target .lox file(s)')
        .action(async (paths: string[], options: { command?: string; model?: string; maxAttempts?: string; allow?: string; allowAll?: boolean; report?: string | false; verbose?: boolean; quiet?: boolean; runs?: string; parallel?: string; minPass?: string; skill?: string | false; policy?: string; isolated?: boolean }) => {
            // Checked before anything runs: a typo here should not cost a batch of agent runs.
            const runs = options.runs === undefined ? 1 : Number.parseInt(options.runs, 10);
            const parallel = options.parallel === undefined ? 1 : Number.parseInt(options.parallel, 10);
            let minPass: number;
            try {
                minPass = parseMinPass(options.minPass);
            } catch (error) {
                console.error(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
                return;
            }
            if (!Number.isInteger(runs) || runs < 1 || !Number.isInteger(parallel) || parallel < 1) {
                console.error('--runs and --parallel must be whole numbers of at least 1');
                process.exitCode = 1;
                return;
            }
            // A skill folder without a SKILL.md is almost always a wrong path, and a benchmark of
            // it would measure the agent with no skill at all.
            if (options.policy !== undefined && options.policy !== 'full' && options.policy !== 'minimal') {
                console.error(`--policy must be full or minimal, not "${options.policy}"`);
                process.exitCode = 1;
                return;
            }
            if (options.skill && !existsSync(resolve(options.skill, 'SKILL.md'))) {
                console.error(`--skill ${options.skill} has no SKILL.md: pass the skill's folder`);
                process.exitCode = 1;
                return;
            }
            let files: string[];
            try {
                files = await collectLanzerCampaignFiles(paths);
            } catch (error) {
                console.error(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
                return;
            }

            const permissions = options.allowAll
                ? permissiveLanzerPolicy()
                : options.allow
                    ? resolvePermissionPolicy(options.allow)
                    : undefined;

            // A misspelled kind would otherwise read as a deliberate withholding, and the run
            // would fail later as if the agent were at fault. Stop on it instead.
            if (permissions && permissions.unknownEntries.length > 0) {
                console.error(`Unknown tool kind(s) in --allow: ${permissions.unknownEntries.join(', ')}`);
                console.error('Valid kinds: read, edit, delete, move, search, execute, think, fetch, switch_mode, other (or "all").');
                process.exitCode = 1;
                return;
            }

            const acp = resolveAcpOptionsFromEnv({
                ...(options.command ? { command: options.command } : {}),
                ...(options.model ? { model: options.model } : {}),
                ...(options.maxAttempts ? { maxAttempts: Number.parseInt(options.maxAttempts, 10) } : {}),
                ...(permissions ? { permissions } : {}),
                ...(options.isolated ? { isolated: true } : {}),
                ...(options.policy === 'minimal' ? { policyMode: 'minimal' as const } : {}),
                ...(options.skill === false ? { noSkill: true } : {}),
                ...(options.quiet ? {} : { progress: { label: 'lox', verbose: !!options.verbose } })
            });
            // Said up front: a benchmark believed isolated but not would compare the wrong things.
            if (acp.isolated && !lanzerTransportServesTools(acp)) {
                console.error('--isolated has no effect with Codex, which reads AGENTS.md regardless; the report records the run as not isolated.');
            }

            if (acp.permissions && acp.permissions.unknownEntries.length > 0) {
                console.error(`Unknown tool kind(s) in LANZER_ACP_ALLOW: ${acp.permissions.unknownEntries.join(', ')}`);
                console.error('Valid kinds: read, edit, delete, move, search, execute, think, fetch, switch_mode, other (or "all").');
                process.exitCode = 1;
                return;
            }
            if (acp.permissions && !options.quiet) {
                console.error(`Agent permissions: ${describePermissionPolicy(acp.permissions)}`);
            }

            const { runs: results } = await runLoxCampaignFiles(files, acp, { runs, parallel }, { skillPath: options.skill || undefined });
            const reports = results.flatMap((run) => (run.report ? [run.report] : []));

            for (const run of results) {
                const label = 'campaignName' in run.task ? run.task.campaignName : 'campaign';
                const report = run.report;
                const ok = report?.ok ?? run.validation?.ok ?? true;
                if (!ok) {
                    console.error(`✗ ${label} — ${report?.failedStageDescription ?? 'requirements not satisfied'}`);
                } else {
                    console.log(`✓ ${label} — generated and validated`);
                }
                // The per-run block carries the detail the ✓/✗ line cannot: which stage failed,
                // what it cost, and which diagnostics came back grouped by code.
                if (report && !options.quiet) {
                    console.error(renderLanzerRunSummary(report));
                } else if (!ok) {
                    for (const issue of run.validation?.issues ?? []) console.error(`  - ${issue}`);
                }
            }

            if (reports.length > 0) {
                const stamp = new Date().toISOString();
                const suite = buildLanzerSuiteReport(reports, stamp);
                if (reports.length > 1 && !options.quiet) {
                    console.error('');
                    console.error(renderLanzerSuiteSummary(suite));
                }
                // Written by default. A run that took minutes and cost real money should not need
                // to be repeated because nobody passed a flag the first time, and the terminal
                // block is a summary — the file is the record.
                if (options.report !== false) {
                    const path = typeof options.report === 'string'
                        ? resolve(options.report)
                        : resolve('.lanzer', 'reports', `${files.length > 1 ? 'suite' : reports[0].campaign}-${stamp.replace(/[:.]/g, '-')}.json`);
                    await mkdir(dirname(path), { recursive: true });
                    await writeFile(path, JSON.stringify(suite, null, 2), 'utf8');
                    console.error(`report: ${path}`);
                }
            }

            // Each campaign must pass its share of runs; with one run each, that is every run.
            const byCampaign = buildLanzerSuiteReport(reports, '').summary.byCampaign;
            const shortOfShare = Object.values(byCampaign).some((campaign) => !meetsMinPass(campaign.succeeded, campaign.total, minPass));
            // A run that ended without a report still counts when it failed.
            const unreportedFailure = results.some((run) => !run.report && run.validation?.ok === false);
            if (shortOfShare || unreportedFailure) process.exitCode = 1;
        });

    program
        .command('compare')
        .argument('<baseline>', 'suite report of the setup to compare against (a)')
        .argument('<candidate>', 'suite report of the setup being tried (b)')
        .option('--json', 'print the comparison as JSON')
        .description('compare two generate reports: pass rates, cost, failure stages, and what changed between the setups')
        .action(async (baseline: string, candidate: string, options: { json?: boolean }) => {
            let a: LanzerSuiteReport;
            let b: LanzerSuiteReport;
            try {
                [a, b] = await Promise.all([readLanzerSuiteReport(baseline), readLanzerSuiteReport(candidate)]);
            } catch (error) {
                console.error(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
                return;
            }
            const comparison = compareLanzerSuiteReports(a, b);
            console.log(options.json ? JSON.stringify(comparison, null, 2) : renderLanzerSuiteComparison(comparison, { a: baseline, b: candidate }));
        });

    return program;
}
