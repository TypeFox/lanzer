import type { LanzerRunReport, LanzerSuiteReport } from './model.js';

/** Enough to act on without burying the summary; the report file keeps the rest. */
const MAX_LISTED_DIAGNOSTICS = 12;

/** A document URI trimmed to its last two segments — enough to identify, short enough to scan. */
function shortenUri(uri: string): string {
    const parts = uri.split('/');
    return parts.slice(-2).join('/');
}

function formatDuration(ms: number): string {
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function formatCost(amount: number | undefined, currency: string | undefined): string | undefined {
    if (amount === undefined) return undefined;
    return `${amount.toFixed(4)} ${currency ?? ''}`.trim();
}

/** Sorted by count then name, so two runs of the same suite print the same order. */
function rankCounts(counts: Record<string, number>): Array<[string, number]> {
    return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** One run, as the block printed after the ✓/✗ line. */
export function renderLanzerRunSummary(report: LanzerRunReport): string {
    const lines: string[] = [];
    const verdict = report.ok ? 'ok' : `failed at ${report.failedStage} — ${report.failedStageDescription}`;
    lines.push(`  ${verdict}`);
    if (report.failureMessage) {
        for (const line of report.failureMessage.split('\n')) {
            lines.push(`    ${line}`);
        }
    }
    lines.push(
        `  ${report.attempts} attempt(s), ${formatDuration(report.durationMs)}, stopped: ${report.stopReason}`
    );

    if (report.toolCalls.length > 0) {
        const failed = report.toolCalls.filter((call) => !call.ok).length;
        lines.push(`  lanzer tools: ${report.toolCalls.length} call(s)${failed > 0 ? `, ${failed} reporting problems` : ''}`);
    }
    if (report.deniedToolCalls.length > 0) {
        const kinds = Array.from(new Set(report.deniedToolCalls.map((call) => call.kind)));
        lines.push(`  refused by policy: ${report.deniedToolCalls.length} call(s) (${kinds.join(', ')})`);
    }

    // The trajectory, when there was more than one attempt: a falling issue count is an agent
    // converging, a flat one is an agent that stopped learning from the prompt, and the final
    // number alone cannot tell those apart.
    if (report.attemptLog.length > 1) {
        const trail = report.attemptLog
            .map((attempt) => `${attempt.kind === 'fix' ? 'fix' : 'gen'}:${attempt.issueCount}`)
            .join(' → ');
        lines.push(`  attempts: ${trail}`);
    }

    if (report.issues.total > 0) {
        lines.push(`  ${report.issues.total} diagnostic(s):`);
        for (const [code, count] of rankCounts(report.issues.byCode)) {
            lines.push(`    ${String(count).padStart(3)}  ${code}`);
        }
        // Where, not just how many. Capped because a badly broken file can produce hundreds, and
        // the report file has all of them.
        const shown = report.documents
            .filter((document) => !document.expectsDiagnostics)
            .flatMap((document) => document.issues.map((issue) => ({ uri: document.uri, issue })));
        for (const { uri, issue } of shown.slice(0, MAX_LISTED_DIAGNOSTICS)) {
            const at = issue.line !== undefined ? `:${issue.line}:${issue.character ?? 1}` : '';
            const code = issue.code ? `[${issue.code}] ` : '';
            lines.push(`    ${shortenUri(uri)}${at} ${code}${issue.message}`);
        }
        if (shown.length > MAX_LISTED_DIAGNOSTICS) {
            lines.push(`    … ${shown.length - MAX_LISTED_DIAGNOSTICS} more (see the report file)`);
        }
    }
    // Shown whether or not they matched: a passing negative file is worth seeing too, since what it was
    // rejected with is the point of generating it.
    for (const file of report.negativeFiles) {
        const matched = file.missing.length === 0 && file.unexpected.length === 0;
        lines.push(`  negative ${shortenUri(file.uri)}: ${matched ? 'rejected as expected' : 'not rejected as expected'}`);
        for (const expected of file.expected) lines.push(`    expected: ${expected}`);
        for (const missing of file.missing) lines.push(`    missing: ${missing}`);
        for (const issue of file.unexpected) {
            const at = issue.line !== undefined ? `:${issue.line}:${issue.character ?? 1}` : '';
            lines.push(`    unexpected${at}: ${issue.code ? `[${issue.code}] ` : ''}${issue.message}`);
        }
    }
    for (const issue of report.campaignIssues) lines.push(`    - ${issue}`);
    for (const issue of report.behaviourIssues) lines.push(`    - ${issue}`);
    for (const issue of report.workspaceIssues) lines.push(`    - ${issue}`);
    // Shown even on a passing run: extra files are not a failure, but they are worth knowing about,
    // and silently producing a dozen of them is exactly what a fuzzing corpus should surface.
    if (report.extraFiles.length > 0) {
        lines.push(`  ${report.extraFiles.length} file(s) beyond the declared set:`);
        for (const file of report.extraFiles.slice(0, MAX_LISTED_DIAGNOSTICS)) {
            lines.push(`    ${shortenUri(file)}`);
        }
    }

    const cost = formatCost(report.usage.costAmount, report.usage.costCurrency);
    const usageBits = [`${report.usage.totalTokens.toLocaleString()} tokens`];
    if (report.usage.contextUsed !== undefined && report.usage.contextSize !== undefined) {
        const pct = ((report.usage.contextUsed / report.usage.contextSize) * 100).toFixed(1);
        usageBits.push(`context ${report.usage.contextUsed.toLocaleString()}/${report.usage.contextSize.toLocaleString()} (${pct}%)`);
    }
    if (cost) usageBits.push(`cost ${cost}`);
    if (report.usage.totalTokens > 0 || cost) lines.push(`  ${usageBits.join(', ')}`);
    if (report.events.compactions > 0) lines.push(`  context compacted ${report.events.compactions} time(s)`);

    return lines.join('\n');
}

/** The whole suite, as the closing block of a multi-campaign run. */
export function renderLanzerSuiteSummary(report: LanzerSuiteReport): string {
    const { summary } = report;
    const lines: string[] = [];
    lines.push(`${summary.succeeded}/${summary.total} campaign(s) succeeded, ${summary.failed} failed`);

    const stages = rankCounts(summary.byStage);
    if (stages.length > 0) {
        lines.push('failures by stage:');
        for (const [stage, count] of stages) lines.push(`  ${String(count).padStart(3)}  ${stage}`);
    }

    const codes = rankCounts(summary.byCode);
    if (codes.length > 0) {
        lines.push('diagnostics by code:');
        for (const [code, count] of codes) lines.push(`  ${String(count).padStart(3)}  ${code}`);
    }

    const bits = [formatDuration(summary.totalDurationMs), `${summary.totalTokens.toLocaleString()} tokens`];
    const cost = formatCost(summary.totalCostAmount, summary.costCurrency);
    if (cost) bits.push(`cost ${cost}`);
    if (summary.toolCalls > 0) bits.push(`${summary.toolCalls} lanzer tool call(s)`);
    lines.push(bits.join(', '));

    return lines.join('\n');
}
