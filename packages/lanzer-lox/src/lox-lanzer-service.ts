import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { isOperationCancelled, type LangiumDocument } from 'langium';
import { isClass, isFunctionDeclaration, isLoxProgram, isVariableDeclaration, type LoxElement, type LoxProgram } from 'langium-lox';
import { runProgram } from 'langium-lox/interpreter';
import {
    DefaultLanzerCampaignRunner,
    DefaultLanzerService,
    severityOfIssue
} from 'lanzer';
import { LOX_DIAGNOSTIC_CODES, withLoxDiagnosticCode } from './lox-diagnostic-codes.js';
import type {
    LanzerDocumentIssue,
    LanzerDocumentResult,
    LanzerDslSkillReference,
    LanzerExecutionRequest,
    LanzerExecutionResult,
    LanzerGenerationJob,
    LanzerGenerationPolicy,
    LanzerGenerationPolicyReferenceFile
} from 'lanzer';

/** What another file contributes to the program: what it declares, not what it does. */
function isTopLevelDeclaration(element: LoxElement): boolean {
    return isFunctionDeclaration(element) || isClass(element) || isVariableDeclaration(element);
}

/** Choices a Lox host can make per run. */
export interface LoxLanzerOptions {
    /** The DSL skill folder to point the agent at, instead of the `write-lox` one found by default. */
    skillPath?: string;
}

/** How much output a run keeps; a program printing past this is cut off, not the process. */
const LOX_OUTPUT_LIMIT = 64 * 1024;

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
 * Note that none of these overrides reach into the Lox language services: they assemble policy
 * data, resolve skill paths, and locate reference files. That is why this service can live in a
 * standalone package that merely depends on `langium-lox` — the language itself is never modified.
 */
export class LoxLanzerService extends DefaultLanzerService {
    /**
     * A `write-lox` skill folder to use instead of the one found beside the repo or in
     * `~/.claude/skills` — how a benchmark tries a second version of the skill against the first.
     */
    readonly skillPath: string | undefined;

    constructor(shared: ConstructorParameters<typeof DefaultLanzerService>[0], language: ConstructorParameters<typeof DefaultLanzerService>[1], options: LoxLanzerOptions = {}) {
        super(shared, language);
        this.skillPath = options.skillPath ? resolve(options.skillPath) : undefined;
    }

