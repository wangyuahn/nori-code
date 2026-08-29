# Using Nori Code CLI in IDEs

Nori Code CLI supports integration into IDEs via the [Agent Client Protocol (ACP)](https://agentclientprotocol.com/), letting you use AI-assisted coding directly inside your editor.

## Prerequisites

Before configuring your IDE, make sure Nori Code CLI is installed and you have completed the login setup.

The ACP adapter is exposed as the `nori acp` subcommand. The IDE launches it as a child process and communicates over stdin/stdout using JSON-RPC. Each time the IDE creates a session, the CLI reuses its existing authentication state — no need to log in again.

::: tip Path note
Child processes launched from an IDE GUI on macOS typically do **not** inherit the terminal shell's `PATH`. If `nori` is not in a system directory like `/usr/local/bin`, use the absolute path in your IDE configuration. Run `which nori` in a terminal to find the active path.
:::

## Using Nori Code CLI in Zed

[Zed](https://zed.dev/) is a modern editor with native ACP support.

Add the following to Zed's config file at `~/.config/zed/settings.json`:

```json
{
  "agent_servers": {
    "Nori Code CLI": {
      "type": "custom",
      "command": "nori",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

Configuration fields:

- `type`: fixed value `"custom"`
- `command`: path to the Nori Code CLI executable. If `nori` is not on `PATH`, use the full path (e.g. `/Users/you/.local/bin/nori`).
- `args`: startup arguments. The `acp` subcommand switches the CLI into ACP mode.
- `env`: additional environment variables; usually leave this empty. Zed injects a default environment automatically.

After saving, open a new conversation in Zed's Agent panel and it will launch a `Nori Code CLI` ACP subprocess using the configuration above. MCP servers declared in Zed's `agent_servers` section are also forwarded to the Nori side via the ACP protocol.

## Using Nori Code CLI in JetBrains IDEs

JetBrains IDEs (IntelliJ IDEA, PyCharm, WebStorm, etc.) support ACP through the AI chat plugin.

If you do not have a JetBrains AI subscription, you can enable `llm.enable.mock.response` in the Registry to access the AI chat panel in ACP-only scenarios. Press Shift twice and search for "Registry" to open it.

In the AI chat panel menu, click **Configure ACP agents** and add the following configuration:

```json
{
  "agent_servers": {
    "Nori Code CLI": {
      "command": "~/.local/bin/nori",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

JetBrains is strict about the `command` field — always use an **absolute path**, which you can get by running `which nori` in a terminal. After saving, `Nori Code CLI` will appear in the AI chat's agent selector.

## Using Nori Code CLI in Paseo

[Paseo](https://paseo.sh/) is a self-hosted orchestrator that runs and supervises agent CLIs from your desktop, web, and mobile. It connects to Nori Code CLI over ACP, the same way an IDE does.

Pick **Nori Code CLI** from Paseo's built-in ACP provider catalog, or add a custom provider in `~/.paseo/config.json`:

```json
{
  "agents": {
    "providers": {
      "nori": {
        "extends": "acp",
        "label": "Nori Code CLI",
        "command": ["nori", "acp"]
      }
    }
  }
}
```

Paseo's generic ACP adapter does not drive the login flow, so complete the terminal login first (see [Prerequisites](#prerequisites)) — otherwise session creation fails with `Authentication required`.

## Troubleshooting

- **Session disconnects immediately / IDE shows "agent exited"**: usually a wrong `command` path or a missing login. Run `nori acp` in a terminal first to verify — if it blocks waiting for stdin, the CLI itself is fine and the problem is in the IDE configuration; if it exits immediately with an error, follow the error message (most commonly you need to run `/login`).
- **IDE shows "auth required"**: the CLI has no usable authentication token. Exit the IDE, run `nori` in a terminal to complete login, then restart the IDE.
- **MCP tools not visible**: check the [`nori acp` reference](../reference/kimi-acp.md) capability table to confirm that the MCP transport type configured in your IDE is supported. The Nori Code CLI ACP adapter currently supports `http`, `stdio`, and `sse` transports; `acp` transport MCP servers are silently dropped and a warning is written to the log.

## Next steps

- [nori acp reference](../reference/kimi-acp.md) — ACP capability matrix and method coverage details
- [nori command reference](../reference/kimi-command.md) — full subcommand list
