import { AbstractAstReflection, GrammarAST, inject, type AstMetaData, type AstReflection } from 'langium';
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
 * Merges the type metadata of every contributing language so that one shared reflection
 * can answer `getReferenceType` / `isSubtype` calls across the whole workspace. Required
 * because the shared `AstReflection` slot is single-valued — without this composite the
 * last-injected language wins and cross-references in the other one fail to resolve.
 */
export class CompositeAstReflection extends AbstractAstReflection {
    override readonly types: AstMetaData;

    constructor(reflections: AstReflection[]) {
        super();
        this.types = Object.assign({}, ...reflections.map((r) => r.types));
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
