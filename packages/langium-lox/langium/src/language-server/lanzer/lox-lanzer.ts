import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { LangiumDocument } from 'langium';
import {
    DefaultLanzerCampaignRunner,
    DefaultLanzerService
} from 'lanzer';
import type {
    LanzerDocumentResult,
    LanzerDslSkillReference,
    LanzerGenerationJob,
    LanzerGenerationPolicy,
    LanzerGenerationPolicyReferenceFile
} from 'lanzer';

/**
 * Lox-specific Lanzer service.
 *
 * Fills in the host-language hooks the Lanzer generation pipeline asks for when a campaign
 * targets the Lox grammar:
 *
 * - {@link getGenerationPolicy} injects the language rules the generator must honour. Lox here
 *   is the statically-typed `langium-lox` dialect, not the dynamically-typed Lox from
 *   *Crafting Interpreters* — the required/forbidden practices below mirror the rules encoded in
 *   the `write-lox` skill and verified against the validator and interpreter.
 * - {@link dslSkill} points the generator at the `write-lox` authoring skill.
 *
 * Unlike the Type-C integration, Lox does NOT override `loadImportedGrammars`: the combined
 * `createLanzerLoxServices` container registers the Langium grammar language, so the default
 * grammar loader already parses imported `.langium` host grammars correctly.
 */
export class LoxLanzerService extends DefaultLanzerService {
    /**
     * Layer Lox-specific generation guidance on top of the base policy (which supplies the
     * grammar reference path). The base instruction is Type-C-specific, so we replace it
     * outright with Lox instructions and add Lox required/forbidden practices.
     */
    override async getGenerationPolicy(job: LanzerGenerationJob): Promise<LanzerGenerationPolicy | undefined> {
        const base = await super.getGenerationPolicy(job);
        if (!base) return undefined;

        const referenceFiles: LanzerGenerationPolicyReferenceFile[] = [];
        const example = this.findExampleReference(job.grammarBaseDir);
        if (example) referenceFiles.push(example);

        const requiredPractices: string[] = [
            'Every variable, parameter, and function is statically typed. Function parameters need type annotations (`a: number`) and every `fun` / method needs an explicit return type (`: number`, `: void`, ...).',
            'A `var` needs a type hint, an initializer, or both: `var x: number;`, `var x = 1;`, or `var x: number = 1;`. A bare `var x;` is an error.',
            'A function whose return type is not `void` must contain a `return` with a value assignable to that type.',
            'Conditions in `if` / `while` must be `boolean` expressions (e.g. `a < b`, `flag == true`, `!done`). There is no truthiness — a non-boolean condition does not coerce.',
            'Primitive types are exactly `number`, `string`, `boolean`, `void`. `number` covers integers and decimals. Function types are written `(number, number) => number`.',
            'Terminate statements with `;` (var, print, return, expression statements). `print` is a statement: `print x;`, never `print(x)`. Blocks and `if`/`while`/`for`/`fun` take no trailing `;` and always use braces.',
            'Arithmetic (`-`, `*`, `/`) and comparison (`<`, `<=`, `>`, `>=`) require both operands to be `number`. `+` additionally allows `string` operands (concatenation or numeric addition). `and` / `or` / `!` are boolean-only.',
            'Functions are first-class: they can be passed, returned, and chained (`makeAdder()(2, 3)`). Use this for higher-order behaviour.'
        ];

        const forbiddenPractices: string[] = [
            'Do NOT emit classes, `this`, `super`, fields, methods, or constructor calls. Classes parse but are a hard error in both the validator ("Classes are currently unsupported.") and the interpreter.',
            'Do NOT use `%` (modulo) or any exponentiation operator — neither exists in the grammar, and the interpreter has no case for them.',
            'Do NOT rely on truthiness or implicit coercion: a number/string/`nil` is never a valid `if`/`while` condition on its own.',
            'Do NOT use arrays, lists, maps, string methods, `clock()`, or any standard-library/built-in call — there is no standard library. The only output mechanism is `print`.',
            'Do NOT use escape sequences or embed `"` inside string literals; strings are plain double-quoted text with no escapes.',
            'Do NOT apply arithmetic/comparison to non-numbers or boolean operators to non-booleans — the type checker rejects it.'
        ];

        return {
            ...base,
            instructions: [
                'This is the statically-typed `langium-lox` dialect, NOT the dynamically-typed Lox from "Crafting Interpreters". Type annotations are mandatory, conditions must be boolean, and classes are unsupported. The required and forbidden practices below are enforced by the validator and the interpreter — honour them exactly.'
            ],
            requiredPractices: [
                ...(base.requiredPractices ?? []),
                ...requiredPractices
            ],
            forbiddenPractices: [
                ...(base.forbiddenPractices ?? []),
                ...forbiddenPractices
            ],
            referenceFiles: [
                ...(base.referenceFiles ?? []),
                ...referenceFiles
            ]
        };
    }

    /**
     * Point the generator at the `write-lox` skill so it has the full Lox language surface
     * before producing code. Resolution order: project-local `<repoRoot>/skills/write-lox`,
     * then the user-level `~/.claude/skills/write-lox` install.
     */
    override async dslSkill(job: LanzerGenerationJob): Promise<LanzerDslSkillReference | undefined> {
        const candidates: string[] = [];
        const repoRoot = this.findRepoRoot(job.grammarBaseDir);
        if (repoRoot) candidates.push(resolve(repoRoot, 'skills', 'write-lox'));
        candidates.push(resolve(homedir(), '.claude', 'skills', 'write-lox'));

        for (const path of candidates) {
            if (existsSync(resolve(path, 'SKILL.md'))) {
                return { name: 'write-lox', path };
            }
        }
        return undefined;
    }

    /**
     * Locate the curated example program shipped with the `write-lox` skill, used as a
     * copy-from reference file in the generation prompt.
     */
    private findExampleReference(start?: string): LanzerGenerationPolicyReferenceFile | undefined {
        const repoRoot = this.findRepoRoot(start);
        if (!repoRoot) return undefined;
        const path = resolve(repoRoot, 'skills', 'write-lox', 'references', 'examples.lox');
        if (!existsSync(path)) return undefined;
        return {
            label: 'write-lox-example',
            path,
            description: 'A curated langium-lox program that passes the type checker and runs. Use it as a copy-from template for valid syntax and idioms.'
        };
    }

    /**
     * Walk up from the grammar's base directory looking for the repo root, recognised by the
     * presence of `skills/write-lox`. Falls back to `process.cwd()` if the walk fails.
     */
    private findRepoRoot(start?: string): string | undefined {
        let dir = start ?? process.cwd();
        for (let i = 0; i < 10; i++) {
            if (existsSync(resolve(dir, 'skills', 'write-lox', 'SKILL.md'))) {
                return dir;
            }
            const parent = resolve(dir, '..');
            if (parent === dir) break;
            dir = parent;
        }
        return undefined;
    }
}

/**
 * Lox-specific campaign runner.
 *
 * Reports only hard errors (lexer/parser errors and severity-1 diagnostics). Warnings — such as
 * the "comparison always returns false" warning Lox emits for incompatible `==` operands — are
 * not surfaced as campaign failures, so the generator is not asked to "fix" intentional code.
 */
export class LoxLanzerCampaignRunner extends DefaultLanzerCampaignRunner {
    protected override collectDocumentResult(document: LangiumDocument): LanzerDocumentResult {
        const result = super.collectDocumentResult(document);
        return {
            ...result,
            issues: result.issues.filter(i => i.kind !== 'diagnostic' || (i.severity ?? 1) === 1)
        };
    }
}
