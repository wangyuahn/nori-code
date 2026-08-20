import type { ToolCall } from '../hooks/useChatMessages';
import { editLineOperationsDiff, editOperationLabel, parseEditLineOperations } from './edit-line-ops';

export interface ToolDetailField {
  key: string;
  label: string;
  value: string;
}

type Translate = (english: string, chinese: string) => string;

export function toolCallDetailFields(tool: ToolCall, tr: Translate): ToolDetailField[] {
  return [
    { key: 'name', label: tr('Tool', '工具名'), value: tool.name.trim() || tr('Unknown tool', '未知工具') },
    { key: 'args', label: tr('Arguments', '参数'), value: formatArguments(tool.args, tr) },
    { key: 'result', label: tr('Result', '返回值'), value: formatResult(tool, tr) },
    { key: 'status', label: tr('Status', '执行状态'), value: formatStatus(tool, tr) },
    { key: 'duration', label: tr('Duration', '耗时'), value: formatDuration(tool, tr) },
    { key: 'error', label: tr('Error', '错误'), value: formatError(tool, tr) },
    ...specializedFields(tool, tr),
  ];
}

export function formatArguments(args: unknown, tr: Translate): string {
  if (args === undefined || args === null) return tr('No arguments', '无参数');
  if (typeof args === 'string') return args.trim() === '' ? tr('No arguments', '无参数') : args;
  if (typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length === 0) {
    return tr('No arguments', '无参数');
  }
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return tr('No arguments', '无参数');
  }
}

function formatResult(tool: ToolCall, tr: Translate): string {
  if (tool.result === undefined) {
    return tool.endedAt === undefined && tool.isError !== true
      ? tr('No result yet', '尚未返回')
      : tr('No return value', '无返回值');
  }
  if (tool.result.trim() === '') return tr('No return value', '无返回值');
  return tool.result;
}

function formatStatus(tool: ToolCall, tr: Translate): string {
  if (tool.isError === true) return tr('Failed', '失败');
  if (tool.result === undefined && tool.endedAt === undefined) return tr('Running', '运行中');
  return tr('Done', '完成');
}

