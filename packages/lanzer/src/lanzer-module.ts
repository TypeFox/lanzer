import { AbstractAstReflection, GrammarAST, inject, type AstMetaData, type AstReflection, type ReferenceInfo, type TypeMetaData } from 'langium';
import {
    createDefaultModule,
    createDefaultSharedModule,
    type DefaultSharedModuleContext,
    type LangiumServices,
    type LangiumSharedServices,
    type PartialLangiumServices
} from 'langium/lsp';
import type { Module } from 'langium';
import {
    LangiumGrammarGeneratedModule,
    LangiumGrammarGeneratedSharedModule,
    LangiumGrammarModule,
    type LangiumGrammarServices
} from 'langium/grammar';
import { LanzerAstReflection } from './generated/ast.js';
import { LanzerGeneratedModule, LanzerGeneratedSharedModule } from './generated/module.js';
import { LanzerScopeProvider } from './references/scope.js';
import { registerValidationChecks } from './lanzer-validator.js';

/**
 * Combines the reflections of every contributing language so that one shared reflection can
 * answer `getReferenceType` / `isSubtype` / `getTypeMetaData` calls across the whole workspace.
 * Required because the shared `AstReflection` slot is single-valued — without this composite the
 * last-injected language wins and cross-references in the others fail to resolve.
 *
 * Resolution is **delegated to the owning language's reflection** rather than computed from a
 * flat-merged type map. A naive `Object.assign` merge is wrong when two languages declare a type
 * of the same name (e.g. both Lox and the Langium grammar language define `Parameter`): the merge
 * lets one language's metadata clobber the other's, so `isSubtype('Parameter', 'NamedElement')`
 * silently flips to `false` and valid references stop resolving. Delegating keeps each language's
 * own subtype/reference logic intact. The merged `types` map is retained only for `getAllTypes`
 * and `isInstance`, which need the union and are insensitive to per-language supertype detail.
 */
export class CompositeAstReflection extends AbstractAstReflection {
    override readonly types: AstMetaData;
    /** First reflection that declares a given type name — the authority for queries about it. */
    private readonly ownerByType = new Map<string, AstReflection>();

    constructor(reflections: AstReflection[]) {
        super();
        // Build the union for getAllTypes/isInstance, and record the owner of each type name.
        // Earlier reflections win ownership so the order passed in is the precedence order.
        const merged: AstMetaData = {};
        for (const reflection of reflections) {
            for (const typeName of Object.keys(reflection.types)) {
                if (!(typeName in merged)) {
                    merged[typeName] = reflection.types[typeName];
                    this.ownerByType.set(typeName, reflection);
                }
            }
        }
        this.types = merged;
    }

    private ownerOf(type: string): AstReflection | undefined {
        return this.ownerByType.get(type);
    }

    override getReferenceType(refInfo: ReferenceInfo): string {
        const owner = this.ownerOf(refInfo.container.$type);
        return owner ? owner.getReferenceType(refInfo) : super.getReferenceType(refInfo);
    }

    override getTypeMetaData(type: string): TypeMetaData {
        const owner = this.ownerOf(type);
        return owner ? owner.getTypeMetaData(type) : super.getTypeMetaData(type);
    }

    override isSubtype(subtype: string, supertype: string): boolean {
        if (subtype === supertype) {
            return true;
        }
        // The subtype's owning language knows its own supertype chain.
        const owner = this.ownerOf(subtype);
        return owner ? owner.isSubtype(subtype, supertype) : super.isSubtype(subtype, supertype);
    }

    override getAllSubTypes(type: string): string[] {
        const owner = this.ownerOf(type);
        return owner ? owner.getAllSubTypes(type) : super.getAllSubTypes(type);
    }
}

export type LanzerLanguageAddedServices = {
    references: {
        ScopeProvider: LanzerScopeProvider;
    };
};
export type LanzerLanguageServices = LangiumServices & LanzerLanguageAddedServices;

export const LanzerLanguageModule: Module<
    LanzerLanguageServices,
    PartialLangiumServices & LanzerLanguageAddedServices
> = {
    references: {
        ScopeProvider: (services) => new LanzerScopeProvider(services)
    }
};

export function createLanzerServices(context: DefaultSharedModuleContext): {
    shared: LangiumSharedServices;
    Lanzer: LanzerLanguageServices;
    grammar: LangiumGrammarServices;
} {
    const shared = inject(
        createDefaultSharedModule(context),
        LanzerGeneratedSharedModule,
        LangiumGrammarGeneratedSharedModule,
        {
            AstReflection: () => new CompositeAstReflection([
                new LanzerAstReflection(),
                new GrammarAST.LangiumGrammarAstReflection()
            ])
        }
    );
    const grammar = inject(
        createDefaultModule({ shared }),
        LangiumGrammarGeneratedModule,
        LangiumGrammarModule
    );
    const Lanzer = inject(
        createDefaultModule({ shared }),
        LanzerGeneratedModule,
        LanzerLanguageModule
    );
    shared.ServiceRegistry.register(grammar);
    shared.ServiceRegistry.register(Lanzer);
    registerValidationChecks(Lanzer);
    if (!context.connection) {
        shared.workspace.ConfigurationProvider.initialized({});
    }
    return { shared, Lanzer, grammar };
}
