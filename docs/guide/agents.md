# Agents and permissions

Lanzer works with any agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com). Pick one in `.env`:

::: code-group

```shell [Claude]
LANZER_ACP_COMMAND=npx
LANZER_ACP_ARGS=["claude-agent-acp"]
LANZER_ACP_MODEL=sonnet
```

```shell [Codex]
# sign in first: npx -y @openai/codex login
LANZER_ACP_COMMAND=npx
LANZER_ACP_ARGS=["-y","@agentclientprotocol/codex-acp"]
LANZER_ACP_PROVIDER=codex
LANZER_ACP_MODEL=gpt-5.5
```

```shell [Gemini]
LANZER_ACP_COMMAND=npx
LANZER_ACP_ARGS=["-y","@google/gemini-cli","--acp"]
```

:::

## Variables

| Variable | Example | Meaning |
|---|---|---|
| `LANZER_ACP_COMMAND`, `LANZER_ACP_ARGS` | `npx`, `["claude-agent-acp"]` | The agent to start. |
| `LANZER_ACP_PROVIDER` | `codex` | Only matters for Codex. |
| `LANZER_ACP_MODEL` | `sonnet`, `gpt-5.5` | The agent's own alias, not an API id. |
| `LANZER_ACP_EFFORT` | `medium` | Reasoning effort. |
| `LANZER_ACP_MAX_ATTEMPTS` | `2` | Prompts per session. |
| `LANZER_ACP_ALLOW` | `read,edit,search,think,other` | What the agent may do. |
| `LANZER_ACP_ISOLATED` | `1` | Run without your own agent setup. |

::: warning Model names
Use the agent's alias (`sonnet`, `opus`, `haiku`), not an API id like `claude-sonnet-4-6`. An unknown alias is skipped and the agent's default is used.
:::

## Permissions

A run is unattended, so by default the agent may only `read`, `edit`, `search`, `think` and `other` (where skills load). No shell, no deleting or moving files, no network.

```shell
# also allow shell commands
lox-lanzer generate ./examples/hello.lanzer --allow read,edit,search,think,other,execute
# no policy at all
lox-lanzer generate ./examples/hello.lanzer --allow-all
```

The list is read literally: naming kinds limits the run to exactly those. Refusals print as `[perm] denied execute: …` and the next fix prompt names them.

What confines files:

- **Writes** stay in the campaign's workspace; **reads** in the workspace plus the grammar, reference files and skill. Claude uses its own file tools, so it keeps to its session roots instead: the same folders, but all writable.
- **After the run**, a declared file left unwritten, or a changed support file, fails it. Other new files are reported.
- **Claude** runs in `acceptEdits` mode, never `bypassPermissions`.

::: danger Shell access
An agent that can run shell commands steps around every file check. At scale, run in a container.
:::

## Codex

Codex through codex-acp gets Lanzer's tools and real sessions, like Claude. Two limits: its token counts cover only the last model request, and whether it asks before running a shell command (so that leaving out `execute` is enforced) is not verified yet.
