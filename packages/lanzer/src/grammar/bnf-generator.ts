import { GrammarAST } from 'langium';

/**
 * Generates a custom BNF reference from a parsed Langium grammar that makes the
 * produced AST types explicit.
 *
 * Each non-fragment parser rule is rendered as:
 *
 *   RuleName → ProducedType
 *     ::= ... body with annotated field names ...
 *
 * Field annotations:
 *   fieldName<Type>       assigned once  (operator `=`)
 *   fieldName<Type>[]     assigned many  (operator `+=`)
 *   'keyword'[fieldName]  boolean flag   (operator `?=`)
 *   fieldName<@RefType>   cross-reference
 *
 * Fragment rules are inlined at their call sites so every rule is self-contained.
 * Hidden terminals, terminal rules, fragment rule entries, and grammar actions
 * (type-switch nodes) are all suppressed.
 */
export function generateCustomBnf(grammars: GrammarAST.Grammar[]): string {
    // Index all rules for lookup
    const allRules = new Map<string, GrammarAST.AbstractRule>();
    for (const grammar of grammars) {
        for (const rule of grammar.rules) {
            allRules.set(rule.name, rule);
        }
    }

    const ctx: RenderCtx = { allRules };
    const blocks: string[] = [];

    for (const grammar of grammars) {
        for (const rule of grammar.rules) {
            if (GrammarAST.isTerminalRule(rule)) continue;   // skip terminal rules
            if (!GrammarAST.isParserRule(rule)) continue;
            if (rule.fragment) continue;                      // fragments are inlined

            const producedType = rule.returnType?.ref?.name ?? rule.name;
            const body = renderElement(rule.definition, ctx, new Set(), true);

            blocks.push(`${rule.name} → ${producedType}`);
            blocks.push(`  ::= ${body}`);
            blocks.push('');
        }
    }

    return blocks.join('\n');
}

// ----------------------------------------------------------------
// Rendering context
// ----------------------------------------------------------------

interface RenderCtx {
    allRules: Map<string, GrammarAST.AbstractRule>;
}

// ----------------------------------------------------------------
// Element rendering
// ----------------------------------------------------------------

function renderElement(
    element: GrammarAST.AbstractElement | undefined,
    ctx: RenderCtx,
    inlining: Set<string>,
    topLevel = false
): string {
    if (!element) return '';

    const card = element.cardinality ?? '';

    if (GrammarAST.isAction(element)) return '';
    const rawType = (element as unknown as { $type: string }).$type;
    if (rawType === 'ParameterReference' || rawType === 'NamedArgument') return '';

    if (GrammarAST.isGroup(element) || GrammarAST.isUnorderedGroup(element)) {
        const parts = element.elements
            .map(e => renderElement(e, ctx, inlining))
            .filter(Boolean);
        if (parts.length === 0) return '';
        const inner = parts.join(' ');
        if (topLevel && !card) return inner;
        if (card) return `(${inner})${card}`;
        // Only wrap in parens if needed for clarity (has multiple parts)
        return parts.length > 1 ? `(${inner})` : inner;
    }

    if (GrammarAST.isAlternatives(element)) {
        const parts = element.elements
            .map(e => renderElement(e, ctx, inlining))
            .filter(Boolean);
        if (parts.length === 0) return '';
        const inner = parts.join(' | ');
        if (topLevel && !card) return inner;
        if (card) return `(${inner})${card}`;
        return `(${inner})`;
    }

    if (GrammarAST.isAssignment(element)) {
        // ?= assignments embed their own `?` — don't append card again
        const rendered = renderAssignment(element, ctx, inlining);
        return element.operator === '?=' ? rendered : rendered + card;
    }

    if (GrammarAST.isRuleCall(element)) {
        const ref = element.rule?.ref;
        if (!ref) return '';
        if (GrammarAST.isTerminalRule(ref)) return '';   // bare terminal in non-assignment context — skip
        if (GrammarAST.isParserRule(ref) && ref.fragment) {
            return inlineFragment(ref, ctx, inlining, card);
        }
        return `${ref.name}${card}`;
    }

    if (GrammarAST.isKeyword(element)) {
        return `'${element.value}'${card}`;
    }

    if (GrammarAST.isCrossReference(element)) {
        const typeName = element.type?.ref?.name ?? 'ref';
        return `@${typeName}${card}`;
    }

    return '';
}

