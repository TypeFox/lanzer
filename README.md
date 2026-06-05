# Lanzer
> An agent-driven Fuzzer for Langium based DSL

<p align="center">
  <img src="assets/lanzer.webp" alt="Lanzer" width="600">
</p>

## What is Lanzer
Lanzer is a semiformal DSL and tools around it, for generating samples, for your DSL.
The DSL is used as a specifications for the tests you want to generate, with formal constraints imposed on the output, and informal description of what the text should do.

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
- Override services required by Lanzer, and specify any additional prompts or info you may need.

## Run the demo

The quickest way to see Lanzer working is the Lox example that ships in this repo. From the repo
root, build once, then move into the Lox package (which holds the campaigns, the `lox-lanzer` CLI,
and the ACP config):

```shell
npm install && npm run build
cd packages/langium-lox
cp .env.copy .env   # configure your ACP agent; only needed for `generate`, not `validate`
```

### Validating a campaign

`validate` checks that a campaign parses **and** that every selector is reachable against the Lox
grammar's AST — no agent involved. A good campaign:

```shell
node ./langium/bin/lox-lanzer.js validate ./examples/lanzer/hello.lanzer
```

```text
Lanzer campaign is valid: file:///…/packages/langium-lox/examples/lanzer/hello.lanzer
```

A deliberately broken campaign ([`examples/lanzer/invalid-demo.lanzer`](packages/langium-lox/examples/lanzer/invalid-demo.lanzer),
which references a type and a property that don't exist in the Lox grammar) shows what failures
look like — and the command exits non-zero:

```shell
node ./langium/bin/lox-lanzer.js validate ./examples/lanzer/invalid-demo.lanzer
```

```text
Lanzer campaign is invalid: file:///…/packages/langium-lox/examples/lanzer/invalid-demo.lanzer
- [diagnostic] @ 14:17 Could not resolve reference to AbstractRule named 'NonExistentNode'.
- [diagnostic] @ 15:37 Type 'FunctionDeclaration' has no property 'notAProp'.
```

### Generating from a campaign

Once a campaign is valid, generate the target `.lox` file(s) by dispatching it to your configured
agent (this one *does* call the agent and write files):

```shell
node --env-file=.env ./langium/bin/lox-lanzer.js generate ./examples/lanzer/hello.lanzer
```

See **Using Lanzer** below for the library equivalents and how to plug in your own DSL.

## Using Lanzer

`lanzer` is a **library**, not a CLI. It exposes the engine; your DSL package owns how that
engine is driven. There are three tiers, from least to most code — pick the one that fits.

The repo ships a complete worked example for the **Lox** language under
[`packages/langium-lox`](packages/langium-lox); the snippets below use it.

### 1. Prebuilt CLI (easiest)

Lox ships a ready-to-run CLI, `lox-lanzer`, that wraps the fast path. Configure an ACP agent and
generate the target files:

```shell
cd packages/langium-lox
cp .env.copy .env           # then edit .env for your agent runtime (see .env.copy)

# validate + plan never call an agent:
node --env-file=.env ./langium/bin/lox-lanzer.js validate ./examples/lanzer/calculator.lanzer
node --env-file=.env ./langium/bin/lox-lanzer.js plan     ./examples/lanzer/calculator.lanzer

# generate dispatches the campaign to your ACP agent and validates the result:
node --env-file=.env ./langium/bin/lox-lanzer.js generate  ./examples/lanzer/calculator.lanzer
```

### 2. Library fast path

Call one function and let it orchestrate jobs → policy → DSL skill → ACP run → requirement
validation. A host language exposes a one-call wrapper (Lox provides `runLoxCampaignFile`); under
the hood it uses the host-agnostic `runLanzerCampaign`:

```ts
import { runLoxCampaignFile } from 'langium-lox';
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

A host language "fills in" Lanzer by implementing its service interface — exactly what Lox does in
[`packages/langium-lox/langium/src/language-server/lanzer/lox-lanzer.ts`](packages/langium-lox/langium/src/language-server/lanzer/lox-lanzer.ts):

- extend `DefaultLanzerService` and override `getGenerationPolicy` (your language's required/forbidden
  practices, reference files) and `dslSkill` (point at your DSL's agent skill);
- optionally extend `DefaultLanzerCampaignRunner` to control which diagnostics count as failures;
- compose a combined services container (Lox uses `createLanzerLoxServices`) so `.lanzer`, your host
  grammar, and your DSL files share one workspace.

Then any of the three tiers above drives generation with your language's conventions applied.


