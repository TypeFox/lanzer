import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanzerCampaignSpec } from '../campaign/model.js';
import type { LanzerDslSkillReference, LanzerGenerationPolicy } from '../services/types.js';
import type { LanzerRunFingerprint } from './model.js';

/** Read once: the version cannot change while the process runs. */
let lanzerVersion: string | undefined;

/** The version of this Lanzer package, from its `package.json`. */
export function getLanzerVersion(): string {
    if (lanzerVersion === undefined) {
        try {
            // `src/report/` and `out/report/` both sit two levels below the package root.
            const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
            lanzerVersion = String(manifest.version ?? 'unknown');
        } catch {
            lanzerVersion = 'unknown';
        }
    }
    return lanzerVersion;
}

/** A SHA-256 over one file's bytes, or undefined when it cannot be read. */
async function hashFile(path: string): Promise<string | undefined> {
    try {
        return createHash('sha256').update(await readFile(path)).digest('hex');
    } catch {
        return undefined;
    }
}

/** Every file under `dir`, as paths relative to it with `/` separators, sorted. */
async function listFiles(dir: string, base = dir): Promise<string[]> {
    const files: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...await listFiles(path, base));
        } else if (entry.isFile()) {
            files.push(relative(base, path).split(sep).join('/'));
        }
    }
    return files.sort();
}

/**
 * A SHA-256 over a folder: each file's relative path and bytes, in path order.
 *
 * The paths are part of it, so renaming a reference file changes the hash as editing one does —
 * both change what the agent is pointed at. Undefined when the folder cannot be read.
 */
export async function hashDirectory(dir: string): Promise<string | undefined> {
    let files: string[];
    try {
        files = await listFiles(dir);
    } catch {
        return undefined;
    }
    const hash = createHash('sha256');
    for (const file of files) {
        hash.update(file).update('\0').update(await readFile(join(dir, file))).update('\0');
    }
    return hash.digest('hex');
}

/** SHA-256 of a text. */
export function hashText(text: string): string {
    return createHash('sha256').update(text).digest('hex');
}

/** JSON with object keys sorted at every level, so the same value always serialises the same. */
function stableStringify(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        const entries = Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b));
        return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

/**
 * The prompt as a run's fingerprint hashes it: with the workspace path replaced by `<workspace>`.
 * Repeated runs each work in their own copy of the workspace, and the path is not something the
 * agent was told to do differently.
 */
export function normalisePrompt(prompt: string, workspaceRoot: string | undefined): string {
    return workspaceRoot ? prompt.split(workspaceRoot).join('<workspace>') : prompt;
}

/**
 * What a run measured: the Lanzer version, the DSL skill, the grammars and the campaign, each with
 * a content hash, and the prompt and host policy it was given.
 *
 * Two reports are only comparable when these say what differs between them. A skill edited in
 * place keeps its name and path, so the hash is what tells "write-lox v2" from v1.
 */
export async function fingerprintLanzerRun(
    campaign: LanzerCampaignSpec,
    dslSkill: LanzerDslSkillReference | undefined,
    given: { prompt?: string; policy?: LanzerGenerationPolicy } = {}
): Promise<LanzerRunFingerprint> {
    const baseDir = campaign.baseDir ?? process.cwd();
    const grammars = await Promise.all(
        campaign.imports.map(async (imp) => {
            const path = resolve(baseDir, imp);
            const hash = await hashFile(path);
            return { path, ...(hash ? { hash } : {}) };
        })
    );
    const campaignPath = campaign.sourceUri?.startsWith('file:') ? fileURLToPath(campaign.sourceUri) : undefined;
    const campaignHash = campaignPath ? await hashFile(campaignPath) : undefined;
    const skillHash = dslSkill?.path ? await hashDirectory(dslSkill.path) : undefined;
    return {
        lanzerVersion: getLanzerVersion(),
        ...(dslSkill
            ? { skill: { ...(dslSkill.name ? { name: dslSkill.name } : {}), ...(dslSkill.path ? { path: dslSkill.path } : {}), ...(skillHash ? { hash: skillHash } : {}) } }
            : {}),
        grammars,
        ...(campaignPath ? { campaign: { path: campaignPath, ...(campaignHash ? { hash: campaignHash } : {}) } } : {}),
        ...(given.prompt !== undefined ? { promptHash: hashText(given.prompt) } : {}),
        ...(given.policy ? { policyHash: hashText(stableStringify(given.policy)) } : {})
    };
}
