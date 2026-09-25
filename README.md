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

That default is worth one sentence of explanation. Lanzer confines the agent's reads and writes to
the campaign's own directories, but that check only covers file access routed through the client —
an agent that shells out steps around it entirely. Withholding `execute` is what keeps those
directories a boundary rather than a suggestion.

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

#### What the agent is allowed to do

A generation run is unattended, so the agent gets what writing files needs and nothing more:
`read`, `edit`, `search`, `think`, and `other` (which is where agents put skill loading). Running
shell commands, deleting or moving files, and reaching the network are all refused unless you ask
for them.

That default is worth one sentence of explanation. Lanzer confines the agent's reads and writes to
the campaign's own directories, but that check only covers file access routed through the client —
an agent that shells out steps around it entirely. Withholding `execute` is what keeps those
directories a boundary rather than a suggestion.

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
`turn`, `no_output`, `syntax`, `semantics`, `requirements`, `scope` — so the report points at the
earliest cause rather than the loudest symptom. A file that never parsed also fails its
requirements, and saying `requirements` for it would send you to fix the wrong thing:

```text
✗ impossible — the files are valid but the campaign requirements are unmet
  failed at requirements — the files are valid but the campaign requirements are unmet
  2 attempt(s), 33.0s, stopped: end_turn
  lanzer tools: 2 call(s), 1 reporting problems
    - Forbidden selector matched 1 node(s) in mainFile: FunctionDeclaration
```

The JSON adds per-run token/cost accounting, every tool call with timings, and diagnostics counted
by code — so a suite run answers "how many succeeded, and where did the rest fail" directly.

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
practices, reference files) and `dslSkill` (point at your DSL's agent skill). Optionally extend
`DefaultLanzerCampaignRunner` to control which diagnostics count as failures. These overrides are
pure config — they never reach into your language's services.

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