function renderAssignment(
    assignment: GrammarAST.Assignment,
    ctx: RenderCtx,
    inlining: Set<string>
): string {
    const feature = assignment.feature;
    const op = assignment.operator;
    const terminal = assignment.terminal;

    // Boolean flag: presence of keyword sets the field to true
    if (op === '?=') {
        if (GrammarAST.isKeyword(terminal)) return `'${terminal.value}'[${feature}]?`;
        if (GrammarAST.isAlternatives(terminal)) {
            const opts = terminal.elements
                .map(e => GrammarAST.isKeyword(e) ? `'${e.value}'` : '')
                .filter(Boolean)
                .join(' | ');
            return `(${opts})[${feature}]?`;
        }
        return `[${feature}]?`;
    }

    const arrayMarker = op === '+=' ? '[]' : '';

    if (!terminal) return `${feature}${arrayMarker}<?>`;

    if (GrammarAST.isRuleCall(terminal)) {
        const ref = terminal.rule?.ref;
        if (!ref) return `${feature}${arrayMarker}<?>`;

        if (GrammarAST.isTerminalRule(ref)) {
            return `${feature}${arrayMarker}<${terminalToType(ref.name)}>`;
        }
        if (GrammarAST.isParserRule(ref) && ref.fragment) {
            const inlined = inlineFragment(ref, ctx, inlining, '');
            return `${feature}${arrayMarker}<${inlined}>`;
        }
        if (GrammarAST.isParserRule(ref)) {
            // Built-in data-type rules (ID, INT, STRING…) resolve as ParserRules
            const mapped = terminalToType(ref.name);
            if (mapped !== ref.name) return `${feature}${arrayMarker}<${mapped}>`;
            const typeName = ref.returnType?.ref?.name ?? ref.name;
            return `${feature}${arrayMarker}<${typeName}>`;
        }
    }

    if (GrammarAST.isCrossReference(terminal)) {
        const typeName = terminal.type?.ref?.name ?? 'ref';
        return `${feature}${arrayMarker}<@${typeName}>`;
    }

    if (GrammarAST.isKeyword(terminal)) {
        return `${feature}${arrayMarker}='${terminal.value}'`;
    }

    if (GrammarAST.isAlternatives(terminal)) {
        // e.g. fnType=('fn' | 'cfn')
        const opts = terminal.elements
            .map(e => {
                if (GrammarAST.isKeyword(e)) return `'${e.value}'`;
                if (GrammarAST.isRuleCall(e)) {
                    const ref = e.rule?.ref;
                    if (!ref) return '?';
                    if (GrammarAST.isTerminalRule(ref)) return terminalToType(ref.name);
                    return ref.returnType?.ref?.name ?? ref.name;
                }
                return '';
            })
            .filter(Boolean)
            .join(' | ');
        return `${feature}${arrayMarker}=(${opts})`;
    }

    return `${feature}${arrayMarker}<?>`;
}

function inlineFragment(
    rule: GrammarAST.ParserRule,
    ctx: RenderCtx,
    inlining: Set<string>,
    card: string
): string {
    if (inlining.has(rule.name)) {
        // Recursive fragment — just show the name to avoid infinite loop
        return `${rule.name}${card}`;
    }
    const next = new Set(inlining);
    next.add(rule.name);
    const body = renderElement(rule.definition, ctx, next);
    if (!body) return '';
    if (card) return `(${body})${card}`;
    return body;
}

// ----------------------------------------------------------------
// Terminal type mapping
// ----------------------------------------------------------------

function terminalToType(terminalName: string): string {
    switch (terminalName) {
        case 'ID':
        case 'IDENTIFIER':
        case 'STRING':
        case 'BINARY_STRING':
            return 'string';
        case 'INT':
        case 'DECIMAL_INT_LITERAL':
        case 'HEXADECIMAL_INT_LITERAL':
        case 'BINARY_INT_LITERAL':
        case 'OCTAL_INT_LITERAL':
        case 'FLOAT_LITERAL':
        case 'DOUBLE_LITERAL':
            return 'number';
        default:
            return terminalName;
    }
}
