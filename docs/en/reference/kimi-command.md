# `nori` Command

`nori` is the main command for Nori Code CLI, used to start an interactive session in the terminal. Running it without any arguments opens a new session in the current working directory; combined with different flags, you can resume a previous session, skip approvals, start Discuss, or load Skills from a custom directory.

> This page’s URL slug remains `kimi-command` for link stability. The executable command is `nori` (npm package `nori-code`).

```sh
nori [options]
nori <subcommand> [options]
```

## Main Command Options

All flags are optional — run `nori` directly to enter an interactive session:

| Option | Short | Description |
| --- | --- | --- |
| `--version` | `-V` | Print the version number and exit |
| `--help` | `-h` | Show help information and exit |
| `--session [id]` | `-S` | Resume a session. With an ID, opens that session directly; without an ID, enters an interactive selector |
| `--continue` | `-c` | Continue the most recent session in the current working directory, without specifying an ID manually |
| `--model <model>` | `-m` | Specify a model alias for this launch. When omitted, new sessions use `default_model` from the config file |
| `--prompt <prompt>` | `-p` | Run a single prompt non-interactively and stream the Assistant output to stdout. This mode does not open the TUI |
| `--output-format <format>` | | Set the non-interactive output format; supports `text` and `stream-json`. Can only be used with `--prompt`; defaults to `text` |
| `--permission <mode>` | | Set permission mode for this launch: `auto` or `yolo` |
| `--discuss` | | Start a new session in Discuss |
| `--skills-dir <dir>` | | Load Skills from the specified directory, replacing the automatically discovered user and project directories. Can be repeated |
| `--add-dir <dir>` | | Add an extra workspace directory for this session. Relative paths resolve against the current working directory. Can be repeated |

`-r` / `--resume` is a hidden alias for `--session`. `-y` / `--yolo` / `--yes` / `--auto-approve` are hidden aliases for `--permission yolo`; `--auto` is a hidden alias for `--permission auto`. These aliases are not shown in help output.

::: warning
`--permission yolo` (and its aliases) skips human approval for regular tool calls, including file writes and shell command execution. Use it only in trusted working directories. It does not bypass Discuss's read-only restrictions.
:::

### Flag Conflict Rules

The following combinations are rejected at startup:

- `--continue` and `--session` are mutually exclusive — both mean "resume a previous session"
- `--prompt` cannot be used with `--permission` or `--discuss` — non-interactive mode uses `auto` permission by default
- `--output-format` can only be used together with `--prompt`

When resuming a session, you can override its saved permission or Discuss state by adding `--permission`, `--yolo` / `--auto`, or `--discuss`. For example, `nori --continue --permission auto` resumes the latest session and switches it to auto permission mode.

## Common Usage

Start a new session directly:

```sh
nori
```

Pick up where you left off (automatically finds the most recent session in the current directory):

```sh
nori --continue
```

Choose from the session history list, or specify a known ID directly:

```sh
nori --session
nori --session 01HZ...XYZ
```

Skip approval prompts — suitable for batch tasks that are known to be safe:

```sh
nori --yolo
```

Let the Agent handle everything autonomously, without asking the user questions:

```sh
nori --auto
```

Enter Discuss to read the code in a read-only team meeting before making file changes:

```sh
nori --discuss
```

### Custom Skills Directories

There are two ways to specify Skills directories, with different semantics:

- **`--skills-dir <dir>`** (CLI flag): **Replaces** the automatically discovered user and project directories for this launch only. Can be repeated to stack multiple directories:

  ```sh
  nori --skills-dir /path/to/team-skills --skills-dir ./local-skills
  ```

- **`extra_skill_dirs`** (`config.toml`): **Adds** directories on top of the automatically discovered ones, taking effect permanently. Suitable for configuring team-shared Skills. See [Agent Skills](../customization/skills.md).

## Non-Interactive Execution

When running a single prompt in a script or CI environment, use `-p`:

```sh
nori -p "Summarize the current repository status"
```

