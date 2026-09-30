import type { LanzerCampaignRunRequest } from '../services/types.js';

export type LanzerRequirementSpec =
    | LanzerSymbolRequirementSpec
    | LanzerCountRequirementSpec
    | LanzerForbidRequirementSpec;

export interface LanzerCampaignSpec {
    name: string;
    description?: string;
    sourceUri?: string;
    baseDir?: string;
    workspaceRoot?: string;
    imports: string[];
    files: LanzerFileSpec[];
    supportFiles: LanzerSupportFileSpec[];
    requirements: LanzerRequirementSpec[];
    /** Entry files to run once the files are valid, and what running each must produce. */
    runs: LanzerRunSpec[];
}

export interface LanzerFileSpec {
    alias: string;
    path: string;
    rootRule: string;
    /** The AST type `rootRule` produces; the generated file's root node must be one. */
    rootAstType: string;
    description?: string;
    requirements: LanzerRequirementSpec[];
    /**
     * The diagnostics the language must reject this file with. Empty for an ordinary file, which
     * must come out clean; non-empty makes it a negative file.
     */
    diagnostics: LanzerDiagnosticExpectation[];
}

/** Severities a diagnostic expectation can name. Mirrors `DiagnosticSeverity` in the grammar. */
export const LANZER_DIAGNOSTIC_SEVERITIES = ['error', 'warning', 'info'] as const;

export type LanzerDiagnosticSeverity = (typeof LANZER_DIAGNOSTIC_SEVERITIES)[number];

/**
 * One diagnostic a negative file must produce: of this severity, and with this code and message
 * where given. Both hold for the same diagnostic.
 */
export interface LanzerDiagnosticExpectation {
    severity: LanzerDiagnosticSeverity;
    code?: string;
    message?: { mode: LanzerOutputMatchMode; value: string };
}

export interface LanzerSupportFileSpec {
    alias: string;
    path: string;
    description?: string;
}

export interface LanzerSymbolRequirementSpec {
    kind: 'symbol';
    selector: LanzerSelector;
    fileAlias?: string;
}

export interface LanzerCountRequirementSpec {
    kind: 'count';
    selector: LanzerSelector;
    count: number;
    fileAlias?: string;
}

export interface LanzerForbidRequirementSpec {
    kind: 'forbid';
    selector: LanzerSelector;
    fileAlias?: string;
}

/**
 * Selector combinators, as a value list the type is derived from.
 *
 * The grammar declares these alternatives as `returns string`, so the parser hands back a plain
 * string and something has to narrow it (see `asLiteral`). Deriving the union from the list keeps
 * the check and the type in step — adding a combinator to the grammar and to this array is one
 * edit, and forgetting the type is not possible.
 */
export const LANZER_COMBINATORS = ['>', '>>'] as const;

export type LanzerCombinator = (typeof LANZER_COMBINATORS)[number];

export interface LanzerSelector {
    leadingCombinator?: LanzerCombinator;
    parts: LanzerSelectorPart[];
    combinators: LanzerCombinator[];
}

export interface LanzerSelectorPart {
    rule: string;
    astType: string;
    predicates: LanzerPredicate[];
    pseudos: LanzerPseudoClass[];
}

export type LanzerPredicate =
    | LanzerPresencePredicate
    | LanzerValuePredicate
    | LanzerCrossRefPredicate;

export interface LanzerPresencePredicate {
    kind: 'presence';
    property: string;
}

/** Comparison operators a value predicate can use. Mirrors `PredicateOp` in the grammar. */
export const LANZER_VALUE_PREDICATE_OPS = ['=', '!=', '^=', '$=', '*='] as const;

export type LanzerValuePredicateOp = (typeof LANZER_VALUE_PREDICATE_OPS)[number];

export interface LanzerValuePredicate {
    kind: 'value';
    property: string;
    op: LanzerValuePredicateOp;
    value: string;
}

export interface LanzerCrossRefPredicate {
    kind: 'crossRef';
    property: string;
    targetRule: string;
    targetAstType: string;
    nestedPredicates: LanzerPredicate[];
}

/** Pseudo-class names a selector can use. Mirrors `PseudoClassKind` in the grammar. */
export const LANZER_PSEUDO_CLASS_KINDS = ['has', 'not'] as const;

export type LanzerPseudoClassKind = (typeof LANZER_PSEUDO_CLASS_KINDS)[number];

export interface LanzerPseudoClass {
    kind: LanzerPseudoClassKind;
    selector: LanzerSelector;
}

/** One `run` block: the declared file the program is run from, and what must hold. */
export interface LanzerRunSpec {
    entryAlias: string;
    /** A file the agent generates, or a support file the campaign provides (e.g. a test driver). */
    entryKind: 'generated' | 'support';
    expectations: LanzerExpectation[];
}

/** How an output expectation compares: the whole output, a substring, or a regex. */
export const LANZER_OUTPUT_MATCH_MODES = ['exact', 'contains', 'matches'] as const;

export type LanzerOutputMatchMode = (typeof LANZER_OUTPUT_MATCH_MODES)[number];

export type LanzerExpectation =
    | { kind: 'runs' }
    | { kind: 'output'; mode: LanzerOutputMatchMode; value: string; negated: boolean };

export interface LanzerResolvedCampaign {
    campaign: LanzerCampaignSpec;
    request: LanzerCampaignRunRequest;
}
