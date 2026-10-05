# Getting started

Lanzer asks a coding agent to write programs in your Langium DSL, then checks them with your language's own parser, validator and runtime. A **campaign** is the spec; every run gets a report.

## What you need

- A Langium language, with its validations.
- An ACP agent: Claude Code, Codex, Gemini CLI, …
- An agent skill for your DSL. A basic one is enough; Lanzer tells you how to improve it.
- A small host package that plugs your language into Lanzer — see [Plug in your DSL](./your-dsl).

## Try it on Lox

The repo ships a ready host for [Lox](https://github.com/TypeFox/langium-lox), pulled in as an unmodified submodule.

```shell
git clone --recurse-submodules https://github.com/TypeFox/lanzer
cd lanzer && npm install && npm run build
cd packages/lanzer-lox
cp .env.copy .env      # the agent to use; see Agents and permissions
```

Check a campaign, look at what the agent will be sent, then run it:

::: code-group

```shell [validate]
npx lox-lanzer validate ./examples/hello.lanzer
```

```shell [plan]
npx lox-lanzer plan ./examples/hello.lanzer --prompt
```

```shell [generate]
npx lox-lanzer generate ./examples/hello.lanzer
```

:::

```text
✓ helloLox — generated and validated
  ok
  1 attempt(s), 10.7s, stopped: end_turn
  lanzer tools: 1 call(s)
  213,988 tokens, context 43,699/1,000,000 (4.4%), cost 0.1310 USD
```

::: tip
`validate`, `plan` and `types` never call an agent, so they need no `.env`. The others read `./.env` by themselves; `--env .env.codex` picks another file.
:::

## How a run works

1. Lanzer sends the agent the campaign, your grammar reference and your DSL skill.
2. The agent writes the files. While it works it can call Lanzer's `validate` tool, which runs the same checks that grade the run.
3. Lanzer checks the result: parse, validate, the campaign's requirements, and any `run` blocks.
4. Problems left at the end of the turn go back to the agent as a fix prompt, up to the attempt budget.
5. The report names the **first stage that failed**: `launch`, `session`, `turn`, `no_output`, `syntax`, `semantics`, `diagnostics`, `requirements`, `behaviour` or `scope`.

::: info Lanzer and grammar fuzzers
Fuzzers make thousands of inputs a second, and most make no sense past the parser. Lanzer works on what they can't reach: programs that type-check, resolve and do something specific. Use a fuzzer for the parser, and Lanzer for what comes after it.
:::

Next: [write your own campaign](./campaigns).
