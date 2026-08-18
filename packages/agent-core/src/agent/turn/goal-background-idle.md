Background agents or tasks are still running. Goal mode suppressed an immediate continuation so the main model is not woken just to wait.

Reassess now:
- If background work may still be progressing, you may keep waiting (do not call UpdateGoal complete). Prefer TaskList / TaskOutput when you need a snapshot.
- If background work finished, failed, stalled, or needs intervention, act on it.
- Call UpdateGoal with `blocked` only when an external condition or missing user input truly prevents progress.
- Call UpdateGoal with `complete` only when the goal's required work and validation are done.
