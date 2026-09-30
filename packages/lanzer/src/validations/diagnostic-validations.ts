import { resolve } from 'node:path';
import type { LangiumDocument } from 'langium';
import { formatLanzerIssue } from '../acp/issues.js';
import type { LanzerCampaignSpec, LanzerDiagnosticExpectation, LanzerDiagnosticSeverity } from '../campaign/model.js';
import type {
    LanzerDiagnosticsOutcome,
    LanzerDiagnosticsValidationResult,
    LanzerDocumentIssue,
    LanzerDocumentResult
} from '../services/types.js';
import { outputMatches } from './behaviour-validations.js';
import { getCampaignFileAbsolutePath } from './requirement-validations.js';

/** LSP's `DiagnosticSeverity` values, by the name a campaign uses for them. */
const LSP_SEVERITIES: Readonly<Record<number, LanzerDiagnosticSeverity | 'hint'>> = {
    1: 'error',
    2: 'warning',
    3: 'info',
    4: 'hint'
};

/**
 * The severity of an issue, as a campaign names it.
 *
 * A file that does not lex or parse is rejected outright, so those are errors. A diagnostic without
 * a severity is too: LSP leaves its meaning to the client, and every client shows it as one.
 */
export function severityOfIssue(issue: LanzerDocumentIssue): LanzerDiagnosticSeverity | 'hint' {
    if (issue.kind !== 'diagnostic') {
        return 'error';
    }
    return LSP_SEVERITIES[issue.severity ?? 1] ?? 'error';
}

/** Whether one issue is the diagnostic an expectation asks for. */
export function diagnosticMeets(expectation: LanzerDiagnosticExpectation, issue: LanzerDocumentIssue): boolean {
    if (severityOfIssue(issue) !== expectation.severity) {
        return false;
    }
    if (expectation.code !== undefined && issue.code !== expectation.code) {
        return false;
    }
    return expectation.message === undefined
        || outputMatches(expectation.message.mode, expectation.message.value, issue.message);
}

/** An expectation in words, for prompts, findings and reports. */
export function describeDiagnosticExpectation(expectation: LanzerDiagnosticExpectation): string {
    const parts: string[] = [];
    if (expectation.code !== undefined) {
        parts.push(`code ${JSON.stringify(expectation.code)}`);
    }
    if (expectation.message) {
        const { mode, value } = expectation.message;
        parts.push({
            exact: `message exactly ${JSON.stringify(value)}`,
            contains: `a message containing ${JSON.stringify(value)}`,
            matches: `a message matching /${value}/`
        }[mode]);
    }
    const article = expectation.severity === 'error' ? 'an' : 'a';
    return `${article} ${expectation.severity} with ${parts.join(' and ')}`;
}

/**
 * Compare what a negative file produced with what it had to.
 *
 * Every expectation needs at least one diagnostic meeting it — one mistake can be reported at
 * several sites, so more than one is fine. Every error has to be met by some expectation: an
 * error nobody asked for means the file is wrong in a second way, which is what a negative file must
 * not be. Warnings and infos nobody asked for are left alone; languages emit them freely.
 */
export function compareDiagnostics(
    expectations: LanzerDiagnosticExpectation[],
    issues: LanzerDocumentIssue[]
): { missing: LanzerDiagnosticExpectation[]; unexpected: LanzerDocumentIssue[] } {
    return {
        missing: expectations.filter((expectation) => !issues.some((issue) => diagnosticMeets(expectation, issue))),
        unexpected: issues.filter((issue) =>
            severityOfIssue(issue) === 'error' && !expectations.some((expectation) => diagnosticMeets(expectation, issue))
        )
    };
}

/**
 * The documents of the campaign's negative files, by index into `documents`.
 *
 * Paired by absolute path, as requirement checks pair their roots, so both agree on which document
 * is which file.
 */
export function findNegativeFileDocuments(
    campaign: LanzerCampaignSpec,
    documents: LangiumDocument[]
): Map<number, LanzerCampaignSpec['files'][number]> {
    const found = new Map<number, LanzerCampaignSpec['files'][number]>();
    for (const file of campaign.files) {
        if (file.diagnostics.length === 0) continue;
        const absolute = resolve(getCampaignFileAbsolutePath(campaign, file));
        const index = documents.findIndex((document) => resolve(document.uri.fsPath) === absolute);
        if (index >= 0) {
            found.set(index, file);
        }
    }
    return found;
}

/**
 * Check every negative file against its expectations.
 *
 * `results` are the documents' findings with nothing filtered away, in the order of `documents`: a
 * warning a clean file would be forgiven is exactly what an `expect warning` looks for. Returns
 * `undefined` for a campaign with no negative files. A negative file that was never loaded is not
 * reported here — the file-set check already says it is missing.
 */
export function validateDiagnostics(
    campaign: LanzerCampaignSpec,
    documents: LangiumDocument[],
    results: LanzerDocumentResult[]
): LanzerDiagnosticsValidationResult | undefined {
    if (!campaign.files.some((file) => file.diagnostics.length > 0)) {
        return undefined;
    }
    const files: LanzerDiagnosticsOutcome[] = [];
    const issues: string[] = [];
    for (const [index, file] of findNegativeFileDocuments(campaign, documents)) {
        const { uri, issues: produced } = results[index];
        const { missing, unexpected } = compareDiagnostics(file.diagnostics, produced);
        files.push({
            fileAlias: file.alias,
            uri,
            expected: file.diagnostics.map(describeDiagnosticExpectation),
            missing: missing.map(describeDiagnosticExpectation),
            unexpected
        });
        for (const expectation of missing) {
            issues.push(formatLanzerIssue({
                uri,
                kind: 'missing diagnostic',
                message: `expected ${describeDiagnosticExpectation(expectation)}, but the language reported none`
            }));
        }
        for (const issue of unexpected) {
            issues.push(formatLanzerIssue({
                uri,
                line: issue.line,
                character: issue.character,
                kind: 'unexpected error',
                message: `${issue.code ? `[${issue.code}] ` : ''}${issue.message}`
            }));
        }
    }
    return { ok: issues.length === 0, files, issues };
}

/**
 * Codes the campaign expects that the host says it never reports.
 *
 * Such an expectation can never be met, so a run for it would spend a whole agent session failing.
 * Only checkable when the host lists its codes; nothing is known to be unknown otherwise.
 */
export function findUnknownDiagnosticCodes(campaign: LanzerCampaignSpec, known: readonly string[]): string[] {
    const knownCodes = new Set(known);
    const unknown = campaign.files
        .flatMap((file) => file.diagnostics)
        .map((expectation) => expectation.code)
        .filter((code): code is string => code !== undefined && !knownCodes.has(code));
    return Array.from(new Set(unknown));
}
