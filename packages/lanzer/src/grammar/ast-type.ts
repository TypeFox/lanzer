import { AstUtils, GrammarAST, type AstNode } from 'langium';
import { hasStringName } from '../util/guards.js';

/** Marks a selector part whose rule reference did not resolve. */
export const UNRESOLVED_AST_TYPE = '<unresolved>';

/**
 * The AST type a selector's rule reference stands for.
 *
 * For a parser rule this is {@link slotTypeOfRule}, with one exception: a body that creates a type
 * named after the rule itself — `Addition infers Expression: Multiplication ({infer Addition.left=
 * current} ...)*` — makes `Addition` a real type, and a selector naming the rule means that one.
 * Terminals, interfaces, type aliases and inferred types are named by themselves.
 */
export function astTypeOfRule(node: AstNode | undefined): string {
    if (!node) {
        return UNRESOLVED_AST_TYPE;
    }
    if (GrammarAST.isParserRule(node)) {
        return createsOwnType(node) ? node.name : slotTypeOfRule(node);
    }
    if (GrammarAST.isTerminalRule(node) || GrammarAST.isInferredType(node) || GrammarAST.isInterface(node) || GrammarAST.isType(node)) {
        return node.name;
    }
    if (hasStringName(node)) {
        return node.name;
    }
    return UNRESOLVED_AST_TYPE;
}

/**
 * Everything a parser rule can produce: its `returns` type, else its `infers` type, else its name.
 */
export function declaredTypeOfRule(rule: GrammarAST.ParserRule): string {
    return rule.returnType?.ref?.name ?? rule.inferredType?.name ?? rule.name;
}

/**
 * The type of the nodes a parser rule actually puts in a slot assigned from it.
 *
 * A rule whose body opens by creating its node — `R returns U: {infer R} ...` — produces that
 * action's type however wide its declared type is: Lox's `VariableDeclaration returns NamedElement`
 * makes `VariableDeclaration` nodes, never other named elements. Otherwise it is the declared type.
 */
export function slotTypeOfRule(rule: GrammarAST.ParserRule): string {
    return leadingActionType(rule) ?? declaredTypeOfRule(rule);
}

/** The type an action creates: `{infer X}` or `{X}`. */
export function actionTypeName(action: GrammarAST.Action): string | undefined {
    return action.inferredType?.name ?? action.type?.ref?.name;
}

/** The type created by a plain action (`{infer X}`, no assignment) that opens the rule's body. */
function leadingActionType(rule: GrammarAST.ParserRule): string | undefined {
    const first = GrammarAST.isGroup(rule.definition) ? rule.definition.elements[0] : rule.definition;
    return GrammarAST.isAction(first) && !first.feature ? actionTypeName(first) : undefined;
}

/** Whether some action in the rule's body creates a type named after the rule. */
function createsOwnType(rule: GrammarAST.ParserRule): boolean {
    return AstUtils.streamAst(rule).some((node) => GrammarAST.isAction(node) && actionTypeName(node) === rule.name);
}
