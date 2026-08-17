import type { ToolCall } from '../hooks/useChatMessages';
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

const MAX_PRE_CHARS = 24_000;
const LIFTED_STRING_CHARS = 120;

interface PayloadField {
  readonly key: string;
  readonly label: string;
}

const PAYLOAD_FIELDS: Record<string, readonly PayloadField[]> = {
  bash: [{ key: 'command', label: 'Command' }],
  write: [{ key: 'content', label: 'New content' }],
  edit: [{ key: 'line_ops', label: 'Line operations' }, { key: 'expected_tag', label: 'Tag' }],
  read: [{ key: 'path', label: 'Path' }],
  norimemorywrite: [{ key: 'content', label: 'Content' }],
  norimemoryedit: [{ key: 'content', label: 'Content' }],
  noriplanwrite: [{ key: 'content', label: 'Content' }],
  agent: [{ key: 'prompt', label: 'Prompt' }, { key: 'description', label: 'Description' }],
  agentswarm: [
    { key: 'prompt_template', label: 'Template' },
    { key: 'tasks', label: 'Tasks' },
    { key: 'items', label: 'Items' },
  ],
  agentswarmcontrol: [{ key: 'prompt', label: 'Prompt' }],
  skill: [{ key: 'args', label: 'Arguments' }],
  todolist: [{ key: 'todos', label: 'Todos' }],
  askuserquestion: [{ key: 'questions', label: 'Questions' }],
  websearch: [{ key: 'query', label: 'Query' }],
  fetchurl: [{ key: 'url', label: 'URL' }],
  grep: [{ key: 'pattern', label: 'Pattern' }],
  glob: [{ key: 'pattern', label: 'Pattern' }],
  norimemorysearch: [{ key: 'keywords', label: 'Keywords' }],
  norimemoryremove: [{ key: 'title', label: 'Title' }],
  noriaskparent: [{ key: 'question', label: 'Question' }, { key: 'context', label: 'Context' }],
  noriswarmlaunch: [{ key: 'params', label: 'Params' }],
  croncreate: [{ key: 'prompt', label: 'Prompt' }],
  creategoal: [
    { key: 'objective', label: 'Objective' },
    { key: 'completionCriterion', label: 'Completion criterion' },
  ],
  browser: [
    { key: 'text', label: 'Text' },
    { key: 'prompt_text', label: 'Prompt' },
    { key: 'paths', label: 'Paths' },
  ],
};

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

function payloadFieldsFor(normalized: string): readonly PayloadField[] {
  return PAYLOAD_FIELDS[normalized] ?? [];
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
  const lines = diff.split('\n').filter(line => !isPlaceholderDiffLine(line));
  let total = 0;
  const kept: string[] = [];
  for (const line of lines) {
    if (total + line.length + 1 > MAX_PRE_CHARS) {
      kept.push(`... ${String(lines.length - kept.length)} more lines`);
      break;
    }
    kept.push(line);
    total += line.length + 1;
  }
  return kept;
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

function formatArgValue(value: unknown): string {
  if (typeof value === 'string') return truncatePre(value);
  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized === undefined ? '[unserializable]' : truncatePre(serialized);
  } catch {
    return '[unserializable]';
  }
}

function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function shouldLiftValue(value: unknown): boolean {
  if (typeof value === 'string') return value.length >= LIFTED_STRING_CHARS || value.includes('\n');
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === 'object' && value !== null;
}

function titleCaseKey(key: string): string {
  const spaced = key.replaceAll(/[_-]+/g, ' ').trim();
  if (spaced.length === 0) return key;
  return spaced.replaceAll(/\b\w/g, char => char.toUpperCase());
}

function formatArgsBlock(args: Record<string, unknown>, excludeKeys: Set<string>): string | undefined {
  const entries = Object.entries(args).filter(([key, value]) => !excludeKeys.has(key) && isPresent(value));
  if (entries.length === 0) return undefined;

  const lines: string[] = [];
  for (const [key, value] of entries) {
    if (typeof value === 'string' && !value.includes('\n')) {
      lines.push(`${key}: ${truncatePre(value)}`);
      continue;
    }
    const formatted = formatArgValue(value);
    lines.push(formatted.includes('\n') ? `${key}:\n${formatted}` : `${key}: ${formatted}`);
  }
  return lines.join('\n');
}

function resultLabel(normalized: string): string {
  if (normalized === 'bash') return 'Output';
  if (normalized === 'read') return 'File';
  if (normalized === 'grep') return 'Matches';
  if (normalized === 'glob') return 'Files';
  if (normalized === 'websearch') return 'Results';
  if (normalized === 'fetchurl') return 'Page';
  if (normalized === 'browser') return 'Snapshot';
  if (normalized === 'skill') return 'Skill output';
  if (normalized === 'taskoutput') return 'Task output';
  return 'Result';
}

export function buildToolCallDetailSections(tool: ToolCall, options?: ToolCallDetailOptions): ToolCallDetailSection[] {
  const sections: ToolCallDetailSection[] = [];
  const normalized = normalizeToolName(tool.name);
  const args = asRecord(tool.args);
  const failed = isToolCallFailed(tool.name, tool.result);
  const changeDiff = buildToolCallChangeDiff(tool, options);
  const payloadFields = payloadFieldsFor(normalized);

  const excludeArgKeys = new Set<string>(payloadFields.map(field => field.key));
  for (const [key, value] of Object.entries(args)) {
    if (excludeArgKeys.has(key)) continue;
    if (shouldLiftValue(value)) excludeArgKeys.add(key);
  }

  const argsSummary = formatArgsBlock(args, excludeArgKeys);
  if (argsSummary !== undefined) {
    sections.push({ kind: 'pre', label: 'Input', text: argsSummary });
  }

  for (const field of payloadFields) {
    const value = args[field.key];
    if (!isPresent(value)) continue;
    if (normalized === 'write' && field.key === 'content') continue;
    if (normalized === 'edit' && (field.key === 'line_ops' || field.key === 'expected_tag')) continue;
    if (normalized === 'bash' && field.key === 'command') {
      const command = firstString(value);
      if (command !== undefined) {
        sections.push({ kind: 'pre', label: 'Command', text: `$ ${truncatePre(command)}` });
      }
      continue;
    }
    sections.push({ kind: 'pre', label: field.label, text: formatArgValue(value) });
  }

  for (const [key, value] of Object.entries(args)) {
    if (payloadFields.some(field => field.key === key)) continue;
    if (!shouldLiftValue(value) || !isPresent(value)) continue;
    sections.push({ kind: 'pre', label: titleCaseKey(key), text: formatArgValue(value) });
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
          label: resultLabel(normalized),
          text: truncatePre(tool.result),
        });
      }
    }
  }

  if (sections.length === 0) {
    const fallback = serializeUnknown(tool.args);
    if (fallback !== undefined) {
      sections.push({ kind: 'pre', label: 'Input', text: fallback });
    } else if (tool.result !== undefined) {
      sections.push({ kind: 'pre', label: 'Input', text: '(empty)' });
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
