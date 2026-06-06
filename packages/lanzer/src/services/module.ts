import type { LangiumServices, LangiumSharedServices } from 'langium/lsp';
import { DefaultLanzerCampaignRunner } from './campaign-runner.js';
import { DefaultLanzerService } from './default-services.js';
import type { LanzerModule } from './types.js';

export function createDefaultLanzerModule<
    TShared extends LangiumSharedServices = LangiumSharedServices,
    TLanguage extends LangiumServices = LangiumServices
>(
    shared: TShared
): LanzerModule<TShared, TLanguage> {
    return {
        lanzer: {
            Lanzer: (services) =>
                new DefaultLanzerService(shared, services),
            CampaignRunner: (services) =>
                new DefaultLanzerCampaignRunner(services)
        }
    };
}
