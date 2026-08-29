# Nori Code

> Loop-core multi-agent coding CLI.

## Install

```sh
npm install -g nori-code
# or
pnpm add -g nori-code
```

Verify:
```sh
nori --version
```

## Quick Start

```sh
cd your-project
nori
```

On first launch, configure a provider with `/provider` and select a model with `/model`. Then try:

```
Take a look at this project and explain the main directories.
```

## Key Features

- **Tree-structured team.** `TeamCreate` hires durable partners as mounted child sessions. `TeamDecide` / `TeamSpeak` run Discuss; `TeamAssign` enters Code; `TeamDismiss` removes partners and deletes their sessions.
- **Conversation map.** Sessions link via `parent_session_id`. `/map` in the TUI and the Web **Map** view browse, open, mount, unmount, and remount nodes.
- **Main read-only by default.** The lead coordinates; members execute assigned tracks. Toggle with `/setting readonly off` when needed.
- **Persistent memory.** Architecture decisions and patterns persist in a bidirectional-link vault via `nori_memory_search` / `nori_memory_write`.
- **Policy-as-Code.** `nori.yaml` enforces deterministic rules: search vault before coding, run tests before exit, require review before merge.
- **Desktop workbench.** Nori Work pairs with the CLI for browser, terminal, Git, and the session map on a large screen.

## Documentation

User docs live under [`docs/`](../docs/) (VitePress, English and Chinese). Start with [Team engineering](../docs/en/guides/team-engineering.md) for 2.0 department workflows, or the project root [README](../README.md) for product overview.

## Repository

<https://github.com/wangyuahn/nori-code>

## License

MIT. Based on [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) (MIT) — see the project root [README](../README.md) for the full attribution and history.
