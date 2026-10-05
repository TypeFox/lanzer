import type { Command } from 'commander';
import { NodeFileSystem } from 'langium/node';
import { createLanzerHostCli } from 'lanzer';
import { createLanzerLoxServices } from './lox-host.js';
import { createLoxDeps } from './run-campaign.js';

/**
 * Prebuilt CLI for driving Lanzer campaigns that target the Lox grammar.
 *
 * The commands are Lanzer's own ({@link createLanzerHostCli}); this supplies the Lox services —
 * the Lox generation policy, the `write-lox` skill, and validation by the Lox campaign runner.
 *
 * ACP transport is configured from the `LANZER_ACP_*` environment variables (see `.env.copy`).
 * Every command reads `./.env` first, or the file `--env <path>` names.
 */
export function createLoxLanzerCli(): Command {
    return createLanzerHostCli({
        name: 'lox-lanzer',
        language: 'Lox',
        label: 'lox',
        skillName: 'write-lox',
        fileExtension: '.lox',
        createService: (options) => createLanzerLoxServices(NodeFileSystem, options).Lanzer.lanzer.Lanzer,
        createDeps: createLoxDeps
    });
}
