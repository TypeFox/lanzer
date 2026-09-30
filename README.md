# Lanzer
> Spec-driven program generation for Langium DSLs: measure how well coding agents write your
> language, and build a corpus of valid, checked programs.

<p align="center">
  <img src="assets/lanzer.webp" alt="Lanzer" width="600">
</p>

## What is Lanzer
Lanzer is a small semiformal campaign language, and the tools around it, for asking a coding agent to write
programs in your Langium DSL and checking what comes back. A campaign is the spec: an informal
description of what the program should do, plus formal constraints on the result: constructs it
must and must not contain (selectors over your grammar's AST), what it must print when run (optional), and,
for a negative file, the diagnostic it must be rejected with.

Lanzer is used three ways:

1.**Generating examples and a corpus from a spec.** A sample that passes is valid in your
   language and meets its campaign: it uses what it was asked to, avoids what it was told not to,
   and, when run, prints what was expected. Useful for documentation examples, test fixtures and
   training data.  
2. **Stress-testing the language implementation.** `run` blocks execute the generated program
   through your host's execute handler and check its output, and negative campaigns ask for
   programs your validator must reject with a specific diagnostic. Both surface places where the
   language does not behave the way its authors, or its documentation, say it does.
3. **Evaluating how well agents write your DSL.** Run a suite of campaigns, several times each,
   and get a pass rate per campaign and the first stage each failure reached: `syntax` says the
   grammar reference is not landing, `semantics` that the DSL skill is too weak, `requirements` or
   `behaviour` that the task itself is hard. `compare` puts two reports side by side to answer "did
   v2 of the skill help?" or "Claude or Codex on this language?" — see
   [Benchmarking a skill or an agent](#benchmarking-a-skill-or-an-agent).
   
```
import "mylang.langium"

campaign sortingDemo {
  description "Sort the integers 5, 3, 8, 1, 2 and print them in order, one per line."
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

  run mainFile {
    expect runs
    expect output "1\n2\n3\n5\n8\n"
  }
}
```


## How it works
Lanzer sends the campaign to a coding agent you already have, works with anything that speaks the Agent
Client Protocol (Claude Code, Gemini CLI, …) or Codex, together with your grammar reference and
your DSL's agent skill. The agent writes the files; Lanzer then checks them with your language's own
parser and validator, the campaign's selectors, and, for `run` blocks, your execute handler. While
it works, the agent can call Lanzer's `validate` tool to check itself; if its turn still ends with
problems, Lanzer sends them back as a fix prompt.

Every run produces a report that names the first stage that failed — the file was never written,
it does not parse, the language rejects it, a negative file is not rejected as expected, the
requirements are unmet, the program misbehaves, or files outside the declared set were touched —
with every diagnostic, the agent's configuration, and its token and cost usage.

### Lanzer and grammar fuzzing
Grammar-based fuzzers derive inputs from the grammar's rules, thousands a second, and most of them
make no sense past the parser. They are the right tool for parser robustness at volume, and Lanzer
does not replace them. Lanzer works on the layer they cannot reach: programs that parse,
type-check, resolve their references and do something specific, which is where an agent writing
your language, or the language's own validator and runtime, actually goes wrong. Use a fuzzer for
the parser and Lanzer for what comes after it.

## Requirements
To leverage lanzer, you need:
- A functional langium-based DSL implementation (with validations too).
- An ACP compatible coding agent (claude code, codex, gemini cli, etc)
- An agent skill for your DSL (You can start with something basic, and improve it with Lanzer)
- A small host integration package that plugs your language into Lanzer (a service supplying your
  generation policy + DSL skill).

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

#### Agent Permissions & Security

In doubt, use dev-containers or agent isolation mechanisms, this is even more critical, if you generate
fixtures you using agents at scale. Lanzer does it best, but the chances for agents to go rogue is not-zero.

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

A run can pass and still have struggled. The agent calls Lanzer's `validate` tool as it works and
fixes what it reports before the end of its turn, so the final verdict only says where it ended up.
When any of those checks failed, the summary lists them in order, with how many problems each
found:

```text
✓ integerMath — generated and validated
  ok
  1 attempt(s), 125.3s, stopped: end_turn
  lanzer tools: 9 call(s), 8 reporting problems
  validate: ✗1 ✗1 ✗1 ✗1 ✗1 ✗1 ✗1 ✗1 ok
```

The JSON report keeps what each failed check reported, as the agent was shown it: the file, line
and code of each diagnostic, and the requirement, behaviour or workspace findings, in the tool
call's `issues` (the first 50; `issuesOmitted` counts the rest).

#### Repeating runs

One passing run says little about an agent that gets the task right two times in three. `--runs N`
runs each campaign N times with the identical prompt and reports how often it passed:

```shell
node --env-file=.env ./bin/lox-lanzer.js generate ./examples/fizzbuzz.lanzer --runs 5 --parallel 2
```

- Each run works in its own copy of the workspace, beside it at `<workspace>.runs/<timestamp>/run-<i>/`.
  The copy leaves out the campaign's generated files, so every run starts clean and none can read
  another's answer. The folders stay after the run, so a failed run's files can be inspected; the
  workspace itself is not touched.
- Each run is validated with its own fresh language services. Langium resolves names across every
  document it has loaded, so runs sharing services could pass on a function only another run wrote.
- `--parallel K` runs up to K at once (default 1).
- Every run keeps its full report, numbered (`run 2/5 in …`). The summary leads with the pass rate
  per campaign and where the failures happened, e.g. `fizzbuzzLox: 4/5 passed (1× behaviour)`.
- The command fails unless every run of every campaign passed. `--min-pass 4/5` or `--min-pass 80%`
  loosens that, e.g. for CI.

Without `--runs`, `generate` works in the workspace itself, as before.

#### Benchmarking a skill or an agent

`generate` takes several campaign files, or folders of them, and runs them as one suite with one
report. `compare` then puts two reports side by side — the way to answer "did write-lox v2 help?"
or "Claude or Codex on this DSL?". `lanzer-lox/bench/` holds a Lox suite for this: five campaigns
built on the dialect's traps (no `%`, comparison binding tighter than `*`, `nil` as an empty
class-typed value, inheritance and `super`, functions returned as values, and a negative file),
each with a reference solution in the tests proving it can be met.

```shell
node --env-file=.env ./bin/lox-lanzer.js generate ./bench --runs 5 --report .lanzer/reports/write-lox-v1.json
# edit ../../skills/write-lox, then run the same suite again:
node --env-file=.env ./bin/lox-lanzer.js generate ./bench --runs 5 --report .lanzer/reports/write-lox-v2.json
node ./bin/lox-lanzer.js compare .lanzer/reports/write-lox-v1.json .lanzer/reports/write-lox-v2.json
```

`--skill <dir>` points a run at another copy of the skill, to keep both versions side by side;
`--model`, `--command` and `LANZER_ACP_*` change the agent instead. `compare` prints the setup
difference first, then the numbers (these are illustrative):

```text
setup:
  skill: write-lox ed17db57ba69 → write-lox 4c1d9e0a7b22

pass rate: 17/25 (68%) → 22/25 (88%), +20 pts on shared campaigns
cost per run: 0.2220 USD → 0.2300 USD (+4%)
time per run: 40.0s → 40.0s (±0%)
tokens per run: 52,000 → 52,000 (±0%)

by campaign:
  higherOrder       5/5 → 5/5  unchanged, ±0 pts
  integerMath       2/5 (2× syntax, 1× semantics) → 4/5 (1× semantics)  improved, +40 pts
  linkedStack       4/5 (1× behaviour) → 4/5 (1× behaviour)  unchanged, ±0 pts
  negativeSubclass  2/5 (3× diagnostics) → 4/5 (1× diagnostics)  improved, +40 pts
  shapes            4/5 (1× semantics) → 5/5  improved, +20 pts

failures by stage (per run):
  syntax        2 (8%) → 0 (0%)
  semantics     2 (8%) → 1 (4%)
  diagnostics   3 (12%) → 1 (4%)
  behaviour     1 (4%) → 1 (4%)

diagnostic codes that moved (occurrences per run):
  LOX_PARSER_ERROR: 0.08 → 0.00
  LOX_TYPE_NOT_ASSIGNABLE: 0.04 → 0.00
```

- **What was measured.** Each run's report carries a `fingerprint`: the Lanzer version, the DSL
  skill's name, path and a content hash over every file in its folder, each imported grammar's hash,
  and the campaign file's hash. With the run configuration (agent, model, effort, permission mode,
  budgets), that is what `compare` lists under `setup`. A skill edited in place keeps its name and
  path; its hash is what tells the two apart. When nothing differs, `compare` says so: the numbers
  are then run-to-run variation.
