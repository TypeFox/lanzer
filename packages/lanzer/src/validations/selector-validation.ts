import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    AstUtils,
    GrammarAST,
    URI,
    type AstNode,
    type AstReflection,
    type LangiumCoreServices,
    type ValidationAcceptor
} from 'langium';
import { interpretAstReflection } from 'langium/grammar';
import * as ast from '../generated/ast.js';
import { hasStringName } from '../util/guards.js';
import { buildContainmentGraph, type ContainmentGraph } from '../grammar/reachability.js';

interface SelectorValidationContext {
    reflection: AstReflection;
    containment: ContainmentGraph;
}

const CONTEXT_PENDING = Symbol('lanzer-selector-context-pending');

/**
 * Authoring-time static check that selectors are structurally reachable in the host grammar.
 *
 * Catches: unknown types, unknown properties, cross-ref target type mismatches, and
 * combinator chains that traverse impossible AST paths (`ClassType > NamespaceDecl`).
 *
 * Lives inside Lanzer and never imports host code. Reflection is interpreted from the
 * imported `.langium` grammars; the containment graph is derived from those same grammars.
 */
export class LanzerSelectorValidator {
    protected readonly contextCache = new WeakMap<ast.CampaignFile, SelectorValidationContext | null | typeof CONTEXT_PENDING>();
    protected readonly contextPromises = new WeakMap<ast.CampaignFile, Promise<SelectorValidationContext | null>>();

    constructor(protected readonly services: LangiumCoreServices) {}

    async validateRequirement(requirement: ast.SymbolRequirement | ast.CountRequirement | ast.ForbidRequirement, accept: ValidationAcceptor): Promise<void> {
        const root = AstUtils.findRootNode(requirement);
        if (!ast.isCampaignFile(root)) return;

        const context = await this.getContext(root);
        if (!context) return;  // imports missing — already reported elsewhere

        this.validateSelector(requirement.selector, undefined, context, accept);
    }

    protected validateSelector(
        selector: ast.Selector,
        carryFromOuter: { astType: string } | undefined,
        context: SelectorValidationContext,
        accept: ValidationAcceptor
    ): void {
        if (selector.parts.length === 0) return;

        // Validate each part on its own (type/property existence)
        for (const part of selector.parts) {
            this.validatePart(part, context, accept);
        }

        // Validate combinator reachability between adjacent parts
        let prevType: string | undefined = carryFromOuter?.astType;
        let prevCombinator: string | undefined = selector.leadingCombinator;

        selector.parts.forEach((part, index) => {
            const partType = resolveAstType(part.rule?.ref);
            if (index === 0) {
                if (prevType && prevCombinator) {
                    this.checkReachability(prevType, partType, prevCombinator, part, context, accept);
                }
            } else {
                const combinator = selector.combinators[index - 1];
                if (prevType) {
                    this.checkReachability(prevType, partType, combinator, part, context, accept);
                }
            }
            prevType = partType;
            prevCombinator = undefined;
        });

        // Recurse into pseudo-classes — each is rooted at the part it adorns
        for (const part of selector.parts) {
            const partType = resolveAstType(part.rule?.ref);
            for (const pseudo of part.pseudos) {
                this.validateSelector(pseudo.selector, { astType: partType }, context, accept);
            }
            // Cross-ref predicates carry nested predicates only (not selectors), validated inside validatePart
        }
    }

    protected validatePart(
        part: ast.SelectorPart,
        context: SelectorValidationContext,
        accept: ValidationAcceptor
    ): void {
        const astType = resolveAstType(part.rule?.ref);
        if (astType === '<unresolved>') return;

        if (!context.reflection.getAllTypes().includes(astType)) {
            accept('error', `Unknown AST type '${astType}'.`, { node: part, property: 'rule' });
            return;
        }

        const metaData = context.reflection.getTypeMetaData(astType);

        for (const predicate of part.predicates) {
            this.validatePredicate(predicate, astType, metaData, context, accept);
        }
    }

    protected validatePredicate(
        predicate: ast.Predicate,
        ownerType: string,
        metaData: ReturnType<AstReflection['getTypeMetaData']>,
        context: SelectorValidationContext,
        accept: ValidationAcceptor
    ): void {
        const propMeta = metaData.properties[predicate.property]
            ?? findPropertyInSubtypes(predicate.property, ownerType, context.reflection);
        if (!propMeta) {
            accept('error', `Type '${ownerType}' has no property '${predicate.property}'.`, {
                node: predicate,
                property: 'property'
            });
            return;
        }

        if (predicate.targetRule) {
            // crossRef predicate
            if (!propMeta.referenceType) {
                accept('error', `Property '${predicate.property}' on '${ownerType}' is not a cross-reference; '->' is not allowed.`, {
                    node: predicate,
                    property: 'property'
                });
                return;
            }
            const targetType = resolveAstType(predicate.targetRule.ref);
            if (targetType === '<unresolved>') return;
            if (!context.reflection.isSubtype(targetType, propMeta.referenceType)) {
                accept('error', `Cross-reference '${predicate.property}' targets '${propMeta.referenceType}', not '${targetType}'.`, {
                    node: predicate,
                    property: 'targetRule'
                });
                return;
            }
            // Validate nested predicates against the target type
            const targetMetaData = context.reflection.getTypeMetaData(targetType);
            for (const nested of predicate.nestedPredicates) {
                this.validatePredicate(nested, targetType, targetMetaData, context, accept);
            }
        }
        // For presence and value predicates, existence on the type is enough.
    }

