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
}

export interface LanzerFileSpec {
    alias: string;
    path: string;
    rootRule: string;
    description?: string;
    requirements: LanzerRequirementSpec[];
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

export interface LanzerResolvedCampaign {
    campaign: LanzerCampaignSpec;
    request: LanzerCampaignRunRequest;
}
