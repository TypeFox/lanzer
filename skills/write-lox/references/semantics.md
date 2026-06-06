# langium-lox — Semantics Reference

Distilled from the validator (`lox-validator.ts`), the type system
(`type-system/operator.ts`, `assignment.ts`, `infer.ts`, `descriptions.ts`), and the interpreter
(`interpreter/runner.ts`). These files are authoritative.

## Types and values

| Type      | Runtime value          | Literals                |
|-----------|------------------------|-------------------------|
| `number`  | JS number (double)     | `42`, `3.14`            |
| `string`  | JS string              | `"text"`                |
| `boolean` | JS boolean             | `true`, `false`         |
| `void`    | (return type only)     | —                       |
| function  | the function value     | `fun`/lambda type form  |
| `nil`     | JS `null`              | `nil`                   |

`nil` is its own type; it is **assignable only to a class-typed target** (see assignment rules).
`print nil;` outputs `null`.

## Static type checking (validator)

Checks that run during validation:

### Variable declarations
- If both a type and a value are present, the value's type must be assignable to the declared type;
  otherwise: `Type 'X' is not assignable to type 'Y'.`
- If **neither** a type nor a value is present: `Variables require a type hint or an assignment at creation`.

### Function / method return types
- If the declared return type is not `void` and the body has **no** `return` statement:
  `A function whose declared type is not 'void' must return a value.`
- Every `return`'s value type must be assignable to the declared return type.
- (`void` functions may use `return;` or omit it.)

### Binary operations — `isLegalOperation`
- `+` : both operands must each be `number` **or** `string` (any mix of the two is legal).
- `-`, `*`, `/`, `<`, `<=`, `>`, `>=` : both operands must be `number`.
- `and`, `or` : both operands must be `boolean`.
- `=` (assignment): right type must be assignable to left type.
- `==`, `!=` : always allowed, but if the two sides are not assignable you get a **warning**:
  `This comparison will always return 'false'/'true' as types ... are not compatible.`
- An illegal operation is an error:
  `Cannot perform operation 'OP' on values of type 'A' and 'B'.`

> Note: `operator.ts` lists `%` as a legal numeric operator, but `%` is **not in the grammar**
> (Multiplication only parses `*`/`/`) and the interpreter has no `%` case. Treat `%` as unavailable.

### Unary operations
- `!` : operand must be `boolean`.
- `-`, `+` : operand must be `number`.
- Otherwise: `Cannot perform operation 'OP' on value of type 'A'.`

### Classes
- **Every `class` declaration is an error**: `Classes are currently unsupported.`
  Any program containing a class fails validation. The interpreter independently throws
  `Classes are currently unsupported` if one is reached.

## Assignability (`isAssignable(from, to)`)

- Class type → class type: assignable iff `from` is the same class as `to` or a subclass (walks the
  `<` inheritance chain). (Only relevant if classes worked.)
- `nil` → assignable **only** to a class type.
- Function type → function type: same parameter count, each parameter type assignable, and the
  return type assignable. (Structural, by position; parameter names ignored.)
- Otherwise: assignable iff the `$type` tags match exactly (e.g. `number`→`number`). There is **no**
  implicit `number`↔`string`↔`boolean` coercion.

## Runtime behavior (interpreter/runner.ts)

- **Top-level evaluation is sequential**, except `class` and `fun` declarations are skipped in the
  main loop (functions are resolvable by reference, giving forward/hoisted visibility for calls;
  encountering a `class` at top level throws). Variables are **not** hoisted — use before declaration
  fails with `No variable 'x' defined`.
- **Scoping is lexical with block scopes.** Each `{ }` block, function call, and `for` header
  introduces a scope. Assignment (`set`) walks outward to find an existing binding; reading an
  undefined name throws `No variable 'x' defined @line:col`.
- **Conditions are strict.**
  - `if`: runs the `then` block only when the condition evaluates to **exactly `true`**; otherwise
    runs `else` if present. A non-`true` (e.g. a number) condition takes the `else`/does nothing.
  - `while`: loops only while the condition is **exactly `true`**.
  - `for`: loops while the condition is *truthy* via JS `Boolean(...)` (a minor inconsistency with
    `if`/`while`) — but the type checker still requires a boolean comparison, so write boolean conditions.
  - **Do not rely on truthiness.** Always use explicit boolean expressions.
- **Operators at runtime** mirror the static rules and additionally enforce operand types, throwing
  `Cannot apply operator 'OP' to values of type ...` on violation. `+` does JS `+` (numeric add or
  string concat). `==`/`!=` are JS `===`/`!==`. There is **no** `%` case (would throw "unknown").
- **Functions / closures**: first-class. Calling pushes a scope, binds arguments positionally to
  parameter names, runs the body, and returns the `return` value (or `undefined` if none). Nested
  functions capture their enclosing scope. Currying works: `identity(returnSum)(1, 2)`.
- **`print`** logs the raw runtime value: numbers as numbers, strings as text, booleans as
  `true`/`false`, `nil` as `null`.
- **Execution timeout**: the interpreter cancels after **5 seconds** (`TIMEOUT_MS`). Infinite or
  long loops are aborted.

## Practical implications for generated code

- Always give conditions a boolean shape (`a < b`, `flag == true`, `!done`).
- Initialize variables before use; don't depend on hoisting for `var`.
- Use `+` for string building; everything else numeric stays numeric.
- Keep loops bounded (5s cap).
- Never emit `class`/`this`/`super`, `%`, arrays, or library calls in code meant to run.
