import type { DefaultSharedModuleContext } from 'langium/lsp';
import {
    LoxAstReflection,
    LoxGeneratedModule,
    LoxGeneratedSharedModule,
    LoxModule,
    type LoxServices
} from 'langium-lox';
import { createLanzerHostServices, type LanzerHostServices } from 'lanzer';
import { LoxLanzerCampaignRunner, LoxLanzerService } from './lox-lanzer-service.js';

/**
 * Combined service container that targets Lanzer at the **unmodified** `langium-lox` language.
 *
 * The point of this package is that `langium-lox` is consumed exactly as published — as if it were
 * a third-party git submodule or npm dependency. The only symbols imported from it are the four
 * standard `langium-cli` building blocks every Langium language exports (`LoxGeneratedSharedModule`,
 * `LoxGeneratedModule`, `LoxModule`, `LoxAstReflection`); the language is never edited. Everything
 * Lox-specific to Lanzer (generation policy, the `write-lox` skill, hard-error-only result
 * collection) lives here in {@link LoxLanzerService} / {@link LoxLanzerCampaignRunner}.
 *
 * The heavy lifting — sharing one workspace across the Lox, Lanzer, and Langium-grammar languages
 * with a single composite reflection — is delegated to {@link createLanzerHostServices}.
 */
export function createLanzerLoxServices(
    context: DefaultSharedModuleContext
): LanzerHostServices<LoxServices> {
    return createLanzerHostServices(
        context,
        {
            generatedSharedModule: LoxGeneratedSharedModule,
            generatedModule: LoxGeneratedModule,
            module: LoxModule,
            astReflection: () => new LoxAstReflection()
        },
        {
            service: (shared, language) => new LoxLanzerService(shared, language),
            campaignRunner: (services) => new LoxLanzerCampaignRunner(services)
        }
    );
}
