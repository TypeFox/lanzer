import { GrammarAST, type AstNode } from 'langium';
import { hasStringName } from '../util/guards.js';

/** Marks a selector part whose rule reference did not resolve. */
export const UNRESOLVED_AST_TYPE = '<unresolved>';

/**
 * The AST type a selector's rule reference stands for.
 *
 * A parser rule declared `returns X` produces nodes of type `X`; otherwise the rule's own name is
 * the type. For rules declared `infers Y` the body typically narrows back to the rule's name via
 * `{infer RuleName}` actions, so selectors target that more specific type. Terminals, interfaces,
 * type aliases and inferred types are named by themselves.
 */
export function astTypeOfRule(node: AstNode | undefined): string {
    if (!node) {
        return UNRESOLVED_AST_TYPE;
    }
    if (GrammarAST.isParserRule(node)) {
        return node.returnType?.ref?.name ?? node.name;
    }
    if (GrammarAST.isTerminalRule(node) || GrammarAST.isInferredType(node) || GrammarAST.isInterface(node) || GrammarAST.isType(node)) {
        return node.name;
    }
    if (hasStringName(node)) {
        return node.name;
    }
    return UNRESOLVED_AST_TYPE;
}
