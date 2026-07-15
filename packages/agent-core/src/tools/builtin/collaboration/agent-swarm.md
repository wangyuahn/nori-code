Launch one or many subagents as the unified swarm orchestration entrypoint.

Every swarm runs as a detached background task with no execution deadline. The call returns immediately with a task id. Completion is inserted into the parent context automatically: active work is not interrupted, and an idle parent is woken to process the result. Use task output only when a live preview is explicitly needed; polling is not required for completion.

Use AgentSwarm for all delegated subagent work, including single implementation tasks, parallel review, and multi-step coding loops. The older Agent tool is only a legacy fallback.

Each spawned subagent receives its resolved profile prompt and tool APIs. Nori subagents also run a phase-0 memory retrieval step before the task prompt: they output `<retrieval_query>` keywords, the host injects `<retrieved_context>`, and the subagent may call `nori_memory_search`, `nori_ask_parent`, `AgentSwarm`, or other available tools again whenever it needs more context or follow-up work.

Bug hunts, failure diagnosis, regression investigations, code reviews, audits, and broad "find problems" requests are primary AgentSwarm use cases. After a brief bounded scan by the parent to identify likely files, commands, or subsystems, split the investigation into parallel tasks instead of doing one serial main-agent search. Useful task tracks include compile/typecheck, tests, runtime behavior, UI/rendering, permission/config, persistence/memory, and dead/duplicate code. If the scope is many files with the same checklist, use `prompt_template + items`; if the tracks differ or have follow-up dependencies, use `tasks`.

For uniform parallel work, pass `prompt_template` plus `items`. The placeholder is exactly `{{item}}`. For example, with `prompt_template` set to `Review {{item}} for likely regressions.` and `items` set to `["src/a.ts", "src/b.ts"]`, AgentSwarm launches two subagents with those concrete prompts.

For heterogeneous work, pass `tasks`: each task has a concrete `prompt`, optional `id`, optional `description`, optional per-task `subagent_type`, and optional `depends_on`. Tasks with no dependencies run concurrently. Tasks with `depends_on` wait until the referenced task ids complete successfully; their prompts receive a `<dependency_results>` block before the original prompt. If a dependency fails, downstream tasks are reported as not-started failures instead of silently running with missing context.

Use `resume_agent_ids` to continue subagents that already exist from earlier work, such as ones that failed or timed out: map each agent id to the prompt for that resumed subagent (usually `continue` if no extra information is needed). You may combine `resume_agent_ids` with `items` in the same call to resume existing subagents and launch new ones. Do not duplicate resumed work in `items`.

Each of these is enforced before any subagent starts: provide at least 1 `item`, `task`, or `resume_agent_ids` entry; whenever `items` are present, `prompt_template` is required and must contain `{{item}}`; filled-in item prompts must be distinct; task ids must be unique; task dependencies must reference existing task ids and may not point to the same task.

Use enough subagents to keep the work focused and parallel. AgentSwarm supports up to 128 subagents, and launches are queued automatically, so it is safe to split large tasks into many clear, independent items.

When a later step is needed after results return, call AgentSwarm again. For unfinished existing subagents, use `resume_agent_ids` with the returned `agent_id`; for new follow-up work, pass a new `tasks` DAG.

If `AgentSwarm` is called, that call must be the only tool call in the response.
