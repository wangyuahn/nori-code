Launch one or more temporary SubAgents for bounded delegated work.

Each task receives its selected execution profile and prompt, runs independently, and reports a result back to the caller. A SubAgent is not a durable Team Agent and never creates another persistent team layer.

Use `prompt_template` with `items` for uniform tasks, or `tasks` for explicit tasks and dependencies. Provide at least one item or task and include concrete paths, symbols, and checks.

For a Team Agent, SubAgent is available only after `TeamAssign` enters Code and only for the assigned execution task. Do not use it during Discuss.
