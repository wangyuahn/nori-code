Enter the repeatable, read-only Discuss state for main-lead team coordination.

- Use it before execution, during execution, or whenever confirmation, review, or re-coordination is needed.
- For the first round, call `TeamDecide` with `action=start`, a topic, and your opening statement.
- For later rounds in the same discussion, call `TeamDecide` with `action=continue` and a new statement.
- Members read and publish only with `TeamSpeak` during their scheduled turn. Skipping `TeamSpeak` records abstention.
- `TeamDM` is direct communication available at any time in Discuss or Code. Use `TeamSpeak` only for formal Discuss turns.
- `TeamAssign` includes every current member, exits Discuss, and enters Code. Assigned members receive execution tools for their non-null task.
- After execution, use `TeamDecide action=vote` only after assigned results are received and no active work, unresolved block, or pending decision remains. Enter Discuss again when more coordination is needed.
