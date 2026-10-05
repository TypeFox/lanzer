import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Load the agent settings file before a command runs: `path` when given, else `./.env` when it
 * exists. Returns the file loaded, if any.
 *
 * Variables already set in the environment keep their value, as with Node's own `--env-file`, so
 * a setting in the shell always wins over the file. A named file that does not exist is an error:
 * a typo in `--env` would otherwise run the default agent without saying so.
 */
export function loadLanzerEnvFile(path?: string, cwd = process.cwd()): string | undefined {
    const file = resolve(cwd, path ?? '.env');
    if (!existsSync(file)) {
        if (path !== undefined) {
            throw new Error(`--env: ${file} does not exist`);
        }
        return undefined;
    }
    process.loadEnvFile(file);
    return file;
}
