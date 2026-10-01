# Evaluating a skill

Did v2 of your skill help? Run the same suite twice and `compare` the reports.

```shell
lox-lanzer generate ./bench --runs 5 --isolated --report v1.json
# edit the skill, or point at a copy with --skill <dir>
lox-lanzer generate ./bench --runs 5 --isolated --report v2.json
lox-lanzer compare v1.json v2.json
```

```text
setup:
  skill: write-lox ed17db57ba69 → write-lox 4c1d9e0a7b22

                            a            b   change
  pass rate       17/25 (68%)  22/25 (88%)  +20 pts
  cost per run     0.2209 USD   0.2301 USD      +4%

by campaign:
  campaign          a                              b                     change
  integerMath       2/5 (2× syntax, 1× semantics)  4/5 (1× semantics)    improved +40 pts
  negativeSubclass  2/5 (3× diagnostics)           4/5 (1× diagnostics)  improved +40 pts
```

`setup` lists what differed between the two runs: skill hash, prompt, policy, agent, model. When nothing differs, the change is just noise. The full output also has cost, time and tokens per campaign, failures by stage, and flaky campaigns.

## Measure the skill, not the setup

| Flag | Why |
|---|---|
| `--isolated` | Runs Claude without your settings, CLAUDE.md, skills or memory, so the skill is the only advice, and runs can't learn from each other. |
| `--policy minimal` | Keeps only the grammar reference from your host's prompt, so the prompt doesn't repeat the skill. |
| `--no-skill` | No skill at all: the baseline. |
| `--no-tools` | No `validate` tool, so the agent's mistakes count instead of being fixed quietly. Add `--max-attempts 1` to drop fix prompts too. |
| `--skill <dir>` | Use another copy of the skill. |

A clean comparison runs three times under `--policy minimal --isolated`: `--no-skill`, the old skill, the new one. `plan --prompt` takes the same flags, to preview what each run is sent.

::: warning Run benchmarks outside the repo
Inside your repo, agents find other runs' answers and the skill's source. Copy the suite to a temporary folder. Each report lists what the agent read outside what it was given; `compare` warns about it.
:::

::: tip Don't teach to the test
Keep campaigns the skill's author hasn't seen. A skill whose examples are the bench's answers will score well and prove nothing.
:::

## Reading the numbers

- Everything is **per run**, so suites of different sizes compare fairly.
- Fewer than 5 runs of a campaign is flagged: one flip moves its rate by 20 points.
- A **failed checks** column shows how hard the agent worked even when it passed: `11,0,2 → 1,1,14`.
- No significance tests: at these sizes they'd mostly say "not enough runs".

The Lox bench is in [`packages/lanzer-lox/bench`](https://github.com/TypeFox/lanzer/tree/main/packages/lanzer-lox/bench): five campaigns built on the dialect's traps.
