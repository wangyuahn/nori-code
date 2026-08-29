# Migrating from kimi-cli

Nori Code is a fork of Kimi Code with its own CLI (`nori`), data root (`~/.nori-code`), and 2.0 **team engineering** model. This page covers two upgrades: moving from a single-agent / in-session Team mental model to durable department sessions and a conversation map, and (for older installs) how legacy kimi-cli data relates to Nori's home directory.

## Upgrading to 2.0 (team engineering)

Nori Code **1.x** already used SubAgents and collaboration tools inside a session. **2.0** adds a department tree of **real child sessions** and a **conversation map**. Existing session transcripts under `~/.nori-code/sessions/` keep working; you do not need a separate data-format migration for the map. What changes is how team work is modeled and how you navigate it.

### Mental model

| 1.x habit | 2.0 behavior |
| --- | --- |
| Treat Team partners as side roles inside one chat | `TeamCreate` hires **mounted child sessions** linked by `parent_session_id` (visible on the map) |
| Expect partners to share the lead's transcript | Identity comes from **`<session_self>`** and mount-change notices — **not** transcript copying |
| Use one slash command for “the team UI” | **`/team`** manages department membership (open a partner session, reports, Discuss speech); **`/map`** manages session mounts |
| Unmount / dismiss interchangeably | **`TeamDismiss`** removes partners and **deletes** their child sessions; **`/map` unmount** only clears the parent link |
| Assume the main Agent writes code freely | Main Agent stays a **read-only coordinator** by default (`Write` / `Edit` blocked); members execute after `TeamAssign`. Use `/setting readonly off` only when the lead should edit |

Typical 2.0 flow: `TeamCreate` → Discuss (`TeamDecide` / `TeamSpeak`) → `TeamAssign` (enters Code) → members work and report. Details: [Team engineering](./team-engineering.md).

### Commands and surfaces to learn

- **`/team`** (alias **`/agents`**) — browse and open hired partners; `/team settings` sets max department depth
- **`/map`** — browse the mount forest; Enter opens a session; **M** mount; **U** unmount
- **Nori Work / Web Map** — same forest with pan/zoom and local annotations (not sent to the model)
- **`Ctrl-Y`** — show or hide the Discuss / Chat pane while `/team` has opened a member session

### What does not change

- Temporary **`SubAgent`** delegates remain for bounded tasks archived under the parent session — they are not map nodes
- Discuss / Code toggling (`Shift-Tab`, `/discuss`, `/plan`) still applies; `TeamAssign` leaves Discuss on success
- Config and sessions already under `~/.nori-code/` (or `$NORI_CODE_HOME`) continue to load after upgrade

::: tip Note
Avoid editing the **same session** simultaneously in the TUI and in Nori Work when both share the home-directory lock — mount metadata and transcripts can race. See [Team engineering](./team-engineering.md#working-across-terminal-and-desktop).
:::

## Legacy kimi-cli data

Older **kimi-cli** (Python/uv) installs kept data under `~/.kimi/`. Nori Code stores runtime data under **`~/.nori-code/`** (override with **`NORI_CODE_HOME`**). The two trees do not overwrite each other.

The monorepo still contains the private `@nori-code/migration-legacy` helpers that can copy config, MCP declarations, input history, skills, and chosen sessions from a legacy kimi-cli home into the Nori data root **without deleting** the source. The current `nori` CLI **does not** register an interactive `migrate` subcommand, so there is no supported one-shot `nori migrate` / `kimi migrate` entrypoint in this tree.

If you still need legacy kimi-cli settings:

1. Install Nori Code (`npm install -g nori-code`) and run `nori`.
2. Re-enter providers with `/login` or `/provider` — OAuth and MCP authorizations are not assumed to carry over from kimi-cli.
3. Re-add MCP servers and Skills under `~/.nori-code/` as needed (see [MCP](../customization/mcp.md) and [Agent Skills](../customization/skills.md)).
4. Treat chat history as optional; start a fresh session unless you already imported sessions under a previous tooling path.

::: tip Note
Nori never modifies or deletes `~/.kimi/` as part of normal CLI startup. Keep the old install until you no longer need it.
:::

## Next steps

- [Team engineering](./team-engineering.md) — department tree, Discuss/Assign, `/team` and `/map`
- [Getting started](./getting-started.md) — install `nori` and first launch
- [Sessions and context](./sessions.md) — mount metadata on `state.json`
- [Data locations](../configuration/data-locations.md) — `~/.nori-code` layout