Output uses a transcript style: thinking content and Assistant text are both prefixed with `• `, and wrapped lines are indented by two spaces. Assistant text goes to stdout; thinking, tool progress, and "resuming session" notices go to stderr. In `-p` mode, no human approval is requested — regular tool calls are handled under the `auto` permission policy, while static deny rules remain in effect.

Temporarily switch the model:

```sh
nori -m nori-code/kimi-for-coding -p "Explain the latest diff"
```

When you need to parse output programmatically, use the `stream-json` format — each line on stdout is a JSON object:

```sh
nori -p "List changed files" --output-format stream-json
```

In `stream-json` mode, regular replies produce an Assistant message; when the model calls a tool, an Assistant message with `tool_calls` is emitted first, followed by the corresponding Tool message, then subsequent Assistant messages. Thinking content is not written to JSONL; tool progress and "resuming session" notices are still written to stderr.

## Subcommands

`nori` provides the following subcommands: `acp` (ACP IDE mode), `server` (run and manage the local REST/WebSocket/web service), `web` (alias for `nori server run --open`), `doctor` (validate configuration files), `export` (export a session), `upgrade` (check for updates), `vis` (session visualizer), and `provider` (manage providers). Interactive account login uses the TUI slash command `/login` (there is no `nori login` subcommand).

### `nori acp`

Switch Nori Code CLI to ACP (Agent Client Protocol) mode, communicating with an IDE via JSON-RPC over stdin/stdout so the editor can directly drive Nori sessions and tool calls. You typically do not need to run this manually — the IDE starts it as a subprocess entry point. For configuration, see [Using in IDEs](../guides/ides.md); for technical details, see the [nori acp reference](./kimi-acp.md).

```sh
nori acp
```

### `nori server`

Run, install, and manage the local Nori server — a single process that exposes the REST + WebSocket API and serves the web UI from the same origin. The parent command is split into an on-demand entrypoint (`run`) and an OS-managed service lifecycle (`install`, `uninstall`, `start`, `stop`, `restart`, `status`). `nori server run` ensures a single background daemon is running and returns once it is healthy; pass `--foreground` to keep the server attached to the current terminal instead.

When the server is running, `GET /openapi.json` returns the REST OpenAPI document and `GET /asyncapi.json` returns the local WebSocket AsyncAPI document.

```sh
nori server run                # start or reuse a background daemon
nori server run --foreground   # run attached to the current terminal
nori server install            # register with launchd / systemd / schtasks
nori server start              # start the OS-managed service
nori server status             # snapshot of installed/running state
```

#### `nori server run`

| Option | Description |
| --- | --- |
| `--port <port>` | Bind port; defaults to `58771` |
| `--log-level <level>` | Enable server logs at the selected level; omitted by default |
| `--debug-endpoints` | Mount `/api/v1/debug/*` routes (off by default) |
| `--foreground` | Run in the foreground instead of spawning a background daemon |
| `--open` | Open the web UI in the default browser once the server is healthy |

`nori server run` binds to local loopback only. By default it spawns a single background daemon (reused across runs) and exits once the daemon is healthy; the daemon shuts itself down after the last web client disconnects. Pass `--foreground` to run the server in the current process instead — it then stays attached to the terminal and shuts down cleanly on `SIGINT` / `SIGTERM`.

#### `nori server install`

Register the server as an OS-managed service so it starts at login and restarts after a crash. The backend picks itself based on the running platform:

- **macOS**: writes a LaunchAgent plist to `~/Library/LaunchAgents/ai.moonshot.nori-server.plist` and bootstraps it via `launchctl bootstrap gui/<uid>`.
- **Linux**: writes a `--user` systemd unit to `~/.config/systemd/user/nori-server.service` and runs `systemctl --user enable --now`.
- **Windows**: registers a scheduled task named `NoriServer` via `schtasks /Create /XML`.

| Option | Description |
| --- | --- |
| `--port <port>` | Bind port the supervised server uses; defaults to `58771` |
| `--log-level <level>` | Log level recorded in the generated unit |
| `--force` | Replace an existing install instead of failing |
| `--json` | Output JSON instead of a human-readable line |

The loopback host, chosen port, and log level are recorded to `~/.nori-code/server/install.json` so `nori server status` can report them even when the service is stopped.

