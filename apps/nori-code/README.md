# Nori Code

> Terminal CLI/TUI for Nori. Early project — **Team Engineering** is the product, not the deleted SubAgent DAG.

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

Requires Node.js `>=24.15.0`.

## Quick Start

```sh
cd your-project
nori
```

On first launch, configure a provider with `/provider` and select a model with `/model`. Then try:

```
Take a look at this project and explain the main directories.
```

## What this CLI does now

- **Department tree.** `TeamCreate` hires durable partners as mounted child sessions. `TeamDecide` / `TeamSpeak` run Discuss; `TeamAssign` enters Code; `TeamDismiss` removes partners and deletes their sessions.
- **Conversation map.** Sessions link via `parent_session_id`. `/map` in the TUI and the Web **Map** view browse, open, mount, unmount, and remount nodes.
- **Main read-only by default.** The lead coordinates; members execute assigned tracks. Toggle with `/setting readonly off` when needed.
- **Persistent memory.** Architecture decisions and patterns persist in a bidirectional-link vault via `nori_memory_search` / `nori_memory_write`.
- **Inherited harness.** MCP, Skills, Hooks, and tool approvals come from the Kimi Code fork. They work; they are not the differentiator.

`nori.yaml` is **not** a DAG scheduler. The runtime injects rule prompts and review/memory gates; it does not execute `phases:` as an orchestrator. LSP and Git in Nori Work are a rough shell. Full comparison and gap list: the project [README](../../README.md).

## Documentation

User docs live under [`docs/`](../../docs/) (VitePress, English and Chinese). Start with [Team engineering](../../docs/en/guides/team-engineering.md).

## Repository

<https://github.com/wangyuahn/nori-code>

## License

MIT. Based on [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) (MIT) — see the project root [README](../../README.md).
