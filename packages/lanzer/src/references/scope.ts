import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    AstUtils,
    DefaultScopeProvider,
    EMPTY_SCOPE,
    GrammarAST,
    URI,
    type AstNode,
    type LangiumCoreServices,
    type LangiumDocuments,
    type ReferenceInfo,
    type Scope
} from 'langium';
import {
    AbstractRule,
    isCampaignFile,
    type CampaignFile,
    type GrammarImport
} from '../generated/ast.js';

/**
 * Resolves references to host-grammar rule and type names imported by the Lanzer document.
 *
 * For cross-references whose target type is `AbstractRule`, the scope is built from
 * every named AST type produced by the imported grammars: parser rules, terminal rules,
 * declared interfaces, declared type aliases, and types inferred via `infer X` actions
 * or `infers X` rule headers. All other references fall through to the default behaviour.
 */
export class LanzerScopeProvider extends DefaultScopeProvider {
    protected readonly langiumDocuments: LangiumDocuments;

    constructor(services: LangiumCoreServices) {
        super(services);
        this.langiumDocuments = services.shared.workspace.LangiumDocuments;
    }

    override getScope(context: ReferenceInfo): Scope {
        const referenceType = this.reflection.getReferenceType(context);
        if (referenceType === AbstractRule.$type) {
            return this.createImportedRuleScope(context);
        }
        return super.getScope(context);
    }

    protected createImportedRuleScope(context: ReferenceInfo): Scope {
        const root = AstUtils.findRootNode(context.container);
        if (!isCampaignFile(root)) {
            return EMPTY_SCOPE;
        }
        const baseDir = this.resolveBaseDir(root);
        if (!baseDir) {
            return EMPTY_SCOPE;
        }

        const collected: AstNode[] = [];
        const seenNames = new Set<string>();
        for (const imp of root.imports) {
            const grammar = this.loadImportedGrammar(imp, baseDir);
            if (grammar) {
                this.collectNamedTypes(grammar, collected, seenNames);
            }
        }
        return this.createScopeForNodes(collected);
    }

    protected collectNamedTypes(
        grammar: GrammarAST.Grammar,
        out: AstNode[],
        seen: Set<string>
    ): void {
        const add = (node: AstNode | undefined, name: string | undefined): void => {
            if (!node || !name || seen.has(name)) {
                return;
            }
            seen.add(name);
            out.push(node);
        };

        for (const rule of grammar.rules) {
            add(rule, rule.name);
            for (const inner of AstUtils.streamAst(rule)) {
                if (GrammarAST.isAction(inner) && inner.inferredType) {
                    add(inner.inferredType, inner.inferredType.name);
                }
                if (GrammarAST.isParserRule(inner) && inner.inferredType) {
                    add(inner.inferredType, inner.inferredType.name);
                }
            }
        }

        for (const iface of grammar.interfaces ?? []) {
            add(iface, iface.name);
        }
        for (const type of grammar.types ?? []) {
            add(type, type.name);
        }
    }

    protected loadImportedGrammar(
        imp: GrammarImport,
        baseDir: string
    ): GrammarAST.Grammar | undefined {
        const path = imp.path.trim();
        if (!path) {
            return undefined;
        }
        const absolute = resolve(baseDir, path);
        const uri = URI.file(absolute);

        const existing = this.langiumDocuments.getDocument(uri);
        if (existing) {
            const value = existing.parseResult.value;
            return GrammarAST.isGrammar(value) ? value : undefined;
        }

        let text: string;
        try {
            text = readFileSync(absolute, 'utf8');
        } catch {
            return undefined;
        }

        const document = this.langiumDocuments.createDocument(uri, text);
        const value = document.parseResult.value;
        return GrammarAST.isGrammar(value) ? value : undefined;
    }

    protected resolveBaseDir(root: CampaignFile): string | undefined {
        const document = AstUtils.getDocument(root);
        const uri = document.uri;
        if (uri.scheme === 'file') {
            return dirname(fileURLToPath(uri.toString()));
        }
        return undefined;
    }
}