- **Per run, not totals.** Cost, time, tokens, stage failures and diagnostic codes are divided by
  each side's number of runs, so a report with more runs does not look worse. The headline pass-rate
  delta counts only the campaigns both reports ran; a campaign on one side only is `added` or
  `removed`.
- **Failed checks.** An agent that calls `validate` as it works can end every run with a pass
  whatever the skill, so the pass rate alone may not move. Under each campaign where either side had
  any, `compare` lists the failed `validate` calls of each run (`failed checks per run: 11,0,2 →
  1,1,14`): how hard the agent had to work to get there.
- **No significance claims.** A campaign with fewer than 5 runs on either side is flagged — one run
  flipping moves its rate by 20 points or more — with a hint to rerun with `--runs`. `compare` does
  not run a statistical test; at these sample sizes it would mostly say "not enough runs".
- `--json` prints the comparison as data. The generic `lanzer` CLI has the same `compare` command.

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

**3. A driver** — a one-call wrapper ([`run-campaign.ts`](packages/lanzer-lox/src/run-campaign.ts))
and/or a CLI ([`cli.ts`](packages/lanzer-lox/src/cli.ts)) on top of the container.

Then any of the three tiers above drives generation with your language's conventions applied — with
zero changes to the language itself.

## License

Lanzer is released under the [MIT License](LICENSE). The `langium-lox` submodule keeps its own license.
