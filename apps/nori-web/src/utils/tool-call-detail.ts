import type { CodeChange, ToolCall } from '../hooks/useChatMessages';
import { editLineOperationsDiff, isChangedDiffLine, isPlaceholderDiffLine, parseEditLineOperations } from './edit-line-ops';

export interface ToolCallDetailOptions {
  readonly recordedDiff?: string | undefined;
}

export interface ToolCallDetailSection {
  readonly kind: 'heading' | 'diff' | 'pre' | 'error';
  readonly label?: string;
  readonly lines?: readonly string[];
  readonly text?: string;
}

const MAX_DIFF_LINES = 80;
const MAX_PRE_CHARS = 24_000;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function normalizeToolName(name: string): string {
  return name.replaceAll(/[-_\s]/g, '').toLowerCase();
}

export function isToolCallFailed(name: string, result: string | undefined): boolean {
  if (result === undefined || result.trim().length === 0) return false;
  const trimmed = result.trimStart();
  if (/^Error[:\s]/i.test(trimmed)) return true;
  if (/Command failed with exit code: [1-9]\d*\./.test(result)) return true;
  if (/^Tool execution failed\b/i.test(trimmed)) return true;
  if (normalizeToolName(name) === 'bash' && /exit code: [1-9]\d*/i.test(result)) return true;
  return false;
}

function writeContentDiff(content: unknown): string {
  if (typeof content !== 'string' || content.length === 0) return '';
  return content
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map(line => `+${line}`)
    .join('\n');
}

function compactDiffLines(diff: string): string[] {
  const lines = diff.split('\n').filter(line =>
    line.startsWith('@@') || isChangedDiffLine(line),
  );
  if (lines.length <= MAX_DIFF_LINES) return lines;
  return [...lines.slice(0, MAX_DIFF_LINES), `... ${String(lines.length - MAX_DIFF_LINES)} more changed lines`];
}

function hasTextDiff(diff: string): boolean {
  return diff.split('\n').some(line => isChangedDiffLine(line));
}

function usableRecordedDiff(diff: string | undefined): string | undefined {
  if (diff === undefined || diff.length === 0) return undefined;
  const cleaned = diff
    .split('\n')
    .filter(line => !isPlaceholderDiffLine(line))
    .join('\n')
    .trim();
  return hasTextDiff(cleaned) ? cleaned : undefined;
}

export function buildToolCallChangeDiff(tool: ToolCall, options?: ToolCallDetailOptions): string | undefined {
  const args = asRecord(tool.args);
  const normalized = normalizeToolName(tool.name);
  const recordedDiff = usableRecordedDiff(options?.recordedDiff?.trim());

  if (normalized === 'edit') {
    if (recordedDiff !== undefined) return recordedDiff;
    const diff = editLineOperationsDiff(args['line_ops']).join('\n');
    return diff.length > 0 ? diff : undefined;
  }
  if (normalized === 'write') {
    const diff = writeContentDiff(args['content']);
    return diff.length > 0 ? diff : undefined;
  }

  const resultDiff = tool.result?.trim();
  if (resultDiff !== undefined && resultDiff.length > 0 && looksLikeUnifiedDiff(resultDiff)) {
    return resultDiff;
  }
  return undefined;
}

function looksLikeUnifiedDiff(text: string): boolean {
  return text.includes('@@') && (text.includes('\n+') || text.includes('\n-'));
}

function truncatePre(text: string): string {
  if (text.length <= MAX_PRE_CHARS) return text;
  return `${text.slice(0, MAX_PRE_CHARS)}\n... truncated`;
}

function formatArgsSummary(tool: ToolCall, excludeKeys: Set<string>): string | undefined {
  const args = asRecord(tool.args);
  const entries = Object.entries(args).filter(([key, value]) => {
    if (excludeKeys.has(key)) return false;
    if (value === undefined || value === null) return false;
    if (typeof value === 'string' && value.length === 0) return false;
    return true;
  });
  if (entries.length === 0) return undefined;

  const lines: string[] = [];
  for (const [key, value] of entries) {
    if (typeof value === 'string') {
      const preview = value.length > 240 ? `${value.slice(0, 240)}…` : value;
      lines.push(`${key}: ${preview}`);
      continue;
    }
    try {
      const serialized = JSON.stringify(value);
      const preview = serialized.length > 240 ? `${serialized.slice(0, 240)}…` : serialized;
      lines.push(`${key}: ${preview}`);
    } catch {
      lines.push(`${key}: [unserializable]`);
    }
  }
  return lines.join('\n');
}

export function buildToolCallDetailSections(tool: ToolCall, options?: ToolCallDetailOptions): ToolCallDetailSection[] {
  const sections: ToolCallDetailSection[] = [];
  const normalized = normalizeToolName(tool.name);
  const args = asRecord(tool.args);
  const failed = isToolCallFailed(tool.name, tool.result);
  const changeDiff = buildToolCallChangeDiff(tool, options);

  const excludeArgKeys = new Set<string>();
  if (normalized === 'write') excludeArgKeys.add('content');
  if (normalized === 'edit') {
    excludeArgKeys.add('line_ops');
    excludeArgKeys.add('expected_tag');
  }
  if (normalized === 'bash') excludeArgKeys.add('command');
  if (normalized === 'norimemorywrite' || normalized === 'norimemoryedit') {
    excludeArgKeys.add('content');
  }

  const argsSummary = formatArgsSummary(tool, excludeArgKeys);
  if (argsSummary !== undefined) {
    sections.push({ kind: 'pre', label: 'Input', text: argsSummary });
  }

  if (normalized === 'norimemorywrite' || normalized === 'norimemoryedit') {
    const content = firstString(args['content']);
    if (content !== undefined) {
      sections.push({ kind: 'pre', label: 'Content', text: truncatePre(content) });
    }
  }

  if (normalized === 'bash') {
    const command = firstString(args['command']);
    if (command !== undefined) {
      sections.push({ kind: 'pre', label: 'Command', text: `$ ${command}` });
    }
  }

  if (normalized === 'edit' && parseEditLineOperations(args['line_ops']).length > 0) {
    sections.push({
      kind: 'heading',
      label: 'Line operations',
      text: `${String(parseEditLineOperations(args['line_ops']).length)} operation(s)`,
    });
  }

  if (changeDiff !== undefined) {
    sections.push({
      kind: 'diff',
      label: normalized === 'write' ? 'New content' : 'Changes',
      lines: compactDiffLines(changeDiff),
    });
  }

  if (tool.result !== undefined) {
    const trimmed = tool.result.trim();
    if (trimmed.length > 0) {
      if (failed) {
        sections.push({ kind: 'error', label: 'Failure', text: truncatePre(tool.result) });
      } else if (changeDiff === undefined || !trimmed.startsWith(changeDiff.slice(0, 32))) {
        sections.push({
          kind: 'pre',
          label: normalized === 'bash' ? 'Output' : 'Result',
          text: truncatePre(tool.result),
        });
      }
    }
  }

  if (sections.length === 0) {
    const fallback = serializeUnknown(tool.args);
    if (fallback !== undefined) {
      sections.push({ kind: 'pre', label: 'Input', text: fallback });
    }
  }

  return sections;
}

function serializeUnknown(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.length > 0 ? truncatePre(value) : undefined;
  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized === undefined || serialized === '{}' || serialized === '[]'
      ? undefined
      : truncatePre(serialized);
  } catch {
    return undefined;
  }
}
