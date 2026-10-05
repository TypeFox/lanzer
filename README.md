# Lanzer
> Spec-driven program generation for Langium DSLs: measure how well coding agents write your
> language, and build a corpus of valid, checked programs.

<p align="center">
  <img src="assets/lanzer.webp" alt="Lanzer" width="600">
</p>

Lanzer is a small semiformal campaign language, and the tools around it, for asking a coding agent
to write programs in your Langium DSL and checking what comes back. A campaign is the spec: a
description of what the program should do, plus constructs it must and must not contain, what it
must print when run, or the diagnostic it must be rejected with.

```
import "mylang.langium"

campaign sortingDemo {
  description "Sort the integers 5, 3, 8, 1, 2 and print them in order, one per line."
  workspace "test/sorting"

  file mainFile at "src/main.my" generates Module {
    require FnDecl[name="sort"]
    require FnDecl[name="main"] >> FunctionCall
    forbid FnDecl[name="eval"]
  }

  run mainFile {
    expect output "1\n2\n3\n5\n8\n"
  }
}
```

Lanzer sends the campaign to an agent you already have (Claude Code, Codex, Gemini CLI, any ACP
agent), then checks the result with your language's own parser, validator and runtime. Use it to:

- **Generate checked programs** for docs, test fixtures and training data.
- **Stress-test your language**: run the programs, and ask for ones your validator must reject.
- **Evaluate agents and skills**: pass rates per campaign, the stage each failure reached, and
  `compare` for "did v2 of the skill help?"

## Quick start

```shell
git clone --recurse-submodules https://github.com/TypeFox/lanzer
cd lanzer && npm install && npm run build
cd packages/lanzer-lox
cp .env.copy .env
npx lox-lanzer generate ./examples/hello.lanzer
```

## Documentation

| | |
|---|---|
| [Getting started](docs/guide/getting-started.md) | Requirements, the Lox demo, how a run works |
| [The Lanzer DSL](docs/guide/campaigns.md) | Campaigns, selectors, `run` blocks, negative files |
| [Commands](docs/guide/commands.md) | `validate`, `types`, `plan`, `generate`, `compare` |
| [Agents and permissions](docs/guide/agents.md) | Claude, Codex, Gemini; `.env`; what the agent may do |
| [Repeated and parallel runs](docs/guide/runs.md) | `--runs`, `--parallel`, `--min-pass` |
| [Evaluating a skill](docs/guide/evaluating-a-skill.md) | Benchmarks, isolation, `compare` |
| [Plug in your DSL](docs/guide/your-dsl.md) | The host package: service, wiring, CLI |

Run the docs site locally with `npm run docs:dev`.

## License

Lanzer is released under the [MIT License](LICENSE). The `langium-lox` submodule keeps its own license.
