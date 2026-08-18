Launch one or many temporary SubAgents as the unified delegation entrypoint.

Every task batch runs detached in the background with no execution deadline. The call returns immediately with a task id. Completion is inserted into the parent context automatically: active work is not interrupted, and an idle parent is woken to process the result. Use task output only when a live preview is explicitly needed; polling is not required for completion.

Use SubAgent for all delegated work, including a single implementation task, parallel review, and multi-step coding loops. Each SubAgent is a full child transcript in this parent session. After it finishes, it is archived so you can reopen it; it does not stay on the live team tree.

Each SubAgent receives its resolved execution profile and task prompt. Nori SubAgents also run a phase-0 memory retrieval step before the task prompt: they output `<retrieval_query>` keywords, the host injects `<retrieved_context>`, and the SubAgent may call `nori_memory_search`, `nori_ask_parent`, `SubAgent`, or other available tools again whenever it needs more context or follow-up work.

Bug hunts, failure diagnosis, regression investigations, code reviews, audits, and broad "find problems" requests are primary SubAgent use cases. After a brief bounded scan by the parent to identify likely files, commands, or subsystems, split the investigation into parallel tasks instead of doing one serial main-agent search. Useful task tracks include compile/typecheck, tests, runtime behavior, UI/rendering, permission/config, persistence/memory, and dead/duplicate code. If the scope is many files with the same checklist, use `prompt_template + items`; if the tracks differ or have follow-up dependencies, use `tasks`.

For uniform parallel work, pass `prompt_template` plus `items`. The placeholder is exactly `{{item}}`. For example, with `prompt_template` set to `Review {{item}} for likely regressions.` and `items` set to `["src/a.ts", "src/b.ts"]`, SubAgent launches two temporary workers with those concrete prompts.

For heterogeneous work, pass `tasks`: each task has a concrete `prompt`, optional `id`, optional `description`, optional per-task `subagent_type`, and optional `depends_on`. Tasks with no dependencies run concurrently. Tasks with `depends_on` wait until the referenced task ids complete successfully; their prompts receive a `<dependency_results>` block before the original prompt. If a dependency fails, downstream tasks are reported as not-started failures instead of silently running with missing context.

Each of these is enforced before any SubAgent starts: provide at least one `item` or `task`; whenever `items` are present, `prompt_template` is required and must contain `{{item}}`; filled-in item prompts must be distinct; task ids must be unique; task dependencies must reference existing task ids and may not point to the same task.

Use enough SubAgents to keep the work focused and parallel. SubAgent supports up to 128 tasks, and launches are queued automatically, so it is safe to split large tasks into many clear, independent items.

When a later step is needed after results return, call SubAgent again with a new `tasks` DAG.

If `SubAgent` is called, that call must be the only tool call in the response. Do not use this tool during Discuss; TeamAssign first.