function formatDuration(tool: ToolCall, tr: Translate): string {
  if (tool.startedAt === undefined || tool.endedAt === undefined) return tr('No duration', '无耗时');
  const durationMs = Math.max(0, tool.endedAt - tool.startedAt);
  if (durationMs < 1000) return `${String(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function formatError(tool: ToolCall, tr: Translate): string {
  if (tool.isError !== true) return tr('No error', '无错误');
  const message = tool.result?.trim();
  return message && message.length > 0 ? message : tr('Tool failed without an error message', '工具失败且无错误信息');
}

function specializedFields(tool: ToolCall, tr: Translate): ToolDetailField[] {
  const args = asRecord(tool.args);
  const normalized = tool.name.toLowerCase();
  if (normalized === 'edit') return editFields(args, tool, tr);
  if (normalized === 'write') return writeFields(args, tool, tr);
  if (normalized === 'read' || normalized === 'readfile' || normalized === 'readmedia') {
    return pathFields(args, tr, extraNumericFields(args, ['offset', 'limit'], tr));
  }
  if (normalized === 'bash' || normalized === 'shell') {
    return [{ key: 'command', label: tr('Command', '命令'), value: firstString(args.command) ?? tr('No command', '无命令') }];
  }
  if (normalized === 'grep') {
    return [
      { key: 'pattern', label: tr('Pattern', '匹配模式'), value: firstString(args.pattern, args.query) ?? tr('No pattern', '无匹配模式') },
      { key: 'path', label: tr('Path', '路径'), value: firstString(args.path, args.directory) ?? tr('No path', '无路径') },
    ];
  }
  if (normalized === 'glob') {
    return [
      { key: 'pattern', label: tr('Pattern', '匹配模式'), value: firstString(args.pattern, args.glob) ?? tr('No pattern', '无匹配模式') },
      { key: 'path', label: tr('Path', '路径'), value: firstString(args.path, args.target_directory) ?? tr('No path', '无路径') },
    ];
  }
  if (normalized === 'websearch') {
    return [{ key: 'query', label: tr('Query', '查询'), value: firstString(args.query, args.search) ?? tr('No query', '无查询') }];
  }
  if (normalized === 'fetchurl' || normalized === 'webfetch') {
    return [{ key: 'url', label: tr('URL', 'URL'), value: firstString(args.url) ?? tr('No URL', '无 URL') }];
  }
  if (normalized === 'skill') {
    return [{ key: 'skill', label: tr('Skill', '技能'), value: firstString(args.skill, args.name, args.skill_name) ?? tr('No skill name', '无技能名') }];
  }
  if (normalized === 'todolist') {
    return [{ key: 'todos', label: tr('Todos', '待办'), value: todoSummary(args.todos, tr) }];
  }
  if (normalized === 'teamcreate') {
    return [{ key: 'members', label: tr('Members', '成员'), value: memberSummary(args.members, tr) }];
  }
  if (normalized === 'teamassign') {
    return [{ key: 'assignments', label: tr('Assignments', '任务分配'), value: assignmentSummary(args.assignments, tr) }];
  }
  if (normalized === 'teamdm' || normalized === 'teambroadcast' || normalized === 'teamspeak') {
    return [
      ...(firstString(args.agent_id) === undefined
        ? []
        : [{ key: 'recipient', label: tr('Recipient', '收件成员'), value: firstString(args.agent_id) as string }]),
      { key: 'message', label: tr('Message', '消息'), value: firstString(args.message) ?? tr('No message', '无消息') },
    ];
  }
  if (normalized === 'teamdecide') {
    return [
      { key: 'action', label: tr('Action', '动作'), value: firstString(args.action) ?? tr('No action', '无动作') },
      { key: 'topic', label: tr('Topic', '议题'), value: firstString(args.topic) ?? tr('No topic', '无议题') },
      { key: 'statement', label: tr('Statement', '发言'), value: firstString(args.statement) ?? tr('No statement', '无发言') },
    ];
  }
  return pathFields(args, tr, []);
}

function editFields(args: Record<string, unknown>, tool: ToolCall, tr: Translate): ToolDetailField[] {
  const operations = parseEditLineOperations(args.line_ops);
  if (operations.length > 0) {
    return [
      { key: 'path', label: tr('File path', '文件路径'), value: firstString(args.path, args.file_path, args.filename) ?? tr('No file path', '无文件路径') },
      { key: 'tag', label: tr('Expected tag', '预期哈希'), value: firstString(args.expected_tag) ?? tr('No content tag', '无内容哈希') },
      { key: 'operations', label: tr('Line operations', '行操作'), value: operations.map(editOperationLabel).join('\n') },
      { key: 'diff', label: tr('Changes', '更改'), value: editLineOperationsDiff(args.line_ops).join('\n') },
      { key: 'applied', label: tr('Apply result', '应用结果'), value: tool.result?.trim() || tr('No apply result', '无应用结果') },
    ];
  }
  const before = firstString(args.old_string, args.old_text);
  const after = firstString(args.new_string, args.new_text, args.content);
  return [
    { key: 'path', label: tr('File path', '文件路径'), value: firstString(args.path, args.file_path, args.filename) ?? tr('No file path', '无文件路径') },
    { key: 'before', label: tr('Before', '编辑前'), value: before ?? tr('No original text', '无编辑前内容') },
    { key: 'after', label: tr('After', '编辑后'), value: after ?? tr('No replacement text', '无编辑后内容') },
    { key: 'diff', label: tr('Diff', '对照'), value: formatEditDiff(before, after, tr) },
    { key: 'applied', label: tr('Apply result', '应用结果'), value: tool.result?.trim() || tr('No apply result', '无应用结果') },
  ];
}

function writeFields(args: Record<string, unknown>, tool: ToolCall, tr: Translate): ToolDetailField[] {
  return [
    { key: 'path', label: tr('File path', '文件路径'), value: firstString(args.path, args.file_path, args.filename) ?? tr('No file path', '无文件路径') },
    { key: 'content', label: tr('Content', '写入内容'), value: firstString(args.content, args.new_string, args.new_text) ?? tr('No content', '无写入内容') },
    { key: 'applied', label: tr('Apply result', '应用结果'), value: tool.result?.trim() || tr('No apply result', '无应用结果') },
  ];
}

function pathFields(args: Record<string, unknown>, tr: Translate, extra: ToolDetailField[]): ToolDetailField[] {
  const path = firstString(args.path, args.file_path, args.filename, args.file, args.target_directory, args.directory);
  if (path === undefined && extra.length === 0) return [];
  return [
    ...(path === undefined ? [] : [{ key: 'path', label: tr('Path', '路径'), value: path }]),
    ...extra,
  ];
}

function extraNumericFields(args: Record<string, unknown>, keys: readonly string[], tr: Translate): ToolDetailField[] {
  return keys.flatMap(key => {
    const value = args[key];
    if (typeof value !== 'number') return [];
    return [{ key, label: key, value: String(value) }];
  }).map(field => (
    field.key === 'offset' ? { ...field, label: tr('Offset', '起始行') }
      : field.key === 'limit' ? { ...field, label: tr('Limit', '行数') }
        : field
  ));
}

export function formatEditDiff(before: string | undefined, after: string | undefined, tr: Translate): string {
  if (before === undefined && after === undefined) return tr('No before/after text', '无前后对照');
  const previous = (before ?? '').split(/\r?\n/);
  const next = (after ?? '').split(/\r?\n/);
  const lines: string[] = [];
  const max = Math.max(previous.length, next.length);
  for (let index = 0; index < max; index += 1) {
    const left = previous[index];
    const right = next[index];
    if (left === right) {
      if (left !== undefined) lines.push(` ${left}`);
      continue;
    }
    if (left !== undefined) lines.push(`-${left}`);
    if (right !== undefined) lines.push(`+${right}`);
  }
  return lines.length > 0 ? lines.join('\n') : tr('No before/after text', '无前后对照');
}

function memberSummary(value: unknown, tr: Translate): string {
  if (!Array.isArray(value) || value.length === 0) return tr('No members', '无成员');
  return value.map(item => {
    const member = asRecord(item);
    const name = firstString(member.name) ?? tr('Unnamed member', '未命名成员');
    const role = firstString(member.role);
    return role === undefined ? name : `${name} — ${role}`;
  }).join('\n');
}

function assignmentSummary(value: unknown, tr: Translate): string {
  if (!Array.isArray(value) || value.length === 0) return tr('No assignments', '无任务分配');
  return value.map(item => {
    const assignment = asRecord(item);
    const agentId = firstString(assignment.agent_id) ?? tr('Unknown member', '未知成员');
    // A null task is how TeamAssign clears an assignment, so say so rather than
    // rendering an empty line the reader has to guess at.
    const task = firstString(assignment.task) ?? tr('cleared', '已清除');
    return `${agentId}: ${task}`;
  }).join('\n');
}

function todoSummary(value: unknown, tr: Translate): string {
  if (!Array.isArray(value) || value.length === 0) return tr('No todos', '无待办');
  return value.map(item => {
    if (typeof item !== 'object' || item === null) return tr('Untitled todo', '未命名待办');
    const title = (item as { title?: unknown }).title;
    const status = (item as { status?: unknown }).status;
    const name = typeof title === 'string' && title.trim() !== '' ? title : tr('Untitled todo', '未命名待办');
    return `${name} (${String(status ?? tr('unknown', '未知'))})`;
  }).join('\n');
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}
