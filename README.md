# Lanzer
> An agent-driven Fuzzer for Langium based DSL

<p align="center">
  <img src="assets/lanzer.webp" alt="Lanzer" width="600">
</p>

## What is Lanzer
Lanzer is a semiformal DSL and tools around it, for generating samples, for your DSL.
The DSL is used as a specification for the samples you want to generate, with formal constraints imposed on the output, and an informal description of what the sample should do.

```
import "mylang.langium"

campaign sortingDemo {
  description "Sort an array of integers."
  workspace "test/test-cases/hello-world"

  file sortFile at "src/sort.tc" generates Module {
    require FnDecl[name="sort"]
    require FnDecl[name="partition"]
    min 2 FnDecl
  }

  file mainFile at "src/main.tc" generates Module {
    require FnDecl[name="main"]
    require FnDecl[name="main"] >> FunctionCall
    forbid FnDecl[name="eval"]
  }
}
```


## How it works
`Lanzer` allows you generate positive samples, for your DSL, it can be used for a variety of cases ranging from stress testing language implementation (and your runtime potentially), generating code examples or even testing your DSL agent skill.

The CLI allows you to use any coding agent you have installed, to generate code, making sure that the generated output is not only a valid document, but also adheres to the fixture.

## Requirements
To leverage lanzer, you need:
- Fully functional langium-based DSL implementation (with validations too).
- An ACP compatible coding agent (claude code, codex, gemini cli, etc)
- An agent skill for your DSL (see more on how to generate an agent skill for your dsl here. TODO: Link langium AI)
- A small host integration package that plugs your language into Lanzer (a service supplying your
  generation policy + DSL skill). Your language itself stays **unmodified** — see **Plugging in your
  own DSL** below.

## Run the demo

