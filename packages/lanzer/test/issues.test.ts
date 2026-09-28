import { describe, expect, test } from 'vitest';
import { appendGroupedLanzerIssues, formatLanzerIssue, splitLanzerIssue } from '../src/acp/issues.js';

const URI = 'file:///work/src/main.lox';

describe('issue lines', () => {
    test('what formatLanzerIssue writes, splitLanzerIssue reads back', () => {
        const line = formatLanzerIssue({ uri: URI, line: 3, character: 7, kind: 'diagnostic', message: 'Unknown type: foo' });
        expect(line).toBe(`${URI}:3:7: [diagnostic] Unknown type: foo`);
        expect(splitLanzerIssue(line)).toEqual({ site: `${URI}:3:7`, message: '[diagnostic] Unknown type: foo' });
    });

    test('a finding without a position keeps its uri as the site', () => {
        const line = formatLanzerIssue({ uri: URI, kind: 'parser-error', message: 'Expecting ;' });
        expect(splitLanzerIssue(line)).toEqual({ site: URI, message: '[parser-error] Expecting ;' });
    });

    test('a finding with no uri, or a plain string, is all message', () => {
        expect(splitLanzerIssue(formatLanzerIssue({ kind: 'lexer-error', message: 'bad char' })))
            .toEqual({ message: '[lexer-error] bad char' });
        expect(splitLanzerIssue('Required selector did not match any node: Fn'))
            .toEqual({ message: 'Required selector did not match any node: Fn' });
    });
});

describe('grouped issues in a fix prompt', () => {
    const at = (line: number, message = "Type 'string' is not assignable to 'number'.") =>
        formatLanzerIssue({ uri: URI, line, character: 1, kind: 'diagnostic', message });

    test('repeats of one message collapse into a single root cause', () => {
        const lines: string[] = [];
        appendGroupedLanzerIssues(lines, [at(1), at(5), at(9)], 16);
        expect(lines).toEqual([
            'All 3 reported issues share one root cause:',
            "  [diagnostic] Type 'string' is not assignable to 'number'.",
            'Sites:',
            `  - ${URI}:1:1`,
            `  - ${URI}:5:1`,
            `  - ${URI}:9:1`
        ]);
    });

    test('mixed findings group by message, keeping first-seen order', () => {
        const lines: string[] = [];
        appendGroupedLanzerIssues(lines, [at(1), at(2, 'Missing return.'), at(4), 'Required selector did not match any node: Fn'], 16);
        expect(lines).toEqual([
            'Fix the following 4 issue(s), grouped by message:',
            "- (2×) [diagnostic] Type 'string' is not assignable to 'number'.",
            `    at ${URI}:1:1`,
            `    at ${URI}:4:1`,
            `- ${URI}:2:1: [diagnostic] Missing return.`,
            '- Required selector did not match any node: Fn'
        ]);
    });

    test('long site lists are capped', () => {
        const lines: string[] = [];
        appendGroupedLanzerIssues(lines, [at(1), at(2), at(3)], 2);
        expect(lines.slice(-3)).toEqual([`  - ${URI}:1:1`, `  - ${URI}:2:1`, '  - ... 1 more site(s) omitted']);
    });
});
