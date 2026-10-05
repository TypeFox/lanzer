# The Lanzer DSL

A `.lanzer` file imports your grammar and declares campaigns. A campaign says which files the agent writes, what each must contain, and what the program must do.

## A first campaign

```lanzer
import "../../langium-lox/langium/src/language-server/lox.langium"

campaign helloLox {
    description "A small statically-typed Lox program with two functions."
    workspace "test/hello-world"

    file mainFile at "src/main.lox" generates LoxProgram {
        require FunctionDeclaration[name="main"]
        require FunctionDeclaration[name="greet"]
        min 2 FunctionDeclaration
    }
}
```

| Line | Meaning |
|---|---|
| `import "…langium"` | The grammar the files are written in. Paths are relative to the `.lanzer` file. |
| `workspace "…"` | The folder the agent writes into, relative to the `.lanzer` file. |
| `file <name> at "<path>" generates <Rule>` | A file to write, and the grammar rule its root must be. |
| `description "…"` | Plain-language intent, for the campaign or one file. |

## Requirements

Requirements are **selectors** over your grammar's AST, like CSS selectors over a DOM.

```lanzer
require FunctionDeclaration[name="gcd"]                 // exists
min 2 FunctionDeclaration                               // at least 2
forbid PrintStatement                                   // must not exist
require FunctionDeclaration[name="gcd"] >> MemberCall   // a call anywhere inside gcd
require Class > MethodMember                            // a method directly inside a class
require MemberCall[element->FunctionDeclaration[name="gcd"]]   // a call that resolves to gcd
require Class:has(MethodMember[name="init"])            // a class with an init method
forbid Class:not(MethodMember[name="init"])             // no class without one
```

- Predicates: `=`, `!=`, `^=` (starts with), `$=` (ends with), `*=` (contains), or `[returnType]` alone for "is set".
- `->` follows a cross-reference to its target.
- At campaign level, add `in <file>` to point a requirement at one file.

::: tip Find the type names
Selectors use AST **type** names, which aren't always rule names. `types` lists each type, its properties and what can sit directly inside it:

```shell
npx lox-lanzer types ./examples/hello.lanzer
```
`validate` suggests fixes for typos and for `>` that should be `>>`.
:::

## Checking behaviour: `run`

```lanzer
run mainFile {
    expect runs                          // no runtime error, no timeout
    expect output "1\n2\n6\n24\n120\n"   // exact
    expect output contains "120"         // substring
    expect output matches "^1\\n"        // regex
    expect not output contains "nil"     // `not` inverts any check
}
```

Your host's `execute` runs the program. The agent sees the expected output, so pair it with requirements that make it compute the answer.

## Support files

A file the campaign provides, such as a fixed test driver. A run can start from it; if the agent changes it, the run fails.

```lanzer
file lib at "lib.lox" generates LoxProgram {
    require FunctionDeclaration[name="gcd"]
}
support driver at "driver.lox" description "The provided test driver; do not change it."
run driver { expect output "21\n" }
```

## Negative files

To test your validator, a file can say how the language must **reject** it. The agent writes a program that is wrong in exactly that way.

```lanzer
file mainFile at "src/main.lox" generates LoxProgram {
    require VariableDeclaration
    expect error code "LOX_TYPE_NOT_ASSIGNABLE" message matches "^Type '\\w+' is not assignable"
}
```

- Severity is `error`, `warning` or `info`; give a `code`, a `message`, or both.
- Any error no line accounts for fails the file.
- A campaign with a negative file can't have `run` blocks.

More examples in [`packages/lanzer-lox/examples`](https://github.com/TypeFox/lanzer/tree/main/packages/lanzer-lox/examples).
