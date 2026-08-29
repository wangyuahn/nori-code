# Built-in Tools

Built-in tools are the tool set provided by Nori Code CLI alongside its core engine — no MCP server installation required. The Agent automatically selects and calls these tools based on the task at hand during each conversation; users can inspect the details of each tool call through the approval interface.

Compared to MCP tools, built-in tools are managed directly by the runtime, their lifecycle is bound to the session, and no external process is required. Both follow the same unified approval mechanism: **read-only tools** (such as `Read`, `Grep`, `Glob`) are automatically allowed by default, while **write and execution tools** (such as `Write`, `Edit`, `Bash`) require user approval by default. Nori's session-level read-only setting blocks direct `Write` and `Edit` calls, but it does not remove file-reading tools or block `Bash`; `Bash` still follows the current permission mode and rules. In YOLO mode, approval for regular tool calls is skipped; Discuss exit approval is not affected.

## File Tools

File tools handle reading, writing, and searching the local filesystem — the foundation for code analysis and modification tasks.

| Tool | Default Approval | Description |
| --- | --- | --- |
| `Read` | Auto-allow | Read a text file's contents |
| `Write` | Requires approval | Create or overwrite a file |
| `Edit` | Requires approval | Hash-anchored line editing |
| `Grep` | Auto-allow | Full-text search powered by ripgrep |
| `Glob` | Auto-allow | Find files by glob pattern |
| `ReadMediaFile` | Auto-allow | Read an image or video file |

**`Read`** accepts a file path (`path`) plus optional `line_offset` (starting line number; negative values count from the end) and `n_lines` (maximum number of lines to read). Returns at most 1000 lines or 100 KB per call; content beyond that limit is accompanied by a truncation notice. Text output starts with `[path#TAG]`, where `TAG` is the four-hex snapshot anchor required by `Edit`. If the file is an image or video, the tool suggests using `ReadMediaFile` instead.

**`Write`** accepts `path`, `content`, and an optional `mode` (`overwrite` or `append`; defaults to overwrite). Missing parent directories are created automatically; `append` mode appends content to the end of the file without automatically adding a newline.

**`Edit`** accepts `path`, `expected_tag` (the latest four-hex tag returned by `Read`), and a non-empty `line_ops` array. Operations use line numbers from that tagged snapshot: `swap` replaces an inclusive range, `del` deletes one, and `insert_pre` / `insert_post` insert around an original line. The full operation list is validated before one write; a stale tag or invalid/overlapping range fails without modifying the file.

**`Grep`** invokes ripgrep to search file contents, supporting regular expressions (`pattern`), a search path (`path`), file type filtering (`type`, e.g., `ts`, `py`), glob filtering (`glob`), and output mode (`output_mode`: `files_with_matches` / `content` / `count_matches`; defaults to `files_with_matches`). `content` mode supports context lines (`-A`, `-B`, `-C`), case-insensitive matching (`-i`), line numbers (`-n`, default true), and multiline matching (`multiline`). All modes support `offset` + `head_limit` pagination; `head_limit` defaults to 250 and `0` means unlimited. Sensitive files such as `.env` files and private keys are automatically filtered out; set `include_ignored=true` to search files ignored by `.gitignore`, though sensitive files remain filtered.

**`Glob`** matches files in a specified directory (`path`; defaults to the working directory) by glob pattern (`pattern`). Results are sorted by modification time in descending order, with a maximum of 100 entries. It respects `.gitignore`, `.ignore`, and `.rgignore` by default; set `include_ignored=true` to include ignored files such as build outputs, while sensitive files remain filtered. Brace patterns such as `*.{ts,tsx}` are supported, and broad wildcard patterns are allowed but usually truncate at the match cap.

**`ReadMediaFile`** sends an image or video to the model as multimodal content. Accepts only `path`; the file size limit is 100 MB. Availability depends on the current model's vision capabilities (`image_in` / `video_in`).

## Shell

| Tool | Default Approval | Description |
| --- | --- | --- |
| `Bash` | Requires approval | Execute a shell command |

**`Bash`** is the most permission-demanding tool and also the most general-purpose. Parameters:

- `command` (required): the shell command to execute
- `cwd`: working directory
- `timeout`: timeout in milliseconds; foreground default is 60 seconds, maximum is 5 minutes
- `run_in_background`: whether to run as a background task; background tasks default to a 10-minute timeout
- `description`: background task description; required when `run_in_background=true`
- `disable_timeout`: whether to remove the timeout limit for background tasks

Foreground mode blocks the current turn until the command completes or times out, and the TUI streams stdout and stderr into the running `Bash` tool card while the command is still active. Background mode returns a task ID immediately and automatically notifies the Agent when the task finishes. stdin is always closed — interactive commands receive EOF immediately. A two-phase termination strategy (SIGTERM → 5-second grace period → SIGKILL) ensures reliable process cleanup after a timeout. On Windows, Git Bash is used by default.

