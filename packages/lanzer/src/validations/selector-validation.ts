import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    AstUtils,
    GrammarAST,
    URI,
    type AstReflection,
    type LangiumCoreServices,
    type ValidationAcceptor
} from 'langium';
import { interpretAstReflection } from 'langium/grammar';
import * as ast from '../generated/ast.js';
import { astTypeOfRule, UNRESOLVED_AST_TYPE } from '../grammar/ast-type.js';
import { CompositeAstReflection } from '../grammar/composite-reflection.js';
import { buildContainmentGraph, type ContainmentGraph } from '../grammar/reachability.js';

interface SelectorValidationContext {
    reflection: AstReflection;
    containment: ContainmentGraph;
    /** The AST types the imported grammars' entry rules produce: every parsed file's root is one. */
    entryTypes: { rule: string; astType: string }[];
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

    /**
     * A file's `generates` rule must be one its root can actually be. The host language parses every
     * file from its entry rule, so any other rule — a statement, an expression — can never be the
     * root, and a campaign naming one asks for a file that cannot exist.
     */
    async validateFileRoot(file: ast.FileSpec, accept: ValidationAcceptor): Promise<void> {
        const root = AstUtils.findRootNode(file);
        if (!ast.isCampaignFile(root)) return;
        const context = await this.getContext(root);
        if (!context || context.entryTypes.length === 0) return;

        const rootType = astTypeOfRule(file.rootRule.ref);
        if (rootType === UNRESOLVED_AST_TYPE) return;
        if (context.entryTypes.some((entry) => context.reflection.isSubtype(entry.astType, rootType))) return;

        const entries = context.entryTypes.map((entry) => `'${entry.rule}'`).join(', ');
        accept('error', `'${file.rootRule.$refText}' cannot be the root of a generated file: the host language parses every file from its entry rule ${entries}.`, {
            node: file,
            property: 'rootRule'
        });
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

        // Validate combinator reachability between adjacent parts. Inside `:has(...)`/`:not(...)`
        // the first part is matched below the adorned node at any depth unless a leading `>` says
        // otherwise, exactly as the evaluator does.
        let prevType: string | undefined = carryFromOuter?.astType;
        let prevCombinator: string | undefined = selector.leadingCombinator ?? (carryFromOuter ? '>>' : undefined);

        selector.parts.forEach((part, index) => {
            const partType = astTypeOfRule(part.rule?.ref);
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
            const partType = astTypeOfRule(part.rule?.ref);
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
        const astType = astTypeOfRule(part.rule?.ref);
        if (astType === UNRESOLVED_AST_TYPE) return;

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
            const targetType = astTypeOfRule(predicate.targetRule.ref);
            if (targetType === UNRESOLVED_AST_TYPE) return;
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
        if (parent === UNRESOLVED_AST_TYPE || child === UNRESOLVED_AST_TYPE) return;

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
        const reflection = reflections.length === 1 ? reflections[0] : new CompositeAstReflection(reflections);
        const containment = buildContainmentGraph(grammars);
        const entryTypes = grammars.flatMap((grammar) => grammar.rules
            .filter((rule) => GrammarAST.isParserRule(rule) && rule.entry)
            .map((rule) => ({ rule: rule.name, astType: astTypeOfRule(rule) })));
        return { reflection, containment, entryTypes };
    }

    protected async loadGrammars(file: ast.CampaignFile): Promise<GrammarAST.Grammar[]> {
        const documents = this.services.shared.workspace.LangiumDocuments;
        const builder = this.services.shared.workspace.DocumentBuilder;
        const baseDir = this.fileBaseDir(file);
        if (!baseDir) return [];
        const toBuild: import('langium').LangiumDocument[] = [];
        for (const imp of file.imports) {
            const path = imp.path.trim();
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
            // Either the slot's declared type is a kind of the requested one, or the requested type
            // is one of the kinds the slot accepts — `body += Stmt` holds `Ret` nodes when
            // `Stmt: Call | Ret`, so `Fn > Ret` is reachable through a slot typed `Stmt`.
            if (reflection.isSubtype(reachableType, child) || reflection.isSubtype(child, reachableType)) return true;
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
