Before the final user message, briefly evaluate whether this goal produced obsolete, temporary, or incorrect notes in shared memory.

- If cleanup is warranted: use `nori_memory_search` to locate them, then `nori_memory_remove` for notes that should be deleted, or `nori_memory_write` only when a correction is better than deletion.
- If nothing needs cleaning: skip memory tools entirely.
- Do not delete durable user knowledge. Never invent a cleanup pass when the vault is fine.
