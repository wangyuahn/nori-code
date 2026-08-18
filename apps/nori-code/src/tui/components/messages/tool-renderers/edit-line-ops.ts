export type EditLineOperationView =
  | { readonly op: 'swap'; readonly start: number; readonly end: number; readonly content: string }
  | { readonly op: 'del'; readonly start: number; readonly end: number }
  | { readonly op: 'insert_pre'; readonly line: number; readonly content: string }
  | { readonly op: 'insert_post'; readonly line: number; readonly content: string };

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

export function parseEditLineOperations(args: Record<string, unknown>): EditLineOperationView[] {
  if (!Array.isArray(args['line_ops'])) return [];
  const operations: EditLineOperationView[] = [];

  for (const candidate of args['line_ops']) {
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

export function operationContentLineCount(content: string): number {
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  return lines.length;
}

export function editOperationLabel(operation: EditLineOperationView): string {
  switch (operation.op) {
    case 'swap':
      return `replace lines ${String(operation.start)}-${String(operation.end)}`;
    case 'del':
      return `delete lines ${String(operation.start)}-${String(operation.end)}`;
    case 'insert_pre':
      return `insert before line ${String(operation.line)}`;
    case 'insert_post':
      return `insert after line ${String(operation.line)}`;
  }
}
