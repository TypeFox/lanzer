# Langium Lox

This repository contains a [Langium](https://langium.org) based implementation of the [Lox language](https://craftinginterpreters.com/the-lox-language.html).

> **Provenance.** Vendored from [TypeFox/langium-lox](https://github.com/TypeFox/langium-lox)
> at commit `aebaa63835f6ac102fb4de1867c06aa7dd2eb939`. It was originally a git submodule and is
> now maintained as regular files in this monorepo. Local changes since vendoring:
> upgraded Langium 3.1.x → 4.1.x (and TypeScript to 5.8), and added `createLanzerLoxServices`
> in `langium/src/language-server/lox-module.ts` to host the Lox, Lanzer, and Langium-grammar
> languages in one shared service container (so Lanzer campaigns can target Lox). The `langium`
> and `vscode` sub-packages are now workspaces of the parent monorepo.

![](https://user-images.githubusercontent.com/4377073/178360339-109b40ba-f41f-457b-bddf-16bd5e2a7119.png)

## How to build

Langium requires Node.js >=20 and npm >=10 (we recommend using [Volta](https://volta.sh/) to ensure your node & npm always match). Once you have those requirements installed, you can build the language using:

```shell
npm install
```

Then either use `npm run watch` or `npm run watch` depending on your needs.

This will automatically compile the language and other sources. Afterwards you can run the language using the `Run Extension` vscode launch config.

The [`examples/basic.lox`](https://github.com/langium/langium-lox/blob/main/examples/basic.lox) file contains a small sample of what the language is capable of. Try it out!

## How does it work

The [langium grammar](https://github.com/langium/langium-lox/blob/main/langium/src/language-server/lox.langium) contains all of the magic necessary to make the Lox language run in vscode.

It contains a grammar definition of the Lox language which is transformed into a parser for that language.
Langium additionally provides advanced editor features, such as code completion, goto reference/find references, folding, and more.

## Debugging the CLI

In VSCode open a **JavaScript Debug Terminal** and then execute the following command:

```shell
node ./langium/lib/interpreter/cli.js run ./examples/basic.lox
```

## Targeting Lox from Lanzer

This package is wired into [Lanzer](../lanzer), the monorepo's campaign DSL for
structured, requirement-checked code generation. A `.lanzer` campaign imports a host
grammar and declares structural requirements (CSS-style selectors over that grammar's
AST); Lanzer validates those requirements before generation and re-checks them against
the generated code afterwards.

Two pieces make Lox a first-class Lanzer host language:

- **`createLanzerLoxServices`** (in [`langium/src/language-server/lox-module.ts`](langium/src/language-server/lox-module.ts))
  hosts the Lox, Lanzer, and Langium-grammar languages in one shared service container, so a
  single workspace can parse and validate both `.lanzer` campaigns and the `.lox` files they target.
- **`LoxLanzerService`** (in [`langium/src/language-server/lanzer/lox-lanzer.ts`](langium/src/language-server/lanzer/lox-lanzer.ts))
  fills in the host-language hooks the generation pipeline asks for: `getGenerationPolicy`
  injects the langium-lox rules (mandatory type annotations, boolean-only conditions; no
  classes, no `%`, no truthiness, no standard library), and `dslSkill` points the generator at
  the `write-lox` skill. A companion `LoxLanzerCampaignRunner` reports only hard errors.

### Sample campaigns

Two example campaigns targeting the Lox grammar live in [`examples/lanzer/`](examples/lanzer/):

- [`hello.lanzer`](examples/lanzer/hello.lanzer) — a single `.lox` file that must define `greet`
  and `main`, have `main` call something, print at least once, and never declare a class.
- [`calculator.lanzer`](examples/lanzer/calculator.lanzer) — a multi-file campaign splitting typed
  numeric helpers (`add`/`sub`/`mul`/`applyTwice`) from a `main` entry point, with file-local and
  campaign-level requirements.

Both import the Lox grammar with `import "../../langium/src/language-server/lox.langium"` and use
`generates LoxProgram` (the grammar's entry rule). Selectors reference real Lox AST node types —
`FunctionDeclaration[name="..."]`, `PrintStatement`, `MemberCall[explicitOperationCall]`,
`BinaryExpression[operator="%"]`, `Class`.

### Running the samples

This package ships a prebuilt CLI, **`lox-lanzer`** ([`langium/bin/lox-lanzer.js`](langium/bin/lox-lanzer.js)),
that drives campaigns with the Lox-aware services. Build the package first (`npm run build`), then
from this directory:

```shell
# Validate a campaign (surface-level checks AND static reachability of every selector
# against the Lox grammar) — does not call an agent:
node ./langium/bin/lox-lanzer.js validate ./examples/lanzer/hello.lanzer

# Resolve into concrete generation jobs (output paths, root rule, requirement counts),
# optionally previewing the prompt for one job — does not call an agent:
node ./langium/bin/lox-lanzer.js plan ./examples/lanzer/calculator.lanzer
node ./langium/bin/lox-lanzer.js plan ./examples/lanzer/calculator.lanzer --job mathFile --prompt
```

To actually generate the `.lox` files, configure an ACP agent and run `generate`:

```shell
cp .env.copy .env          # edit .env for your agent runtime; see .env.copy for the options
node --env-file=.env ./langium/bin/lox-lanzer.js generate ./examples/lanzer/calculator.lanzer
```

`generate` applies the Lox generation policy and the `write-lox` skill, dispatches each job to the
agent over ACP, and re-validates the produced files against the campaign requirements (reporting
only hard errors). `validate`/`plan` use Lanzer's generic services and so do not emit the
Lox-specific policy — that is applied only on the `generate` path via `createLanzerLoxServices`.

Pass `--verbose` to watch what the agent does (the commands it runs, the files it touches, and its
narration):

```shell
node --env-file=.env ./langium/bin/lox-lanzer.js generate ./examples/lanzer/hello.lanzer --verbose
```

### Running a produced file

The campaigns write their output under `examples/lanzer/out/` (the `workspace "out"` declared in
each campaign). Once generated, run a `.lox` file through the interpreter to see it execute:

```shell
node ./langium/lib/interpreter/cli.js run ./examples/lanzer/out/hello.lox
```

That closes the loop: a `.lanzer` campaign describes and constrains the program, `generate` produces
a `.lox` file that satisfies those constraints, and the interpreter runs it.

The same flows are available as library functions (`runLoxCampaignFile`, and the host-agnostic
`runLanzerCampaign`) — see the "Using Lanzer" section in the [repository README](../../README.md).