In the default Nori read-only posture, the main Agent can still use `Bash` for bounded inspection and verification, such as `git status`, `pnpm test`, or `date`. Commands that mutate files or external state should still be treated as higher risk and approved under the normal permission flow.

## Web Tools

| Tool | Default Approval | Description |
| --- | --- | --- |
| `WebSearch` | Auto-allow | Web search |
| `FetchURL` | Auto-allow | Fetch the content of a specified URL |

**`WebSearch`** accepts `query` (search terms). Requires the host to provide a search implementation; when not injected, the tool does not appear in the tool list.

**`FetchURL`** accepts a single `url` parameter and returns the page content. For HTML pages, the host extracts the body text rather than returning the full HTML; plain text or Markdown pages are passed through directly. Also requires a host-provided implementation.

## Discuss

| Tool | Default Approval | Description |
| --- | --- | --- |
| `TeamDecide` | Main agent | Enter Discuss with `action=start`; continue with `action=continue` |

Discuss is a read-only team meeting. New sessions start here unless the user turned that default off. While Discuss is active, `Write`, `Edit`, `Bash`, `SubAgent`, `TaskStop`, `CronCreate`, and `CronDelete` are blocked. There is no session-file workflow and no `ExitDiscussMode` model exit.

**`TeamDecide`** uses `action=start` with a topic and opening statement to enter Discuss, then `action=continue` with a new statement for later rounds. Members use `TeamSpeak`; no call records a skipped turn. Use `TeamAssign` to enter Code. The UI Discuss/Code toggle can also leave or re-enter this stage.

## State Management

| Tool | Default Approval | Description |
| --- | --- | --- |
| `TodoList` | Auto-allow | Manage a task to-do list |

**`TodoList`** maintains a visible subtask list across multi-step operations; state is stored within the Agent session. The `todos` parameter accepts an array where each item has a `title` and `status` (`pending` / `in_progress` / `done`). Omitting `todos` queries the current list; passing an empty array clears it.

## Collaboration Tools

Collaboration tools handle inter-Agent coordination, user interaction, and Skill invocation.

| Tool | Default Approval | Description |
| --- | --- | --- |
| `SubAgent` | Auto-allow in SubAgent mode; otherwise requires approval | Launch one or many temporary SubAgents |
| `TeamCreate` | Auto-allow | Create durable team partners |
| `TeamDecide` | Auto-allow | Start/continue discussion, or vote after execution |
| `TeamSpeak` | Auto-allow | Publish a discussion statement; not calling it records the turn as skipped (abstention) |
| `TeamAssign` | Auto-allow | Assign work; success leaves Discuss and enters Code |
| `TeamDismiss` | Auto-allow | Dismiss department members and delete their mounted child sessions |
| `AskUserQuestion` | Auto-allow | Ask the user a question to gather structured input |
| `Skill` | Auto-allow | Invoke a registered inline Skill |

**`SubAgent`** is the unified temporary-delegation tool. Launch one or many full child transcripts with `prompt_template` + `items`, `tasks` (including `depends_on` DAGs), or `resume_agent_ids`. Completed SubAgents are archived in the parent session. If a model response calls `SubAgent`, that call must be the only tool call in the response. Do not use SubAgent during Discuss; call TeamAssign first.

**`TeamCreate`** requires a unique `name`, `role`, and `mandate` for every member. Each hire creates a real child session mounted under the caller (visible on the conversation map). **`TeamDismiss`** removes members from the department and deletes those child sessions; provide `reason`, and use `confirm_active=true` only after accepting interruption of active work. **`TeamDecide`** `action=start` requires `topic` and the lead `statement`. Members publish only with `TeamSpeak`. After execution, `action=vote` does not require Discuss; every team member votes (`discuss_again` / `proceed` / `abstain`), including members left idle with `task=null`.

Session mount changes refresh **`<session_self>`** in each affected session's system prompt and may inject **`<session_mount_changed>`** on the next turn. This is identity and topology only — not transcript sharing. See [Team engineering](../guides/team-engineering.md#identity-session_self-and-mount-changes).

**`AskUserQuestion`** asks the user a structured multiple-choice question — useful for disambiguation or option selection. The `questions` parameter accepts 1–4 questions; each question requires `question` (ending with `?`), `options` (2–4 choices, each with a `label` and `description`), and optional `header` (max 12 characters) and `multi_select` (defaults to false). An "Other" option is appended automatically. Setting `background` to true starts a background question task and returns a task ID immediately. When the host does not support interactive questioning, a failure message is returned and the Agent should ask the user directly in a text reply instead.

**`Skill`** allows the Agent to actively invoke a registered inline-type Skill. Accepts `skill` (the Skill name) and optional `args` (additional argument text). Only `type = "inline"` Skills can be called via this tool; Skills with `disableModelInvocation: true` are rejected. Maximum nesting depth is 3 levels. See [Agent Skills](../customization/skills.md) for details.

## Nori Tools

