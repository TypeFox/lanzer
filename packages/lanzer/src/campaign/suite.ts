import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * The campaign files a suite names: each file as given, each folder as the `.lanzer` files directly
 * inside it, sorted by name. Not recursive: a suite folder's subfolders are its campaigns'
 * workspaces, and one of those holding a `.lanzer` file is not meant to join the suite.
 *
 * A file named twice runs once. Throws for a path that does not exist and for a folder with no
 * campaigns, since either is a mistake that would otherwise shrink the suite without a word.
 */
export async function collectLanzerCampaignFiles(paths: string[]): Promise<string[]> {
    const files: string[] = [];
    for (const path of paths) {
        const absolute = resolve(path);
        const stats = await stat(absolute).catch(() => undefined);
        if (!stats) {
            throw new Error(`No such campaign file or folder: ${path}`);
        }
        if (!stats.isDirectory()) {
            files.push(absolute);
            continue;
        }
        const campaigns = (await readdir(absolute, { withFileTypes: true }))
            .filter((entry) => entry.isFile() && entry.name.endsWith('.lanzer'))
            .map((entry) => join(absolute, entry.name))
            .sort();
        if (campaigns.length === 0) {
            throw new Error(`No .lanzer campaign files in ${path}`);
        }
        files.push(...campaigns);
    }
    return Array.from(new Set(files));
}
