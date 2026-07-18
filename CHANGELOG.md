# Changelog

## Unreleased

### Fixes
- Create `<NORI_CODE_HOME>/server/server.log` before Nori Work launches the bundled server, so first-start failures always expose a real log path instead of opening a missing Windows path.
- Keep ordinary code previews mounted during refresh and defer highlighted DOM replacement while text is selected, preventing preview selections from expanding or disappearing.
- Keep Markdown code-copy controls clickable during the real `mousedown`/`mouseup`/`click` sequence instead of removing them when selection protection activates.

### Verification
- Nori Work desktop tests: `14/14` passed.
- Nori Web tests: `129/129` passed.
- Nori Web and Nori Work type checks passed.
- Local Windows EXE rebuilt from these fixes as `Nori-Work-1.0.0-pre.2-x64.exe` (not published).

## v1.0.0-pre.2 (2026-07-17)
### Features
- Allow each custom Agent profile to select its own model or inherit the parent Agent model, including model selection in the Nori Work agent editor and consistent model restoration on resume.
- Render inline and block math through the shared Markdown component with locally bundled KaTeX assets across chat, previews, memory notes, approvals, and Agent output.
- Bundle the complete Pyright runtime into the native server and launch packaged Node language servers through Nori Work's Electron Node runtime.

### Fixes
- Update Plan/Code controls immediately while session configuration saves in the background instead of waiting for the next status poll.
- Keep active Agent navigation yellow in every view and theme, recover ordinary background Agent counts after reconnects, and avoid double-counting Swarm tasks.
- Restore a parent subagent from waiting to running when nested Agent completion wakes it in a new turn.
- Preserve custom Agent profile names and streamed output in the collaboration panel with explicit server projection coverage.
- Apply custom Agent configuration changes to already-open sessions by rebuilding collaboration tools and refreshing their system prompts.
- Clear collaboration activity immediately after a manual Agent termination and avoid treating stopped Swarm agents as ordinary running agents.
- Preserve mouse text selections during fast streamed Markdown updates and defer code-copy controls until the selection is released.

## v1.0.0-pre.1
### Features
- Add a session-scoped Cron Job page with create, list, refresh, and delete controls, recurring and one-shot schedules, next/last-run metadata, validation, and a live sidebar count.
- Add an opt-in Loop switch to the composer. Enabled requests receive a goal-intake reminder so the main model creates a checkable goal before entering the loop state machine.
- Turn the send action into a real-time Guide action while the model is working, inserting the user's guidance into the visible transcript immediately instead of leaving it in the normal prompt queue.
- Add file-workflow shortcuts: reveal files and folders in the native file manager, refresh previews manually, jump from a changed-file card to Preview, and automatically refresh the active preview after Edit or Write changes that file.
- Add a deterministic native SEA build pipeline for the bundled Nori server, including bundle, blob, injection, signing, verification, packaging, and smoke-test stages.

### Fixes
- Open files and folders from Nori Work through Electron's native shell so the file manager is brought forward instead of being launched by the background server.
- Detect and replace a same-version background server when it lacks desktop-required routes, preventing a stale daemon from disabling Cron Jobs after an updated build.
- Move website permission requests out of the browser header and into the existing permission dock above the chat composer, including the same AUTO/YOLO switching actions used by ordinary tool approvals.
- Highlight Cron Job navigation in yellow and show the current session's scheduled-job count, updating immediately after create/delete and periodically in the background.
- Keep the shared background server alive only while clients are connected, then retain the existing 60-second idle shutdown grace after Nori Work closes.
- Keep terminal startup from stealing focus after the user has returned to the chat composer, while still focusing a newly opened terminal when appropriate.
- Preserve the current chat/composer focus while an Agent activates tabs or sends input to the built-in browser, without overriding a later focus change made by the user.
- Preserve the original new-task flow: opening a blank task does not create a session or lock a project, and the project picker appears only when the first message needs a session.
- Keep the same composer DOM node after rewind so Windows/Electron input methods can immediately edit the restored prompt without requiring a window focus cycle.
- Send live guidance through the supported Prompt collection action endpoint instead of the malformed double-colon URL that returned `unsupported action: prompts.steer`.
- Serialize close, archive, delete, reload, and resume operations for the same session so overlapping lifecycle requests cannot leave stale active-session state.
- Accept both supported provider-auth status response shapes when detecting configured credentials.
- Add direct regression coverage for main-model AgentSwarm projection: project/session grouping, internal Agent cards, Markdown output, terminal states, and nested child Swarms all render without leaking subagent transcripts into chat.

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
