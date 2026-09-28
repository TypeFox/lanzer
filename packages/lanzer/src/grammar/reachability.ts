import { GrammarAST } from 'langium';

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
        walkElement(rule.definition, ruleType, directChildren, knownTypes, new Set());
    }
}

function walkElement(
    element: GrammarAST.AbstractElement | undefined,
    currentType: string,
    directChildren: Map<string, Set<string>>,
    knownTypes: Set<string>,
    visitedFragments: Set<string>
): void {
    if (!element) {
        return;
    }

    if (GrammarAST.isAssignment(element)) {
        walkAssignment(element, currentType, directChildren, knownTypes, visitedFragments);
        return;
    }

    if (GrammarAST.isAction(element)) {
        const inferred = element.inferredType?.name;
        if (inferred) {
            addChild(directChildren, currentType, inferred);
            knownTypes.add(inferred);
        }
        return;
    }

    if (GrammarAST.isRuleCall(element)) {
        const target = element.rule?.ref;
        if (!target) return;
        if (GrammarAST.isParserRule(target)) {
            if (target.fragment) {
                if (!visitedFragments.has(target.name)) {
                    visitedFragments.add(target.name);
                    walkElement(target.definition, currentType, directChildren, knownTypes, visitedFragments);
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
                    walkElement(target.definition, currentType, directChildren, knownTypes, visitedFragments);
                    visitedFragments.delete(target.name);
                }
            }
        }
        return;
    }

    if (GrammarAST.isGroup(element) || GrammarAST.isUnorderedGroup(element)) {
        let typeInScope = currentType;
        for (const child of element.elements) {
            if (GrammarAST.isAction(child) && child.inferredType?.name) {
                addChild(directChildren, typeInScope, child.inferredType.name);
                knownTypes.add(child.inferredType.name);
                typeInScope = child.inferredType.name;
                continue;
            }
            walkElement(child, typeInScope, directChildren, knownTypes, visitedFragments);
        }
        return;
    }

    if (GrammarAST.isAlternatives(element)) {
        for (const child of element.elements) {
            walkElement(child, currentType, directChildren, knownTypes, visitedFragments);
        }
        return;
    }
}

function walkAssignment(
    assignment: GrammarAST.Assignment,
    currentType: string,
    directChildren: Map<string, Set<string>>,
    knownTypes: Set<string>,
    visitedFragments: Set<string>
): void {
    const terminal = assignment.terminal;
    if (!terminal) {
        return;
    }
    if (GrammarAST.isCrossReference(terminal)) {
        return;
    }
    if (GrammarAST.isRuleCall(terminal)) {
        const target = terminal.rule?.ref;
        if (!target) {
            return;
        }
        if (GrammarAST.isParserRule(target)) {
            if (target.fragment) {
                if (!visitedFragments.has(target.name)) {
                    visitedFragments.add(target.name);
                    walkElement(target.definition, currentType, directChildren, knownTypes, visitedFragments);
                    visitedFragments.delete(target.name);
                }
                return;
            }
            const targetType = ruleProducedType(target);
            if (targetType) {
                addChild(directChildren, currentType, targetType);
                knownTypes.add(targetType);
            }
        }
        return;
    }
    walkElement(terminal, currentType, directChildren, knownTypes, visitedFragments);
}

function ruleProducedType(rule: GrammarAST.ParserRule): string | undefined {
    if (rule.returnType?.ref?.name) {
        return rule.returnType.ref.name;
    }
    return rule.name;
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
