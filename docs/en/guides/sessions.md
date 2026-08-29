# Sessions and context

Nori Code CLI persists every conversation as a "session" — storing message history and metadata so you can close the terminal and pick up right where you left off. This page covers how to resume sessions, manage context, and export or fork sessions.

## Session storage

All sessions are saved under `$NORI_CODE_HOME/sessions/` (default: `~/.nori-code/sessions/`), grouped by working directory:

```text
~/.nori-code/
├── config.toml
├── session_index.jsonl
└── sessions/
    └── <workDirKey>/
        └── <sessionId>/
            ├── state.json
            └── agents/
                ├── main/
                │   └── wire.jsonl
                └── <subagentId>/
                    └── wire.jsonl
```

- `state.json`: session metadata such as title and creation time.
- `agents/*/wire.jsonl`: the agent event stream, used for session recovery and replay.

::: warning
Do not manually edit files inside the `sessions/` directory — doing so may prevent sessions from being restored correctly.
:::

## Starting and resuming sessions

Every time you run `nori` directly it creates a new session. To resume a previous session, use one of the following:

**Resume the most recent session in the current directory:**

```sh
nori --continue
```

**Resume a specific session by ID:**

```sh
nori --session abc123
```

**Interactively browse session history and choose one:**

```sh
nori --session
```

::: warning
`--continue` and `--session` are mutually exclusive.
:::

## Switching sessions inside the TUI

You can manage sessions without leaving the terminal. The following slash commands are available only when the agent is idle:

- **`/new`** (alias `/clear`): switch to a new session, discarding the current context.
- **`/sessions`** (alias `/resume`): browse and resume a previous session.
- **`/fork`**: fork the current session (see below).
- **`/title <text>`** (alias `/rename`): set a session title for easier identification; without arguments, displays the current title.

## Context compression

As a conversation grows, Nori Code CLI automatically compresses the message history when the context approaches the window limit, freeing up token space. You can also trigger compression manually at any time:

```
/compact
```

You can pass a hint to tell the model what to prioritize when compressing:

```
/compact Keep the discussion about database migrations
```

## Forking a session

To explore a new direction without disrupting the current conversation, use `/fork`:

```
/fork
```

The two resulting sessions are completely independent and do not affect each other. You can switch back to the original at any time using `/sessions`. A saved `/goal` is not copied to the fork. Start a new goal there if you want autonomous goal work.

## Session mount tree

Beyond fork/continue, sessions can form a **conversation map** linked by `parent_session_id` in session metadata (optional `mount_role` / `mount_mandate`). Hired team partners created with `TeamCreate` are mounted child sessions; `/map` in the TUI and the Web **Map** view let you browse, open, mount, unmount, or remount nodes for the current working directory.

Mount operations update **`<session_self>`** in each affected session and may inject **`<session_mount_changed>`** on the next turn — identity and topology only, not shared transcript history. See [Team engineering](./team-engineering.md).

## Exporting a session

Use `nori export` to package a session as a ZIP file — useful for sharing, archiving, or filing a bug report:

```sh
nori export <sessionId>
```

Omitting `sessionId` exports the most recent session in the current directory (with an interactive confirmation prompt; add `-y` to skip). Use `-o` to specify an output path:

```sh
nori export <sessionId> -o ~/Desktop/my-session.zip
```

The export includes all files in the session directory, including diagnostic logs. The global diagnostic log (`~/.nori-code/logs/nori-code.log`) is also bundled by default; add `--no-include-global-log` to exclude it.

You can also export from inside the TUI without leaving the interactive session:

- **`/export-debug-zip`**: produces the same debug ZIP as `nori export`.
- **`/export-md`** (alias `/export`): exports the conversation as a human-readable Markdown file, suitable for sharing or archiving. Accepts an optional path argument; without one, it writes to `nori-export-<short-id>-<timestamp>.md` in the current working directory.

::: tip
Exported files may contain code, command output, and file paths that are sensitive. Review the content before sharing.
:::

## Next steps

- [Data locations](../configuration/data-locations.md) — full directory layout for session files
- [nori command reference](../reference/kimi-command.md) — complete parameter reference for `--continue`, `--session`, `export`, and other commands
