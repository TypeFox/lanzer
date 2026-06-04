---
name: lanzer
description: Create, edit, validate, and explain Lanzer DSL campaign files for structured multi-file code generation in this repository. Use when the user asks to work with `.lanzer` files, split generation across many files, add workspace or support-file context, repair Lanzer syntax, inspect Lanzer planning output, or turn informal generation goals into explicit Lanzer requirements.
metadata:
  short-description: Work with Lanzer campaigns
---

# Lanzer

Lanzer is the repository's DSL for structured generation campaigns. A `.lanzer` file is not the final prompt sent to ACP; the Lanzer runner turns the campaign into concrete jobs and prompt payloads, dispatches generation, and then **statically validates** the result against the requirements you write — by walking the generated AST.

Use this skill when the task is about:
- creating a new `.lanzer` campaign
- modifying or debugging an existing campaign
- expanding one generated file into several generated files
- adding `workspace` or `support` context
- making campaign intent machine-checkable with selector requirements
- validating or planning a campaign before generation

Do not use this skill for ordinary `.tc` source editing.

## Core model

A campaign has these layers:

1. `import "<path>.langium"` — at the top of the file, one or more imports of the **host grammar** the generated code must conform to. All `require` / `min` / `forbid` requirements reference rules and types defined in this grammar, and Lanzer statically checks that they are reachable.
2. `campaign` — the whole generation request.
3. `workspace` — the project root the generated files live in.
4. `file` — one generated output and its file-local requirements.
5. `support` — existing context files the generator may read but **must not** generate.
6. Campaign-level `require ... in <fileAlias>` constraints for cross-file expectations.

## DSL shape

```lanzer
import "../../language/src/type-c.langium"

campaign exampleName {
    description "High-level goal for the whole generated artifact set."
    workspace "../path/to/project-root"

    file someFile at "src/some-file.tc" generates Module {
        description "What this file should contain."
        require FnDecl[name="main"]
        require FnDecl[name="main"] >> FunctionCall
        min 2 FnDecl
        forbid FnDecl[name="eval"]
    }

    support moduleConfig at "module.json" description "Project workspace configuration."

    require FnDecl[name="main"] in someFile
}
```

`generates <RootRule>` names the entry parser rule of the host grammar. For Type-C, this is `Module`.

## Requirements: selectors over the host AST

Every requirement is a **CSS-style selector** that picks nodes out of the generated file's AST. Three verbs wrap selectors:

| Verb | Meaning |
|------|---------|
| `require <selector>` | At least one matching node must exist. |
| `min N <selector>` | At least N matching nodes must exist. |
| `forbid <selector>` | Zero matching nodes — flags anti-patterns. |

### Selector grammar

A selector is a chain of **parts** connected by **combinators**:

```
<Type>[predicate1][predicate2]:pseudo(...) <combinator> <Type>[...] <combinator> <Type>[...]
```

