# Changelog

## Unreleased

## v1.0.0-pre.0
### Features
- Add the multi-tab Nori Work browser with Agent navigation, stable-reference snapshots, interaction, uploads, screenshots, diagnostics, annotations, local HTML support, user takeover, and immediate no-page errors.
- Add configurable custom Agent roles and permissions, built-in LSP operations, persistent terminals, movable inspector tools, and standalone inspector windows.
- Keep Agent and AgentSwarm execution in the background with project/session ownership, nested activity, output previews, token accounting, pause/guide/resume/stop controls, and main-Agent wakeups on completion or failure.
- Present project changes, file previews, and Git operations in one cached project-scoped inspector, including per-Agent edit attribution and accumulated edits to the same file.
- Make project memory Obsidian-compatible with vault-relative links, outgoing links, backlinks, a movable knowledge graph, legacy-layout migration, and optional vector retrieval through a dedicated embedding provider.
- Improve streaming chat, tool placement, Markdown rendering, image/file input, session organization, usage dashboards, rewind, approval modes, goals, prompts, and provider/model configuration.

### Fixes
- Return an immediate actionable Browser error for `snapshot`, interaction, screenshot, and diagnostics actions when no page is open instead of waiting for the bridge timeout.
- Keep Browser tools available through bridge startup and reconnection, and keep long-running browser actions alive with independent heartbeats.
- Allow safe local HTML preview while continuing to block arbitrary local files, remote UNC files, and privileged URL schemes.
- Reject stale Web and SEA inputs during desktop packaging so a new renderer cannot ship with an old backend.
- Recover desktop startup from stale or incompatible server locks and replace older bundled/global server processes before connecting.
- Show ordinary Agent activity alongside Swarm activity, preserve project/session/nested ownership, and report completion/failure counts and states correctly.
- Restore Chat navigation to the conversation view and session list.
- Stop creating duplicate legacy plural Vault folders, migrate existing notes to canonical folders, and resolve Related links and backlinks by Obsidian-compatible relative paths.
- Discover configured and installed language servers for common file types before reporting that no LSP is available.

## v0.1.18
- Fix the settings form so selecting **New Provider** reliably opens a clean, editable provider configuration instead of snapping back to the previous connection.
- Make custom OpenAI-compatible Provider model discovery accept API roots with or without `/v1`, fall back across both common model endpoints, and report actionable non-JSON response errors.
- Make project changes react to main-agent and subagent `Edit`/`Write` operations in real time, including non-Git workspaces, and rebuild both conversation history and Git state from the refresh control.
- Cache changes by project across sessions, accumulate repeated edits to the same file, and deduplicate the realtime, live-turn, and persisted-history copies of one mutation.
- Merge background Agent and Agent Swarm wake-up output into the active assistant turn without requiring a session reload.
- Generate first-message conversation titles through the main Agent while hiding title reminders and repairing previously polluted titles.
- Keep Agent Swarm navigation in its normal idle color when no agents are running.

## v0.1.17
- Make chat WebSocket readiness acknowledgement-driven across startup and reconnects, and replace incompatible background server versions before Nori Work connects.
- Preserve and render user images in optimistic messages and reloaded conversation history.
- Keep `ReadMediaFile` registered for every configured profile while reporting unsupported model media capabilities at execution time.
- Keep the project-change recalculation control visible in clean and empty states, refreshing Git status before rebuilding the project diff cache.

## v0.1.16
- Restore authenticated real-time WebSocket streaming, including continued output after tool calls.
- Stabilize workspace file and Git refreshes, nested-repository detection, and Windows untracked-file diffs.
- Add responsive usage dashboards, lazy session creation, reliable rename/fork actions, and native Markdown export.
- Improve change cards with explicit agent attribution, metadata-only filtering, collapsible diffs, and filename-preserving paths.
- Add loading feedback, consolidated assistant turns, and focused regression coverage for the updated desktop workflow.
- Run Agent and Agent Swarm work in the background with completion/failure wakeups, nested task management, usage accounting, and per-session activity views.
- Add project-scoped change caching, shared Git refreshes, slash commands, Plan/Code switching, multimodal Kimi capability detection, and richer Swarm controls.
- Add an independent OpenAI-compatible embedding provider for vector Memory retrieval, with separate credentials, secure configuration responses, caching, and hybrid semantic/full-text/link scoring.

## v0.1.13
- **nori_memory_remove** — delete notes from vault (soft-delete to .trash/)
- **WebSearch fix** — always available with DuckDuckGo fallback, 10s timeout + abort support
- **nori_memory_write** — `links: ["None"]` to explicitly skip linking
- **Bidirectional BFS** — inLinks + outLinks chain traversal
- **Various fixes** — nori_plan_write Windows paths, session resume providers, noriRules normalization

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
