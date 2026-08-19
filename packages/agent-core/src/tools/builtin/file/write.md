Create, append to, or replace a file entirely.

- Missing parent directories are created automatically (like `mkdir(parents=True, exist_ok=True)`).
- Mode defaults to overwrite; append adds content at EOF without adding a newline.
- Write is NOT ALLOWED for incremental changes to existing files, including trivial, one-line, quick, or cosmetic edits. Use Edit instead.
- Use Write only when the file does not exist, you intend a complete replacement, or the new contents have little continuity with the old contents.
- Do not create unsolicited documentation files (`*.md` write-ups, `README`s, summaries) just because a task finished — write one only when the user asks for it, or when a task or project instruction requires it (for example a changeset the repo mandates).
- Read before overwriting an existing file.
- When overwriting or appending to an existing file, pass the four-hex `expected_tag` from the latest Read whenever one is available. A tag mismatch is a hard conflict; re-read instead of retrying blindly.
- Concurrent Write/Edit calls for one file are serialized. A queued overwrite fails with conflict details rather than replacing content written by another Agent; different files can still be written in parallel.
- Write ignores the Read/Edit line-number view. NEVER include line prefixes.
- Write outputs content literally, including supplied line endings: \n stays LF, \r\n stays CRLF.
- For new content too large for one call, overwrite the first chunk, then append subsequent chunks. Never chunk Write to modify an existing file.
