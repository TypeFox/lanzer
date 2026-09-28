import { GrammarAST, inject } from 'langium';
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
import { CompositeAstReflection } from './grammar/composite-reflection.js';

export { CompositeAstReflection } from './grammar/composite-reflection.js';

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