**Combinators**
- `>` — direct child
- `>>` — descendant at any depth (use this when the structural path goes through wrappers you don't care to enumerate)

**Predicates** appear in square brackets and filter nodes by their properties:

- `[prop="value"]` — string equality
- `[prop!="value"]` — string inequality
- `[prop^="prefix"]` / `[prop$="suffix"]` / `[prop*="substr"]` — starts/ends/contains
- `[prop]` — property is present (non-empty)
- `[prop->TargetType[...]]` — `prop` is a cross-reference whose resolved target is of type `TargetType`, optionally further filtered

**Pseudo-classes** attach to a part and root their inner selector at that match:

- `:has(<selector>)` — the node has at least one inner match
- `:not(<selector>)` — the node has zero inner matches

Inside `:has` and `:not`, a leading combinator changes semantics: `:has(> Foo)` means "direct child Foo", `:has(Foo)` (default `>>`) means "descendant Foo".

### Examples

```lanzer
// A function declaration named "main"
require FnDecl[name="main"]

// The main function contains a call somewhere inside it
require FnDecl[name="main"] >> FunctionCall

// The main function calls a specific other function (follow cross-reference)
require FnDecl[name="main"] >> QualifiedReference[reference->FnDecl[name="sort"]]

// At least 3 top-level function declarations
min 3 FnDecl

// A class type declaration named "Entry" (Type-C wraps anonymous classes in a TypeDecl)
require TypeDecl[name="Entry"]:has(>> ClassType)

// At least one type declaration that is *not* a class
require TypeDecl:not(>> ClassType)

// Forbid functions whose name starts with an underscore
forbid FnDecl[name^="_"]
```

## Static reachability

Lanzer's authoring validator catches structurally impossible selectors **before** generation runs. It rejects:

- Unknown types: `FooDoesNotExist[name="x"]`
- Unknown properties: `FnDecl[notAProp="x"]`
- Cross-reference target mismatches: `SubModule[reference->ClassType]` (the cross-ref targets `IdentifiableReference`, not `ClassType`)
- Unreachable combinator paths: `ClassType > FnDecl` (functions don't appear directly inside classes — they are `ClassMethod` nodes there)

If you write a selector and Lanzer says it's not reachable, the path you described literally cannot occur in the host grammar's AST. Re-check the grammar — typically you need a different rule or `>>` instead of `>`.

## Authoring rules

- Always include the `import` line — selectors will not link otherwise.
- Prefer one `file` block per generated source file.
- Add `workspace` when the target project root is known.
- Put existing context files such as `module.json` under `support`, not `file`.
- Use file-local `require` entries for obligations that belong to one file.
- Use campaign-level requirements with `in <fileAlias>` when relationships between files matter.
- Use `description` aggressively — it carries the informal intent that the generator uses to enrich the concrete jobs.
- Keep aliases short and stable, because other requirements refer to them.

## Translating user intent

Map informal requests into selectors:

| Informal | Selector |
|---------|----------|
| "Has a function named X" | `require FnDecl[name="X"]` |
| "Calls function X" | `require FunctionCall:has(>> QualifiedReference[reference->FnDecl[name="X"]])` or, in a specific function, `require FnDecl[name="callerName"] >> FunctionCall` |
| "Defines a class named X" | `require TypeDecl[name="X"]:has(>> ClassType)` |
| "Defines an interface X" | `require TypeDecl[name="X"]:has(>> InterfaceType)` |
| "Defines a variant X" | `require TypeDecl[name="X"]:has(>> VariantType)` |
| "Imports X from somewhere" | `require SubModule[reference->IdentifiableReference[name="X"]]` |
| "Has at least N functions" | `min N FnDecl` |
| "No use of `eval`" | `forbid QualifiedReference[reference->FnDecl[name="eval"]]` |

For multi-file projects:
- Create multiple `file` blocks, each narrow and explicit.
- Add campaign-level requirements with `in <fileAlias>` for cross-file relationships.
- Add `support` entries for important existing files.

## What to avoid

- Do not omit the `import` statement — every selector resolves against it.
- Do not put ACP transport details into `.lanzer`.
- Do not use `support` for files that must be generated.
- Do not collapse a multi-file project into one giant generated file unless the user explicitly wants that.
- Do not write selectors against rule names that don't appear in the imported grammar — Lanzer will reject the campaign.
- Do not use `>` when a structural wrapper sits between the parent and child types — switch to `>>` (descendant).

## Repo-specific guidance for Type-C

- Treat `module.json` as a support/context file unless the user explicitly wants it generated.
- Use `generates Module` as the root rule for `.tc` files.
- Common rule names: `FnDecl` (functions), `TypeDecl` (type aliases), `ClassType` / `InterfaceType` / `VariantType` / `StructType` (anonymous, accessed via `TypeDecl[name="X"]:has(>> Kind)`), `FunctionCall` (call sites), `QualifiedReference` (identifier references with `reference` cross-ref), `Import` / `SubModule` (imports), `VariableDeclSingle` (variables), `ClassMethod` (methods inside classes).
- Prefer multi-file campaigns for substantial Type-C programs.

## Validation workflow

After editing a `.lanzer` file, validate it before relying on it:

```bash
node packages/lanzer/bin/lanzer.js validate <campaign.lanzer>
```

The validator runs both surface-level checks (duplicate aliases, empty paths) **and** static reachability checks (every selector is structurally possible in the imported grammar).

To inspect the generated jobs or prompt preview:

```bash
node packages/lanzer/bin/lanzer.js plan <campaign.lanzer>
node packages/lanzer/bin/lanzer.js plan <campaign.lanzer> --job <alias> --prompt
```

To run a campaign through ACP generation:

```bash
node packages/compiler/bin/cli.js generate-campaign <campaign.lanzer>
```

ACP settings are read from `.env` (`LANZER_ACP_COMMAND`, `LANZER_ACP_MODEL`, `LANZER_ACP_PROVIDER`, etc.). Use `--concurrency <n>` to control parallel campaigns.

After generation, Lanzer runs each requirement's selector against the generated file's AST. Failures are reported as `Required selector did not match any node ...`, `Selector matched K of required N ...`, or `Forbidden selector matched K node(s) ...`.

## Output expectations

When the user asks for a Lanzer campaign:
- include the top-level `import` line
- produce a valid `.lanzer` file or patch
- keep formatting simple and readable
- include `description` strings
- prefer explicit multi-file structure over vague broad prompts
- when in doubt about a selector, validate it with `lanzer validate` before handing it back

When modifying an existing campaign:
- preserve existing aliases when possible
- add requirements surgically
- do not remove `support` files or `workspace` declarations unless the user intends that
- when porting an older campaign that uses pre-selector syntax (`require function "..."`, `require call "..."`, `min N functions`, `generates MainProgram`), translate to the selector forms above and switch the root rule to `Module`

## Reference

Read the example campaign for a concrete pattern:
- `references/sorting-demo.lanzer`
