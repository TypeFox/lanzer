import path from 'node:path';
import type { LanzerCampaignSpec } from './model.js';

/**
 * Where a campaign's declared files live on disk — the one implementation.
 *
 * Everything that needs a declared file's path asks here: the jobs that tell the agent where to
 * write, the request that loads documents for validation, the requirement and behaviour checks,
 * and the negative-file pairing. They used to work it out separately, with different fallbacks,
 * and any disagreement means the agent writes one path while the checker reads another.
 *
 * The workspace is resolved against the campaign's base directory (the folder of its `.lanzer`
 * file), or the current directory for a campaign built in code without one. The result is always
 * absolute, so it does not depend on where it is later used from.
 */
export function getCampaignWorkspaceRoot(campaign: LanzerCampaignSpec): string {
    return path.resolve(campaign.baseDir ?? process.cwd(), campaign.workspaceRoot ?? '.');
}

/** Absolute path of a declared file — generated or support — in the campaign's workspace. */
export function getCampaignFileAbsolutePath(campaign: LanzerCampaignSpec, file: { path: string }): string {
    return path.resolve(getCampaignWorkspaceRoot(campaign), file.path);
}
