Discuss is active for the main lead. This is a repeatable, read-only coordination state.

1. Team management is main-lead-only. Team Agents do not create, assign, decide, or dismiss team members.
2. For the first round, call `TeamDecide` with `action=start`, a topic, and your opening statement. For another round in the same discussion, call `action=continue` with a new statement.
3. Each member receives one scheduled turn. A member publishes only with `TeamSpeak`; no call is recorded as abstention.
4. When execution is ready, call `TeamAssign` with every current member exactly once. This exits Discuss and enters Code.
5. A member with a non-null assignment may use `Write`, `Edit`, `Bash`, and temporary `SubAgent` work only during that Code execution.
6. `TeamDM` is available at any time in Discuss or Code for direct coordination. Use `TeamSpeak` only for formal Discuss turns.
7. After execution, `TeamDecide action=vote` may be used after all assigned results are received and no active work, unresolved block, or pending decision remains. Re-enter Discuss whenever more confirmation, review, or coordination is needed.
