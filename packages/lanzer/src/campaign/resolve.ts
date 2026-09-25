import type { LoadLanzerDocumentOptions, LanzerDocumentLoadResult } from './load.js';
import { loadLanzerDocumentFromFile } from './load.js';
import { mapLanzerCampaignFile, resolveLanzerCampaigns, type ResolveLanzerCampaignOptions } from './map.js';
import type { LanzerCampaignSpec, LanzerResolvedCampaign } from './model.js';

export interface ResolveLanzerCampaignFileResult extends LanzerDocumentLoadResult {
    campaigns: LanzerCampaignSpec[];
    resolvedCampaigns: LanzerResolvedCampaign[];
}

export async function resolveLanzerCampaignFile(
    filePath: string,
    loadOptions: Omit<LoadLanzerDocumentOptions, 'uri'> = {},
    resolveOptions: ResolveLanzerCampaignOptions = {}
): Promise<ResolveLanzerCampaignFileResult> {
    const loaded = await loadLanzerDocumentFromFile(filePath, loadOptions);
    // No campaign root means nothing to resolve. `loaded.issues` already carries the parse
    // errors that explain it, so this reports an empty result rather than a second failure.
    const campaigns = loaded.model
        ? mapLanzerCampaignFile(loaded.model, { sourceUri: loaded.document.uri.toString() })
        : [];

    return {
        ...loaded,
        campaigns,
        resolvedCampaigns: resolveLanzerCampaigns(campaigns, resolveOptions)
    };
}
