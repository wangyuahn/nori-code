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

**Loop-core orchestration** — plan → implement → review phases, each with configurable mode (rule-enforced / hybrid / llm-autonomous). Goal mode auto-drives turns through all phases.

**Custom rules engine** — define rules in `nori.yaml` that trigger on phase entry/exit or tool calls. 4 condition types: `always`, `on_phase`, `on_tool`, `on_event`. Injected as system prompts. View/edit via `/setting rules`.

**Shared Obsidian memory** — markdown vault at `~/.nori-code/vault/` with `[[bidirectional links]]`. `nori_memory_search` queries vault (embedding + keyword + link graph). `nori_memory_write` records decisions/analysis/reviews. Note rules enforce mandatory notes at phase boundaries.

**Agent Swarm** — DAG-based parallel task execution with dependency chains and configurable recursion depth (`/settings → Swarm Depth`). `nori_swarm_launch` spawns coder/test/review sub-agents. `nori_ask_parent` lets sub-agents ask the orchestrator for guidance.

**Read-only orchestrator** — main agent cannot write code directly. Must delegate via `nori_swarm_launch` or `nori_plan_write` (for docs). Togglable via `/settings → Read-only Mode`.

**Review gate & scoring** — TurnFlow tracks per-turn activity (files changed, swarm calls, shell commands) and scores 0–10. Exceeding thresholds triggers mandatory/suggested review. Configurable via `/settings → Workflow`.

**Post-code review** — review phase auto-runs tests, lint, type checks, then launches swarm review DAG.

**Tool hints** — on error, the system classifies the failure (compile / test / type / runtime / network / timeout) and suggests recovery tools. Model decides the fix.

**Centralized `/settings`** — model, permission, theme, editor, swarm depth, coder write, note rules, read-only mode, workflow thresholds. All in one GUI selector.

---

## Quick Start

```sh
# Install globally
npm install -g nori-code

# Start interactive TUI
nori

# Single task mode
nori -p "your task"

# Auto-approve mode
nori --permission auto
```

Requirements: Node.js ≥ 24.15.0.

After install, configure a model provider:

```sh
nori
# In the TUI:
/provider    # add your API key (OpenAI, Anthropic, DeepSeek, etc.)
/model       # select a model
```

### Build from source

```sh
git clone https://github.com/wangyuahn/nori-code.git
cd nori-code
pnpm install
pnpm -C apps/nori-code run build
node apps/nori-code/dist/main.mjs
```

---

## Configuration (`nori.yaml`)

Place `nori.yaml` in your project root. If absent, sensible defaults are used (default vault at `~/.nori-code/vault/`).

```yaml
phases:
  - name: plan
    mode: hybrid
    hybrid:
      retrieval_gate:
        trigger: { mode: on_keywords }
        max_results: 10
  - name: implement
    mode: llm-autonomous
    llm_autonomous:
      max_iterations: 50
  - name: review
    mode: rule-enforced
    rule_enforced:
      steps:
        - type: exec
          id: run_tests
          command: "npm test"
        - type: exec
          id: lint
          command: "eslint src/"

workflow:
  review:
    suggestion_threshold: 4
    required_threshold: 7
    max_gate_continuations: 2

rules:
  definitions:
    - name: search_before_code
      condition: { type: on_phase, phase: implement, stage: entry }
      prompt: "Search Obsidian vault for past decisions before coding."
      enforced: true
      editable: true
    - name: require_plan_document
      condition: { type: on_phase, phase: plan, stage: exit }
      prompt: "Write a plan document before leaving the plan phase."
      enforced: true
      editable: false

swarm:
  max_concurrency: 4
  max_swarm_depth: 3
  checks:
    - id: type_check
      agent_type: coder
      on_failure: fix_and_retry
    - id: test_check
      agent_type: coder
      depends_on: [type_check]
      on_failure: block
```

Phase modes:
- **rule-enforced** — deterministic steps, no LLM involvement (tests, lint, build)
- **hybrid** — forced retrieval gate: model declares keywords → system searches vault → results injected → model continues
- **llm-autonomous** — model plans and delegates freely, custom rules still enforced

---

## Slash Commands

| Command | Action |
|---------|--------|
| `/settings` | Open settings GUI (12 options: model, permission, theme, editor, experiments, updates, usage, coder write, swarm depth, note rules, read-only mode, workflow) |
| `/settings auto` | Interactive setup wizard (6-step guided configuration) |
| `/settings permission auto\|yolo\|manual` | Set permission mode |
| `/setting rules` | View/edit custom rules |
| `/setting note` | Toggle mandatory note rules (analysis/decision/pattern) |
| `/provider` | Configure third-party model providers |

## Memory Tools

| Tool | Description |
|------|-------------|
| `nori_memory_search` | Query vault by keywords. Returns ranked results from embedding + full-text + link graph |
| `nori_memory_write` | Write notes to vault. Use `[[wiki-links]]` for bidirectional linking |
| `nori_plan_write` | Write plan docs to project workspace (docs/plans/). Not blocked by read-only mode |

## Swarm Tools

| Tool | Description |
|------|-------------|
| `nori_swarm_launch` | Launch DAG-based parallel sub-agents (coder/test/review) |
| `nori_swarm_status` | Check running swarm progress |
| `nori_swarm_result` | Retrieve swarm results |
| `nori_ask_parent` | (subagent only) Ask parent orchestrator for guidance |

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
