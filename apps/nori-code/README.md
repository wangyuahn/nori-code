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

- **Multi-agent DAG orchestration.** AgentSwarm decomposes tasks into parallel sub-agents with dependency scheduling — plan, implement, verify, and review run concurrently.
- **Persistent memory.** Architecture decisions, code reviews, and patterns persist in a bidirectional-link vault via `nori_memory_search` / `nori_memory_write`. Cross-session knowledge means Nori learns your project over time.
- **Policy-as-Code.** `nori.yaml` enforces deterministic rules: search vault before coding, run tests before exit, require review before merge.
- **Sub-agents.** Dispatch `coder`, `explore`, and `plan` sub-agents with isolated context. The main conversation stays clean.
- **Lifecycle hooks.** Run arbitrary commands at key workflow gates — audit tool calls, fire notifications, trigger CI.
- **Desktop workbench.** Nori Work pairs with the CLI for a full IDE-like experience.

## Documentation

TBD — see the project root [README](../README.md) for architecture and feature docs.

## Repository

<https://github.com/wangyuahn/nori-code>

## License

MIT. Based on [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) (MIT) — see the project root [README](../README.md) for the full attribution and history.
