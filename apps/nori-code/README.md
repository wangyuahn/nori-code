# Nori Code

Terminal coding agent. Hire a department of durable partner sessions, discuss in short rounds, then assign work. The conversation map is the session console.

```sh
npm install -g nori-code
# or: pnpm add -g nori-code

nori --version
cd your-project
nori
```

Requires Node.js ≥ 22.19.0. The executable is `nori`.

First launch: `/login` or `/provider`, then `/model`.

```sh
nori -p "your task"    # one shot
nori -c                # resume
nori web               # browser workspace
```

- **Team** — `TeamCreate` hires mounted child sessions. `TeamDecide` / `TeamSpeak` run multi-round Discuss (one short point per turn, then `action=continue`). `TeamAssign` enters Code. `TeamDismiss` deletes the child session.
- **Map** — `/map` in the TUI; **Map** in Nori Work / `nori web`. Same sessions as hire.
- **Main Agent** — read-only coordinator by default. `/setting readonly off` if the lead should edit.
- **SubAgent** — temporary delegate inside the parent session; not a map node.

User docs: [`docs/`](../../docs/). Start with [Getting started](../../docs/en/guides/getting-started.md) and [Team engineering](../../docs/en/guides/team-engineering.md). Product overview: [root README](../../README.md).

Repository: <https://github.com/wangyuahn/nori-code>

MIT. Based on [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) (MIT) — see the [root README](../../README.md).