Nori-specific tools extend the built-in tool set with shared memory, documentation writes, and configured DAG templates. They appear only when the matching provider or runtime feature is available.

| Tool | Default Approval | Description |
| --- | --- | --- |
| `nori_memory_search` | Follows permission rules | Search the Obsidian shared memory vault |
| `nori_memory_write` | Follows permission rules | Write analysis, decision, task, or review notes to the vault |
| `nori_ask_parent` | Subagent only | Let a subagent ask its parent Agent for guidance |

**`nori_memory_search`** accepts concrete `keywords`, optional `note_types`, `top_k`, `include_linked`, `link_depth`, `chain_depth`, and `follow_up_keywords`. Use chained retrieval (`chain_depth: 1` or `2`) when the first results reveal better terms or linked notes.

**`nori_memory_write`** records structured notes in the shared vault. Use it for durable task progress, architecture analysis, review findings, and decisions that future turns or subagents should retrieve.


## Background Tasks

Background task tools manage tasks started via `Bash`, `SubAgent`, or `AskUserQuestion`. When a task reaches a terminal state, its status and saved output path are automatically delivered back to the Agent; use `TaskOutput` to check progress early.

| Tool | Default Approval | Description |
| --- | --- | --- |
| `TaskList` | Auto-allow | List background tasks |
| `TaskOutput` | Auto-allow | View the output of a background task |
| `TaskStop` | Requires approval | Stop a running background task |

**`TaskList`** returns the list of background tasks. Optional parameters: `active_only` (defaults to true; lists only running tasks) and `limit` (defaults to 20; range 1–100).

**`TaskOutput`** returns the status and output of a task given its `task_id`. The inline preview includes at most the most recent 32 KB of content; the full log is saved to disk, and the tool also returns an `output_path` with a suggestion to use `Read` for paginated access. Optional `block` (defaults to false) and `timeout` (seconds to wait; defaults to 30; range 0–3600) parameters allow waiting for the task to complete before returning.

**`TaskStop`** accepts a `task_id` and optional `reason` (defaults to `Stopped by TaskStop`). Safe to call on tasks that are already in a terminal state.

## Scheduled Tasks

Scheduled task tools allow the Agent to re-inject a prompt into the current session at a future time — either as a one-time reminder or as a recurring cron-triggered task (periodic checks, daily reports, deployment monitoring, etc.). Schedules are bound to the session and remain active after `nori --continue`, but are not carried into a brand-new session. A single session can hold at most 50 active scheduled tasks. Set `NORI_DISABLE_CRON=1` to disable them entirely; see [Environment Variables](../configuration/env-vars.md#runtime-switches).

| Tool | Default Approval | Description |
| --- | --- | --- |
| `CronCreate` | Requires approval | Schedule a prompt to fire at a future time |
| `CronList` | Auto-allow | List scheduled tasks |
| `CronDelete` | Requires approval | Cancel a scheduled task |

**`CronCreate`** accepts `cron` (a standard 5-field cron expression in the user's local timezone: `minute hour day-of-month month day-of-week`), `prompt` (the text to inject when triggered; UTF-8 limit 8 KB), and optional `recurring` (defaults to `true`; pass `false` for a one-time reminder that auto-deletes after firing). On success, returns an 8-hex-digit `id`, a human-readable `humanSchedule` (e.g., `every 5 minutes`), and `nextFireAt` (the ISO timestamp of the next fire time).

To prevent all users from firing at the same time on the hour, the scheduler applies deterministic jitter: recurring tasks are shifted forward by `min(10% of the period, 15 minutes)`; one-time tasks that fall exactly on `:00` or `:30` are moved forward by up to 90 seconds. If the scheduler misses several fire times (e.g., because the laptop was sleeping), it fires only once on wake-up — the prompt is wrapped in a `<cron-fire>` envelope with a `coalescedCount`. Recurring tasks that have been alive for more than 7 days fire one final time with `stale="true"` and are then automatically deleted; call `CronCreate` again to keep them.

**`CronList`** is a read-only tool that accepts no parameters. It returns one record per active task with fields: `id`, `cron`, `humanSchedule`, `nextFireAt`, `recurring`, `ageDays`, and `stale`. Records are separated by `---` and sorted by schedule time.

**`CronDelete`** accepts a single `id`. For recurring tasks, all future fires stop immediately; for one-time tasks, the pending fire is cancelled. One-time tasks that have already fired are auto-deleted, so calling `CronDelete` on an already-fired one-time task returns `No cron job with id ...`. Deletion is irreversible — use `CronCreate` again to restore. `CronDelete` is also blocked in Discuss.

## Next steps

- [Agent & Sub-Agents](../customization/agents.md) — Scheduling mechanics and context isolation for the `Agent` tool
- [Hooks](../customization/hooks.md) — Trigger local scripts before and after tool calls
- [Slash Commands](./slash-commands.md) — Quick reference for TUI built-in control commands
