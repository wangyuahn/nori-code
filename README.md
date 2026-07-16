# Nori Code / Nori Work

> **Multi-agent coding workspace — decompose, distribute, verify, remember.**

Nori orchestrates multiple AI agents to plan, implement, review, and persist knowledge across sessions. Not another chat-over-code tool — a **multi-agent engineering workspace**.

[中文说明](README.zh-CN.md)

![Nori Work](docs/images/nori-work.png)

---

## Products

| | Nori Code | Nori Work |
|---|---|---|
| **What** | Terminal CLI/TUI for focused coding sessions | Electron desktop workbench |
| **Who for** | Terminal-first power users | Full workspace with browser, terminal, Git, filesystem |
| **Interface** | Ink-based TUI with split panes | Multi-panel desktop with embedded browser/terminal |
| **Start** | `nori` | Standalone installer (see releases) |

---

## Why Nori

Most AI coding tools are **single-agent chat shells**: one model, one context, one turn at a time. Nori is built differently:

- **Parallel, not serial.** Complex tasks decompose into DAG-shaped agent workflows — plan → implement → verify → review — running in parallel with dependency scheduling.
- **Memory, not amnesia.** Architecture decisions, code reviews, and patterns persist in a bidirectional-link vault. What you learned last month is available next session.
- **Policy, not guesswork.** `nori.yaml` enforces deterministic rules: search memory before coding, run tests before exit, review before merge. AI flexibility backed by project discipline.
- **Desktop, not a web tab.** Nori Work embeds a native terminal (node-pty), browser view (WebContentsView), filesystem sandbox, system tray, notifications, and auto-update — a proper local workspace.

---

## Key Features

### 🧠 Multi-Agent DAG Orchestration
AgentSwarm splits a task into parallel sub-agents with explicit dependency chaining. A multi-file refactor dispatches `{ plan, implement-1, implement-2, verify, review }` concurrently — no manual turn-by-turn handholding.

### 📚 Persistent Project Memory
Every decision, review, and pattern lands in an Obsidian-compatible vault with `[[wiki-links]]`. The planner searches it automatically before each implementation phase. Cross-session knowledge means Nori gets smarter about *your project* over time.

### ⚙️ Policy-as-Code (`nori.yaml`)
Codify project rules that the agent loop enforces automatically:
```yaml
rules:
  - name: search_before_code
    condition: { on_phase: implement, stage: enter }
    prompt: "Search vault for prior decisions and patterns."
    enforced: true
```
Orchestrator, coder, and reviewer can each use a different model/provider.

### 🖥️ Nori Work Desktop
Built from scratch (Electron + node-pty + WebContentsView):
- Embedded terminal with full PTY support
- Embedded browser for documentation / preview
- Filesystem sandbox (whitelist + blocklist)
- System tray with phase/swarm state
- Native OS notifications
- Secure preload bridge (no raw Node in renderer)

### 🔌 Provider Flexibility
Bring any OpenAI-compatible provider — local (Ollama, LM Studio) or cloud. Each agent role (orchestrator / coder / reviewer) can run its own model.

---

## Roadmap

| Priority | Feature | Status |
|----------|---------|--------|
| P0 | **Built-in LSP** — symbol definition, references, types, diagnostics via language server | 📝 Planned |
| P0 | **Custom Agent Profiles** — user-defined agents with custom prompts, tools, and model selection | 📝 Planned |
| P1 | **Agent Browser Tool** — headless browser for page rendering, screenshot, JS evaluation | 📝 Planned |

See [plans/roadmap-todo.md](plans/roadmap-todo.md) for details.

---

## Quick Start

```sh
npm install -g nori-code

# Interactive TUI
nori

# One-shot prompt
nori -p "your task"

# Start the local web workspace
nori web
```

Nori Work is available as a **standalone desktop installer** — see the [latest release](https://github.com/wangyuahn/nori-code/releases).

### From source

```sh
git clone https://github.com/wangyuahn/nori-code.git
cd nori-code
corepack enable
pnpm install

pnpm dev:cli       # Terminal TUI
pnpm dev:web       # Web UI
pnpm dev:desktop   # Desktop workbench
```

---

## Packages

| Package | Role |
|---------|------|
| `apps/nori-code` | CLI/TUI entry point |
| `apps/nori-web` | Web UI (loaded by desktop) |
| `apps/nori-desktop` | Electron desktop workbench |
| `packages/agent-core` | Agent, session, swarm, tool, workflow engine |
| `packages/server` | REST/WebSocket server |
| `packages/kosong` | Model/provider abstraction |
| `packages/kaos` | File, process, environment abstractions |
| `packages/node-sdk` | Public TypeScript SDK |
| `packages/oauth` | Authentication and provider registry |

---

## Development

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm check:brand    # Verify no stray Kimi branding
```

Run focused checks per affected package first; expand to root-level checks before commit.

---

## License

MIT. Based on [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) (MIT), from which Nori forked and grew its own architecture: multi-agent DAG orchestration, persistent memory, desktop environment, policy engine, and independent branding. Required upstream compatibility is maintained where shared protocol surfaces apply.
