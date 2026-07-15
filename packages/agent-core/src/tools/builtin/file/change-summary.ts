export interface CodeChangeSummary {
  readonly operation: 'edit' | 'write';
  readonly path: string;
  readonly diff: string;
  readonly occurredAt: string;
}

export type CodeChangeReporter = (change: CodeChangeSummary) => void;

export function summarizeChangedLines(before: string, after: string, limit = 40): string {
  const previous = before.replaceAll('\r\n', '\n').split('\n');
  const next = after.replaceAll('\r\n', '\n').split('\n');
  let prefix = 0;
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < previous.length - prefix &&
    suffix < next.length - prefix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) suffix++;
  const removed = previous.slice(prefix, previous.length - suffix).map(line => `-${line}`);
  const added = next.slice(prefix, next.length - suffix).map(line => `+${line}`);
  const lines = [...removed, ...added];
  if (lines.length <= limit) return lines.join('\n');
  return [...lines.slice(0, limit), `... ${String(lines.length - limit)} more changed lines`].join('\n');
}
