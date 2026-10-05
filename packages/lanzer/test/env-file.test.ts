import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { loadLanzerEnvFile } from '../src/cli/env-file.js';

const KEY = 'LANZER_TEST_ENV_FILE_MODEL';

let dir: string;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lanzer-env-'));
    delete process.env[KEY];
});

afterEach(() => {
    delete process.env[KEY];
});

describe('loading agent settings', () => {
    test('loads ./.env when it exists', async () => {
        await writeFile(join(dir, '.env'), `${KEY}=from-dotenv\n`);
        expect(loadLanzerEnvFile(undefined, dir)).toBe(join(dir, '.env'));
        expect(process.env[KEY]).toBe('from-dotenv');
    });

    test('loads nothing, quietly, when there is no ./.env', () => {
        expect(loadLanzerEnvFile(undefined, dir)).toBeUndefined();
        expect(process.env[KEY]).toBeUndefined();
    });

    test('loads the named file instead of ./.env', async () => {
        await writeFile(join(dir, '.env'), `${KEY}=from-dotenv\n`);
        await writeFile(join(dir, '.env.codex'), `${KEY}=from-codex\n`);
        loadLanzerEnvFile('.env.codex', dir);
        expect(process.env[KEY]).toBe('from-codex');
    });

    test('a variable already set in the shell wins over the file', async () => {
        await writeFile(join(dir, '.env'), `${KEY}=from-dotenv\n`);
        process.env[KEY] = 'from-shell';
        loadLanzerEnvFile(undefined, dir);
        expect(process.env[KEY]).toBe('from-shell');
    });

    test('a named file that does not exist is an error', () => {
        expect(() => loadLanzerEnvFile('nope.env', dir)).toThrow(`--env: ${join(dir, 'nope.env')} does not exist`);
    });
});
