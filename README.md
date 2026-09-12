# Nori Code / Nori Work

> **A department of agents — discuss, assign, execute, remember.**

Nori Code is a terminal coding agent. Nori Work is the companion Electron workbench. Together they treat a project as a **department tree of real sessions**, not one chat with side notes.

Hire durable partners. They speak in **multi-round Discuss** (one short `TeamSpeak` per turn, then `action=continue`). `TeamAssign` enters Code. The **conversation map** is the session console: open, stop, mount, and edit identity.

[中文说明](README.zh-CN.md) · [Getting started](docs/en/guides/getting-started.md) · [Team engineering](docs/en/guides/team-engineering.md)

![Nori Work conversation workspace](docs/images/nori-work-overview.png)

![Nori Work browser workspace](docs/images/nori-work-browser.png)

---

## Products

| | Nori Code | Nori Work |
|---|---|---|
| **What** | Terminal CLI / TUI | Electron desktop workbench |
| **Who for** | Terminal-first sessions | Chat, files, Git, terminal, browser, and Map on one screen |
| **Start** | `nori` | Installer from [Releases](https://github.com/wangyuahn/nori-code/releases), or `nori web` for the browser workspace |

The CLI package on npm is `nori-code`. The executable is `nori`. Published CLI requires **Node.js ≥ 22.19.0**. Developing this monorepo requires **Node.js ≥ 24.15.0** and **pnpm 10.33.0**.

---

## How work moves

1. **`TeamCreate`** — hire partners. Each hire is a **mounted child session** (a card on the map) plus a team agent so Discuss still addresses this department.
2. **`TeamDecide action=start`** — open Discuss. Members speak in order with **`TeamSpeak`**: one claim, one disagreement, or one concrete suggestion. Do not finish the whole problem in a single turn. Use **`action=continue`** for the next slice. A skipped turn is an abstention; later speakers still run. While Discuss is open, `Write` / `Edit` / `Bash` stay blocked.
3. **`TeamAssign`** — hand out file-bounded tasks. Success **leaves Discuss** and enters Code.
4. **Code** — members execute. `TeamChat` is peer traffic; `TeamDM` is one-to-one (including reports to the parent: `completed` / `blocked` / `needs_decision`).
5. **Map** — the same sessions. Click to select, open chat, force-stop a turn, create a child, edit name/role/mandate/tags, unmount, or delete. Box-select for batch actions.

The main Agent is a **read-only coordinator** by default (`/setting readonly on`). Members execute assigned tracks. Use `/setting readonly off` only when the lead should edit files.

**SubAgent** is a different model: a temporary delegate archived under the parent session. It is not a map node and is not a long-lived department.

`TeamDismiss` deletes a hired child session. Unmount on the map only drops the parent link.

---

## Surfaces

| Surface | What it is for |
|---|---|
| `nori` | Interactive TUI in the project directory |
| `/team` (alias `/agents`) | Open a partner session, reports, this-round Discuss speech, max department depth |
| `/map` | Mount forest: open, mount, unmount |
| `Shift-Tab` / `/discuss` | Toggle Discuss / Code (`/plan` is a compatibility alias) |
| `Ctrl-Y` | Show or hide the Discuss / Chat pane |
| `nori web` | Hand the current session to the browser workspace |
| Nori Work **Map** | Pan/zoom console: create, wire, stop, settings, filters, box-select |

Identity is **`<session_self>`** plus mount/identity change notices. Partners do not share the lead's transcript.

---

## Also in the box

- **Memory** — Obsidian-compatible vault (`nori_memory_search` / `nori_memory_write`) with `[[wiki-links]]`, backlinks, and a graph in Nori Work.
- **`nori.yaml`** — project phases, vault path, and enforced rules (for example search memory before implement).
- **Providers** — OpenAI-compatible cloud or local (Ollama, LM Studio). Configure with `/login` or `/provider`.
- **Browser tool** — navigate, snapshot, click, type, screenshot. Local `.html` / `.htm` are allowed; arbitrary `file://` is not. Actions fail immediately when no page is open.
- **LSP** — diagnostics and navigation when a language server is available.

---

## Quick start

```sh
npm install -g nori-code
# or: pnpm add -g nori-code

cd your-project
nori
```

First launch: `/login` or `/provider`, then `/model`. Try:

```
Take a look at this project and explain the main directories.
```

Non-interactive:

```sh
nori -p "your task"
nori -c                 # resume previous session
nori web                # browser workspace
nori upgrade            # update the CLI
```

Nori Work desktop builds: [Releases](https://github.com/wangyuahn/nori-code/releases).

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

## Documentation

| Topic | English | 中文 |
|---|---|---|
| Install and first launch | [Getting started](docs/en/guides/getting-started.md) | [开始使用](docs/zh/guides/getting-started.md) |
| Department tree, Discuss, Map | [Team engineering](docs/en/guides/team-engineering.md) | [团队工程](docs/zh/guides/team-engineering.md) |
| 1.x → 2.0 | [Migration](docs/en/guides/migration.md) | [迁移](docs/zh/guides/migration.md) |
| Built-in tools | [Tools](docs/en/reference/tools.md) | [工具](docs/zh/reference/tools.md) |

---

## Repository map

| Path | Role |
|---|---|
| `apps/nori-code` | CLI / TUI (`nori`) |
| `apps/nori-web` | Web UI (desktop and `nori web`) |
| `apps/nori-desktop` | Electron workbench |
| `packages/agent-core` | Agent, Session, Team, tools |
| `packages/server` | REST + WebSocket (`/api/v1`) |
| `packages/kosong` | Model / provider layer |
| `packages/kaos` | Files, processes, environment |
| `packages/node-sdk` | Public TypeScript SDK |
| `packages/oauth` | Auth |

---

## Development

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm check:brand    # no leftover Kimi branding
```

Run focused checks on the package you touched; run the root commands before merge.

---

## License

MIT. Forked from [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) (MIT). Nori keeps the shared protocol surfaces it still needs, and owns its department-tree runtime, conversation map, memory vault, desktop workbench, and branding.
