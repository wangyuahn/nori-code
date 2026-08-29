# Team engineering

Nori Code CLI 2.0 treats a project as a **department tree** of real sessions, not a single chat transcript with side notes. Each hired partner owns its own session, Discuss rounds gather statements before execution, and a **conversation map** shows how sessions mount under one another. This page explains how those pieces fit together in the terminal and in Nori Work.

## Department tree vs SubAgent

Two collaboration models coexist:

- **Team partners** (`TeamCreate`) are **durable child sessions** mounted under a parent via `parent_session_id`. They keep their own transcript, Discuss/Assign workflow, and place on the conversation map until `TeamDismiss` deletes them.
- **SubAgents** (`SubAgent`) are **temporary delegates** archived inside the parent's session directory. They finish a bounded task and return a result; they are not map nodes and are not meant as long-lived departments.

The main Agent stays a **read-only coordinator** by default: direct `Write` / `Edit` are blocked (`/setting readonly on`), while hired members execute assigned tracks after `TeamAssign` leaves Discuss. Use `/setting readonly off` only when you want the lead to edit files directly.

## Discuss and Code

**Discuss** is a read-only team meeting. While it is active, `Write`, `Edit`, `Bash`, `SubAgent`, and several scheduling tools stay blocked until the team enters **Code**.

Typical flow:

1. **`TeamCreate`** — hire partners into your department (each becomes a mounted child session).
2. **`TeamDecide`** with `action=start` — open Discuss with a topic; members speak with **`TeamSpeak`** (skipping a turn records abstention).
3. **`TeamAssign`** — hand out concrete tasks; success **leaves Discuss** and enters Code so members can execute.
4. After work, **`TeamDecide`** with `action=vote` — the team votes (`discuss_again` / `proceed` / `abstain`) without re-entering full Discuss.

Toggle Discuss from the UI with **`Shift-Tab`**, **`/discuss`**, or the compatibility alias **`/plan`**. **`TeamAssign`** and the Discuss/Code toggle both leave Discuss; YOLO does not add a separate exit approval.

See [Interaction and input](./interaction.md#mode-switching) for approval behavior and [Built-in tools](../reference/tools.md#discuss) for tool-level detail.

## TeamCreate and TeamDismiss

| Tool | Role |
| --- | --- |
| `TeamCreate` | Hire one or more partners (`name`, `role`, `mandate` each). Creates mounted child sessions visible on the map. Respects `/team settings` max department depth. |
| `TeamDismiss` | Remove partners from your department and **delete** their mounted child sessions. Requires a `reason`. If a member is still working, call with `confirm_active=false` first; retry with `confirm_active=true` only after you accept the interruption. |

`TeamDismiss` is the supported way to remove a hired partner. Unmounting via `/map` detaches the session from the tree but **does not** delete the child session.

## Conversation map (session mounts)

The **conversation map** is the forest of sessions linked by **`parent_session_id`** metadata (plus optional `mount_role` / `mount_mandate`). Operations:

- **Mount** — attach session B under session A.
- **Unmount** — remove B's parent link (session data remains).
- **Remount** — change B's parent when it already has one.

### Terminal: `/map`

Type **`/map`** to browse the mount forest for the current working directory:

- **Enter** — open the highlighted session (switches the TUI to that session).
- **M** — start mount: pick the child row, then pick the parent row; optional role/mandate prompts follow.
- **U** — unmount the highlighted session when it has a parent.
- Type to search; **Esc** cancels.

`/map` manages **session mounts**. **`/team`** manages **department membership** (open a partner's session, browse reports, read this-round Discuss speech).

### Web: Map view

In Nori Work / the Web UI, open the sidebar **Map** entry (conversation map). The canvas shows the same mount forest: pan/zoom the tree, open a session into Chat, create a child under a parent, mount or remount with role/mandate, and add local labels or annotation boxes (map-only chrome — not sent to the model).

Use **`/web`** from the TUI to hand off the current session to the browser workspace when you want the map on a large screen.

## Identity: `<session_self>` and mount changes

Team identity is **not** injected by copying another session's transcript or by a legacy summary tool. Instead:

- **`<session_self>`** — rendered into each session's system prompt from current mount metadata: session id, title, depth, parent, role, mandate, and direct members.
- **`<session_mount_changed>`** — injected on the next turn for affected sessions when a mount, unmount, remount, or parent deletion occurs (`event.session.mount_changed`).

After mount metadata changes, the runtime refreshes `<session_self>` so every partner knows where it sits in the tree. This is identity and topology only — not shared chat history.

## Terminal panes: `/team` and `Ctrl-Y`

- **`/team`** (alias **`/agents`**) — searchable department browser. **Enter** opens the selected partner's session (messages and input follow that member). **Main** returns to the lead session. **Tab** shows member details. A discussion row opens the Discuss pane. **`/team settings`** sets max department depth.
- **`Ctrl-Y`** — show or hide the bottom **Discuss / Chat** pane. While Discuss is on, the pane is a read-only meeting track; otherwise it shows department Chat. Hiding the pane does not leave Discuss or exit the member session you opened.

See [Keyboard shortcuts](../reference/keyboard.md#team-pane) for the full key reference.

## Working across terminal and desktop

When Nori server or Nori Work already holds the home-directory lock, the TUI may warn that it runs an **in-process core** against the same storage. Avoid editing the **same session** simultaneously in the terminal and in Nori Work — mount changes and transcripts can race.

## Next steps

- [Slash commands](../reference/slash-commands.md) — `/team`, `/map`, `/discuss`, `/web`
- [Built-in tools](../reference/tools.md#collaboration-tools) — `TeamCreate`, `TeamAssign`, `TeamDismiss`, and related tools
- [Agents and sub-agents](../customization/agents.md) — read-only main Agent and SubAgent delegation
- [Sessions and context](./sessions.md) — storage layout and session metadata
