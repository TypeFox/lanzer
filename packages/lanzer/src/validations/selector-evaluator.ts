import { AstUtils, isAstNode, isReference, type AstNode, type AstReflection, type Reference } from 'langium';
import type {
    LanzerCombinator,
    LanzerPredicate,
    LanzerPseudoClass,
    LanzerSelector,
    LanzerSelectorPart
} from '../campaign/model.js';

/**
 * Evaluates a Lanzer selector against an AST rooted at the given node.
 *
 * Top-level: candidates are descendants of `root` (or direct children if the selector
 * carries a leading `>` combinator). Subsequent parts narrow the set via the
 * combinator between them. Predicates filter each candidate; `:has(...)` / `:not(...)`
 * evaluate the inner selector rooted at the candidate.
 */
export function evaluateSelector(
    selector: LanzerSelector,
    root: AstNode,
    reflection: AstReflection
): AstNode[] {
    if (selector.parts.length === 0) {
        return [];
    }

    let candidates = collectCandidates(
        root,
        selector.parts[0],
        reflection,
        selector.leadingCombinator ?? '>>'
    );

    for (let i = 1; i < selector.parts.length; i++) {
        const combinator = selector.combinators[i - 1];
        const part = selector.parts[i];
        const next: AstNode[] = [];
        for (const candidate of candidates) {
            next.push(...collectCandidates(candidate, part, reflection, combinator));
        }
        candidates = dedupe(next);
    }

    return candidates;
}

function collectCandidates(
    root: AstNode,
    part: LanzerSelectorPart,
    reflection: AstReflection,
    combinator: LanzerCombinator
): AstNode[] {
    const pool = combinator === '>' ? directChildren(root) : descendantsOf(root);
    const matches: AstNode[] = [];
    for (const candidate of pool) {
        if (matchesPart(candidate, part, reflection)) {
            matches.push(candidate);
        }
    }
    return matches;
}

function matchesPart(
    node: AstNode,
    part: LanzerSelectorPart,
    reflection: AstReflection
): boolean {
    if (!reflection.isSubtype(node.$type, part.astType)) {
        return false;
    }
    for (const predicate of part.predicates) {
        if (!matchesPredicate(node, predicate, reflection)) {
            return false;
        }
    }
    for (const pseudo of part.pseudos) {
        if (!matchesPseudo(node, pseudo, reflection)) {
            return false;
        }
    }
    return true;
}

function matchesPredicate(
    node: AstNode,
    predicate: LanzerPredicate,
    reflection: AstReflection
): boolean {
    const value = (node as unknown as Record<string, unknown>)[predicate.property];

    if (predicate.kind === 'presence') {
        if (value === undefined || value === null) return false;
        if (Array.isArray(value)) return value.length > 0;
        return true;
    }

    if (predicate.kind === 'value') {
        const actual = readStringValue(value);
        if (actual === undefined) return false;
        return compareValue(actual, predicate.op, predicate.value);
    }

    // crossRef
    if (!isReference(value)) {
        return false;
    }
    const resolved = value.ref;
    if (!resolved) {
        return false;
    }
    if (!reflection.isSubtype(resolved.$type, predicate.targetAstType)) {
        return false;
    }
    for (const nested of predicate.nestedPredicates) {
        if (!matchesPredicate(resolved, nested, reflection)) {
            return false;
        }
    }
    return true;
}

function matchesPseudo(
    node: AstNode,
    pseudo: LanzerPseudoClass,
    reflection: AstReflection
): boolean {
    const matches = evaluateSelector(pseudo.selector, node, reflection);
    return pseudo.kind === 'has' ? matches.length > 0 : matches.length === 0;
}

function directChildren(node: AstNode): AstNode[] {
    const out: AstNode[] = [];
    for (const key of Object.keys(node)) {
        if (key.startsWith('$')) continue;
        const value = (node as unknown as Record<string, unknown>)[key];
        if (Array.isArray(value)) {
            for (const entry of value) {
                if (isAstNode(entry)) {
                    out.push(entry);
                }
            }
        } else if (isAstNode(value)) {
            out.push(value);
        }
    }
    return out;
}

function descendantsOf(node: AstNode): AstNode[] {
    const out: AstNode[] = [];
    for (const descendant of AstUtils.streamAst(node)) {
        if (descendant !== node) {
            out.push(descendant);
        }
    }
    return out;
}

function readStringValue(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (isReference(value as Reference | undefined)) {
        return (value as Reference).$refText;
    }
    return undefined;
}

function compareValue(actual: string, op: string, expected: string): boolean {
    switch (op) {
        case '=':  return actual === expected;
        case '!=': return actual !== expected;
        case '^=': return actual.startsWith(expected);
        case '$=': return actual.endsWith(expected);
        case '*=': return actual.includes(expected);
        default:   return false;
    }
}

function dedupe(nodes: AstNode[]): AstNode[] {
    const seen = new Set<AstNode>();
    const out: AstNode[] = [];
    for (const node of nodes) {
        if (!seen.has(node)) {
            seen.add(node);
            out.push(node);
        }
    }
    return out;
}