    protected checkReachability(
        parent: string,
        child: string,
        combinator: string,
        partNode: ast.SelectorPart,
        context: SelectorValidationContext,
        accept: ValidationAcceptor
    ): void {
        if (parent === '<unresolved>' || child === '<unresolved>') return;

        const kind = combinator === '>' ? 'direct' : 'descendant';
        if (!canReach(parent, child, context.containment, context.reflection, kind)) {
            accept(
                'error',
                `'${child}' is not reachable as a ${kind === 'direct' ? 'direct child' : 'descendant'} of '${parent}' in the imported grammar.`,
                { node: partNode, property: 'rule' }
            );
        }
    }

    protected async getContext(file: ast.CampaignFile): Promise<SelectorValidationContext | undefined> {
        const cached = this.contextCache.get(file);
        if (cached === null) return undefined;
        if (cached && cached !== CONTEXT_PENDING) return cached;
        if (cached === CONTEXT_PENDING) {
            const pending = this.contextPromises.get(file);
            return (await pending) ?? undefined;
        }

        this.contextCache.set(file, CONTEXT_PENDING);
        const promise = this.computeContext(file);
        this.contextPromises.set(file, promise);
        const context = await promise;
        this.contextCache.set(file, context);
        return context ?? undefined;
    }

    protected async computeContext(file: ast.CampaignFile): Promise<SelectorValidationContext | null> {
        const grammars = await this.loadGrammars(file);
        if (grammars.length === 0) {
            return null;
        }
        const reflections = grammars.map((grammar) => interpretAstReflection(grammar));
        const reflection = reflections.length === 1 ? reflections[0] : mergeReflections(reflections);
        const containment = buildContainmentGraph(grammars);
        return { reflection, containment };
    }

    protected async loadGrammars(file: ast.CampaignFile): Promise<GrammarAST.Grammar[]> {
        const documents = this.services.shared.workspace.LangiumDocuments;
        const builder = this.services.shared.workspace.DocumentBuilder;
        const baseDir = this.fileBaseDir(file);
        if (!baseDir) return [];
        const toBuild: import('langium').LangiumDocument[] = [];
        for (const imp of file.imports) {
            const path = stripQuotes(imp.path);
            if (!path) continue;
            const uri = URI.file(resolve(baseDir, path));
            let document = documents.getDocument(uri);
            if (!document) {
                try {
                    const text = readFileSync(uri.fsPath, 'utf8');
                    document = documents.createDocument(uri, text);
                } catch {
                    continue;
                }
            }
            toBuild.push(document);
        }
        if (toBuild.length > 0) {
            await builder.build(toBuild, { validation: false });
        }
        const out: GrammarAST.Grammar[] = [];
        for (const document of toBuild) {
            const value = document.parseResult.value;
            if (GrammarAST.isGrammar(value)) {
                out.push(value);
            }
        }
        return out;
    }

    protected fileBaseDir(file: ast.CampaignFile): string | undefined {
        const document = AstUtils.getDocument(file);
        const uri = document.uri;
        if (uri.scheme === 'file') {
            return dirname(fileURLToPath(uri.toString()));
        }
        return undefined;
    }
}

function resolveAstType(node: AstNode | undefined): string {
    if (!node) return '<unresolved>';
    if (GrammarAST.isParserRule(node)) {
        if (node.returnType?.ref?.name) return node.returnType.ref.name;
        return node.name;
    }
    if (GrammarAST.isTerminalRule(node)) {
        return node.name;
    }
    if (GrammarAST.isInferredType(node) || GrammarAST.isInterface(node) || GrammarAST.isType(node)) {
        return node.name;
    }
    if (hasStringName(node)) {
        return node.name;
    }
    return '<unresolved>';
}

function canReach(
    parent: string,
    child: string,
    graph: ContainmentGraph,
    reflection: AstReflection,
    kind: 'direct' | 'descendant'
): boolean {
    const parentTypes = expandSubtypes(parent, reflection);
    const map = kind === 'direct' ? graph.directChildren : graph.descendants;
    for (const parentType of parentTypes) {
        const reachable = map.get(parentType);
        if (!reachable) continue;
        for (const reachableType of reachable) {
            if (reflection.isSubtype(reachableType, child)) return true;
        }
    }
    return false;
}

function expandSubtypes(type: string, reflection: AstReflection): Set<string> {
    const out = new Set<string>([type]);
    try {
        for (const subtype of reflection.getAllSubTypes(type)) {
            out.add(subtype);
        }
    } catch {
        // ignore unknown types
    }
    return out;
}

function stripQuotes(value: string | undefined): string | undefined {
    if (!value) return undefined;
    if (value.length >= 2) {
        const first = value[0];
        const last = value[value.length - 1];
        if ((first === '"' || first === '\'') && last === first) {
            return value.slice(1, -1);
        }
    }
    return value;
}

function findPropertyInSubtypes(
    property: string,
    type: string,
    reflection: AstReflection
): ReturnType<AstReflection['getTypeMetaData']>['properties'][string] | undefined {
    try {
        for (const subtype of reflection.getAllSubTypes(type)) {
            const meta = reflection.getTypeMetaData(subtype);
            const prop = meta.properties[property];
            if (prop) return prop;
        }
    } catch {
        // ignore unknown types
    }
    return undefined;
}

function mergeReflections(reflections: AstReflection[]): AstReflection {
    // Lightweight composite — for authoring validation only, doesn't need subtype caches.
    const merged = reflections[0];
    for (let i = 1; i < reflections.length; i++) {
        Object.assign(merged.types, reflections[i].types);
    }
    return merged;
}
