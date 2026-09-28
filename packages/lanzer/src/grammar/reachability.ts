import { GrammarAST } from 'langium';
import { actionTypeName, declaredTypeOfRule, slotTypeOfRule } from './ast-type.js';

/**
 * Containment graph derived from a parsed host grammar.
 *
 * Records, for every AST type the grammar can produce, which other AST types can appear
 * directly inside it. The descendant relation is the transitive closure of the direct
 * relation, used by selector reachability checks for `>` (direct child) and `>>`
 * (descendant) combinators.
 *
 * Subtype-aware: queries consider the parent's subtypes and the candidate child's
 * subtypes, mirroring how a concrete AST node satisfies a typed selector.
 */
export interface ContainmentGraph {
    knownTypes: Set<string>;
    directChildren: Map<string, Set<string>>;
    descendants: Map<string, Set<string>>;
}

export function buildContainmentGraph(grammars: GrammarAST.Grammar[]): ContainmentGraph {
    const directChildren = new Map<string, Set<string>>();
    const knownTypes = new Set<string>();

    for (const grammar of grammars) {
        for (const rule of grammar.rules) {
            registerRule(rule, directChildren, knownTypes);
        }
        for (const iface of grammar.interfaces ?? []) {
            knownTypes.add(iface.name);
        }
        for (const typeAlias of grammar.types ?? []) {
            knownTypes.add(typeAlias.name);
        }
    }

    return {
        knownTypes,
        directChildren,
        descendants: computeDescendants(directChildren)
    };
}

function registerRule(
    rule: GrammarAST.AbstractRule,
    directChildren: Map<string, Set<string>>,
    knownTypes: Set<string>
): void {
    if (GrammarAST.isTerminalRule(rule)) {
        knownTypes.add(rule.name);
        return;
    }
    if (!GrammarAST.isParserRule(rule)) {
        return;
    }
    const ruleType = ruleProducedType(rule);
    if (ruleType) {
        knownTypes.add(ruleType);
    }
    if (rule.fragment) {
        return;
    }
    if (rule.definition && ruleType) {
        walkElement(rule.definition, ruleType, declaredTypeOfRule(rule), directChildren, knownTypes, new Set());
    }
}

/**
 * Record the containment edges of one grammar element.
 *
 * `currentType` is the node the element's assignments go to. `bodyType` is everything the rule that
 * owns this body can produce — what `current` may be when an action wraps it.
 */
function walkElement(
    element: GrammarAST.AbstractElement | undefined,
    currentType: string,
    bodyType: string,
    directChildren: Map<string, Set<string>>,
    knownTypes: Set<string>,
    visitedFragments: Set<string>
): void {
    if (!element) {
        return;
    }

    if (GrammarAST.isAssignment(element)) {
        walkAssignment(element, currentType, bodyType, directChildren, knownTypes, visitedFragments);
        return;
    }

    if (GrammarAST.isAction(element)) {
        applyAction(element, bodyType, directChildren, knownTypes);
        return;
    }

    if (GrammarAST.isRuleCall(element)) {
        const target = element.rule?.ref;
        if (!target) return;
        if (GrammarAST.isParserRule(target)) {
            if (target.fragment) {
                if (!visitedFragments.has(target.name)) {
                    visitedFragments.add(target.name);
                    walkElement(target.definition, currentType, bodyType, directChildren, knownTypes, visitedFragments);
                    visitedFragments.delete(target.name);
                }
            } else {
                // Unassigned rule call: the node produced here *is* the target's node — `Stmt: Call |
                // Ret` makes a Stmt that is a Call, not one that contains a Call. Its body is a
                // continuation of the current type's body, so what the target contains the current
                // type contains, but no containment edge is recorded to the target itself: that
                // relation is subtyping, and reachability checks it through the reflection.
                if (!visitedFragments.has(target.name)) {
                    visitedFragments.add(target.name);
                    walkElement(target.definition, currentType, declaredTypeOfRule(target), directChildren, knownTypes, visitedFragments);
                    visitedFragments.delete(target.name);
                }
            }
        }
        return;
    }

    if (GrammarAST.isGroup(element) || GrammarAST.isUnorderedGroup(element)) {
        let typeInScope = currentType;
        for (const child of element.elements) {
            if (GrammarAST.isAction(child)) {
                // Everything after an action in the same group is assigned to the node it created.
                typeInScope = applyAction(child, bodyType, directChildren, knownTypes) ?? typeInScope;
                continue;
            }
            walkElement(child, typeInScope, bodyType, directChildren, knownTypes, visitedFragments);
        }
        return;
    }

    if (GrammarAST.isAlternatives(element)) {
        for (const child of element.elements) {
            walkElement(child, currentType, bodyType, directChildren, knownTypes, visitedFragments);
        }
        return;
    }
}

