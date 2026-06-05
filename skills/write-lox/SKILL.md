---
name: write-lox
description: Write, generate, fix, or review Lox (.lox) source code for the langium-lox implementation in this repository. This is a STATICALLY TYPED variant of Lox (type annotations required), not the dynamically-typed language from "Crafting Interpreters". TRIGGER when the user asks to write, generate, fix, validate, or review .lox files, Lox programs, or Lox snippets.
metadata:
  short-description: Write typed Lox (langium-lox) code
---

# Writing Lox (langium-lox)

You are writing code for the **langium-lox** language at `packages/langium-lox`. This is a
[Langium](https://langium.org)-based, **statically typed** dialect of Lox. It looks like the Lox
from *Crafting Interpreters* but is **not the same language** — every variable, parameter, and
function has a declared type, and the type checker rejects programs the book would accept.

Ground every answer in the actual grammar and semantics, which live in the submodule:

- Grammar: `packages/langium-lox/langium/src/language-server/lox.langium`
- Type rules: `packages/langium-lox/langium/src/language-server/type-system/` and `lox-validator.ts`
- Runtime: `packages/langium-lox/langium/src/interpreter/runner.ts`

When a question turns on a detail not covered below, read those files rather than guessing — and
read the bundled reference files in `references/` for the full picture.

## Critical Rules (violating any of these produces invalid code)

1. **Type annotations are mandatory** where the grammar requires them:
   - Function/method parameters: `fun f(a: number, b: string): void { ... }`
   - Function/method return types are **required**: every `fun` and method ends its signature with `: <Type>`.
   - A `var` needs **a type hint or an initializer** (or both): `var x: number;`, `var x = 1;`, or `var x: number = 1;`. A bare `var x;` is an error.
2. **Primitive types are `number`, `string`, `boolean`, `void`.** There is no `int`/`float`/`double`/`nil` type keyword. `number` covers both integers and decimals.
3. **`void` is only a return type.** A non-`void` function must contain a `return` with an assignable value, or it is an error ("must return a value").
4. **Statements that aren't blocks end with `;`** — `var`, `print`, `return`, and bare expression statements. `if`/`while`/`for`/`fun`/`class` and `{ }` blocks do **not** take a trailing `;`.
5. **`print` is a statement, not a function**: `print x;` — never `print(x)`.
6. **Conditions must be `boolean`.** `if`/`while` only run when the condition is exactly `true` (strict `=== true` at runtime). A non-boolean condition silently does nothing — never relies on "truthiness". There is **no** truthy/falsy coercion of numbers, strings, or `nil`.
7. **`and` / `or` / `!` are boolean-only.** Both operands must be `boolean`. They do not work on numbers or `nil`.
8. **Arithmetic (`-` `*` `/`) and comparison (`<` `<=` `>` `>=`) are number-only.** Mixing in a string/boolean is a type error.
9. **`+` is the only mixed operator** — allowed between `number` and/or `string` operands (string concatenation or numeric addition). `boolean`/`nil` are not allowed.
10. **`==` / `!=` are strict.** Comparing incompatible types is allowed but produces a **warning** ("always false"/"always true"); at runtime it is JS `===`/`!==`.
11. **Do NOT use `%` (modulo).** It is not in the grammar's `*`/`/` rule and the interpreter has no case for it — it cannot be written or will throw. There is no exponent operator either.
12. **Classes parse but are HARD ERRORS.** Both the validator ("Classes are currently unsupported.") and the interpreter reject any `class`. Do not emit classes, `this`, `super`, fields, methods, or constructor calls unless the user explicitly wants the *grammar* demonstrated and accepts that it won't validate or run.
13. **Function/lambda types are written `(P1, P2) => R`** — e.g. `var f: (number, number) => number = add;`. Functions are first-class and can be passed, returned, and curried (`identity(add)(1, 2)`).
14. **No standard library / built-ins.** There is no `clock()`, no string methods, no `for`-each, no arrays/lists/maps. The only output is `print`.
15. **Comments** are `// line` and `/* block */`. Strings are double-quoted only, with no escape sequences or interpolation; a string cannot contain `"`.

## Shape at a glance

```lox
// variables — need a type or an initializer
var greeting = "hello";
var count: number = 0;

// functions — typed params, mandatory return type, braced body
fun add(a: number, b: number): number {
    return a + b;
}

fun greet(name: string): void {
    print "hi " + name;   // + concatenates string + ... ; print is a statement
}

// first-class / higher-order functions
fun pickAdd(): (number, number) => number {
    return add;
}
print pickAdd()(2, 3);    // 5

// control flow — conditions MUST be boolean, blocks are always braced, no trailing ;
if (count < 10) {
    print "small";
} else {
    print "big";
}

var i: number = 0;
while (i < 3) {
    print i;
    i = i + 1;
}

for (var j = 0; j < 3; j = j + 1) {
    print j;
}
```

## Common mistakes to reject when reviewing

- Untyped parameters or a missing return type on a `fun`/method.
- `var x;` with neither a type nor a value.
- A non-`void` function with no `return`.
- Using a number/string/`nil` as an `if`/`while` condition, or relying on truthiness.
- `and`/`or`/`!` on non-booleans; arithmetic or `<`/`>` on non-numbers.
- `print(x)` instead of `print x;`, or a missing `;` on a statement.
- Using `%`, exponentiation, arrays, `clock()`, or other built-ins that don't exist.
- Emitting `class`/`this`/`super` and expecting it to validate or run.
- Escape sequences or `"` inside string literals.

## References

Consult these bundled files for detail; prefer them over recalling canonical Lox:

- `references/grammar.md` — full syntax: declarations, expressions, precedence, terminals, type syntax.
- `references/semantics.md` — type-checking rules, runtime behavior, truthiness, errors, the 5s timeout, and class status.
- `references/examples.lox` — a curated program that validates and runs (use as a copy-from template).

## Authoring & review workflow

When writing a `.lox` file: produce a program that passes the type checker (rules above), keep
statements terminated, brace all blocks, and avoid classes and nonexistent built-ins.

To actually run a program through the bundled interpreter (5-second execution cap):

```bash
cd packages/langium-lox
npm install            # first time; needs Node >=20, npm >=10
npm run build          # or `npm run watch`
node ./langium/lib/interpreter/cli.js run ./examples/basic.lox
```
