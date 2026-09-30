import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { describeSelectableTypes, loadGrammarsFor, loadLanzerDocumentFromFile } from 'lanzer';

const LOX_GRAMMAR = fileURLToPath(new URL('../../langium-lox/langium/src/language-server/lox.langium', import.meta.url));

describe('authoring help against the Lox grammar', () => {
    test('a mistyped type, a mistyped property and a > that should be >> each get their hint', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'lanzer-lox-hints-'));
        const campaign = join(dir, 'campaign.lanzer');
        await writeFile(campaign, [
            `import ${JSON.stringify(LOX_GRAMMAR)}`,
            'campaign hints {',
            '    workspace "ws"',
            '    file main at "main.lox" generates LoxProgram {',
            '        require FunctionDeclaraton',
            '        require FunctionDeclaration[nmae="x"]',
            '        require FunctionDeclaration > MemberCall',
            '    }',
            '}'
        ].join('\n'), 'utf8');
        const { issues } = await loadLanzerDocumentFromFile(campaign, { validate: true });
        expect(issues.map((issue) => issue.message)).toEqual([
            "Could not resolve reference to AbstractRule named 'FunctionDeclaraton'. Did you mean 'FunctionDeclaration'?",
            "Type 'FunctionDeclaration' has no property 'nmae'. Did you mean 'name'?",
            "'MemberCall' is not reachable as a direct child of 'FunctionDeclaration' in the imported grammar. It is a descendant, though, via 'ExpressionBlock' > 'LoxElement': use '>>'."
        ]);
    });

    test("the type listing shows that Assignment matches Expression nodes, and MemberCall's cross-reference", async () => {
        const types = describeSelectableTypes(await loadGrammarsFor(LOX_GRAMMAR));
        expect(types.find((type) => type.name === 'Assignment')).toMatchObject({ kind: 'parser rule', astType: 'Expression' });
        expect(types.find((type) => type.name === 'MemberCall')?.properties).toContainEqual({ name: 'element', crossReference: 'NamedElement' });
    });
});
