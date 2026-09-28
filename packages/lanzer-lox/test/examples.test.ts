import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { loadLanzerDocumentFromFile } from 'lanzer';

function example(name: string): string {
    return fileURLToPath(new URL(`../examples/${name}`, import.meta.url));
}

describe('shipped example campaigns against the Lox grammar', () => {
    test.each(['hello.lanzer', 'classes.lanzer'])('%s is valid', async (name) => {
        const result = await loadLanzerDocumentFromFile(example(name), { validate: true });
        expect(result.issues).toEqual([]);
    });

    test('invalid-demo.lanzer reports exactly its two deliberate mistakes', async () => {
        const result = await loadLanzerDocumentFromFile(example('invalid-demo.lanzer'), { validate: true });
        expect(result.issues.map((issue) => [issue.line, issue.character, issue.message])).toEqual([
            [11, 17, "Could not resolve reference to AbstractRule named 'NonExistentNode'."],
            [12, 37, "Type 'FunctionDeclaration' has no property 'notAProp'."]
        ]);
    });
});
