import type { LanzerDocumentIssue } from 'lanzer';

/**
 * A code taxonomy for Lox diagnostics, assigned here rather than in the language.
 *
 * `langium-lox` sets no `code` on any diagnostic — it is optional in LSP and `langium-cli` does not
 * scaffold one — so every failure would otherwise be groupable only by its exact message, and the
 * messages interpolate types and identifiers (`Type 'number' is not assignable to type 'string'`).
 * Counting those would produce a long tail of one-offs instead of the handful of classes an
 * operator can act on.
 *
 * Deliberately kept out of the submodule. `langium-lox` is consumed exactly as published, which is
 * the claim the whole example exists to demonstrate, and a fuzzing toolkit aimed at other people's
 * languages should not require patching them first. It also proves the more useful thing: Lanzer
 * can impose a taxonomy on a language that has none.
 *
 * A language that *does* set codes needs none of this — `DefaultLanzerCampaignRunner` already
 * carries the host's own code through.
 */

/** Ordered: the first pattern that matches wins, so put the specific before the general. */
const LOX_CODE_PATTERNS: ReadonlyArray<{ code: string; pattern: RegExp }> = [
    { code: 'LOX_UNRESOLVED_REFERENCE', pattern: /^Could not resolve reference to/ },
    { code: 'LOX_TYPE_NOT_ASSIGNABLE', pattern: /is not assignable to type/ },
    { code: 'LOX_ARITY_MISMATCH', pattern: /^Expected \d+ argument\(s\) but got \d+/ },
    { code: 'LOX_BAD_BINARY_OPERANDS', pattern: /^Cannot perform operation '.*' on values of type/ },
    { code: 'LOX_BAD_UNARY_OPERAND', pattern: /^Cannot perform operation '.*' on value of type/ },
    { code: 'LOX_INCOMPARABLE_TYPES', pattern: /^This comparison will always return/ },
    { code: 'LOX_CALL_ON_NON_FUNCTION', pattern: /^Cannot call operation on non-function type/ },
    { code: 'LOX_CYCLIC_INHERITANCE', pattern: /^Cyclic inheritance is not allowed/ },
    { code: 'LOX_MISSING_TYPE_HINT', pattern: /^(No type hint for this element|Variables require a type hint)/ },
    { code: 'LOX_TYPE_INFERENCE_FAILED', pattern: /^Could not infer type/ }
];

/** Codes for the failures that are not the validator's — the file did not lex or parse. */
const LOX_LEXER_ERROR = 'LOX_LEXER_ERROR';
const LOX_PARSER_ERROR = 'LOX_PARSER_ERROR';

/** Anything the validator emits that no pattern above recognises. */
const LOX_UNCLASSIFIED = 'LOX_UNCLASSIFIED';

/** Every code {@link withLoxDiagnosticCode} can assign, for campaigns that expect one. */
export const LOX_DIAGNOSTIC_CODES: readonly string[] = [
    ...LOX_CODE_PATTERNS.map((entry) => entry.code),
    LOX_LEXER_ERROR,
    LOX_PARSER_ERROR,
    LOX_UNCLASSIFIED
];

/**
 * Attach a code to one issue, leaving any the host already supplied untouched.
 *
 * Nothing is dropped when no pattern matches: an unrecognised diagnostic becomes
 * `LOX_UNCLASSIFIED` rather than uncoded, so it still appears in a histogram — and a rising
 * `LOX_UNCLASSIFIED` count is the signal that this table has fallen behind the language.
 */
export function withLoxDiagnosticCode(issue: LanzerDocumentIssue): LanzerDocumentIssue {
    if (issue.code) {
        return issue;
    }
    if (issue.kind === 'lexer-error') {
        return { ...issue, code: LOX_LEXER_ERROR };
    }
    if (issue.kind === 'parser-error') {
        return { ...issue, code: LOX_PARSER_ERROR };
    }
    const matched = LOX_CODE_PATTERNS.find((entry) => entry.pattern.test(issue.message));
    return { ...issue, code: matched?.code ?? LOX_UNCLASSIFIED };
}
