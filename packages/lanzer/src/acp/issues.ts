/**
 * The one-line form a validation finding takes on its way to a fix prompt.
 *
 * Findings travel as strings — they are logged per attempt, compared to spot a stalled fix pass,
 * and printed by the CLI — but the fix prompt needs them apart again, to group many sites of one
 * root cause under a single message. The writer and the reader of that string live here together
 * so they cannot drift: a reader that recognised a shape no writer produced is how grouping once
 * silently never happened.
 */

/** A finding split back into where it is and what is wrong. */
export interface LanzerIssueParts {
    /** `uri:line:column`, `uri`, or `undefined` for findings about no particular place. */
    site?: string;
    /** The kind tag and message, e.g. `[diagnostic] Unknown type`. Identical findings share it. */
    message: string;
}

/**
 * Render a finding as `site: [kind] message`, or `[kind] message` when it has no site.
 *
 * `line` and `character` are 1-based, as Lanzer reports them everywhere else.
 */
export function formatLanzerIssue(finding: {
    uri?: string;
    line?: number;
    character?: number;
    kind: string;
    message: string;
}): string {
    const tagged = `[${finding.kind}] ${finding.message}`;
    if (!finding.uri) {
        return tagged;
    }
    const position = finding.line === undefined
        ? ''
        : `:${finding.line}${finding.character === undefined ? '' : `:${finding.character}`}`;
    return `${finding.uri}${position}: ${tagged}`;
}

/**
 * Split a line written by {@link formatLanzerIssue}.
 *
 * Any other string — a requirement or file-set finding, which name no position — comes back whole
 * as the message, so it still groups with its own repeats.
 */
export function splitLanzerIssue(line: string): LanzerIssueParts {
    const match = /^(.+?): (\[[^\]]+\] [\s\S]*)$/.exec(line);
    if (!match) {
        return { message: line.trim() };
    }
    return { site: match[1], message: match[2].trim() };
}

/** How a site-less finding is listed among sites. */
const NO_SITE = '(no site)';

/**
 * Append the findings to a fix prompt, grouped by message with their sites under each.
 *
 * A 30-item list with one root cause becomes one message and 30 locations, which an agent acts on
 * as one fix rather than thirty patches. `maxSitesPerGroup` caps each group's location list.
 */
export function appendGroupedLanzerIssues(lines: string[], issues: string[], maxSitesPerGroup: number): void {
    const groups = new Map<string, (string | undefined)[]>();
    for (const issue of issues) {
        const { site, message } = splitLanzerIssue(issue);
        const sites = groups.get(message);
        if (sites) {
            sites.push(site);
        } else {
            groups.set(message, [site]);
        }
    }

    const pushSites = (sites: (string | undefined)[], prefix: string, omittedPrefix: string): void => {
        for (const site of sites.slice(0, maxSitesPerGroup)) {
            lines.push(`${prefix}${site ?? NO_SITE}`);
        }
        if (sites.length > maxSitesPerGroup) {
            lines.push(`${omittedPrefix}... ${sites.length - maxSitesPerGroup} more site(s) omitted`);
        }
    };

    const [only] = groups;
    if (groups.size === 1 && only[1].length > 1) {
        const [message, sites] = only;
        lines.push(`All ${sites.length} reported issues share one root cause:`);
        lines.push(`  ${message}`);
        lines.push('Sites:');
        pushSites(sites, '  - ', '  - ');
        return;
    }

    lines.push(`Fix the following ${issues.length} issue(s), grouped by message:`);
    for (const [message, sites] of groups) {
        if (sites.length === 1) {
            lines.push(sites[0] === undefined ? `- ${message}` : `- ${sites[0]}: ${message}`);
        } else {
            lines.push(`- (${sites.length}×) ${message}`);
            pushSites(sites, '    at ', '    ');
        }
    }
}
