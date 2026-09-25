---
name: lanzer
description: Create, edit, validate, and explain Lanzer DSL campaign files for structured multi-file code generation in this repository. Use when the user asks to work with `.lanzer` files, split generation across many files, add workspace or support-file context, repair Lanzer syntax, inspect Lanzer planning output, or turn informal generation goals into explicit Lanzer requirements.
metadata:
  short-description: Work with Lanzer campaigns
---

# Lanzer

Lanzer is the repository's DSL for structured generation campaigns. A `.lanzer` file is not the final prompt sent to ACP; the Lanzer runner turns the campaign into concrete jobs and prompt payloads, dispatches generation, and then **statically validates** the result against the requirements you write — by walking the generated AST.

Lanzer is **language-agnostic**: a campaign targets whatever Langium grammar it imports, and all
requirements are selectors over that grammar's AST. The rule and type names you write in selectors
(`FnDecl`, `Module`, etc. below are only illustrative) come from **your** imported grammar — always
check the grammar for the real names.

Use this skill when the task is about:
- creating a new `.lanzer` campaign
- modifying or debugging an existing campaign
- expanding one generated file into several generated files
- adding `workspace` or `support` context
- making campaign intent machine-checkable with selector requirements
- validating or planning a campaign before generation

Do not use this skill for editing the host language's source files themselves.

## Core model

A campaign has these layers:

1. `import "<path>.langium"` — at the top of the file, one or more imports of the **host grammar** the generated code must conform to. All `require` / `min` / `forbid` requirements reference rules and types defined in this grammar, and Lanzer statically checks that they are reachable.
2. `campaign` — the whole generation request.
3. `workspace` — **required.** The project root the generated files live in; every `file` path is resolved relative to it. Declare it right after the optional `description` and before any `file`.
4. `file` — one generated output and its file-local requirements.
5. `support` — the project's own non-generated files: a manifest, a config, a lock file. The
   agent may create, update or remove them freely; it is building the project, and a project is
   more than its source files. Lanzer does not police them — what a valid one looks like belongs
   in the DSL skill, which is where the agent learns the language's conventions anyway.

   Give each a `description` saying what it is for. That plus the skill is what the agent works
   from. A support file written in the host language is also parsed and validated alongside the
   generated files; one in another format (JSON, TOML) is context only.
6. Campaign-level `require ... in <fileAlias>` constraints for cross-file expectations.

## DSL shape

```lanzer
import "<path>/your-language.langium"

campaign exampleName {
    description "High-level goal for the whole generated artifact set."
    workspace "../path/to/project-root"

    file someFile at "src/some-file.<ext>" generates <RootRule> {
        description "What this file should contain."
        require FnDecl[name="main"]
        require FnDecl[name="main"] >> FunctionCall
        min 2 FnDecl
        forbid FnDecl[name="eval"]
    }

    support config at "config.json" description "Existing context the generator may read."

    require FnDecl[name="main"] in someFile
}
```

`generates <RootRule>` names the entry parser rule of the imported grammar (the rule marked `entry`
in the `.langium` file). The type names in the selectors above (`FnDecl`, `FunctionCall`) are
placeholders — substitute the actual rule/type names from your grammar.

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

// A declaration named "Entry" that wraps a specific sub-kind (when the grammar nests kinds)
require TypeDecl[name="Entry"]:has(>> ClassType)

// At least one declaration of a kind that does NOT contain a given sub-kind
require TypeDecl:not(>> ClassType)