The quickest way to see Lanzer working is the **Lox** example in
[`packages/lanzer-lox`](packages/lanzer-lox). It targets
[`langium-lox`](https://github.com/TypeFox/langium-lox), pulled in as a **git submodule that is
never modified** — `lanzer-lox` consumes it exactly as published. Clone with submodules, build
once, then configure the ACP agent:

```shell
git submodule update --init        # if you didn't clone with --recurse-submodules
npm install && npm run build
cd packages/lanzer-lox
cp .env.copy .env   # configure your ACP agent; only needed for `generate`, not `validate`
```

### Validating a campaign

`validate` checks that a campaign parses **and** that every selector is reachable against the Lox
grammar's AST — no agent involved. A good campaign:

```shell
node ./bin/lox-lanzer.js validate ./examples/hello.lanzer
```

```text
Lanzer campaign is valid: file:///…/packages/lanzer-lox/examples/hello.lanzer
```

A deliberately broken campaign ([`examples/invalid-demo.lanzer`](packages/lanzer-lox/examples/invalid-demo.lanzer),
which references a type and a property that don't exist in the Lox grammar) shows what failures
look like — and the command exits non-zero:

```shell
node ./bin/lox-lanzer.js validate ./examples/invalid-demo.lanzer
```

```text
Lanzer campaign is invalid: file:///…/packages/lanzer-lox/examples/invalid-demo.lanzer
- [diagnostic] @ 11:17 Could not resolve reference to AbstractRule named 'NonExistentNode'.
- [diagnostic] @ 12:37 Type 'FunctionDeclaration' has no property 'notAProp'.
```

### Generating from a campaign

Once a campaign is valid, generate the target `.lox` file(s) by dispatching it to your configured
agent (this one *does* call the agent and write files):

```shell
node --env-file=.env ./bin/lox-lanzer.js generate ./examples/hello.lanzer
```

See **Using Lanzer** below for the library equivalents and how to plug in your own DSL.

## Using Lanzer

`lanzer` is a **toolchain** around the generation engine: a library, plus a generic CLI that can
`validate` and `plan` any campaign with no host code. The host-specific part — driving `generate`
with your language's policy and skill — lives in your DSL package. There are three tiers below,
from least to most code; pick the one that fits.

The repo ships a complete worked example for the **Lox** language under
[`packages/lanzer-lox`](packages/lanzer-lox) — a standalone package that drives the unmodified
`langium-lox` submodule; the snippets below use it.

### 1. Prebuilt CLI (easiest)

`lanzer-lox` ships a ready-to-run CLI, `lox-lanzer`, that wraps the fast path. Configure an ACP
agent and generate the target files:

```shell
cd packages/lanzer-lox
cp .env.copy .env           # then edit .env for your agent runtime (see .env.copy)

# validate + plan never call an agent (no .env needed):
node ./bin/lox-lanzer.js validate ./examples/hello.lanzer
node ./bin/lox-lanzer.js plan     ./examples/hello.lanzer

# generate dispatches the campaign to your ACP agent and validates the result:
node --env-file=.env ./bin/lox-lanzer.js generate  ./examples/hello.lanzer
```

#### What the agent is allowed to do

A generation run is unattended, so the agent gets what writing files needs and nothing more:
`read`, `edit`, `search`, `think`, and `other` (which is where agents put skill loading). Running
shell commands, deleting or moving files, and reaching the network are all refused unless you ask
for them.

What actually confines the agent's file access depends on how the agent reaches the disk. ACP lets
an agent read and write through the client (`fs/read_text_file`, `fs/write_text_file`) but does not
require it, and asking the client's permission before a tool call is optional too. For an agent that
does use the client, Lanzer confines writes to the campaign's workspace and reads to the workspace
plus what Lanzer points it at (the grammar reference, the policy's reference files, the DSL skill),
judged after resolving symlinks.

Claude does not. `claude-agent-acp` (0.82.0) reads and writes through Claude Code's own tools, so for
Claude today the limits are:

- **Claude's session roots**: the workspace plus the directories Lanzer points it at. Claude keeps
  its file tools inside them, but it treats them all alike, so the reference and skill directories
  are writable to it, not read-only.
- **The file-set check after the run**, over the workspace only: a declared target left unwritten, or
  a changed support file that a `run` block starts from, fails the run. New files outside the
  declared set are reported, and fail the run only with `strictFileSet`.
- **The permission mode**, set through `session/set_mode`: `acceptEdits` when the policy allows
  `edit`, `default` otherwise. Lanzer always refuses Claude's `bypassPermissions` mode, even when
  your own Claude settings default to it.

Tightening the path confinement for Claude is open work, starting with a real run to show how far
these limits reach. Withholding `execute` stays essential either way: an agent with a shell steps around
every one of these checks.

A declared target that already exists when the run starts has to be rewritten by the agent: one left
untouched fails the run as `no_output`, since passing validation says nothing about a file the agent
never produced.

Widen or narrow it with `LANZER_ACP_ALLOW`, or per-run:

```shell
# let the agent run commands as well
node --env-file=.env ./bin/lox-lanzer.js generate ./examples/hello.lanzer --allow read,edit,search,think,other,execute

# no policy at all
node --env-file=.env ./bin/lox-lanzer.js generate ./examples/hello.lanzer --allow-all
```

The setting is read literally: naming any kind limits the run to exactly those, so the same option
both widens and narrows. Refusals are printed as they happen (`[perm] denied execute: …`) and are
named in the next fix pass, so the agent tries another route instead of retrying a closed one.

The policy is keyed on ACP tool *kinds* rather than tool names because Lanzer picks its agent at
runtime — Claude's `Bash`/`Edit` mean nothing to Codex, and a policy that silently enforced nothing
under another agent would be worse than none. One consequence is honest about its limits: the Codex
MCP transport has no permission callback, and its sandbox cannot separate running commands from
writing files, so a run there warns that `execute` is not enforced.

#### What the agent can call

During a run Lanzer serves the agent a small toolkit **in-process** — no subprocess, no external
MCP server. The agent connects back over a loopback port guarded by a per-run token:

- `validate` — parse errors, language diagnostics, and campaign requirements, run through the
  **same `CampaignRunner` that grades the run**. There is no second implementation to drift, and a
  `VALID` answer to the agent is the answer Lanzer will give.
- `grammar_reference` — the generated BNF for the target language.

Both are backed by services a host integration already implements, so nothing new is asked of a
host author. A run without them behaves exactly as before.

#### Checking behaviour

Requirements say what the generated code *is*; a `run` block says what it must *do*. Name a
declared file as the program's entry, and state what running it must produce:

```
campaign factorialLox {
    description "Print the factorials of 1 through 5, computed by a recursive function."
    workspace "test/factorial"

    file mainFile at "src/main.lox" generates LoxProgram {
        require FunctionDeclaration[name="factorial"]
    }

    run mainFile {
        expect runs                          // finishes: no runtime error, no timeout
        expect output "1\n2\n6\n24\n120\n"    // exact (trailing whitespace ignored)
        expect output contains "120"         // substring
        expect output matches "^1\\n"         // regex over the whole output
        expect not output contains "nil"     // `not` inverts any output check
    }
}
```

`run` names the file the program starts from — a generated file, or a `support` file the campaign
provides, such as a fixed driver that calls the generated code and prints what it returns. The name
is a reference: one that is not a declared file is a Lanzer error at `validate`. A support file used
as an entry is protected: if the agent changes it, the run fails. The host is given the whole
workspace along with the entry, so a program may span files: an interpreter runs the entry with the
other files' definitions in scope, a compiled language builds the workspace and treats the entry as
its main.

Once the files are valid, Lanzer runs each program through the host language and checks every
expectation; a miss fails the run at the `behaviour` stage, with the expected and actual output in
the fix prompt and in the agent's `validate` tool. The agent sees the expected output up front, so
pair it with requirements that make it compute rather than print the answer. A host runs programs
by implementing `execute` on its service (see [Plugging in your own DSL](#plugging-in-your-own-dsl));
Lox runs them in-process with its interpreter. A campaign with `run` blocks against a host that
cannot run programs fails rather than passing unchecked.

Examples, each tested to pass with a correct program and to fail with a wrong one:
[`factorial.lanzer`](packages/lanzer-lox/examples/factorial.lanzer) (requirements force recursion),
[`fizzbuzz.lanzer`](packages/lanzer-lox/examples/fizzbuzz.lanzer) (every kind of `expect`), and
[`geometry.lanzer`](packages/lanzer-lox/examples/geometry.lanzer), whose run starts from a provided
[test driver](packages/lanzer-lox/examples/geometry/driver.lox) that calls the generated library.

#### Checking diagnostics: negative files

To test a language's validator rather than its happy path, a `file` block can say which diagnostics
the language must reject it with. The agent then writes a program that is almost right and wrong in
exactly that way:

```
file mainFile at "src/main.lox" generates LoxProgram {
    require VariableDeclaration
    expect error code "LOX_TYPE_NOT_ASSIGNABLE"
    expect error message matches "^Duplicate identifier '\\w+'"   // names the agent picks
    expect error code "DUP" message contains "declared twice"      // both, on one diagnostic
    expect warning message contains "unused"
    expect info code "STYLE_HINT"
}
```

- The severity is `error`, `warning` or `info`, and each line gives a `code`, a `message`, or both;
  with both, a single diagnostic must carry the code and match the message.
- `message` compares like `expect output`: exact with no mode, `contains`, or `matches` (a regex).
  Use a regex when the message names something the agent chooses.
- Each line must be met by at least one diagnostic. An **error** no line accounts for fails the
  file, since a negative file is wrong in one way, not two; warnings and infos nobody asked for are
  ignored. Parse errors are errors like any other.
- Requirements still apply to a negative file, and every other generated file must stay valid. A
  campaign with a negative file cannot have `run` blocks: its workspace is invalid on purpose.
- Codes are the host's own, so `validate` checks only the shape of the line. A host that lists its
  codes (Lox does) rejects an unknown one before any agent starts.

The prompt asks the agent for exactly the listed mistake; fix prompts and the `validate` tool report
only what is missing or unexpected, never the intended diagnostics themselves. A mismatch fails the
run at the `diagnostics` stage. Example, tested to pass on the intended mistake and to fail on an
extra error, a missing one, or a different one:
[`negative.lanzer`](packages/lanzer-lox/examples/negative.lanzer).

#### Reports

`generate` prints a summary per campaign and can write the whole thing as JSON:

```shell
node --env-file=.env ./bin/lox-lanzer.js generate ./examples/hello.lanzer --report run.json
```

```text
✓ helloLox — generated and validated
  ok
  1 attempt(s), 10.7s, stopped: end_turn
  lanzer tools: 1 call(s)
  213,988 tokens, context 43,699/1,000,000 (4.4%), cost 0.1310 USD
```

A failure names **the stage it failed at**, walking the pipeline in order — `launch`, `session`,
`turn`, `no_output`, `syntax`, `semantics`, `diagnostics`, `requirements`, `behaviour`, `scope` — so the report points at the
earliest cause rather than the loudest symptom. A file that never parsed also fails its
requirements, and saying `requirements` for it would send you to fix the wrong thing:

```text
✗ impossible — the files are valid but the campaign requirements are unmet
  failed at requirements — the files are valid but the campaign requirements are unmet
  2 attempt(s), 33.0s, stopped: end_turn
  lanzer tools: 2 call(s), 1 reporting problems
    - Forbidden selector matched 1 node(s) in mainFile: FunctionDeclaration
```

A [negative file](#checking-diagnostics-negative-files) rejected exactly as its expectations say
is a success: the run is `ok`, and its intended diagnostics are left out of the per-code counts, so
they never read as failures. The summary still lists what it was rejected with. A file rejected any
other way fails at `diagnostics`, listing what was expected, what never came, and which errors came
instead:

```text
✗ typeMismatchLox — a negative file is not rejected the way the campaign expects
  failed at diagnostics — a negative file is not rejected the way the campaign expects
  3 attempt(s), 18.4s, stopped: end_turn
  1 diagnostic(s):
      1  LOX_ARITY_MISMATCH
  negative src/main.lox: not rejected as expected
    expected: an error with code "LOX_TYPE_NOT_ASSIGNABLE" and a message matching /^Type '\w+' is not assignable to type '\w+'/
    missing: an error with code "LOX_TYPE_NOT_ASSIGNABLE" and a message matching /^Type '\w+' is not assignable to type '\w+'/
    unexpected:2:19: [LOX_ARITY_MISMATCH] Expected 2 argument(s) but got 1.
```

Every report also records how the run was configured: the agent's own name and version, the model
and effort, the permission mode the session ran in (the sandbox, for Codex), the allowed tool kinds
and the fix and retry budgets. The summary shows it on one line, e.g. `agent:
@agentclientprotocol/claude-agent-acp 0.82.0, model sonnet, effort medium, mode acceptEdits`, so two
runs of the same campaign can be told apart.

The JSON adds per-run token/cost accounting, every tool call with timings, and diagnostics counted
by code — so a suite run answers "how many succeeded, and where did the rest fail" directly. Its
`negativeFiles` field holds the same expected, missing and unexpected lists for each negative file,
and a negative file's entry in `documents` is marked `expectsDiagnostics`, since the diagnostics
listed there are the ones it was meant to produce.

### 2. Library fast path

Call one function and let it orchestrate jobs → policy → DSL skill → ACP run → requirement
validation. A host language exposes a one-call wrapper (Lox provides `runLoxCampaignFile`); under
the hood it uses the host-agnostic `runLanzerCampaign`:

```ts
import { runLoxCampaignFile } from 'lanzer-lox';
import { resolveAcpOptionsFromEnv } from 'lanzer';

const { runs } = await runLoxCampaignFile('campaign.lanzer', resolveAcpOptionsFromEnv());
for (const run of runs) console.log(run.validation?.ok ? 'ok' : run.validation?.issues);
```

The generic primitive, if you bring your own host services:

```ts
import { runLanzerCampaign, resolveLanzerCampaignFile, resolveAcpOptionsFromEnv } from 'lanzer';

const resolved = await resolveLanzerCampaignFile('campaign.lanzer', { validate: true });
for (const campaign of resolved.resolvedCampaigns) {
  await runLanzerCampaign(campaign, { service, runner }, resolveAcpOptionsFromEnv());
}
```

### 3. Slow path (full control)

Assemble the building blocks yourself — useful for batching, concurrency, custom retry/validation,
or non-standard transports:

```ts
import {
  buildLanzerGenerationJobs,
  runLanzerCampaignTaskOverAcp
} from 'lanzer';

const jobs = buildLanzerGenerationJobs(resolvedCampaign);
const policy = await service.getGenerationPolicy(jobs[0]);
const dslSkill = await service.dslSkill(jobs[0]);
const validate = async () => { /* wrap runner.validateCampaign(...) */ };
await runLanzerCampaignTaskOverAcp(jobs, { command, model, policy, dslSkill, validate /* ... */ });
```

### Plugging in your own DSL

You do **not** modify your language to use Lanzer. `npm install lanzer`, then add a small package
that *consumes* it together with your language's standard exports —
[`packages/lanzer-lox`](packages/lanzer-lox) is that package for Lox and the template below. (Your
language is just a dependency you already have; this repo only pulls `langium-lox` in as a git
submodule to prove a third-party language can be driven with **zero edits**.) The template has three
parts:

**1. A service** ([`lox-lanzer-service.ts`](packages/lanzer-lox/src/lox-lanzer-service.ts)) — extend
`DefaultLanzerService` and override `getGenerationPolicy` (your language's required/forbidden
practices, reference files) and `dslSkill` (point at your DSL's agent skill). To support `run`
blocks, also implement `execute(request)`: the request carries the workspace root, the entry (its
alias, whether it is generated or support, its path, and its parsed document when it is in your
language) and every loaded document. Run the program from the entry — however your language runs a
project — and return what it printed, whether it completed, and any error or timeout, bounding time
and output, since the code is agent-written. If your language has diagnostic codes, return them all
from `diagnosticCodes()` so a campaign expecting an unknown one is rejected before an agent starts.
Optionally extend `DefaultLanzerCampaignRunner`: override `collectDocumentResult` to attach codes to
diagnostics that lack them (Lox does), and `failsCleanFile(issue)` to decide which issues fail an
ordinary file (Lox fails only on errors). Decide that in `failsCleanFile`, not by dropping issues in
`collectDocumentResult`: a dropped warning can never be matched by a negative file's
`expect warning`. These overrides never modify your language itself.

**2. The wiring** ([`lox-host.ts`](packages/lanzer-lox/src/lox-host.ts)) — call the generic
`createLanzerHostServices` with your language's generated shared module, its AST reflection, and a
`createServices` function that injects your language onto Lanzer's shared container. That function
body is the same `inject` your own `create<Lang>Services` already performs, with the shared
container handed in rather than created — so it still uses only the symbols `langium-cli` generates,
and your language stays unmodified. It composes one shared workspace across `.lanzer`, your host
grammar, and your generated files:

```ts
import { inject } from 'langium';
import { createDefaultModule } from 'langium/lsp';
import { LoxAstReflection, LoxGeneratedModule, LoxGeneratedSharedModule, LoxModule } from 'langium-lox';
import { createLanzerHostServices } from 'lanzer';

export const createLanzerLoxServices = (context) => createLanzerHostServices(context, {
  generatedSharedModule: LoxGeneratedSharedModule,
  createServices: (shared) => inject(createDefaultModule({ shared }), LoxGeneratedModule, LoxModule),
  astReflection: () => new LoxAstReflection(),
}, {
  service: (shared, language) => new LoxLanzerService(shared, language),
  campaignRunner: (services) => new LoxLanzerCampaignRunner(services),
});
```

Returning the finished services rather than the raw modules is what makes the result properly typed:
`THost` is inferred from what `createServices` returns, so `createLanzerHostServices(...)` gives you
`LanzerHostServices<LoxServices>` with no type argument and no cast.

**3. A driver** — a one-call wrapper ([`run-campaign.ts`](packages/lanzer-lox/src/run-campaign.ts))
and/or a CLI ([`cli.ts`](packages/lanzer-lox/src/cli.ts)) on top of the container.

Then any of the three tiers above drives generation with your language's conventions applied — with
zero changes to the language itself.


