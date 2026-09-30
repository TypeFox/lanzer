import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RecordingClient } from './client.js';
import type { LanzerToolkit } from './tool-host.js';
import type { LanzerAgentValidationResult } from './types.js';

/** A file-set verdict, plus the files that were merely extra rather than wrong. */
export interface LanzerFileSetResult extends LanzerAgentValidationResult {
    extraFiles: string[];
    staleFiles: string[];
}

export interface WorkspaceSnapshot {
    files: Set<string>;
    /** Modification time of each declared target that already existed when the run started. */
    targetTimes: Map<string, number>;
    /** Content of each support file a `run` block starts from, or `undefined` if it did not exist. */
    runEntryContents: Map<string, string | undefined>;
}

/**
 * Give the agent's `validate` tool the same checks the run itself applies.
 *
 * The host's campaign runner answers only for the documents. The run additionally checks that the
 * declared file set is what appeared on disk — and without this, a run failing on a stray file
 * hands the agent a tool that keeps answering VALID. That is worse than having no tool: the fix
 * prompt says the file set is wrong, the tool says everything is fine, and the agent has nothing
 * it can observe changing. One campaign spent three attempts and $0.86 in exactly that
 * position, its `validate` reporting `ok` every time while the run failed.
 *
 * The tool's description promises that a VALID answer means the run will pass. This is what makes
 * that true.
 */
export function withFileSetCheck(
    toolkit: LanzerToolkit,
    extraValidate: ((client: RecordingClient) => Promise<LanzerFileSetResult>) | undefined,
    client: RecordingClient
): LanzerToolkit {
    const validate = toolkit.validate;
    if (!validate || !extraValidate) {
        return toolkit;
    }
    return {
        ...toolkit,
        validate: async () => {
            const result = await validate();
            const fileSet = await extraValidate(client);
            if (fileSet.ok) {
                return result;
            }
            return {
                ...result,
                ok: false,
                workspace: {
                    ok: false,
                    issues: [...(result.workspace?.issues ?? []), ...fileSet.issues]
                }
            };
        }
    };
}

/**
 * Check the workspace against what the campaign declared.
 *
 * A campaign states what must be true of the result, not an exhaustive manifest of what may exist.
 * Producing a declared target is required. Everything else the agent writes is it solving the
 * problem — a language may need a manifest, a module index, a config file before its own imports
 * resolve, and a campaign author should not have to enumerate those to get a passing run.
 *
 * Support files are not policed at all: they are the project's, and the agent owns the project. It
 * may create, edit or remove them as the language requires, guided by the DSL skill that documents
 * what they should contain. The only failure here is a declared target that never appeared.
 *
 * `strict` additionally fails on files the campaign never mentioned, for a caller that does want an
 * exact manifest.
 */
export async function validateCampaignFileSet(
    workspaceRoot: string,
    baseline: WorkspaceSnapshot,
    expectedOutputPaths: string[],
    supportPaths: string[],
    strict: boolean
): Promise<LanzerFileSetResult> {
    const issues: string[] = [];
    const extraFiles: string[] = [];
    const expected = new Set(expectedOutputPaths.map((filePath) => resolve(filePath)));
    const support = new Set(supportPaths.map((filePath) => resolve(filePath)));
    const currentFiles = await listFilesRecursive(workspaceRoot);

    const staleFiles: string[] = [];
    for (const filePath of expected) {
        const modified = await modificationTime(filePath);
        if (modified === undefined) {
            issues.push(`Missing required generated file: ${filePath}`);
        } else if (baseline.targetTimes.get(filePath) === modified) {
            staleFiles.push(filePath);
            issues.push(`Required generated file was not written during this run (unchanged since before it started): ${filePath}`);
        }
    }

    for (const [filePath, before] of baseline.runEntryContents) {
        if (await readTextIfExists(filePath) !== before) {
            issues.push(`A run starts from ${filePath}, which the campaign provides; it must not be changed, but it was changed during this run.`);
        }
    }

    for (const filePath of currentFiles) {
        // Support files are declared, so they are never interlopers however they got there.
        if (!baseline.files.has(filePath) && !expected.has(filePath) && !support.has(filePath)) {
            extraFiles.push(filePath);
            if (strict) {
                issues.push(`Unexpected generated file was written outside the declared file set: ${filePath}`);
            }
        }
    }

    return {
        ok: issues.length === 0,
        issues,
        extraFiles,
        staleFiles
    };
}

export async function captureWorkspaceSnapshot(
    workspaceRoot: string,
    targets: string[],
    runEntries: string[]
): Promise<WorkspaceSnapshot> {
    const files = await listFilesRecursive(workspaceRoot);
    const targetTimes = new Map<string, number>();
    for (const target of targets) {
        const modified = await modificationTime(target);
        if (modified !== undefined) {
            targetTimes.set(resolve(target), modified);
        }
    }
    const runEntryContents = new Map<string, string | undefined>();
    for (const entry of runEntries) {
        runEntryContents.set(entry, await readTextIfExists(entry));
    }
    return { files, targetTimes, runEntryContents };
}

/** A file's text, or `undefined` when there is no such file. */
async function readTextIfExists(filePath: string): Promise<string | undefined> {
    try {
        return await readFile(filePath, 'utf8');
    } catch {
        return undefined;
    }
}

/** A file's modification time, or `undefined` when there is no such file. */
async function modificationTime(filePath: string): Promise<number | undefined> {
    try {
        const stats = await stat(filePath);
        return stats.isFile() ? stats.mtimeMs : undefined;
    } catch {
        return undefined;
    }
}

async function listFilesRecursive(root: string): Promise<Set<string>> {
    const files = new Set<string>();
    const walk = async (current: string): Promise<void> => {
        let dirEntries;
        try {
            dirEntries = await readdir(current, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of dirEntries) {
            const absolute = resolve(current, entry.name);
            if (entry.isDirectory()) {
                await walk(absolute);
            } else if (entry.isFile()) {
                files.add(absolute);
            }
        }
    };
    await walk(resolve(root));
    return files;
}
