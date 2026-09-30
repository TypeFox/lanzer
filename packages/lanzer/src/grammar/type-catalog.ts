import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AstUtils, GrammarAST, type AstReflection } from 'langium';
import { interpretAstReflection } from 'langium/grammar';
import { loadLanzerDocumentFromFile } from '../campaign/load.js';
import { astTypeOfRule } from './ast-type.js';
import { CompositeAstReflection } from './composite-reflection.js';
import { parseLanzerHostGrammar } from './parse.js';
import { buildContainmentGraph } from './reachability.js';

/** One name a selector can use, and what it can say about a node of that type. */
export interface LanzerSelectableType {
    /** The name as written in a selector. */
    name: string;
    kind: 'entry rule' | 'parser rule' | 'terminal' | 'interface' | 'type' | 'inferred type';
    /**
     * The AST type a node matched by this name has. Differs from the name for a rule that produces
     * another type, e.g. `Assignment infers Expression`.
     */
    astType: string;
    /** Properties a predicate can test; a cross-reference names the type it points at. */
    properties: { name: string; crossReference?: string }[];
    /** Other types a node of this type can be: union members and subtypes. */
    subtypes: string[];
    /** Types that can appear directly inside it — what `>` can reach. */
    children: string[];
}

/**
 * Every name a selector can use in these grammars, with its properties, subtypes and direct
 * children. Built from the same reflection and containment graph as selector validation, so the
 * listing and the checks cannot disagree.
 */
export function describeSelectableTypes(grammars: GrammarAST.Grammar[]): LanzerSelectableType[] {
    const reflections = grammars.map((grammar) => interpretAstReflection(grammar));
    const reflection: AstReflection = reflections.length === 1 ? reflections[0] : new CompositeAstReflection(reflections);
    const containment = buildContainmentGraph(grammars);
    const types: LanzerSelectableType[] = [];
    const seen = new Set<string>();

    const add = (name: string, kind: LanzerSelectableType['kind'], astType: string): void => {
        if (seen.has(name)) return;
        seen.add(name);
        let properties: LanzerSelectableType['properties'] = [];
        let subtypes: string[] = [];
        try {
            properties = Object.values(reflection.getTypeMetaData(astType).properties)
                .map((property) => ({ name: property.name, ...(property.referenceType ? { crossReference: property.referenceType } : {}) }))
                .sort((a, b) => a.name.localeCompare(b.name));
        } catch {
            // A type without metadata of its own (a union) has no properties of its own.
        }
        try {
            subtypes = reflection.getAllSubTypes(astType).filter((type) => type !== astType).sort();
        } catch {
            // Unknown to the reflection: no subtypes to list.
        }
        const children = Array.from(containment.directChildren.get(astType) ?? []).sort();
        types.push({ name, kind, astType, properties, subtypes, children });
    };

    // The same names, in the same order, as the selector scope offers them.
    for (const grammar of grammars) {
        for (const rule of grammar.rules) {
            if (GrammarAST.isParserRule(rule)) {
                add(rule.name, rule.entry ? 'entry rule' : 'parser rule', astTypeOfRule(rule));
            } else if (GrammarAST.isTerminalRule(rule)) {
                add(rule.name, 'terminal', rule.name);
            }
            for (const inner of AstUtils.streamAst(rule)) {
                if ((GrammarAST.isAction(inner) || GrammarAST.isParserRule(inner)) && inner.inferredType) {
                    add(inner.inferredType.name, 'inferred type', inner.inferredType.name);
                }
            }
        }
        for (const iface of grammar.interfaces ?? []) add(iface.name, 'interface', iface.name);
        for (const type of grammar.types ?? []) add(type.name, 'type', type.name);
    }
    return types;
}

/**
 * The grammars a file stands for: a `.langium` grammar itself, or the grammars a `.lanzer`
 * campaign imports.
 */
export async function loadGrammarsFor(filePath: string): Promise<GrammarAST.Grammar[]> {
    const absolute = resolve(filePath);
    const paths = extname(absolute) === '.langium'
        ? [absolute]
        : ((await loadLanzerDocumentFromFile(absolute, { validate: false })).model?.imports ?? [])
            .map((imp) => resolve(dirname(absolute), imp.path));
    const grammars: GrammarAST.Grammar[] = [];
    for (const path of paths) {
        const { grammar } = await parseLanzerHostGrammar({
            source: await readFile(path, 'utf8'),
            uri: pathToFileURL(path).toString(),
            validate: false
        });
        grammars.push(grammar);
    }
    return grammars;
}

/** The listing `lanzer types` prints: one block per selectable name. */
export function renderSelectableTypes(types: LanzerSelectableType[]): string {
    const blocks = types.map((type) => {
        const lines = [`${type.name}  (${type.kind}${type.astType !== type.name ? `, matches '${type.astType}' nodes` : ''})`];
        if (type.properties.length > 0) {
            const properties = type.properties.map((property) => property.crossReference ? `${property.name} -> ${property.crossReference}` : property.name);
            lines.push(`  properties: ${properties.join(', ')}`);
        }
        if (type.subtypes.length > 0) lines.push(`  can be: ${type.subtypes.join(', ')}`);
        if (type.children.length > 0) lines.push(`  direct children: ${type.children.join(', ')}`);
        return lines.join('\n');
    });
    return blocks.join('\n');
}
