# Team engineering

Nori Code CLI 2.0 treats a project as a **department tree**, not a single chat transcript with side notes. `TeamCreate` hires by creating and resuming a **mounted child session** — the same card the conversation map shows. Work, tools, cwd, sibling chat, and identity live on that child session. Discuss rounds gather statements before execution. This page explains how those pieces fit together in the terminal and in Nori Work.

::: warning Note
Temporary `SubAgent` DAG orchestration was **removed** in v2.0. Team Engineering is the only way Nori hands work to another agent. Comparison with Codex / Claude Code, and an honest gap list (LSP and Git are still a rough shell), live in the GitHub [README](https://github.com/wangyuahn/nori-code/blob/master/README.md).
:::

## Department tree and the conversation map

There is one collaboration model, shown in two places:

- **Team partners** (`TeamCreate`) are **real child sessions** mounted under you. They appear as session cards on the conversation map. Discuss, Assign, sibling chat, and identity all address that session id until `TeamDismiss` removes them.
- **Map nodes** are the same class: **real child sessions** linked by `parent_session_id`. Creating or wiring a child on the Web Map canvas uses the same create-child + mount path as `TeamCreate`. A session can have only one parent (part-time / second-parent hire is not supported).

There is no second Team Agent identity in the parent session. Durable collaborators are Sessions only.

The main Agent stays a **read-only coordinator** by default: direct `Write` / `Edit` are blocked (`/setting readonly on`), while hired members execute assigned tracks after `TeamAssign` leaves Discuss. Use `/setting readonly off` only when you want the lead to edit files directly.

## Discuss and Code

**Discuss** is a read-only team meeting. While it is active, `Write`, `Edit`, `Bash`, `TaskStop`, `CronCreate`, and `CronDelete` stay blocked until the team enters **Code**.

Typical flow:

1. **`TeamCreate`** — hire partners into your department (each is a real child session on the map).
2. **`TeamDecide`** with `action=start` — open Discuss with a topic; members speak with **`TeamSpeak`** (skipping a turn records abstention).
3. **`TeamAssign`** — hand out concrete tasks; success **leaves Discuss** and enters Code so members can execute.
4. During Code, siblings coordinate with **`TeamChat`** and **`TeamDM`**. Reports (`completed` / `blocked` / `needs_decision`) go to the parent via `TeamDM`.
5. After work, **`TeamDecide`** with `action=vote` — the team votes (`discuss_again` / `proceed` / `abstain`) without re-entering full Discuss.

Discuss is **multi-round**. Each `TeamSpeak` is one short, decidable point — not a complete plan. Keep using `TeamDecide` with `action=continue` for the next slice. A skipped member is an abstention; later speakers still take their turn.

Toggle Discuss from the UI with **`Shift-Tab`**, **`/discuss`**, or the compatibility alias **`/plan`**. **`TeamAssign`** and the Discuss/Code toggle both leave Discuss; YOLO does not add a separate exit approval.

See [Interaction and input](./interaction.md#mode-switching) for approval behavior and [Built-in tools](../reference/tools.md#discuss) for tool-level detail.

## TeamCreate and TeamDismiss

| Tool | Role |
| --- | --- |
| `TeamCreate` | Hire one or more partners (`name`, `role`, `mandate` each). Creates and resumes a mounted child session (a session card on the map). Discuss/Assign/Chat address that session id. Respects `/team settings` max department depth. |
| `TeamDismiss` | Remove partners from your department. Dismissing deletes that child session. Requires a `reason`. If a member is still working, call with `confirm_active=false` first; retry with `confirm_active=true` only after you accept the interruption. |
| `TeamUpdate` | Update name, role, mandate, or tags for this session or a member. Related sessions receive a system reminder and do not start a turn. |

`TeamDismiss` is the supported way to remove a hired partner. Unmounting via `/map` detaches the session from the tree but **does not** delete the child session.

## TeamChat, TeamDM, and other channels

Recipients are session ids or display names (aliases such as `agent-1` and `parent` also resolve). In Nori Work the inspector **Meeting** and **Chat** tabs are always visible.

| Tool | Role |
| --- | --- |
| `TeamChat` | Persistent **group chat among siblings**. The parent does **not** read it. Every message must start with `@all` or `@session-id` (also pass `mentions`); only mentioned members are interrupted. This is the working channel during Code. Send the parent final status with `TeamDM`. |
| `TeamDM` | Private message to a parent, sibling, or a member you hired. Task reports set `report_status` to `completed` / `blocked` / `needs_decision` plus `report_summary` — reports always go to the parent. Ordinary DMs are not reports. Formal Discuss turns use `TeamSpeak` only. |
| `TeamBroadcast` | Wake every member of your department with the same prompt, in parallel. Members actually run a turn. |
| `TeamStatus` | `members` you hired plus `colleagues` (peers): role, idle/running, assigned task, whether they have reported. Leave a `running` peer to finish. |
| `TeamDiscussInvite` / `TeamDiscussKick` | Add or drop participants in the active Discuss without dismissing them. |
| `SessionSearch` / `SessionGraph` / `SessionMount` / `SessionUnmount` | Find, read, attach, or detach sessions on the same forest as the map. Unmount detaches; `TeamDismiss` deletes. |

See [Built-in tools](../reference/tools.md#collaboration-tools) for parameters. GitHub [README](https://github.com/wangyuahn/nori-code/blob/master/README.md#team-tools) has the same catalog.

## Conversation map (session mounts)

The **conversation map** is the forest of sessions linked by **`parent_session_id`** metadata (plus optional `mount_role` / `mount_mandate`). Operations:

- **Mount** — attach session B under session A.
- **Unmount** — remove B's parent link (session data remains).
- **Remount** — change B's parent when it already has one (replaces the parent; does not add a second job).

Shift+drag from an **output** port creates a **peer** link and Alt+drag from an output port creates a **service** link: stored on the local map only, not a mount. Click the dashed wire to remove it. Input-port drags always remount (Shift/Alt do not change that).

### Terminal: `/map`

Type **`/map`** to browse the mount forest for the current working directory:

- **Enter** — open the highlighted session (switches the TUI to that session).
- **M** — start mount: pick the child row, then pick the parent row; optional role/mandate prompts follow.
- **U** — unmount the highlighted session when it has a parent.
- Type to search; **Esc** cancels.

`/map` and **`/team`** show the **same Session forest**. `/team` is the department browser (open a partner's session, browse reports, read this-round Discuss speech); `/map` is the spatial view of those same sessions.

### Web: Map view

In Nori Work / the Web UI, open the sidebar **Map** entry (conversation map). The canvas is a session console, not a static blueprint: pan/zoom the tree, read each card's running state, open a session into Chat, create a child under a parent, stop a running turn, edit name/mandate/tags, mount or remount with role/mandate, and add local labels or annotation boxes (map-only chrome — not sent to the model).

Blueprint gestures:

- **Right-click empty canvas** — create a top-level session there; **right-drag** — pan.
- **Drag an output port onto a card** — silent mount; drop on empty canvas — identity draft then `createChild`.
- **Drag an input port onto another card** — remount. If the child already has a parent, confirm: this remounts, it does not add a second job.
- **Alt+click a card (or its input port)** — unmount to top-level. Right-click a card to end its work without disconnecting. Mount/unmount on a busy session queues until idle.
- **Box-select** — a toolbar appears for Open, Stop, Settings, Unmount, and Delete. Right-click the selection for the same batch actions.
- **Label filters** apply to both the list and the canvas. Every visible card is a real session and can be boxed or wired.

Use **`/web`** from the TUI to hand off the current session to the browser workspace when you want the map on a large screen.

## Identity: `<session_self>` and mount changes

Team identity is **not** injected by copying another session's transcript or by a legacy summary tool. Instead:

- **`<session_self>`** — rendered into each session's system prompt from current mount metadata: session id, title, depth, parent, role, mandate, tags, and direct members.
- **`<session_mount_changed>`** — injected on the next turn for affected sessions when a mount, unmount, remount, or parent deletion occurs (`event.session.mount_changed`).
- **`<session_identity_changed>`** — injected when name, role, mandate, or tags change. Related sessions are notified and **do not start a turn**.

After mount metadata changes, the runtime refreshes `<session_self>` so every partner knows where it sits in the tree. This is identity and topology only — not shared chat history.

## Terminal panes: `/team` and `Ctrl-Y`

- **`/team`** (alias **`/agents`**) — searchable department browser. **Enter** opens the selected partner's session (messages and input follow that member). **Main** stays on this session. **Tab** shows member details. A discussion row opens the Discuss pane. **`/team settings`** sets max department depth.
- **`Ctrl-Y`** — show or hide the bottom **Discuss / Chat** pane on the **current** session. Department Chat and Discuss live on the lead session. While Discuss is on, the pane is a read-only meeting track; otherwise it shows department Chat. Hiding the pane does not leave Discuss or switch sessions. On a mounted child with no department of its own, the pane says Chat lives on the parent — open that session from `/map` or `/team`.

See [Keyboard shortcuts](../reference/keyboard.md#team-pane) for the full key reference.

## Working across terminal and desktop

When Nori server or Nori Work already holds the home-directory lock, the TUI may warn that it runs an **in-process core** against the same storage. Avoid editing the **same session** simultaneously in the terminal and in Nori Work — mount changes and transcripts can race.

## Next steps

- [Slash commands](../reference/slash-commands.md) — `/team`, `/map`, `/discuss`, `/web`
- [Built-in tools](../reference/tools.md#collaboration-tools) — `TeamCreate`, `TeamChat`, `TeamDM`, `TeamAssign`, `TeamDismiss`, and related tools
- [Sessions and context](./sessions.md) — storage layout and session metadata
- GitHub [README](https://github.com/wangyuahn/nori-code/blob/master/README.md) — what Nori is now vs Codex / Claude Code, including gaps