function walkAssignment(
    assignment: GrammarAST.Assignment,
    currentType: string,
    bodyType: string,
    directChildren: Map<string, Set<string>>,
    knownTypes: Set<string>,
    visitedFragments: Set<string>
): void {
    walkAssignedTerminal(assignment.terminal, currentType, bodyType, directChildren, knownTypes, visitedFragments);
}

/**
 * Record what an assignment's right-hand side puts in the slot.
 *
 * Every rule call in it is assigned, including each branch of `body+=(Var | Fun)` — walking those
 * branches as ordinary elements would read them as unassigned calls and record no slot at all.
 */
function walkAssignedTerminal(
    terminal: GrammarAST.AbstractElement | undefined,
    currentType: string,
    bodyType: string,
    directChildren: Map<string, Set<string>>,
    knownTypes: Set<string>,
    visitedFragments: Set<string>
): void {
    if (!terminal || GrammarAST.isCrossReference(terminal)) {
        return;
    }
    if (GrammarAST.isAlternatives(terminal)) {
        for (const branch of terminal.elements) {
            walkAssignedTerminal(branch, currentType, bodyType, directChildren, knownTypes, visitedFragments);
        }
        return;
    }
    if (GrammarAST.isRuleCall(terminal)) {
        const target = terminal.rule?.ref;
        if (!target || !GrammarAST.isParserRule(target)) {
            return;
        }
        if (target.fragment) {
            if (!visitedFragments.has(target.name)) {
                visitedFragments.add(target.name);
                walkElement(target.definition, currentType, bodyType, directChildren, knownTypes, visitedFragments);
                visitedFragments.delete(target.name);
            }
            return;
        }
        const targetType = ruleProducedType(target);
        if (targetType) {
            addChild(directChildren, currentType, targetType);
            knownTypes.add(targetType);
        }
        return;
    }
    walkElement(terminal, currentType, bodyType, directChildren, knownTypes, visitedFragments);
}

function ruleProducedType(rule: GrammarAST.ParserRule): string | undefined {
    return slotTypeOfRule(rule);
}

/**
 * Record what an action creates, and return the type it creates.
 *
 * `{infer X}` creates the node as an `X` and contains nothing new. `{infer X.left=current}` creates
 * an `X` that holds the node built so far — something the owning rule produces, `heldType` — so the
 * edge runs from `X` to it, not the other way round, which would claim the operand contains the
 * expression built around it.
 */
function applyAction(
    action: GrammarAST.Action,
    heldType: string,
    directChildren: Map<string, Set<string>>,
    knownTypes: Set<string>
): string | undefined {
    const created = actionTypeName(action);
    if (!created) {
        return undefined;
    }
    knownTypes.add(created);
    if (action.feature) {
        addChild(directChildren, created, heldType);
    }
    return created;
}

function addChild(map: Map<string, Set<string>>, parent: string, child: string): void {
    let set = map.get(parent);
    if (!set) {
        set = new Set();
        map.set(parent, set);
    }
    set.add(child);
}

function computeDescendants(direct: Map<string, Set<string>>): Map<string, Set<string>> {
    const descendants = new Map<string, Set<string>>();
    for (const parent of direct.keys()) {
        const reachable = new Set<string>();
        const stack = [parent];
        while (stack.length > 0) {
            const current = stack.pop()!;
            const children = direct.get(current);
            if (!children) continue;
            for (const child of children) {
                if (!reachable.has(child)) {
                    reachable.add(child);
                    stack.push(child);
                }
            }
        }
        descendants.set(parent, reachable);
    }
    return descendants;
}