// Forbid functions whose name starts with an underscore
forbid FnDecl[name^="_"]
```

## Static reachability

Lanzer's authoring validator catches structurally impossible selectors **before** generation runs. It rejects:

- Unknown types: a selector naming a type that the grammar does not define
- Unknown properties: `SomeType[notAProp="x"]` where `notAProp` is not a property of `SomeType`
- Cross-reference target mismatches: `[reference->WrongType]` where the cross-ref resolves to a different type than `WrongType`
- Unreachable combinator paths: `A > B` when `B` never appears as a direct child of `A` in the grammar (it may only appear deeper — use `>>`)

If you write a selector and Lanzer says it's not reachable, the path you described literally cannot occur in the host grammar's AST. Re-check the grammar — typically you need a different rule or `>>` instead of `>`.

## Authoring rules

- Always include the `import` line — selectors will not link otherwise.
- Prefer one `file` block per generated source file.
- Always declare `workspace` — it is required, and all `file` paths resolve relative to it.
- Put existing context files such as `module.json` under `support`, not `file`.
- Use file-local `require` entries for obligations that belong to one file.
- Use campaign-level requirements with `in <fileAlias>` when relationships between files matter.
- Use `description` aggressively — it carries the informal intent that the generator uses to enrich the concrete jobs.
- Keep aliases short and stable, because other requirements refer to them.

## Translating user intent

Map informal requests into selectors. The exact type/property names depend on your grammar; the
**patterns** are what transfer:

| Informal | Selector pattern |
|---------|----------|
| "Has a declaration named X" | `require <DeclType>[name="X"]` |
| "Declaration X contains a call/use of something" | `require <DeclType>[name="X"] >> <CallType>` |
| "X references/calls Y (follow cross-reference)" | `require <DeclType>[name="X"] >> <RefType>[reference-><DeclType>[name="Y"]]` |
| "Defines a construct of kind K named X" (when a wrapper rule holds the kind) | `require <WrapperType>[name="X"]:has(>> <KindType>)` |
| "Has at least N declarations of a kind" | `min N <DeclType>` |
| "Never uses a forbidden symbol" | `forbid <RefType>[reference-><DeclType>[name="forbidden"]]` |

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

## Working with your host grammar

The selector type/property names are entirely determined by the imported `.langium` grammar — there
are no built-in names. Before writing requirements:

- Open the imported grammar and read its parser rules. The `entry` rule is your `generates <RootRule>`.
- Each rule name is a selectable type; each assignment in a rule (`name=ID`, `value=Expr`, ...) is a
  selectable property; each `[Ref:ID]` cross-reference is queryable via `[prop->TargetType]`.
- Type unions / `infer` actions create additional selectable type names — use `:has(>> Kind)` when a
  wrapper rule holds a sub-kind.
- Treat config/manifest files the project needs as `support` (read-only context), not `file`, unless
  the user explicitly wants them generated.
- If you are unsure a selector is valid, write it and run `validate` — Lanzer checks reachability
  against the actual grammar and tells you exactly what's wrong.

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

Running a campaign through ACP generation is driven by the **host language's** CLI or by the
library directly — `validate`/`plan` are part of the generic `lanzer` engine, but actually
generating files requires host services (the generation policy and DSL skill for that language). See
the host package's own tooling for its `generate` command.

ACP settings are read from environment variables (`LANZER_ACP_COMMAND`, `LANZER_ACP_MODEL`,
`LANZER_ACP_PROVIDER`, `LANZER_ACP_EFFORT`, `LANZER_ACP_MAX_ATTEMPTS`, `LANZER_ACP_ALLOW`).

`LANZER_ACP_ALLOW` lists the ACP tool kinds the agent may use — `read`, `edit`, `delete`, `move`,
`search`, `execute`, `think`, `fetch`, `switch_mode`, `other`. Unset means the generation baseline
(`read`, `edit`, `search`, `think`, `other`): enough to write files, no shell and no network. Naming
any kind limits the run to exactly those. A campaign that needs the agent to run commands must say
so with `execute`, or with `--allow-all` on the host CLI.

During generation the agent can call Lanzer's own tools — `validate` (the same campaign check that
grades the run) and `grammar_reference` — served in-process. `generate` reports the outcome per
campaign and accepts `--report <path>` for a JSON dump; a failure names the stage it failed at
(`launch`, `session`, `turn`, `no_output`, `syntax`, `semantics`, `requirements`, `scope`).

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
- when porting an older campaign that uses pre-selector syntax (`require function "..."`, `require call "..."`, `min N functions`), translate to the selector forms above and set the root rule to your grammar's `entry` rule

## Reference

Read these concrete, validating example campaigns (they target the Lox grammar, but the structure
is the same for any host language):
- `references/hello.lanzer` — a single-file campaign
- `references/calculator.lanzer` — a multi-file campaign with cross-file requirements
