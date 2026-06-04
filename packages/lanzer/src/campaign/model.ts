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

export type LanzerCombinator = '>' | '>>';

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

export interface LanzerValuePredicate {
    kind: 'value';
    property: string;
    op: '=' | '!=' | '^=' | '$=' | '*=';
    value: string;
}

export interface LanzerCrossRefPredicate {
    kind: 'crossRef';
    property: string;
    targetRule: string;
    targetAstType: string;
    nestedPredicates: LanzerPredicate[];
}

export interface LanzerPseudoClass {
    kind: 'has' | 'not';
    selector: LanzerSelector;
}

export interface LanzerResolvedCampaign {
    campaign: LanzerCampaignSpec;
    request: LanzerCampaignRunRequest;
}
