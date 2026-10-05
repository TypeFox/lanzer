# Repeated and parallel runs

One pass says little about an agent that gets it right two times in three. `--runs` repeats each campaign with the identical prompt and reports the pass rate:

```shell
npx lox-lanzer generate ./examples/fizzbuzz.lanzer --runs 5 --parallel 2
```

```text
fizzbuzzLox: 4/5 passed (1× behaviour)
```

| Flag | Effect |
|---|---|
| `--runs <n>` | Run each campaign n times. |
| `--parallel <k>` | Up to k of a campaign's runs at once (default 1). Campaigns in a suite still run one after another. |
| `--min-pass <share>` | Pass if this share passed: `4/5` or `80%`. Default: every run. Handy in CI. |

- **Clean and separate.** Each run gets its own copy of the workspace at `<workspace>.runs/<time>/run-<i>/`, without the generated files, so no run can read another's answer. The copies stay for inspection.
- **Fresh services.** Each run is validated with its own language services, so one run can't pass on a function another wrote.
- **Full reports.** Every run keeps its report, numbered `run 2/5`.

Without `--runs`, `generate` writes into the workspace itself.
