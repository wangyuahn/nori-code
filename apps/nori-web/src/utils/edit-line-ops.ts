export type EditLineOperation =
  | { readonly op: 'swap'; readonly start: number; readonly end: number; readonly content: string }
  | { readonly op: 'del'; readonly start: number; readonly end: number }
  | { readonly op: 'insert_pre'; readonly line: number; readonly content: string }
  | { readonly op: 'insert_post'; readonly line: number; readonly content: string };

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

export function parseEditLineOperations(value: unknown): EditLineOperation[] {
  if (!Array.isArray(value)) return [];
  const operations: EditLineOperation[] = [];

  for (const candidate of value) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    const op = record['op'];
    if (op === 'swap' || op === 'del') {
      const start = positiveInteger(record['start']);
      const end = positiveInteger(record['end']);
      if (start === undefined || end === undefined || end < start) continue;
      if (op === 'swap') {
        if (typeof record['content'] !== 'string') continue;
        operations.push({ op, start, end, content: record['content'] });
      } else {
        operations.push({ op, start, end });
      }
      continue;
    }
    if (op === 'insert_pre' || op === 'insert_post') {
      const line = positiveInteger(record['line']);
      if (line === undefined || typeof record['content'] !== 'string') continue;
      operations.push({ op, line, content: record['content'] });
    }
  }

  return operations;
}

export function contentLineCount(content: string): number {
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  return lines.length;
}

export function editLineOperationStats(value: unknown): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const operation of parseEditLineOperations(value)) {
    if (operation.op === 'swap' || operation.op === 'del') {
      deletions += operation.end - operation.start + 1;
    }
    if (operation.op !== 'del') additions += contentLineCount(operation.content);
  }
  return { additions, deletions };
}

export function editLineOperationsDiff(value: unknown): string[] {
  const lines: string[] = [];
  for (const operation of parseEditLineOperations(value)) {
    if (operation.op === 'swap' || operation.op === 'del') {
      const action = operation.op === 'swap' ? 'replaced' : 'deleted';
      for (let line = operation.start; line <= operation.end; line += 1) {
        lines.push(`- [original line ${String(line)} ${action}]`);
      }
    }
    if (operation.op !== 'del') {
      const contentLines = operation.content.replaceAll('\r\n', '\n').split('\n');
      if (operation.content.endsWith('\n')) contentLines.pop();
      lines.push(...contentLines.map(line => `+${line}`));
    }
  }
  return lines;
}
