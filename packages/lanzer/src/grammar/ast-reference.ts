import { AstUtils, GrammarAST } from 'langium';

/**
 * Generates a compact, LLM-friendly AST node reference from a parsed Langium grammar.
 *
 * Unlike the raw BNF output from langium-cli, this reference:
 *  - Shows the *inferred type model* (field names + types) rather than parser rules
 *  - Skips hidden terminals (WS, ML_COMMENT, SL_COMMENT) entirely
 *  - Skips fragment rules and terminal rules
 *  - Renders union type aliases so the LLM understands which concrete types a
 *    union selector like `>> Expression` can match
 *
 * The output format is intentionally simple prose — readable by an LLM without
 * knowledge of EBNF or Langium syntax.
 */
export function generateAstReference(grammars: GrammarAST.Grammar[]): string {
    const sections: string[] = [];

    const explicitInterfaces: GrammarAST.Interface[] = [];
    const typeAliases: GrammarAST.Type[] = [];
    const inferredRules: GrammarAST.ParserRule[] = [];

    for (const grammar of grammars) {
        for (const iface of grammar.interfaces ?? []) {
            if (GrammarAST.isInterface(iface)) explicitInterfaces.push(iface);
        }
        for (const alias of grammar.types ?? []) {
            if (GrammarAST.isType(alias)) typeAliases.push(alias);
        }
        for (const rule of grammar.rules) {
            if (GrammarAST.isTerminalRule(rule)) continue;   // skip all terminal rules (incl. hidden)
            if (!GrammarAST.isParserRule(rule)) continue;
            if (rule.fragment) continue;                      // skip fragments
            if (rule.returnType) continue;                    // covered by explicit interface
            inferredRules.push(rule);
        }
    }

    // ----------------------------------------------------------------
    // Section 1: Explicit interfaces (declared fields)
    // ----------------------------------------------------------------
    if (explicitInterfaces.length > 0) {
        const lines: string[] = ['## Declared node interfaces'];
        lines.push('# These types have explicitly declared fields in the grammar.');
        lines.push('');
        for (const iface of explicitInterfaces) {
            lines.push(`### ${iface.name}`);
            const supers = (iface.superTypes ?? []).map(s => s.ref?.name).filter(Boolean);
            if (supers.length) lines.push(`  extends: ${supers.join(', ')}`);
            for (const attr of iface.attributes) {
                const typeStr = renderTypeDefinition(attr.type);
                const optional = attr.isOptional ? '?' : '';
                lines.push(`  ${attr.name}${optional}: ${typeStr}`);
            }
            lines.push('');
        }
        sections.push(lines.join('\n'));
    }

    // ----------------------------------------------------------------
    // Section 2: Inferred parser rule types
    // ----------------------------------------------------------------
    if (inferredRules.length > 0) {
        const lines: string[] = ['## Inferred node types'];
        lines.push('# These types are produced by parser rules. Field names come from grammar assignments.');
        lines.push('');
        for (const rule of inferredRules) {
            const fields = collectRuleFields(rule);
            lines.push(`### ${rule.name}`);
            if (fields.length === 0) {
                lines.push('  (no named fields)');
            } else {
                for (const f of fields) {
                    lines.push(`  ${f.name}${f.optional ? '?' : ''}: ${f.type}`);
                }
            }
            lines.push('');
        }
        sections.push(lines.join('\n'));
    }

    // ----------------------------------------------------------------
    // Section 3: Type aliases / union types
    // ----------------------------------------------------------------
    if (typeAliases.length > 0) {
        const lines: string[] = ['## Type unions'];
        lines.push('# A selector matching one of these union names will accept any of its member types.');
        lines.push('');
        for (const alias of typeAliases) {
            const typeStr = renderTypeDefinition(alias.type);
            lines.push(`${alias.name} = ${typeStr}`);
        }
        sections.push(lines.join('\n'));
    }

    return sections.join('\n\n');
}

// ----------------------------------------------------------------
// TypeDefinition rendering
// ----------------------------------------------------------------

function renderTypeDefinition(type: GrammarAST.TypeDefinition): string {
    if (GrammarAST.isArrayType(type)) {
        const inner = renderTypeDefinition(type.elementType);
        return inner.includes(' | ') ? `(${inner})[]` : `${inner}[]`;
    }
    if (GrammarAST.isUnionType(type)) {
        return type.types.map(renderTypeDefinition).join(' | ');
    }
    if (GrammarAST.isSimpleType(type)) {
        if (type.typeRef?.ref?.name) return type.typeRef.ref.name;
        if (type.primitiveType) return type.primitiveType;
        // String literal types (e.g. 'fn' | 'cfn') live in the `stringType` property
        const stringType = (type as unknown as Record<string, unknown>)['stringType'];
        if (typeof stringType === 'string') return `'${stringType}'`;
        return 'boolean'; // only remaining SimpleType variant is stringBool
    }
    if (GrammarAST.isReferenceType(type)) {
        const refName = (type.referenceType as GrammarAST.SimpleType | undefined)?.typeRef?.ref?.name;
        return refName ? `@${refName}` : '@ref';
    }
    return 'unknown';
}

// ----------------------------------------------------------------
// Assignment-based field extraction for inferred rules
// ----------------------------------------------------------------

interface FieldInfo {
    name: string;
    type: string;
    optional: boolean;
}

function collectRuleFields(rule: GrammarAST.ParserRule): FieldInfo[] {
    const fieldMap = new Map<string, FieldInfo>();

    const assignments = AstUtils.streamAllContents(rule)
        .filter(GrammarAST.isAssignment)
        .toArray();

    for (const assignment of assignments) {
        const name = assignment.feature;
        if (!name || name === '$') continue;

        const isArray = assignment.operator === '+=';
        const isBool = assignment.operator === '?=';
        const optional = !isArray;

        let typeName: string;
        if (isBool) {
            typeName = 'boolean';
        } else {
            typeName = resolveAssignmentTerminalType(assignment.terminal);
        }

        if (isArray) typeName = `${typeName}[]`;

        const existing = fieldMap.get(name);
        if (!existing || existing.type === 'unknown') {
            fieldMap.set(name, { name, type: typeName, optional });
        }
    }

    return [...fieldMap.values()];
}

function resolveAssignmentTerminalType(terminal: GrammarAST.AbstractElement | undefined): string {
    if (!terminal) return 'unknown';

    if (GrammarAST.isRuleCall(terminal)) {
        const ref = terminal.rule?.ref;
        if (!ref) return 'unknown';
        if (GrammarAST.isTerminalRule(ref)) return terminalToType(ref.name);
        if (GrammarAST.isParserRule(ref)) return ref.returnType?.ref?.name ?? ref.name;
    }

    if (GrammarAST.isCrossReference(terminal)) {
        return terminal.type?.ref?.name ?? 'unknown';
    }

    if (GrammarAST.isAlternatives(terminal)) {
        const types = terminal.elements
            .map(resolveAssignmentTerminalType)
            .filter(t => t !== 'unknown');
        const unique = [...new Set(types)];
        return unique.length > 0 ? unique.join(' | ') : 'unknown';
    }

    if (GrammarAST.isKeyword(terminal)) {
        return `'${terminal.value}'`;
    }

    return 'unknown';
}

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
