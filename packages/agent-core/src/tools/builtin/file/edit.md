Apply hash-anchored line operations to an existing text file.

Edit accepts `path`, `expected_tag`, and `line_ops`.

## Required workflow

1. Read the target file immediately before editing it.
2. Copy the four-hex TAG from Read's first line: `[path#TAG]`.
3. Use that TAG as `expected_tag`. All line numbers refer to that tagged Read snapshot.
4. Keep every range as small as possible and include only changed final content.
5. After Edit succeeds, use the new `[path#TAG]` returned by Edit for the next edit, or Read again.

Do not call Edit from memory, stale context, guessed line numbers, or a TAG from an older Edit.
A TAG mismatch is a hard conflict: re-read and rebuild the operations instead of retrying blindly.

## Operations

- `swap`: replace original lines `start..end`, inclusive, with `content`.
- `del`: delete original lines `start..end`, inclusive.
- `insert_pre`: insert `content` immediately before original `line`.
- `insert_post`: insert `content` immediately after original `line`.

Every operation in one call uses coordinates from the same original Read output. Edit preflights
the complete list and writes once; overlapping replacement/deletion ranges are rejected.

`content` is the final text to write:

- Use LF between multiple lines.
- Do not include line-number prefixes.
- Do not include unchanged context lines.
- Do not include `-old` deletion lines. Use `del` instead.
- For a pure insertion, use `insert_pre` or `insert_post`; do not widen a `swap` and retype unchanged lines.
- For pure CRLF files, Read shows LF and Edit preserves CRLF on disk.
- For mixed line endings, preserve explicit `\r` characters shown by Read in affected replacement content.

## Example

After Read returns `[src/greet.ts#A1B2]`:

```json
{
  "path": "src/greet.ts",
  "expected_tag": "A1B2",
  "line_ops": [
    { "op": "insert_pre", "line": 2, "content": "const greeting = 'Hi';" },
    { "op": "swap", "start": 2, "end": 2, "content": "return greeting + ', ' + name;" },
    { "op": "del", "start": 4, "end": 4 }
  ]
}
```

## Wrong patterns

- WRONG: empty `line_ops`. RIGHT: provide at least one concrete operation.
- WRONG: use post-edit line numbers for later operations in the same call. RIGHT: every coordinate comes from the original tagged Read.
- WRONG: represent deletion with empty replacement content. RIGHT: use `del`.
- WRONG: include unchanged lines around a swap. RIGHT: swap only the exact changed range.
- WRONG: reuse the old TAG after a successful Edit. RIGHT: use Edit's returned TAG or Read again.

Edit is mandatory for incremental changes. Do not use Write or Bash `sed` to bypass this contract.
Multiple Edit calls may run in one response only when they target different files.
