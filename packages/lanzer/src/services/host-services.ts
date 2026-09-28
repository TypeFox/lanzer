import {
    GrammarAST,
    inject,
    type AstReflection,
    type LangiumGeneratedSharedCoreServices,
    type Module
} from 'langium';
import {
    createDefaultModule,
    createDefaultSharedModule,
    type DefaultSharedModuleContext,
    type LangiumServices,
    type LangiumSharedServices
} from 'langium/lsp';
import {
    LangiumGrammarGeneratedModule,
    LangiumGrammarGeneratedSharedModule,
    LangiumGrammarModule,
    type LangiumGrammarServices
} from 'langium/grammar';
import { CompositeAstReflection, LanzerLanguageModule } from '../lanzer-module.js';
import { LanzerAstReflection } from '../generated/ast.js';
import { LanzerGeneratedModule, LanzerGeneratedSharedModule } from '../generated/module.js';
import { registerValidationChecks } from '../lanzer-validator.js';
import { DefaultLanzerCampaignRunner } from './campaign-runner.js';
import { DefaultLanzerService } from './default-services.js';
import type {
    LanzerCampaignRunner,
    LanzerService,
    LanzerServices
} from './types.js';

/**
 * The building blocks a Langium host language must expose for Lanzer to target it.
 *
 * Every one of these is standard `langium-cli` scaffold output — the generated modules and AST
 * reflection — plus the language's own DI module. A host language is therefore wired into Lanzer
 * **without any change to the language itself**: you import these symbols, you do not edit them.
 * For the Lox language they are `LoxGeneratedSharedModule`, `LoxGeneratedModule`, `LoxModule`,
 * and `LoxAstReflection`, all re-exported from the unmodified `langium-lox` package entry.
 *
 * The language services are built by the host rather than from modules handed over, because the
 * host is the only party that knows their type: `inject` infers it from the modules it is given,
 * so {@link createServices} returns `THost` exactly, and nothing has to assert it afterwards.
 */
export interface LanzerHostLanguage<THost extends LangiumServices> {
    /** langium-cli generated shared module, e.g. `LoxGeneratedSharedModule`. */
    generatedSharedModule: Module<LangiumSharedServices, LangiumGeneratedSharedCoreServices>;
    /**
     * Build the host language's services on Lanzer's shared container. This is the same `inject`
     * the language's own `create<Lang>Services` performs, with `shared` handed in instead of
     * created, e.g. `(shared) => inject(createDefaultModule({ shared }), LoxGeneratedModule, LoxModule)`.
     */
    createServices: (shared: LangiumSharedServices) => THost;
    /** Produces the host language's AST reflection, e.g. `() => new LoxAstReflection()`. */
    astReflection: () => AstReflection;
}

/**
 * Optional Lanzer service overrides. Both default to the host-agnostic implementations
 * ({@link DefaultLanzerService} / {@link DefaultLanzerCampaignRunner}). Supply a `service` to
 * inject language-specific generation policy and the DSL skill, and a `campaignRunner` to control
 * which diagnostics count as campaign failures.
 */
export interface LanzerHostOverrides {
    service?: (shared: LangiumSharedServices, language: LanzerServices) => LanzerService;
    campaignRunner?: (services: LanzerServices) => LanzerCampaignRunner;
}

export interface LanzerHostServices<THost extends LangiumServices = LangiumServices> {
    shared: LangiumSharedServices;
    /** The host language services (e.g. Lox), sharing the one workspace. */
    host: THost;
    /** The Lanzer services that drive campaign resolution, generation, and validation. */
    Lanzer: LanzerServices;
    /** The Langium grammar-language services, so imported `.langium` host grammars parse. */
    grammar: LangiumGrammarServices;
}

/**
 * Build a combined Langium service container that hosts an arbitrary Langium language alongside
 * the Lanzer campaign language and the Langium grammar language in one shared workspace. This is
 * the generic core that a per-language helper such as `createLanzerLoxServices` is a thin wrapper
 * around — pass your language's building blocks and (optionally) its Lanzer service overrides.
 *
 * All three languages share a single {@link CompositeAstReflection} because the shared reflection
 * slot is single-valued; the host reflection is listed first so its types win ownership when a
 * type name collides across languages. Registering the host language also routes its files (by the
 * extension declared in its generated `LanguageMetaData`) to the host services, so generated
 * documents are parsed and validated by the host's own validator.
 */
export function createLanzerHostServices<THost extends LangiumServices>(
    context: DefaultSharedModuleContext,
    host: LanzerHostLanguage<THost>,
    overrides: LanzerHostOverrides = {}
): LanzerHostServices<THost> {
    const makeService = overrides.service
        ?? ((shared: LangiumSharedServices, language: LanzerServices) => new DefaultLanzerService(shared, language));
    const makeRunner = overrides.campaignRunner
        ?? ((services: LanzerServices) => new DefaultLanzerCampaignRunner(services));

    const shared = inject(
        createDefaultSharedModule(context),
        host.generatedSharedModule,
        LanzerGeneratedSharedModule,
        LangiumGrammarGeneratedSharedModule,
        {
            AstReflection: () => new CompositeAstReflection([
                host.astReflection(),
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
    const hostServices = host.createServices(shared);
    const Lanzer = inject(
        createDefaultModule({ shared }),
        LanzerGeneratedModule,
        LanzerLanguageModule,
        {
            lanzer: {
                Lanzer: (services: LanzerServices) => makeService(shared, services),
                CampaignRunner: (services: LanzerServices) => makeRunner(services)
            }
        }
    );
    shared.ServiceRegistry.register(grammar);
    shared.ServiceRegistry.register(hostServices);
    shared.ServiceRegistry.register(Lanzer);
    registerValidationChecks(Lanzer);
    if (!context.connection) {
        shared.workspace.ConfigurationProvider.initialized({});
    }
    return {
        shared,
        host: hostServices,
        Lanzer,
        grammar
    };
}