#### Lifecycle subcommands

| Command | Description |
| --- | --- |
| `nori server uninstall` | Stop and remove the OS service definition. Idempotent. |
| `nori server start` | Start the OS-managed service. Errors if not installed. |
| `nori server stop` | Stop the OS-managed service. |
| `nori server restart` | Restart the OS-managed service. |
| `nori server status` | Print installed / running / pid / port / log-path. `--json` for automation. |

#### `nori web`

Opens Nori's graphical session in the browser as an alternative to the terminal TUI.

Equivalent to `nori server run --open`: it starts a local Nori server in the background (reusing one already running), opens the web UI in the default browser, and returns, leaving the server resident in the background. The only difference from `nori server run` is that `--open` is enabled by default (auto-launches the browser); all other behavior is identical.

```sh
nori web                 # start the server in the background and open the browser (reuses a running one)
nori web --no-open       # don't open the browser; same as `nori server run`
nori web --foreground    # run attached to the current terminal and open the browser
```

Stop the server with `nori server kill` and list active connections with `nori server ps`; `--port`, `--log-level`, and the other flags match `nori server run`.

### `nori doctor`

Validate `config.toml` and `tui.toml` without starting the TUI or modifying either file. By default, the command checks the files under `NORI_CODE_HOME` (or `~/.nori-code` when the environment variable is unset). Missing default files are reported as skipped because built-in defaults can apply.

```sh
nori doctor
```

| Command | Description |
| --- | --- |
| `nori doctor` | Validate the default `config.toml` and `tui.toml` |
| `nori doctor config [path]` | Validate only `config.toml`, using `path` instead of the default file when provided |
| `nori doctor tui [path]` | Validate only `tui.toml`, using `path` instead of the default file when provided |

When an explicit path is passed, the file must exist. The command exits with `0` when all checked files are valid or skipped, and `1` when any requested file is missing or invalid.

```sh
# Check the default config files
nori doctor

# Check only the default runtime config
nori doctor config

# Check a candidate TUI config before replacing the live config
nori doctor tui ./tui.toml
```

### `nori export`

Package a session into a ZIP file for sharing, archiving, or submitting bug reports.

```sh
nori export [sessionId] [options]
```

| Parameter / Option | Short | Description |
| --- | --- | --- |
| `sessionId` | | The ID of the session to export. When omitted, the most recent session in the current working directory is automatically selected and requires confirmation |
| `--output <path>` | `-o` | Output ZIP file path. When omitted, writes to a default filename in the current directory |
| `--yes` | `-y` | Skip the confirmation prompt for the default session and export directly |
| `--no-include-global-log` | | Do not include the global diagnostic log. Included by default |

The export contains all files in the target session directory. The global diagnostic log (`~/.nori-code/logs/nori-code.log`) is included by default because it may contain events from other sessions or projects; add `--no-include-global-log` if you do not want to share it.

```sh
# Export the most recent session in the current directory, skipping confirmation
nori export -y

# Export a specific session to a custom path
nori export 01HZ...XYZ -o ./bug-report.zip

# Exclude the global diagnostic log
nori export 01HZ...XYZ -o ./bug-report.zip --no-include-global-log
```

### Legacy kimi-cli data

Nori stores runtime data under `~/.nori-code/` (`NORI_CODE_HOME`). The current `nori` CLI **does not** register an interactive `migrate` subcommand. For 1.x → 2.0 team-engineering behavior and legacy kimi-cli notes, see [Migrating from kimi-cli](../guides/migration.md).

### `nori upgrade`

Immediately check for the latest version and display an update prompt; exits after you make a selection. `nori update` is an alias for this command.

```sh
nori upgrade
```

For global npm and pnpm installations, `nori upgrade` shows update options; selecting `Install update now` runs the corresponding foreground install command. When the current installation method cannot be upgraded automatically, the manual update command is printed instead.

### `nori vis`

Launch the session visualizer in your browser to inspect a session as it unfolds. The command starts an in-process server pointed at your local sessions, prints the URL, opens your browser, and keeps running until you press `Ctrl-C`.

