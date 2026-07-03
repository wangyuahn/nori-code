# Nori Code

> Loop-core multi-agent coding tool — plan, delegate, review, repeat.

Nori Code is an AI coding agent that orchestrates work through a plan → implement → review loop. Instead of a single agent doing everything, it acts as a read-only orchestrator that delegates all code changes to parallel swarm sub-agents, backed by an Obsidian-style shared memory vault.

Built on the [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) (MIT license), Nori Code adds a hybrid rule engine, phase-based workflow enforcement, custom user-defined rules, and deep swarm integration.

---

## How It Works

```
You: "Build a login system"

  plan (hybrid)          → Search Obsidian vault → Analyze → Write plan
     ↓
  implement (autonomous) → nori_swarm_launch → Coder agents write code
     ↓                          ↓
   (custom rules enforced)  ask_parent ←→ orchestrator guidance
     ↓
  review (rule-enforced)  → Auto tests + lint + swarm review DAG
     ↓
  done                    → Write review note to Obsidian vault
```

The orchestrator is **read-only** — it plans, searches memory, and delegates. All Write/Edit/Bash operations go through swarm sub-agents.

---

## Core Features

**Loop-core orchestration** — plan → implement → review phases, each with configurable mode (rule-enforced / hybrid / llm-autonomous).

**Custom rules engine** — define rules in `nori.yaml` that trigger on phase entry/exit or tool calls. Injected as system prompts. Fully user-editable.

**Shared Obsidian memory** — markdown vault with `[[bidirectional links]]`. Agents search before coding, write after decisions. Sub-agents inherit vault access.

**Agent Swarm** — DAG-based parallel task execution with dependency chains and configurable recursion depth.

**Read-only orchestrator** — main agent cannot write code directly. Must delegate via `nori_swarm_launch`. Togglable via `/settings`.

**Post-code review** — review phase auto-runs tests, lint, type checks, then launches swarm review DAG.

**Tool hints** — on error, the system classifies the failure and suggests recovery tools. Model decides the fix.

**Centralized `/settings`** — all configuration in one GUI selector: model, permission, theme, swarm depth, coder write, note rules.

---

## Quick Start

```sh
# 1. Install dependencies
pnpm install

# 2. Build
pnpm -C apps/nori-code run build

# 3. Run
node apps/nori-code/dist/main.mjs
```
Or single-task mode: `node apps/nori-code/dist/main.mjs -p "your task"`

Requirements: Node.js ≥ 24.15.0, pnpm.

---

## Configuration (`nori.yaml`)

```yaml
phases:
  - name: plan
    mode: hybrid            # rule-enforced | hybrid | llm-autonomous
  - name: implement
    mode: llm-autonomous
  - name: review
    mode: rule-enforced

rules:
  definitions:
    - name: search_before_code
      condition: { type: on_phase, phase: implement, stage: entry }
      prompt: "Search Obsidian vault for past decisions before coding."
      enforced: true
      editable: true
```

Phase modes:
- **rule-enforced** — deterministic steps, no LLM involvement (tests, lint, build)
- **hybrid** — forced retrieval gate: model declares keywords → system searches vault → results injected → model continues
- **llm-autonomous** — model plans and delegates freely, custom rules still enforced

---

## Slash Commands

| Command | Action |
|---------|--------|
| `/settings` | Open settings GUI (model, permission, theme, swarm depth, coder write, note rules) |
| `/settings permission auto\|yolo\|manual` | Set permission mode |
| `/setting rules` | View custom rules |
| `/provider` | Configure third-party model providers |

---

## Develop

```sh
pnpm install
pnpm -C apps/nori-code run dev    # dev mode with hot reload
pnpm -C apps/nori-code run build  # production build
pnpm test                          # run tests
```

---

## License

MIT. Based on [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code).
