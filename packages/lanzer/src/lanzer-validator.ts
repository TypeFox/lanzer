import type { ValidationChecks } from 'langium';
import type { LanzerAstType } from './generated/ast.js';
import type { LanzerLanguageServices } from './lanzer-module.js';
import { LanzerCampaignValidator } from './validations/campaign-validations.js';
import { LanzerSelectorValidator } from './validations/selector-validation.js';

/**
 * Register custom validation checks for the Lanzer campaign DSL.
 *
 * Lanzer resolves campaign-internal references with Langium, but semantic authoring checks
 * still belong here so invalid campaign files are rejected before generation begins.
 */
export function registerValidationChecks(services: LanzerLanguageServices): void {
    const registry = services.validation.ValidationRegistry;

    const campaignChecks = new LanzerCampaignValidator();
    registry.register(campaignChecks.getChecks(), campaignChecks);

    const selectorChecks = new LanzerSelectorValidator(services);
    const selectorRegistration: ValidationChecks<LanzerAstType> = {
        SymbolRequirement: selectorChecks.validateRequirement.bind(selectorChecks),
        CountRequirement: selectorChecks.validateRequirement.bind(selectorChecks),
        ForbidRequirement: selectorChecks.validateRequirement.bind(selectorChecks)
    };
    registry.register(selectorRegistration, selectorChecks);
}