```sh
nori vis [sessionId] [options]
```

| Parameter / Option | Description |
| --- | --- |
| `sessionId` | Open the visualizer directly to this session. When omitted, it opens the home view listing your sessions |
| `--port <number>` | Port to bind. By default an available port is picked automatically |
| `--host <host>` | Host to bind. Default: `127.0.0.1` |
| `--no-open` | Do not open the browser automatically; just print the URL |

```sh
# Start the visualizer and open the browser at the home view
nori vis

# Open directly to a specific session
nori vis 01HZ...XYZ

# Bind a fixed port and host without opening a browser (e.g. on a remote host)
nori vis --host 0.0.0.0 --port 8123 --no-open
```

### `nori provider`

Manage providers in the shell — the non-interactive equivalent of `/provider` in the TUI. Suitable for scripted deployments, CI initialization, and one-line setup on a new machine.

```sh
nori provider <action> [options]
```

Five actions are available:

#### `nori provider add <url>`

Bulk-import all providers from a custom registry (`api.json`). The command fetches the registry, creates a `[providers.<id>]` and `[models.<alias>]` entry for each item, and writes `source` metadata so the TUI refreshes providers and models from the same registry URL automatically on next startup.

| Parameter / Option | Description |
| --- | --- |
| `<url>` | Registry URL |
| `--api-key <key>` | Bearer token for accessing the registry. Falls back to the `NORI_REGISTRY_API_KEY` environment variable if not provided; required |

```sh
nori provider add https://registry.example.com/v1/models/api.json --api-key YOUR_KEY

# Or via environment variable (suitable for CI / .envrc)
NORI_REGISTRY_API_KEY=YOUR_KEY nori provider add https://registry.example.com/v1/models/api.json
```

If a provider ID already exists, it is removed and re-created. The default model is not set automatically; you can select one later with `-m` or `/model` in the TUI.

#### `nori provider remove <providerId>`

Remove the specified provider and all its model aliases. If the removed provider is the one referenced by `default_model`, `default_model` is also cleared.

```sh
nori provider remove kohub
```

#### `nori provider list`

Print each configured provider on a separate line, including type, model count, and source. Add `--json` to output the raw `providers` and `models` tables for programmatic processing.

```sh
nori provider list
nori provider list --json | jq '.providers | keys'
```

#### `nori provider catalog list [providerId]`

Browse the public [models.dev](https://models.dev/) model catalog without modifying any configuration. Without an argument, lists all providers along with their protocol type and model count; with a `providerId`, lists all models under that provider along with their context window and capabilities.

| Parameter / Option | Description |
| --- | --- |
| `[providerId]` | Optional — the provider ID to inspect |
| `--filter <substring>` | Case-insensitive substring filter on ID or name |
| `--url <url>` | Override the catalog URL; defaults to `https://models.dev/api.json` |
| `--json` | Output matching entries as JSON |

```sh
nori provider catalog list
nori provider catalog list --filter anthropic
nori provider catalog list anthropic
```

#### `nori provider catalog add <providerId>`

Import a known provider directly from the catalog by ID. The protocol type, base URL, and model information are all supplied by the catalog — only an API key is required.

| Parameter / Option | Description |
| --- | --- |
| `<providerId>` | Provider ID in the catalog, e.g., `anthropic`, `openai` |
| `--api-key <key>` | Provider API key. Falls back to `NORI_REGISTRY_API_KEY` if not provided; required |
| `--default-model <modelId>` | Optional — set `default_model` to `<providerId>/<modelId>` after import |
| `--url <url>` | Override the catalog URL; defaults to `https://models.dev/api.json` |

```sh
nori provider catalog list anthropic          # Browse available models first
nori provider catalog add anthropic --api-key sk-ant-... --default-model claude-opus-4-7
```

## Next steps

- [Slash Commands](./slash-commands.md) — Quick reference for control commands in the interactive TUI
- [Configuration Files](../configuration/config-files.md) — Persistent configuration for `default_model`, permission mode, and other startup parameters
- [Agent Skills](../customization/skills.md) — Skill file format for directories loaded via `--skills-dir`
