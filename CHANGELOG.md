# Changelog

## v0.1.12
- **Two-phase memory write**: `links=[]` triggers auto-search, `links=["None"]` skips linking, `links=["Title"]` writes with [[wiki-links]]
- **Bidirectional link traversal**: inLinks + outLinks BFS chain lookup
- **Session resume**: nori providers and rules properly restored on resume
- **nori_plan_write**: Windows path support

## v0.1.11 — First public release

Nori Code is a loop-core multi-agent coding tool. The orchestrator is read-only — it searches project memory, enforces custom rules, and delegates all code changes to parallel swarm sub-agents.

### Core Features
- **Loop-core orchestration** — plan → implement → review phases, goal-driven auto-continuation
- **Custom rules engine** — `nori.yaml` rules trigger on phase entry/exit or tool calls (always/on_phase/on_tool/on_event)
- **Obsidian-style shared memory** — markdown vault with `[[bidirectional links]]`, chain lookup with BFS link traversal
- **Agent Swarm** — DAG-based parallel execution with recursive depth control
- **Read-only orchestrator** — forced delegation via `nori_swarm_launch`, configurable via `/settings`
- **Review gate scoring** — per-turn activity scoring triggers mandatory/suggested review
- **Two-phase memory write** — enforced vault search before linking notes
- **12-setting GUI** — model, permission, theme, swarm depth, coder write, note rules, workflow thresholds

### Install
```sh
npm install -g nori-code
nori
```

### Requirements
Node.js ≥ 24.15.0

Built on Kimi Code CLI (MIT).