    /**
     * Layer Lox-specific generation guidance on top of the base policy (which supplies only the
     * grammar reference path) by adding Lox instructions and required/forbidden practices.
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
            'Functions are first-class: they can be passed, returned, and chained (`makeAdder()(2, 3)`). Use this for higher-order behaviour.',
            'Classes are supported: a field is `name: Type` (no `var`/`;`), a method is `name(params): ReturnType { body }` (no `fun`), construct with `ClassName()` (no `new`; fields start `nil`, assign them after construction), inherit with `class Sub < Super { ... }`, and use `this`/`super` inside methods.'
        ];

        const forbiddenPractices: string[] = [
            'Do NOT use `%` (modulo) or any exponentiation operator — neither exists in the grammar, and the interpreter has no case for them.',
            'Do NOT rely on truthiness or implicit coercion: a number/string/`nil` is never a valid `if`/`while` condition on its own.',
            'Do NOT use arrays, lists, maps, string methods, `clock()`, or any standard-library/built-in call — there is no standard library. The only output mechanism is `print`.',
            'Do NOT use escape sequences or embed `"` inside string literals; strings are plain double-quoted text with no escapes.',
            'Do NOT apply arithmetic/comparison to non-numbers or boolean operators to non-booleans — the type checker rejects it.'
        ];

        return {
            ...base,
            instructions: [
                'This is the statically-typed `langium-lox` dialect, NOT the dynamically-typed Lox from "Crafting Interpreters". Type annotations are mandatory and conditions must be boolean. Classes ARE supported (fields `name: Type`, methods `name(): Ret { ... }`, construct with `ClassName()`). The required and forbidden practices below are enforced by the validator and the interpreter — honour them exactly.'
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
     * then the user-level `~/.claude/skills/write-lox` install — unless a skill path was chosen.
     */
    override async dslSkill(job: LanzerGenerationJob): Promise<LanzerDslSkillReference | undefined> {
        // A chosen skill is used as given, even when it is broken: benchmarking a broken skill
        // should measure it, not silently fall back to the default one.
        if (this.skillPath) return { name: 'write-lox', path: this.skillPath };
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

    /** The codes {@link withLoxDiagnosticCode} assigns — Lox itself sets none. */
    async diagnosticCodes(): Promise<readonly string[]> {
        return LOX_DIAGNOSTIC_CODES;
    }

    /**
     * Run a Lox program with the `langium-lox` interpreter, in-process, capturing what it prints.
     *
     * In-process is safe for Lox: the language has no file, network or process access, and the
     * interpreter stops a program itself after five seconds (its cancellation surfaces here as a
     * timeout). The limit is the interpreter's own, fixed in `langium-lox`, and cannot be changed
     * from here. Output is captured the way the Lox CLI prints it — each value followed by a newline —
     * and capped, so a program printing in a loop cannot exhaust memory before it times out.
     *
     * Lox has no modules, but Langium resolves its top-level names across every file in the
     * workspace, so a generated program may call a function another file declares — and it
     * type-checks. Running matches that: the other Lox files' top-level declarations (functions,
     * classes, top-level variables) come first, then the entry's statements. The other files'
     * remaining statements are not run; only the entry is the program.
     */
    async execute(request: LanzerExecutionRequest): Promise<LanzerExecutionResult> {
        const startedAt = Date.now();
        const entry = request.entry.document?.parseResult.value;
        if (!isLoxProgram(entry)) {
            return { completed: false, output: '', error: 'the entry file is not a Lox program', timedOut: false, durationMs: 0 };
        }
        let output = '';
        const log = (value: unknown): void => {
            if (output.length < LOX_OUTPUT_LIMIT) {
                output += `${String(value)}\n`;
            }
        };
        const declarations = request.documents
            .filter((document) => document !== request.entry.document)
            .map((document) => document.parseResult.value)
            .filter(isLoxProgram)
            .flatMap((other) => other.elements.filter(isTopLevelDeclaration));
        const program: LoxProgram = { $type: 'LoxProgram', elements: [...declarations, ...entry.elements] };
        try {
            await runProgram(program, { log });
            return { completed: true, output, timedOut: false, durationMs: Date.now() - startedAt };
        } catch (error) {
            const timedOut = isOperationCancelled(error);
            return {
                completed: false,
                output,
                ...(timedOut ? {} : { error: error instanceof Error ? error.message : String(error) }),
                timedOut,
                durationMs: Date.now() - startedAt
            };
        }
    }

    /**
     * Locate the curated example program shipped with the `write-lox` skill, used as a
     * copy-from reference file in the generation prompt.
     */
    private findExampleReference(start?: string): LanzerGenerationPolicyReferenceFile | undefined {
        // The example is part of the skill: a chosen skill brings its own, or none.
        const repoRoot = this.skillPath ? undefined : this.findRepoRoot(start);
        const skillRoot = this.skillPath ?? (repoRoot && resolve(repoRoot, 'skills', 'write-lox'));
        if (!skillRoot) return undefined;
        const path = resolve(skillRoot, 'references', 'examples.lox');
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
 * An ordinary file fails only on hard errors (lexer/parser errors and severity-1 diagnostics).
 * Warnings — such as the "comparison always returns false" warning Lox emits for incompatible `==`
 * operands — are not campaign failures, so the generator is not asked to "fix" intentional code.
 * They are still collected, coded, for a negative file that expects one.
 */
export class LoxLanzerCampaignRunner extends DefaultLanzerCampaignRunner {
    protected override collectDocumentResult(document: LangiumDocument): LanzerDocumentResult {
        const result = super.collectDocumentResult(document);
        return { ...result, issues: result.issues.map(withLoxDiagnosticCode) };
    }

    protected override failsCleanFile(issue: LanzerDocumentIssue): boolean {
        return severityOfIssue(issue) === 'error';
    }
}
