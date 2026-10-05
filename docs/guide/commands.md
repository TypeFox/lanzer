# Commands

Every host CLI has the same commands. The examples use Lox's `lox-lanzer`, run from `packages/lanzer-lox`; yours has your language's name.

| Command | Calls an agent | What it does |
|---|---|---|
| `validate <file>` | no | Parses a campaign and checks every selector against your grammar. |
| `types <file>` | no | Lists the AST types a selector can use, with their properties. |
| `plan <file>` | no | Shows the jobs, and with `--prompt` the exact prompt the agent gets. |
| `generate <files...>` | yes | Runs campaigns through the agent and checks the result. |
| `compare <a> <b>` | no | Puts two reports side by side. See [Evaluating a skill](./evaluating-a-skill). |

`validate`, `types`, `plan` and `compare` take `--json` to print data instead.

## generate

```shell
npx lox-lanzer generate ./examples/hello.lanzer
```

Give it several files or folders and they run as one suite, with one report.

| Flag | Effect |
|---|---|
| `--model <m>`, `--command <bin>` | Override the agent from `.env`. |
| `--max-attempts <n>` | Prompts per session, the first plus fix prompts. |
| `--allow <kinds>`, `--allow-all` | What the agent may do. See [Agents and permissions](./agents). |
| `--report <path>`, `--no-report` | Where the JSON report goes (default `.lanzer/reports/`). |
| `--verbose`, `--quiet` | More or less live output. |
| `--runs <n>`, `--parallel <k>`, `--min-pass <share>` | [Repeated and parallel runs](./runs). |
| `--skill <dir>`, `--no-skill`, `--policy minimal`, `--no-tools`, `--isolated` | [Evaluating a skill](./evaluating-a-skill). |

## Reading the result

A failure names the **first** stage that failed, so you fix the cause, not the loudest symptom:

```text
✗ impossible — the files are valid but the campaign requirements are unmet
  failed at requirements — the files are valid but the campaign requirements are unmet
  2 attempt(s), 33.0s, stopped: end_turn
  lanzer tools: 2 call(s), 1 reporting problems
    - Forbidden selector matched 1 node(s) in mainFile: FunctionDeclaration
```

A pass can still have struggled. `validate:` lists the agent's own checks along the way:

```text
✓ integerMath — generated and validated
  ok
  1 attempt(s), 125.3s, stopped: end_turn
  lanzer tools: 9 call(s), 8 reporting problems
  validate: ✗1 ✗1 ✗1 ✗1 ✗1 ✗1 ✗1 ✗1 ok
```

The JSON report has every diagnostic, the agent's configuration, tokens and cost, and what each failed check reported.

## In code

The same run, from TypeScript:

```ts
import { runLoxCampaignFile } from 'lanzer-lox';
import { resolveAcpOptionsFromEnv } from 'lanzer';

const { runs } = await runLoxCampaignFile('campaign.lanzer', resolveAcpOptionsFromEnv());
```
