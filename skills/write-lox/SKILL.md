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
12. **Classes are supported** — declaration, fields, methods, single inheritance, `this`, and `super` all validate and run. A **field** is `name: Type` (no `var`, no `;`); a **method** is `name(params): ReturnType { body }` (no `fun`; return type required, like a function). Construct with `ClassName()` (there is **no** `new`); the constructor takes **no arguments** and fields start as `nil`, so assign them after construction (`var c = Counter(); c.value = 0;`). Inherit with `class Sub < Super { ... }` (circular inheritance is rejected). A class name is a usable type, and `nil` is assignable to any class-typed target. Methods are chosen by the declared type, not the object's (see Traps).
13. **Function/lambda types are written `(P1, P2) => R`** — e.g. `var f: (number, number) => number = add;`. Functions are first-class and can be passed, returned, and curried (`identity(add)(1, 2)`).
14. **No standard library / built-ins.** There is no `clock()`, no string methods, no `for`-each, no arrays/lists/maps. The only output is `print`.
15. **Comments** are `// line` and `/* block */`. Strings are double-quoted only, with no escape sequences or interpolation; a string cannot contain `"`.

## Traps: valid code that does the wrong thing

Each of these was checked against the interpreter. The first two pass the type checker and only go
wrong when the program runs, so write around them from the start.

1. **A `return` inside a `while` or `for` does not leave the loop.** The loop keeps running and
   the function returns later, with a different value — or never, and the 5-second cap kills it.
   `return` from inside an `if` outside any loop is fine. For an early exit, put a flag in the
   loop condition and return after the loop:

   ```lox
   fun firstAbove(limit: number): number {
       var found = -1;
       var d = 0;
       while ((found == -1) and (d < 5)) {
           d = d + 1;
           if (d > limit) { found = d; }
       }
       return found;
   }
   ```

2. **Methods are chosen by the variable's declared class, not the object's.** An overriding method
   runs only when called through a variable, parameter or field typed as the subclass. Through a
   `Shape`-typed parameter, `shape.area()` always runs `Shape.area`, even for a `Square`. Call
   overridden methods through the object's own class; `super.method()` works as expected.

3. **Comparisons bind tighter than every other binary operator.** Precedence, loosest first:
   `=`, then `+ -`, then `* /`, then `and or`, then `< <= > >= == !=`. So `d * d <= n` is
   `d * (d <= n)` and `a + 1 < b` is `a + (1 < b)` — both type errors. **Parenthesise arithmetic
   inside a comparison:** `(d * d) <= n`, `(a + 1) < b`. `a < b and b < c` needs no parentheses.

4. **There is no `%`.** Build a remainder from subtraction:

   ```lox
   fun remainder(a: number, b: number): number {
       var r = a;
       while (r >= b) { r = r - b; }
       return r;
   }
   ```

5. **An empty linked structure is a class-typed `nil`.** Declare it with its type
   (`var head: Node = nil;`), test it with `== nil` / `!= nil`, and walk it with a `while` loop.

6. **There are no lambda expressions.** To return a function, declare a nested named `fun` and
   return it by name; it captures the enclosing parameters:

   ```lox
   fun makeAdder(n: number): (number) => number {
       fun add(x: number): number { return x + n; }
       return add;
   }
   ```

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

// classes — fields `name: Type`, methods `name(): Ret { ... }`, construct with Name()
class Counter {
    value: number
    bump(): void { this.value = this.value + 1; }
    get(): number { return this.value; }
}
var c = Counter();
c.value = 0;          // fields start nil; assign after construction (no `new`, no ctor args)
c.bump();
print c.get();        // 1
```

## Common mistakes to reject when reviewing

- Untyped parameters or a missing return type on a `fun`/method.
- `var x;` with neither a type nor a value.
- A non-`void` function with no `return`.
- Using a number/string/`nil` as an `if`/`while` condition, or relying on truthiness.
- `and`/`or`/`!` on non-booleans; arithmetic or `<`/`>` on non-numbers.
- `print(x)` instead of `print x;`, or a missing `;` on a statement.
- Using `%`, exponentiation, arrays, `clock()`, or other built-ins that don't exist.
- A class field declared with `var` or a trailing `;` (it's `name: Type`), or a method written with `fun`; using `new` or passing constructor arguments (construct with `ClassName()`, then assign fields).
- Escape sequences or `"` inside string literals.
- Anything in **Traps** above: a `return` inside a loop, an override called through a superclass-typed
  variable, or arithmetic inside a comparison without parentheses.

## References

Consult these bundled files for detail; prefer them over recalling canonical Lox:

- `references/grammar.md` — full syntax: declarations, expressions, precedence, terminals, type syntax.
- `references/semantics.md` — type-checking rules, runtime behavior, truthiness, errors, the 5s timeout, and class semantics.
- `references/examples.lox` — a curated program that validates and runs (use as a copy-from template).

## Authoring & review workflow

When writing a `.lox` file: produce a program that passes the type checker (rules above), keep
statements terminated, brace all blocks, and avoid nonexistent built-ins.

To actually run a program through the bundled interpreter (5-second execution cap):

```bash
cd packages/langium-lox
npm install            # first time; needs Node >=20, npm >=10
npm run build          # or `npm run watch`
node ./langium/lib/interpreter/cli.js run ./examples/basic.lox
```
