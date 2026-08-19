/**
 * Session chat state: REST history plus the live WebSocket event stream.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, getWebSocketProtocols, type ApprovalRequest, type GoalSnapshot, type Message, type MessageContent, type PromptAttachment, type PromptExecutionOptions, type QuestionAnswer, type QuestionRequest, type SessionRealtimeStatus, type TokenUsage } from '../api/client';
import { playNotificationSound } from '../notificationSounds';

export interface ToolCall {
  id?: string;
  name: string;
  args: unknown;
  result?: string;
  isError?: boolean;
  startedAt?: number;
  endedAt?: number;
}

export type WorkBlock =
  | { id: string; type: 'thinking'; text: string }
  | { id: string; type: 'progress'; text: string }
  | { id: string; type: 'tool'; tool: ToolCall };

export interface TodoItem {
  title: string;
  status: 'pending' | 'in_progress' | 'done';
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  kind?: 'discussion';
  speaker?: {
    from: 'user' | 'lead' | 'team' | 'sub' | 'system';
    id?: string;
    name?: string;
  };
  images?: ChatImage[];
  files?: ChatFile[];
  toolCalls?: ToolCall[];
  thinking?: string;
  workBlocks?: WorkBlock[];
  createdAt?: string;
  isStreaming?: boolean;
  usage?: TokenUsage;
  turnBoundary?: boolean;
}

export interface ChatImage {
  src: string;
  alt: string;
}

export interface ChatFile {
  name: string;
  mediaType: string;
  size?: number;
}

interface RealtimeSubscriptionWaiter {
  resolve: (ready: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class RealtimeSubscriptionGate {
  private ready = false;
  private readonly waiters = new Set<RealtimeSubscriptionWaiter>();

  markPending(): void {
    this.ready = false;
  }

  markReady(): void {
    this.ready = true;
    this.settle(true);
  }

  reset(): void {
    this.ready = false;
    this.settle(false);
  }

  wait(timeoutMs = 30_000, signal?: AbortSignal): Promise<boolean> {
    if (this.ready) return Promise.resolve(true);
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise(resolve => {
      const waiter: RealtimeSubscriptionWaiter = {
        resolve,
        signal,
        timer: setTimeout(() => {
          this.finish(waiter, false);
        }, timeoutMs),
      };
      waiter.onAbort = () => { this.finish(waiter, false); };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.add(waiter);
    });
  }

  private settle(ready: boolean): void {
    for (const waiter of this.waiters) this.finish(waiter, ready);
  }

  private finish(waiter: RealtimeSubscriptionWaiter, ready: boolean): void {
    if (!this.waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort);
    waiter.resolve(ready);
  }
}

export interface CodeChange {
  operationId?: string;
  agentId: string;
  operation: 'edit' | 'write';
  path: string;
  diff: string;
  occurredAt: string;
}

export interface QueuedPrompt {
  id: string;
  text: string;
  createdAt: string;
}

function normalizeWireUsage(usage: WsPayload['usage']): TokenUsage | undefined {
  if (usage === undefined) return undefined;
  if ('input_other' in usage) return usage;
  return {
    input_other: usage.inputOther,
    output: usage.output,
    input_cache_read: usage.inputCacheRead,
    input_cache_creation: usage.inputCacheCreation,
  };
}

export interface UseChatMessagesResult {
  messages: ChatMessage[];
  messagesLoading: boolean;
  isStreaming: boolean;
  currentStreaming: string;
  currentThinking: string;
  currentWorkBlocks: WorkBlock[];
  sessionStatus: SessionRealtimeStatus | null;
  agentTreeRevision: number;
  discussionTurnAgentId: string | null | undefined;
  refreshSessionStatus: () => Promise<SessionRealtimeStatus | null>;
  compacting: boolean;
  pendingApprovals: ApprovalRequest[];
  pendingQuestions: QuestionRequest[];
  queuedPrompts: QueuedPrompt[];
  todos: TodoItem[];
  activeSubagentIds: string[];
  codeChanges: CodeChange[];
  resolveApproval: (approvalId: string, decision: 'approved' | 'rejected' | 'cancelled', options?: { remember?: boolean; feedback?: string; selectedLabel?: string }) => Promise<void>;
  resolveQuestion: (questionId: string, answers: Record<string, QuestionAnswer>) => Promise<void>;
  dismissQuestion: (questionId: string) => Promise<void>;
  sendMessage: (text: string, attachments?: PromptAttachment[], behavior?: 'queue' | 'steer', options?: PromptExecutionOptions) => Promise<boolean>;
  cancelQueuedPrompt: (promptId: string) => Promise<void>;
  rewindToPrompt: (count: number) => Promise<string | undefined>;
  refreshMessages: () => Promise<void>;
  abort: () => Promise<boolean>;
}

interface WsPayload {
  type?: string;
  delta?: string;
  message?: string;
  message_id?: string;
  turnId?: number;
  toolCallId?: string;
  id?: string;
  name?: string;
  args?: unknown;
  output?: unknown;
  result?: string;
  nonce?: string;
  accepted?: string[];
  accepted_subscriptions?: string[];
  promptId?: string;
  reason?: string;
  error?: { message?: string; code?: string; [key: string]: unknown };
  agentId?: string;
  discussMode?: boolean;
  coderWriteEnabled?: boolean;
  team?: {
    reportStatus?: string;
    reportSummary?: string | null;
    reportReceived?: boolean;
    assignedTask?: string | null;
    status?: string;
  };
  operationId?: string;
  operation?: 'edit' | 'write';
  path?: string;
  diff?: string;
  occurredAt?: string;
  usage?: TokenUsage | {
    inputOther: number;
    output: number;
    inputCacheRead: number;
    inputCacheCreation: number;
  };
  snapshot?: GoalSnapshot | null;
  isError?: boolean;
  subagentId?: string;
  discussionAgentId?: string;
  currentTurnAgentId?: string | null;
  kind?: string;
  runInBackground?: boolean;
  info?: {
    kind?: string;
    agentId?: string;
  };
}

function addTokenUsage(left: TokenUsage | undefined, right: TokenUsage | undefined): TokenUsage | undefined {
  if (left === undefined) return right === undefined ? undefined : { ...right };
  if (right === undefined) return { ...left };
  return {
    input_other: left.input_other + right.input_other,
    output: left.output + right.output,
    input_cache_read: left.input_cache_read + right.input_cache_read,
    input_cache_creation: left.input_cache_creation + right.input_cache_creation,
  };
}

interface WsMessage {
  type: string;
  id?: string;
  seq?: number;
  epoch?: string;
  volatile?: boolean;
  session_id?: string;
  code?: number;
  offset?: number;
  payload?: WsPayload;
}

/**
 * Durable WebSocket events are replayable. A reconnect can therefore deliver
 * the same event once through the live subscription and once through replay.
 * Volatile frames intentionally share the durable watermark and must not
 * participate in this comparison.
 */
export class RealtimeEventDeduper {
  private epoch: string | undefined;
  private lastDurableSeq = 0;

  reset(): void {
    this.epoch = undefined;
    this.lastDurableSeq = 0;
  }

  accept(frame: { seq?: number; epoch?: string; volatile?: boolean }): boolean {
    if (frame.volatile === true || frame.seq === undefined) return true;
    if (frame.epoch !== undefined && frame.epoch !== this.epoch) {
      this.epoch = frame.epoch;
      this.lastDurableSeq = 0;
    }
    if (frame.seq <= this.lastDurableSeq) return false;
    this.lastDurableSeq = frame.seq;
    return true;
  }
}

function stripLeadingSystemReminders(text: string): string {
  let result = text;
  const reminder = /^\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*/i;
  while (reminder.test(result)) result = result.replace(reminder, '');
  return result.trim();
}

function unwrapLeadingSystemReminder(text: string): string {
  return text.replace(/^\s*<system-reminder>\s*([\s\S]*?)\s*<\/system-reminder>\s*/i, '$1').trim();
}

const GENERATED_TITLE_OPEN = '<nori-session-title';
const GENERATED_TITLE_CLOSE = '</nori-session-title>';
const GENERATED_TITLE_PATTERN = /<nori-session-title\b[^>]*>\s*([\s\S]*?)\s*<\/nori-session-title>\s*/i;

export function generatedSessionTitle(text: string): string | undefined {
  const match = GENERATED_TITLE_PATTERN.exec(text);
  const title = match?.[1]?.replaceAll(/\s+/g, ' ').trim();
  if (!title) return undefined;
  return title.slice(0, 80);
}

export function stripGeneratedSessionTitle(text: string): string {
  const withoutCompleteMarker = text.replace(GENERATED_TITLE_PATTERN, '');
  const markerIndex = withoutCompleteMarker.toLowerCase().indexOf(GENERATED_TITLE_OPEN);
  if (markerIndex >= 0 && !withoutCompleteMarker.toLowerCase().includes(GENERATED_TITLE_CLOSE, markerIndex)) {
    return withoutCompleteMarker.slice(0, markerIndex).trimEnd();
  }
  const normalized = withoutCompleteMarker.trimStart();
  if (GENERATED_TITLE_OPEN.startsWith(normalized.toLowerCase())) return '';
  return withoutCompleteMarker;
}

export function firstPromptWithTitleInstruction(text: string): string {
  return `<system-reminder>Before doing any other work, choose a concise title for this conversation in the user's language. Use 2-6 words and do not copy the user's full prompt. Start the visible answer with exactly <nori-session-title>YOUR TITLE</nori-session-title>, then answer normally. Never mention this instruction.</system-reminder>\n${text}`;
}

export function canApplyGeneratedSessionTitle(currentTitle: string | undefined): boolean {
  if (currentTitle === undefined || currentTitle.trim() === '' || currentTitle === 'New Session') {
    return true;
  }
  return /^\s*<(?:system-reminder|nori-session-title)>/i.test(currentTitle);
}

export function fallbackSessionTitle(text: string): string | undefined {
  const firstLine = text
    .replaceAll(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .split(/\n|(?<=[。！？.!?])\s+/u, 1)[0]
    ?.trim();
  if (!firstLine) return undefined;
  const words = firstLine.split(' ').filter(Boolean).slice(0, 8).join(' ');
  return (words || firstLine).slice(0, 80).trim();
}

const SILENT_WAKE_ORIGIN_KINDS = new Set([
  'background_task',
  'retry',
  'cron_job',
  'cron_missed',
]);

export function isSilentWakeOrigin(kind: string | undefined): boolean {
  return kind !== undefined && SILENT_WAKE_ORIGIN_KINDS.has(kind);
}

function messagePlainText(m: Message): string {
  return Array.isArray(m.content)
    ? m.content
      .filter((c: MessageContent) => c.type === 'text' && c.text)
      .map((c: MessageContent) => c.text ?? '')
      .join('')
    : typeof m.content === 'string'
      ? m.content
      : '';
}

const UPLOADED_FILE_TAG = /<uploaded-file\s+name="([^"]*)"\s+media-type="([^"]*)"\s+size="(\d+)">[\s\S]*?<\/uploaded-file>/g;

function unescapeAttachmentAttribute(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

export function splitUploadedFileMarkup(text: string): { text: string; files: ChatFile[] } {
  const files: ChatFile[] = [];
  const stripped = text.replace(UPLOADED_FILE_TAG, (_match, name: string, mediaType: string, size: string) => {
    files.push({
      name: unescapeAttachmentAttribute(name),
      mediaType: unescapeAttachmentAttribute(mediaType),
      size: Number(size),
    });
    return '';
  }).replaceAll(/\n{3,}/g, '\n\n').trim();
  return { text: stripped, files };
}

export function chatFilesFromPromptAttachments(attachments: readonly PromptAttachment[]): ChatFile[] {
  return attachments.flatMap(attachment => attachment.kind === 'file'
    ? [{ name: attachment.name, mediaType: attachment.media_type, size: attachment.size }]
    : []);
}

export function chatImagesFromPromptAttachments(attachments: readonly PromptAttachment[]): ChatImage[] {
  return attachments.flatMap(attachment => attachment.kind === 'image'
    ? [{
        src: `data:${attachment.source.media_type};base64,${attachment.source.data}`,
        alt: attachment.name,
      }]
    : []);
}

function contentFileParts(content: Message['content']): ChatFile[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap(part => {
    if (part.type !== 'file' || part.name === undefined || part.name.length === 0) return [];
    return [{
      name: part.name,
      mediaType: part.media_type ?? 'application/octet-stream',
      size: part.size,
    }];
  });
}

type DiscussionSpeaker = {
  from: 'lead' | 'team' | 'sub';
  id?: string;
  name?: string;
};

function toDiscussionSpeaker(speaker: unknown): DiscussionSpeaker | undefined {
  if (speaker === null || typeof speaker !== 'object') return undefined;
  const candidate = speaker as { from?: unknown; speakerId?: unknown; speakerName?: unknown };
  if (candidate.from !== 'lead' && candidate.from !== 'team' && candidate.from !== 'sub') return undefined;
  return {
    from: candidate.from,
    ...(typeof candidate.speakerId === 'string' ? { id: candidate.speakerId } : {}),
    ...(typeof candidate.speakerName === 'string' ? { name: candidate.speakerName } : {}),
  };
}

async function releasePromptFileBlobs(attachments: readonly PromptAttachment[]): Promise<void> {
  await Promise.all(attachments.map(attachment =>
    attachment.kind === 'file'
      ? api.files.delete(attachment.file_id).catch(() => undefined)
      : Promise.resolve(),
  ));
}

export function apiMessageToChat(m: Message): ChatMessage | null {
  const origin = m.metadata?.origin;
  const originKind = origin?.kind;
  const rawText = messagePlainText(m);
  // TeamDM is an internal prompt transport. It remains in the agent's model
  // context, but must not reappear as a human-visible chat message when REST
  // history is replayed after refresh.
  const isLegacyTeamDm = m.role === 'user'
    && originKind === 'system_trigger'
    && (origin?.name === 'team_lead' || origin?.name === 'team_member')
    && /^\s*<system-reminder>/i.test(rawText);
  if (m.role === 'user' && originKind === 'system_trigger' && (origin?.name === 'team_dm' || isLegacyTeamDm)) {
    return null;
  }
  if (m.role === 'tool' && originKind === 'injection' && origin?.variant === 'permission_mode') {
    return null;
  }
  const speaker = toDiscussionSpeaker(origin?.speaker);
  if (m.role === 'user' && originKind !== undefined && originKind !== 'user') {
    if (isSilentWakeOrigin(originKind)) {
      return { id: m.id, role: 'system', text: '', createdAt: m.created_at, turnBoundary: true };
    }
    if (speaker !== undefined) {
      return {
        id: m.id,
        role: 'system',
        kind: 'discussion',
        text: unwrapLeadingSystemReminder(messagePlainText(m)),
        speaker: {
          from: speaker.from,
          ...(speaker.id ? { id: speaker.id } : {}),
          ...(speaker.name ? { name: speaker.name } : {}),
        },
        createdAt: m.created_at,
      };
    }
  }

  const text = m.role === 'user'
    ? stripLeadingSystemReminders(rawText)
    : m.role === 'assistant'
      ? stripGeneratedSessionTitle(rawText)
      : rawText;

  const thinkingFromContent = Array.isArray(m.content)
    ? m.content
        .filter((c: MessageContent) => c.type === 'thinking')
        .map((c: MessageContent) => c.thinking ?? c.text ?? '')
        .join('\n')
    : '';
  const images = Array.isArray(m.content)
    ? m.content.flatMap((content, index) => {
        if (content.type !== 'image' || content.source === undefined) return [];
        if (content.source.kind === 'url') {
          return [{ src: content.source.url, alt: `Attached image ${String(index + 1)}` }];
        }
        if (content.source.kind === 'base64') {
          return [{
            src: `data:${content.source.media_type};base64,${content.source.data}`,
            alt: `Attached image ${String(index + 1)}`,
          }];
        }
        return [];
      })
    : [];

  let toolCalls: ToolCall[] = (m.tool_calls ?? []).map(tc => ({
    id: tc.id,
    name: tc.name,
    args: tc.args,
    result: tc.result,
    isError: tc.is_error,
  }));

  if (Array.isArray(m.content)) {
    for (const c of m.content) {
      if (c.type === 'tool_use') {
        toolCalls = mergeToolCalls(toolCalls, [{ id: c.tool_call_id, name: c.tool_name ?? c.name ?? 'tool', args: c.input }]);
      } else if (c.type === 'tool_result') {
        const matching = toolCalls.find(tool => tool.id && tool.id === c.tool_call_id);
        if (matching) {
          matching.result = c.output;
          matching.isError = c.is_error === true;
        } else {
          toolCalls.push({
            id: c.tool_call_id,
            name: 'tool',
            args: undefined,
            result: c.output,
            isError: c.is_error === true,
          });
        }
      }
    }
  }
  // Permission-mode reminders remain model context, but are intentionally
  // omitted from the human transcript. Read the projected tool input instead
  // of manufacturing a ContextInjection from message origin metadata.
  toolCalls = toolCalls.filter(tool => {
    if (tool.name !== 'ContextInjection') return true;
    if (typeof tool.args !== 'object' || tool.args === null) return true;
    return (tool.args as { source?: unknown }).source !== 'permission_mode';
  });

  const thinking = m.thinking || thinkingFromContent || undefined;
  const textIsProgress = m.role === 'assistant' && toolCalls.length > 0 && Boolean(text.trim());
  const workBlocks = workBlocksFromMessage(m, toolCalls, thinking, textIsProgress ? text : undefined);
  const parsedUploads = m.role === 'user' ? splitUploadedFileMarkup(text) : { text, files: [] as ChatFile[] };
  const files = [...contentFileParts(m.content), ...parsedUploads.files];
  const visibleText = textIsProgress ? '' : (m.role === 'user' ? parsedUploads.text : text);
  if (!visibleText && !thinking && toolCalls.length === 0 && images.length === 0 && files.length === 0) return null;

  return {
    id: m.id,
    role: m.role === 'tool' ? 'assistant' : m.role,
    text: visibleText,
    images: images.length > 0 ? images : undefined,
    files: files.length > 0 ? files : undefined,
    thinking,
    workBlocks: workBlocks.length > 0 ? workBlocks : undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    createdAt: m.created_at,
  };
}

/**
 * Keep persisted message boundaries intact. Process/tool messages and the
 * final assistant answer are separate messages; combining them here makes the
 * UI manufacture a final row containing the whole preceding transcript.
 */
export function foldConversationTurns(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(message => !message.turnBoundary);
}

export function insertSteerBoundary(
  messages: ChatMessage[],
  assistant: ChatMessage | null,
  user: ChatMessage,
): ChatMessage[] {
  return [
    ...messages,
    ...(assistant === null ? [] : [assistant]),
    user,
  ];
}

function workBlocksFromMessage(
  message: Message,
  toolCalls: ToolCall[],
  thinking: string | undefined,
  progressText?: string,
): WorkBlock[] {
  const blocks: WorkBlock[] = [];
  let thinkingIndex = 0;
  const representedToolIds = new Set<string>();
  let progressInserted = false;

  for (const content of message.content) {
    if (!progressInserted && progressText !== undefined && content.type === 'text') {
      const progress = createProgressBlock(`${message.id}-progress`, progressText);
      if (progress !== undefined) blocks.push(progress);
      progressInserted = true;
    }
    if (content.type === 'thinking') {
      const text = content.thinking ?? content.text ?? '';
      if (text) blocks.push({ id: `${message.id}-thinking-${thinkingIndex++}`, type: 'thinking', text });
      continue;
    }
    if (content.type !== 'tool_use' && content.type !== 'tool_result') continue;
    const id = content.tool_call_id;
    const tool = id ? toolCalls.find(candidate => candidate.id === id) : undefined;
    if (tool && (!id || !representedToolIds.has(id))) {
      blocks.push({ id: id ?? `${message.id}-tool-${blocks.length}`, type: 'tool', tool });
      if (id) representedToolIds.add(id);
    }
  }

  if (thinking && !blocks.some(block => block.type === 'thinking')) {
    blocks.unshift({ id: `${message.id}-thinking`, type: 'thinking', text: thinking });
  }
  if (!progressInserted && progressText !== undefined) {
    const progress = createProgressBlock(`${message.id}-progress`, progressText);
    if (progress !== undefined) {
      const firstToolIndex = blocks.findIndex(block => block.type === 'tool');
      blocks.splice(firstToolIndex < 0 ? blocks.length : firstToolIndex, 0, progress);
    }
  }
  for (const tool of toolCalls) {
    if (tool.id && representedToolIds.has(tool.id)) continue;
    blocks.push({ id: tool.id ?? `${message.id}-tool-${blocks.length}`, type: 'tool', tool });
  }
  return blocks;
}

function createProgressBlock(id: string, text: string): Extract<WorkBlock, { type: 'progress' }> | undefined {
  const normalized = stripGeneratedSessionTitle(text).trim();
  return normalized ? { id, type: 'progress', text: normalized } : undefined;
}

function mergeWorkBlocks(previous: WorkBlock[], incoming: WorkBlock[]): WorkBlock[] {
  const merged = previous.map(block => block.type === 'tool'
    ? { ...block, tool: { ...block.tool } }
    : { ...block });
  for (const block of incoming) {
    if (block.type === 'tool' && block.tool.id) {
      const existing = merged.find(candidate => candidate.type === 'tool' && candidate.tool.id === block.tool.id);
      if (existing?.type === 'tool') {
        existing.tool = mergeToolCalls([existing.tool], [block.tool])[0]!;
        continue;
      }
    }
    merged.push(block.type === 'tool' ? { ...block, tool: { ...block.tool } } : { ...block });
  }
  return merged;
}

/**
 * A reconnect snapshot only contains tools that are still running. Keep the
 * completed steps already received over the socket instead of replacing the
 * visible work log with that intentionally partial snapshot.
 */
export function mergeInFlightWorkBlocks(previous: WorkBlock[], snapshot: WorkBlock[]): WorkBlock[] {
  if (previous.length === 0) return mergeWorkBlocks([], snapshot);

  const missingThinking = previous.some(block => block.type === 'thinking')
    ? []
    : snapshot.filter(block => block.type === 'thinking');
  const runningTools = snapshot.filter(block => block.type === 'tool');
  return mergeWorkBlocks(previous, [...missingThinking, ...runningTools]);
}

function appendStreamDelta(current: string, delta: string, offset: number | undefined): { text: string; appended: string } | null {
  if (offset === undefined) return { text: current + delta, appended: delta };
  if (offset > current.length) return null;
  if (offset === current.length) return { text: current + delta, appended: delta };
  const overlap = current.length - offset;
  const appended = overlap >= delta.length ? '' : delta.slice(overlap);
  return { text: current + appended, appended };
}

function mergeToolCalls(previous: ToolCall[], incoming: ToolCall[]): ToolCall[] {
  const merged = previous.map(tool => ({ ...tool }));
  for (const tool of incoming) {
    const match = tool.id ? merged.find(candidate => candidate.id === tool.id) : undefined;
    if (match) {
      if (tool.name !== 'tool') match.name = tool.name;
      if (tool.args !== undefined) match.args = tool.args;
      if (tool.result !== undefined) match.result = tool.result;
      if (tool.isError !== undefined) match.isError = tool.isError;
      if (tool.startedAt !== undefined) match.startedAt = tool.startedAt;
      if (tool.endedAt !== undefined) match.endedAt = tool.endedAt;
    } else {
      merged.push({ ...tool });
    }
  }
  return merged;
}

function todosFromToolArgs(args: unknown): TodoItem[] | undefined {
  if (typeof args !== 'object' || args === null || !('todos' in args)) return undefined;
  const value = (args as { todos?: unknown }).todos;
  if (!Array.isArray(value)) return undefined;
  return value.flatMap(item => {
    if (typeof item !== 'object' || item === null) return [];
    const title = (item as { title?: unknown }).title;
    const status = (item as { status?: unknown }).status;
    if (typeof title !== 'string' || !['pending', 'in_progress', 'done'].includes(String(status))) return [];
    return [{ title, status: status as TodoItem['status'] }];
  });
}

export function latestTodos(messages: ChatMessage[]): TodoItem[] {
  let latest: TodoItem[] | undefined;
  for (const message of messages) {
    for (const tool of message.toolCalls ?? []) {
      if (tool.name !== 'TodoList') continue;
      latest = todosFromToolArgs(tool.args) ?? latest;
    }
  }
  return latest ?? [];
}

function messageTime(message: ChatMessage): number {
  const parsed = Date.parse(message.createdAt ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Prompt submit returns a synthetic `msg_<sid>_pending_<promptId>` before the
 * transcript assigns the stable `msg_<sid>_<index>` id. Treat both that
 * placeholder and local/live ids as transient so history merge can collapse
 * them by their authoritative server id instead of showing the same user turn twice.
 */
export function isTransientChatMessageId(id: string): boolean {
  return id.startsWith('local-user-') || id.startsWith('live-') || id.includes('_pending_prompt_');
}

export function confirmOptimisticUserMessage(
  messages: ChatMessage[],
  localId: string,
  serverId: string,
  createdAt: string,
): ChatMessage[] {
  if (localId === serverId) {
    return messages.map(message => message.id === localId ? { ...message, createdAt } : message);
  }
  if (messages.some(message => message.id === serverId)) {
    return messages.filter(message => message.id !== localId);
  }
  const local = messages.find(message => message.id === localId);
  // History may already expose the derived transcript id while submit still
  // returns the pending placeholder — drop the optimistic row instead of
  // renaming it to a second id for the same text.
  if (local !== undefined && messages.some(message =>
    message.id !== localId
    && !isTransientChatMessageId(message.id)
    && message.role === local.role
    && message.text === local.text
    && Math.abs(messageTime(message) - messageTime(local)) < 15_000
    && (local.role === 'assistant' || (message.thinking ?? '') === (local.thinking ?? '')),
  )) {
    return messages.filter(message => message.id !== localId);
  }
  return messages.map(message => message.id === localId
    ? { ...message, id: serverId, createdAt }
    : message);
}

export function mergeHistory(previous: ChatMessage[], remote: ChatMessage[]): ChatMessage[] {
  // Message ids are the only safe identity here. Process text, Team reports,
  // and final answers may be identical while representing different events.
  const byId = new Map<string, ChatMessage>();
  for (const message of remote) {
    if (!byId.has(message.id)) byId.set(message.id, message);
  }
  for (const local of previous) {
    if (byId.has(local.id)) continue;
    // Legacy prompt submissions used a pending id before the server returned
    // the authoritative user_message_id. Keep this narrow compatibility path
    // for user rows only; assistant/process rows are never text-matched.
    const confirmedUser = local.role === 'user' && local.id.includes('_pending_prompt_')
      ? remote.find(message =>
        message.role === local.role
        && message.text === local.text
        && message.id.startsWith('msg_')
        && Math.abs(messageTime(message) - messageTime(local)) < 15_000
        && (message.thinking ?? '') === (local.thinking ?? ''),
      )
      : undefined;
    if (confirmedUser !== undefined) continue;
    byId.set(local.id, local);
  }
  return foldConversationTurns([...byId.values()].sort((a, b) => messageTime(a) - messageTime(b)));
}

function reconcileHistory(_previous: ChatMessage[], remote: ChatMessage[]): ChatMessage[] {
  // A replace is an authoritative REST snapshot. Never rename its stable
  // message ids to temporary UI ids by matching message text.
  return foldConversationTurns(remote);
}

function normalizeEventType(type: string): string {
  return type.startsWith('event.') ? type.slice('event.'.length) : type;
}

export function applyRealtimeStatusEvent(
  status: SessionRealtimeStatus | null,
  type: string,
  payload: { discussMode?: boolean; coderWriteEnabled?: boolean },
): SessionRealtimeStatus | null {
  if (status === null || normalizeEventType(type) !== 'agent.status.updated') return status;
  if (payload.discussMode === undefined && payload.coderWriteEnabled === undefined) return status;
  return {
    ...status,
    discuss_mode: payload.discussMode ?? status.discuss_mode,
    main_write_enabled: payload.coderWriteEnabled ?? status.main_write_enabled,
  };
}

function controlId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function promptForRewind(messages: ChatMessage[], count: number): string | undefined {
  if (!Number.isInteger(count) || count < 1) return undefined;
  let userPromptCount = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    userPromptCount++;
    if (userPromptCount === count) return message.text;
  }
  return undefined;
}

export function liveAssistantMessage(input: {
  sessionId: string;
  text: string;
  thinking: string;
  workBlocks: WorkBlock[];
  usage?: TokenUsage;
  createdAt?: string;
}): ChatMessage | null {
  if (!input.text && !input.thinking && input.workBlocks.length === 0) return null;
  const createdAt = input.createdAt ?? new Date().toISOString();
  const toolCalls = input.workBlocks.flatMap(block => block.type === 'tool' ? [block.tool] : []);
  return {
    id: `live-${input.sessionId}-${Date.parse(createdAt) || Date.now()}`,
    role: 'assistant',
    text: input.text,
    thinking: input.thinking || undefined,
    workBlocks: input.workBlocks.length > 0 ? input.workBlocks : undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: input.usage,
    createdAt,
  };
}

export function shouldFinishAbortedPrompt(
  activePromptId: string | null,
  abortedPromptId: string | undefined,
): boolean {
  return abortedPromptId === undefined || abortedPromptId === activePromptId;
}

export function chatScopeKey(sessionId: string | null, agentId = 'main'): string | null {
  return sessionId === null ? null : `${sessionId}\u0000${agentId}`;
}

function hasCurrentScope(
  scopeRef: { current: string | null },
  sessionId: string,
  agentId: string,
): boolean {
  return scopeRef.current === chatScopeKey(sessionId, agentId);
}

export function useChatMessages(
  sessionId: string | null,
  agentId = 'main',
  sessionTitle?: string,
): UseChatMessagesResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [currentStreaming, setCurrentStreaming] = useState('');
  const [currentThinking, setCurrentThinking] = useState('');
  const [currentWorkBlocks, setCurrentWorkBlocks] = useState<WorkBlock[]>([]);
  const [sessionStatus, setSessionStatus] = useState<SessionRealtimeStatus | null>(null);
  const [agentTreeRevision, setAgentTreeRevision] = useState(0);
  const [discussionTurnAgentId, setDiscussionTurnAgentId] = useState<string | null | undefined>(undefined);
  const [compacting, setCompacting] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([]);
  const [pendingQuestions, setPendingQuestions] = useState<QuestionRequest[]>([]);
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([]);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [activeSubagentIds, setActiveSubagentIds] = useState<string[]>([]);
  const [codeChanges, setCodeChanges] = useState<CodeChange[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const scopeRef = useRef(chatScopeKey(sessionId, agentId));
  const sessionStatusScopeRef = useRef<string | null>(null);
  const sessionTitleRef = useRef(sessionTitle);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subscriptionGateRef = useRef(new RealtimeSubscriptionGate());
  const sendAbortRef = useRef<AbortController | null>(null);
  const sendSettledRef = useRef<Promise<void> | null>(null);
  const sendInFlightRef = useRef(false);
  const promptIdRef = useRef<string | null>(null);
  const sendStartedAtRef = useRef(0);
  const lastStreamActivityAtRef = useRef(0);
  const streamingRef = useRef('');
  const assistantRawRef = useRef('');
  const thinkingRef = useRef('');
  const thinkingRawRef = useRef('');
  const hasUserPromptRef = useRef(false);
  const titleAppliedRef = useRef(false);
  const titlePromptRef = useRef<string | null>(null);
  const turnUsageRef = useRef<TokenUsage | undefined>(undefined);
  const activeTurnIdRef = useRef<number | null>(null);
  const completedTurnIdsRef = useRef(new Set<number>());
  const historyRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const compactTriggeredRef = useRef(false);
  const compactingRef = useRef(false);
  const activeToolCallsRef = useRef(new Map<string, ToolCall>());
  const liveWorkBlocksRef = useRef<WorkBlock[]>([]);
  const attentionRequestIdsRef = useRef(new Set<string>());

  scopeRef.current = chatScopeKey(sessionId, agentId);
  sessionTitleRef.current = sessionTitle;

  const applyGeneratedTitle = useCallback((text: string, fallbackText?: string) => {
    if (agentId !== 'main' || !sessionId || titleAppliedRef.current || !canApplyGeneratedSessionTitle(sessionTitleRef.current)) {
      return;
    }
    const title = generatedSessionTitle(text) ?? (fallbackText ? fallbackSessionTitle(fallbackText) : undefined);
    if (!title) return;
    titleAppliedRef.current = true;
    void api.renameSession(sessionId, title).then(() => {
      sessionTitleRef.current = title;
      window.dispatchEvent(new CustomEvent('nori:session-title-changed', { detail: { sessionId, title } }));
    }).catch(error => {
      titleAppliedRef.current = false;
      console.error('Failed to apply generated session title:', error);
    });
  }, [agentId, sessionId]);

  const clearDraft = useCallback(() => {
    streamingRef.current = '';
    assistantRawRef.current = '';
    thinkingRef.current = '';
    thinkingRawRef.current = '';
    setCurrentStreaming('');
    setCurrentThinking('');
    liveWorkBlocksRef.current = [];
    setCurrentWorkBlocks([]);
  }, []);

  const finishLiveTurn = useCallback((turnId?: number) => {
    if (turnId !== undefined) {
      if (completedTurnIdsRef.current.has(turnId)) return;
      completedTurnIdsRef.current.add(turnId);
      if (completedTurnIdsRef.current.size > 32) {
        const oldest = completedTurnIdsRef.current.values().next().value;
        if (oldest !== undefined) completedTurnIdsRef.current.delete(oldest);
      }
    }

    applyGeneratedTitle(assistantRawRef.current, titlePromptRef.current ?? undefined);
    if (sessionId) {
      const completed = liveAssistantMessage({
        sessionId: `${sessionId}-${agentId}`,
        text: stripGeneratedSessionTitle(streamingRef.current),
        thinking: thinkingRef.current,
        workBlocks: liveWorkBlocksRef.current,
        usage: turnUsageRef.current,
      });
      if (completed) setMessages(previous => mergeHistory(previous, [completed]));
    }

    setIsStreaming(false);
    activeTurnIdRef.current = null;
    promptIdRef.current = null;
    turnUsageRef.current = undefined;
    clearDraft();
  }, [agentId, applyGeneratedTitle, clearDraft, sessionId]);

  const hydrateInFlight = useCallback(async (targetSessionId: string, targetAgentId = agentId) => {
    // The snapshot endpoint is currently parent-session scoped. Never use a
    // main-agent snapshot to rebuild a child transcript.
    if (targetAgentId !== 'main') return false;
    const snapshot = await api.sessions.getSnapshot(targetSessionId, targetAgentId);
    if (!hasCurrentScope(scopeRef, targetSessionId, targetAgentId)) return false;
    setPendingApprovals(previous => preserveEqual(previous, snapshot.pending_approvals ?? []));
    setPendingQuestions(previous => preserveEqual(previous, snapshot.pending_questions ?? []));
    const inFlight = snapshot.in_flight_turn;
    if (!inFlight) return false;
    const isSameTurn = activeTurnIdRef.current === inFlight.turn_id;
    const restoredProgress = inFlight.running_tools.length > 0
      ? createProgressBlock(`snapshot-progress-${inFlight.turn_id}`, inFlight.assistant_text)
      : undefined;
    assistantRawRef.current = inFlight.assistant_text;
    thinkingRawRef.current = inFlight.thinking_text;
    activeTurnIdRef.current = inFlight.turn_id;
    activeToolCallsRef.current.clear();
    const snapshotBlocks: WorkBlock[] = [
      ...(inFlight.thinking_text.trim()
        ? [{ id: `snapshot-thinking-${inFlight.turn_id}`, type: 'thinking' as const, text: inFlight.thinking_text }]
        : []),
      ...(restoredProgress === undefined ? [] : [restoredProgress]),
      ...inFlight.running_tools.map(tool => {
        const restoredTool: ToolCall = { id: tool.tool_call_id, name: tool.name, args: tool.args };
        activeToolCallsRef.current.set(tool.tool_call_id, restoredTool);
        return { id: tool.tool_call_id, type: 'tool' as const, tool: restoredTool };
      }),
    ];
    const preservesLiveBlocks = isSameTurn && liveWorkBlocksRef.current.length > 0;
    const restoredBlocks = preservesLiveBlocks
      ? mergeInFlightWorkBlocks(liveWorkBlocksRef.current, snapshotBlocks)
      : snapshotBlocks;
    liveWorkBlocksRef.current = restoredBlocks;
    if (!preservesLiveBlocks) {
      streamingRef.current = restoredProgress === undefined ? inFlight.assistant_text : '';
      thinkingRef.current = inFlight.thinking_text;
      setCurrentStreaming(restoredProgress === undefined ? stripGeneratedSessionTitle(inFlight.assistant_text) : '');
      setCurrentThinking(inFlight.thinking_text);
    }
    setCurrentWorkBlocks(restoredBlocks);
    lastStreamActivityAtRef.current = Date.now();
    setIsStreaming(true);
    return true;
  }, [agentId]);

  const applyHistoryItems = useCallback((items: Message[], targetSessionId: string, targetAgentId: string, replace: boolean) => {
    for (const message of items) {
      if (message.role !== 'assistant') continue;
      const rawText = Array.isArray(message.content)
        ? message.content.filter(part => part.type === 'text').map(part => part.text ?? '').join('')
        : typeof message.content === 'string' ? message.content : '';
      applyGeneratedTitle(rawText);
      if (titleAppliedRef.current) break;
    }
    const history = foldConversationTurns(items
      .map(apiMessageToChat)
      .filter((message): message is ChatMessage => message !== null)
      .sort((a, b) => messageTime(a) - messageTime(b)));
    if (hasCurrentScope(scopeRef, targetSessionId, targetAgentId)) {
      hasUserPromptRef.current = history.some(message => message.role === 'user');
      setTodos(latestTodos(history));
      setMessages(previous => {
        const next = replace ? reconcileHistory(previous, history) : mergeHistory(previous, history);
        return preserveEqual(previous, next);
      });
    }
    return history;
  }, [applyGeneratedTitle]);

  const refreshHistory = useCallback(async (targetSessionId = sessionId, targetAgentId = agentId, replace = false) => {
    if (!targetSessionId) return [] as ChatMessage[];
    const data = await api.sessions.getMessages(targetSessionId, { page_size: 100, agent_id: targetAgentId });
    return applyHistoryItems(data?.items ?? [], targetSessionId, targetAgentId, replace);
  }, [agentId, applyHistoryItems, sessionId]);

  useEffect(() => {
    setMessages([]);
    setMessagesLoading(Boolean(sessionId));
    setIsStreaming(false);
    subscriptionGateRef.current.reset();
    promptIdRef.current = null;
    hasUserPromptRef.current = false;
    titleAppliedRef.current = false;
    titlePromptRef.current = null;
    turnUsageRef.current = undefined;
    activeTurnIdRef.current = null;
    completedTurnIdsRef.current.clear();
    if (historyRefreshTimerRef.current) clearTimeout(historyRefreshTimerRef.current);
    historyRefreshTimerRef.current = null;
    compactTriggeredRef.current = false;
    compactingRef.current = false;
    sessionStatusScopeRef.current = null;
    setSessionStatus(null);
    setAgentTreeRevision(0);
    setDiscussionTurnAgentId(undefined);
    setPendingQuestions([]);
    attentionRequestIdsRef.current = new Set([
      ...pendingApprovals.map(request => `approval:${request.approval_id}`),
      ...pendingQuestions.map(request => `question:${request.question_id}`),
    ]);
    setQueuedPrompts([]);
    setTodos([]);
    setActiveSubagentIds([]);
    activeToolCallsRef.current.clear();
    setCompacting(false);
    clearDraft();
    if (!sessionId) return;
    void refreshHistory(sessionId, agentId)
      .catch(error => {
        if (hasCurrentScope(scopeRef, sessionId, agentId)) console.error('Failed to load messages:', error);
      })
      .finally(() => {
        if (hasCurrentScope(scopeRef, sessionId, agentId)) setMessagesLoading(false);
      });
  }, [agentId, clearDraft, refreshHistory, sessionId]);

  useEffect(() => {
    const ids = [
      ...pendingApprovals.map(request => `approval:${request.approval_id}`),
      ...pendingQuestions.map(request => `question:${request.question_id}`),
    ];
    const hasNew = ids.some(id => !attentionRequestIdsRef.current.has(id));
    for (const id of ids) attentionRequestIdsRef.current.add(id);
    if (hasNew) playNotificationSound('attention');
  }, [pendingApprovals, pendingQuestions]);

  const refreshSessionStatus = useCallback(async (): Promise<SessionRealtimeStatus | null> => {
    if (!sessionId) return null;
    const status = await api.sessions.getStatus(sessionId, agentId);
    if (!hasCurrentScope(scopeRef, sessionId, agentId)) return null;
    sessionStatusScopeRef.current = chatScopeKey(sessionId, agentId);
    setSessionStatus(previous => preserveEqual(previous, status));
    return status;
  }, [agentId, sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const refreshStatus = async () => {
      try {
        let status = await refreshSessionStatus();
        if (disposed || status === null) return;

        if (status.context_usage < 0.78) compactTriggeredRef.current = false;
        if (
          status.context_usage >= 0.8 &&
          status.status !== 'running' &&
          !compactTriggeredRef.current &&
          !compactingRef.current
        ) {
          compactTriggeredRef.current = true;
          compactingRef.current = true;
          setCompacting(true);
          try {
            await api.sessions.compact(sessionId, undefined, agentId);
            status = await refreshSessionStatus();
          } catch (error) {
            console.error('Automatic context compaction failed:', error);
          } finally {
            compactingRef.current = false;
            if (!disposed) setCompacting(false);
          }
        }
      } catch (error) {
        if (!disposed) console.error('Failed to load session usage:', error);
      } finally {
        if (!disposed) timer = setTimeout(refreshStatus, isStreaming ? 1000 : 3000);
      }
    };

    void refreshStatus();
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [isStreaming, refreshSessionStatus, sessionId]);

  const refreshApprovals = useCallback(async () => {
    if (!sessionId) {
      setPendingApprovals([]);
      return;
    }
    const result = await api.sessions.approvals.list(sessionId, agentId);
    if (!hasCurrentScope(scopeRef, sessionId, agentId)) return;
    const now = Date.now();
    const expired = result.items.filter(request => Date.parse(request.expires_at) <= now);
    if (expired.length > 0) {
      await api.abortSession(sessionId, agentId).catch(() => undefined);
      setPendingApprovals([]);
      setIsStreaming(false);
      clearDraft();
      setMessages(previous => mergeHistory(previous, [{
        id: `approval-expired-${sessionId}-${agentId}-${now}`,
        role: 'system',
        text: '工具授权已过期，本轮已自动取消。可以继续发送消息并重试。',
        createdAt: new Date().toISOString(),
      }]));
      return;
    }
    setPendingApprovals(previous => preserveEqual(previous, result.items));
  }, [agentId, clearDraft, sessionId]);

  const refreshQuestions = useCallback(async () => {
    if (!sessionId) {
      setPendingQuestions([]);
      return;
    }
    const result = await api.sessions.questions.list(sessionId, agentId);
    if (hasCurrentScope(scopeRef, sessionId, agentId)) {
      setPendingQuestions(previous => preserveEqual(previous, result.items));
    }
  }, [agentId, sessionId]);

  const refreshPromptQueue = useCallback(async () => {
    if (!sessionId) {
      setQueuedPrompts([]);
      return;
    }
    const result = await api.sessions.prompts.list(sessionId, agentId);
    if (!hasCurrentScope(scopeRef, sessionId, agentId)) return;
    if (result.active) promptIdRef.current = result.active.prompt_id;
    const queued = result.queued.map(prompt => ({
      id: prompt.prompt_id,
      text: prompt.content.filter(part => part.type === 'text').map(part => part.text ?? '').join(''),
      createdAt: prompt.created_at,
    }));
    setQueuedPrompts(previous => preserveEqual(previous, queued));
  }, [agentId, sessionId]);

  useEffect(() => {
    setPendingApprovals([]);
    setPendingQuestions([]);
    setQueuedPrompts([]);
    setCodeChanges([]);
    if (!sessionId) return;
    void refreshApprovals().catch(() => undefined);
    void refreshQuestions().catch(() => undefined);
    void refreshPromptQueue().catch(() => undefined);
    const timer = setInterval(() => {
      void refreshApprovals().catch(() => undefined);
      void refreshQuestions().catch(() => undefined);
      void refreshPromptQueue().catch(() => undefined);
    }, 750);
    return () => clearInterval(timer);
  }, [agentId, refreshApprovals, refreshPromptQueue, refreshQuestions, sessionId]);

  useEffect(() => {
    if (!sessionId) return;

    let disposed = false;
    let reconnectAttempt = 0;
    let subscribeRequestId: string | null = null;
    const eventDeduper = new RealtimeEventDeduper();

    const scheduleHistoryRefresh = () => {
      if (historyRefreshTimerRef.current) clearTimeout(historyRefreshTimerRef.current);
      historyRefreshTimerRef.current = setTimeout(() => {
        historyRefreshTimerRef.current = null;
        if (!disposed && hasCurrentScope(scopeRef, sessionId, agentId)) {
          void refreshHistory(sessionId, agentId, true).catch(error => console.error('Failed to refresh completed turn:', error));
        }
      }, 300);
    };

    const finishTurn = (turnId?: number, refresh = false) => {
      finishLiveTurn(turnId);
      if (refresh) scheduleHistoryRefresh();
    };

    const connect = async () => {
      try {
        const wsUrl = await api.getWsUrl();
        if (disposed) return;
        const protocols = await getWebSocketProtocols();
        if (disposed) return;
        const socket = new WebSocket(wsUrl, protocols);
        wsRef.current = socket;

        socket.onopen = () => {
          if (disposed) {
            socket.close();
            return;
          }
          reconnectAttempt = 0;
          subscriptionGateRef.current.markPending();
          subscribeRequestId = controlId('subscribe');
          socket.send(JSON.stringify({
            type: 'subscribe',
            id: subscribeRequestId,
            payload: { session_ids: [sessionId], agent_ids: { [sessionId]: [agentId] } },
          }));
        };

        socket.onmessage = (event: MessageEvent) => {
          if (disposed) return;
          let data: WsMessage;
          try {
            data = JSON.parse(event.data as string) as WsMessage;
          } catch {
            console.error('Failed to parse WebSocket message:', event.data);
            return;
          }

          if (data.type === 'ping' && data.payload?.nonce) {
            socket.send(JSON.stringify({ type: 'pong', payload: { nonce: data.payload.nonce } }));
            return;
          }
          if (data.type === 'ack') {
            if (data.id !== subscribeRequestId) return;
            const accepted = data.payload?.accepted ?? data.payload?.accepted_subscriptions;
            if (data.code === 0 && Array.isArray(accepted) && accepted.includes(sessionId)) {
              subscriptionGateRef.current.markReady();
            }
            return;
          }
          if (data.type === 'resync_required') {
            void refreshHistory(sessionId, agentId).catch(error => console.error('WebSocket resync failed:', error));
            void hydrateInFlight(sessionId, agentId).catch(error => console.error('In-flight snapshot sync failed:', error));
            return;
          }

          if (!eventDeduper.accept(data)) return;
          const type = normalizeEventType(data.type);
          const payload = data.payload ?? {};
          if (data.session_id && data.session_id !== sessionId) return;
          if (shouldIgnoreTranscriptEvent(type, payload.agentId, agentId)) return;

          switch (type) {
            case 'turn.started':
              if (activeTurnIdRef.current === null && liveWorkBlocksRef.current.length === 0) {
                clearDraft();
              }
              activeTurnIdRef.current = payload.turnId ?? null;
              lastStreamActivityAtRef.current = Date.now();
              turnUsageRef.current = undefined;
              setIsStreaming(true);
              break;
            case 'assistant.delta': {
              const delta = payload.delta ?? '';
              if (!delta) break;
              const reconciled = appendStreamDelta(assistantRawRef.current, delta, data.offset);
              if (reconciled === null) {
                void hydrateInFlight(sessionId, agentId).catch(error => console.error('Assistant stream gap recovery failed:', error));
                break;
              }
              assistantRawRef.current = reconciled.text;
              streamingRef.current += reconciled.appended;
              lastStreamActivityAtRef.current = Date.now();
              applyGeneratedTitle(assistantRawRef.current);
              setCurrentStreaming(stripGeneratedSessionTitle(streamingRef.current));
              setIsStreaming(true);
              break;
            }
            case 'thinking.delta': {
              const delta = payload.delta ?? '';
              if (!delta) break;
              const reconciled = appendStreamDelta(thinkingRawRef.current, delta, data.offset);
              if (reconciled === null) {
                void hydrateInFlight(sessionId, agentId).catch(error => console.error('Thinking stream gap recovery failed:', error));
                break;
              }
              thinkingRawRef.current = reconciled.text;
              thinkingRef.current += reconciled.appended;
              lastStreamActivityAtRef.current = Date.now();
              setCurrentThinking(thinkingRef.current);
              if (reconciled.appended) {
                const previous = liveWorkBlocksRef.current;
                const last = previous.at(-1);
                liveWorkBlocksRef.current = last?.type === 'thinking'
                  ? [...previous.slice(0, -1), { ...last, text: last.text + reconciled.appended }]
                  : [...previous, { id: `live-thinking-${payload.turnId ?? 'turn'}-${previous.length}`, type: 'thinking', text: reconciled.appended }];
                setCurrentWorkBlocks(liveWorkBlocksRef.current);
              }
              setIsStreaming(true);
              break;
            }
            case 'turn.step.completed':
              turnUsageRef.current = addTokenUsage(turnUsageRef.current, normalizeWireUsage(payload.usage));
              break;
            case 'turn.ended':
              if (payload.reason === 'failed') {
                const errorMessage = payload.error?.message;
                if (errorMessage) {
                setMessages(previous => mergeHistory(previous, [{
                  id: `turn-error-${sessionId}-${agentId}-${String(payload.turnId ?? Date.now())}`,
                  role: 'system',
                  text: errorMessage,
                  createdAt: new Date().toISOString(),
                }]));
                }
              }
              // A turn can finish immediately before prompt.completed. Keep
              // the streamed work visible until that prompt-level terminal
              // event commits the complete transcript exactly once.
              break;
            case 'prompt.completed':
              playNotificationSound(payload.reason === 'failed' ? 'error' : 'complete');
              if (streamingRef.current || thinkingRef.current || liveWorkBlocksRef.current.length > 0) {
                finishTurn(activeTurnIdRef.current ?? undefined, true);
              }
              else setIsStreaming(false);
              break;
            case 'prompt.aborted':
              if (payload.promptId) {
                setQueuedPrompts(previous => previous.filter(item => item.id !== payload.promptId));
              }
              if (shouldFinishAbortedPrompt(promptIdRef.current, payload.promptId)) {
                finishTurn(activeTurnIdRef.current ?? undefined, true);
              }
              break;
            case 'tool.call.started':
              lastStreamActivityAtRef.current = Date.now();
              if (payload.toolCallId && payload.name) {
                const existingTool = liveWorkBlocksRef.current.find(
                  block => block.type === 'tool' && block.tool.id === payload.toolCallId,
                );
                if (existingTool?.type === 'tool') {
                  activeToolCallsRef.current.set(payload.toolCallId, existingTool.tool);
                  setIsStreaming(true);
                  break;
                }
                const tool = { id: payload.toolCallId, name: payload.name, args: payload.args, startedAt: Date.now() };
                activeToolCallsRef.current.set(payload.toolCallId, tool);
                const progress = createProgressBlock(
                  `live-progress-${payload.turnId ?? 'turn'}-${liveWorkBlocksRef.current.length}`,
                  streamingRef.current,
                );
                streamingRef.current = '';
                setCurrentStreaming('');
                liveWorkBlocksRef.current = [
                  ...liveWorkBlocksRef.current,
                  ...(progress === undefined ? [] : [progress]),
                  { id: payload.toolCallId, type: 'tool', tool },
                ];
                setCurrentWorkBlocks(liveWorkBlocksRef.current);
                if (payload.name === 'TodoList') {
                  const nextTodos = todosFromToolArgs(payload.args);
                  if (nextTodos !== undefined) setTodos(nextTodos);
                }
              }
              setIsStreaming(true);
              break;
            case 'tool.result':
              lastStreamActivityAtRef.current = Date.now();
              if (payload.toolCallId) {
                const result = serializeToolOutput(payload.output ?? payload.result);
                liveWorkBlocksRef.current = liveWorkBlocksRef.current.map(block => block.type === 'tool' && block.tool.id === payload.toolCallId
                  ? { ...block, tool: { ...block.tool, result, isError: payload.isError === true, endedAt: Date.now() } }
                  : block);
                setCurrentWorkBlocks(liveWorkBlocksRef.current);
                activeToolCallsRef.current.delete(payload.toolCallId);
              }
              break;
            case 'tool.progress':
              lastStreamActivityAtRef.current = Date.now();
              break;
            case 'subagent.started':
              if (payload.subagentId) {
                setActiveSubagentIds(previous => previous.includes(payload.subagentId!) ? previous : [...previous, payload.subagentId!]);
              }
              break;
            case 'subagent.suspended':
            case 'subagent.completed':
            case 'subagent.failed':
              if (payload.subagentId) {
                setActiveSubagentIds(previous => previous.filter(id => id !== payload.subagentId));
              }
              if (type === 'subagent.completed') playNotificationSound('agent-complete');
              if (type === 'subagent.failed') playNotificationSound('error');
              break;
            case 'background.task.terminated': {
              const terminatedAgentId = payload.info?.kind === 'agent'
                ? payload.info.agentId
                : undefined;
              if (terminatedAgentId) {
                setActiveSubagentIds(previous => removeTerminatedAgent(previous, terminatedAgentId));
              }
              break;
            }
            case 'code.change':
              if (payload.path && payload.operation && payload.diff !== undefined) {
                const change: CodeChange = {
                  operationId: payload.operationId,
                  agentId: payload.agentId || 'main',
                  operation: payload.operation,
                  path: payload.path.replaceAll('\\', '/'),
                  diff: payload.diff,
                  occurredAt: payload.occurredAt || new Date().toISOString(),
                };
                setCodeChanges(previous => {
                  const duplicate = previous.some(item => item.agentId === change.agentId && item.path === change.path && item.occurredAt === change.occurredAt);
                  return duplicate ? previous : [change, ...previous].slice(0, 100);
                });
              }
              break;
            case 'goal.updated':
              setSessionStatus(previous => previous === null
                ? previous
                : { ...previous, goal: payload.snapshot ?? null });
              break;
            case 'agent.status.updated':
              setSessionStatus(previous => applyRealtimeStatusEvent(previous, type, payload));
              if (payload.team !== undefined) {
                setAgentTreeRevision(previous => previous + 1);
              }
              if (payload.discussMode === undefined && payload.coderWriteEnabled === undefined) {
                void refreshSessionStatus().catch(error => console.error('Agent status refresh failed:', error));
              }
              break;
            case 'session.status_changed':
              void refreshSessionStatus().catch(error => console.error('Session status refresh failed:', error));
              break;
            case 'discussion.updated':
              if (payload.currentTurnAgentId !== undefined) {
                setDiscussionTurnAgentId(payload.currentTurnAgentId);
              } else {
                setAgentTreeRevision(previous => previous + 1);
              }
              void refreshSessionStatus()
                .catch(error => console.error('Discussion status refresh failed:', error));
              if (payload.discussionAgentId === agentId) {
                void refreshHistory(sessionId, agentId, true)
                  .catch(error => console.error('Discussion history refresh failed:', error));
              }
              break;
            case 'error':
              playNotificationSound('error');
              console.error('Stream error:', payload);
              if (payload.message) {
                setMessages(previous => [...previous, {
                  id: `stream-error-${Date.now()}`,
                  role: 'system',
                  text: payload.message ?? 'Streaming failed',
                  createdAt: new Date().toISOString(),
                }]);
              }
              finishTurn(activeTurnIdRef.current ?? undefined, true);
              break;
            default:
              break;
          }
        };

        socket.onerror = () => {
          if (!disposed) console.error('WebSocket connection error');
        };

        socket.onclose = () => {
          if (wsRef.current === socket) wsRef.current = null;
          subscriptionGateRef.current.markPending();
          if (!disposed) {
            const delay = Math.min(1000 * 2 ** reconnectAttempt, 8000);
            reconnectAttempt += 1;
            reconnectTimerRef.current = setTimeout(() => void connect(), delay);
          }
        };
      } catch (error) {
        if (!disposed) {
          console.error('Failed to connect WebSocket:', error);
          const delay = Math.min(1000 * 2 ** reconnectAttempt, 8000);
          reconnectAttempt += 1;
          reconnectTimerRef.current = setTimeout(() => void connect(), delay);
        }
      }
    };

    void connect();
    return () => {
      disposed = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (historyRefreshTimerRef.current) clearTimeout(historyRefreshTimerRef.current);
      historyRefreshTimerRef.current = null;
      reconnectTimerRef.current = null;
      subscriptionGateRef.current.reset();
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [agentId, clearDraft, finishLiveTurn, hydrateInFlight, refreshHistory, refreshSessionStatus, sessionId]);

  useEffect(() => {
    if (!isStreaming || !sessionId) return;
    const timer = setInterval(() => {
      if (Date.now() - lastStreamActivityAtRef.current < 6000) return;
      void hydrateInFlight(sessionId, agentId)
        .then(inFlight => inFlight ? null : refreshHistory(sessionId, agentId))
        .then(history => {
          if (history === null) return;
          const completedAssistant = history.some(message =>
            message.role === 'assistant' &&
            messageTime(message) >= sendStartedAtRef.current - 2000 &&
            Boolean(message.text.trim() || message.thinking?.trim() || message.toolCalls?.length),
          );
          if (completedAssistant && hasCurrentScope(scopeRef, sessionId, agentId)) {
            setIsStreaming(false);
            clearDraft();
          }
        })
        .catch(() => undefined);
    }, 6000);
    return () => clearInterval(timer);
  }, [agentId, clearDraft, hydrateInFlight, isStreaming, refreshHistory, sessionId]);

  const waitForSubscription = useCallback(async (signal?: AbortSignal): Promise<boolean> => {
    return subscriptionGateRef.current.wait(30_000, signal);
  }, []);

  const sendMessage = useCallback(async (text: string, attachments: PromptAttachment[] = [], behavior: 'queue' | 'steer' = 'queue', options: PromptExecutionOptions = {}) => {
    const trimmed = text.trim();
    if (!sessionId || (!trimmed && attachments.length === 0)) return false;
    if (sendInFlightRef.current) return false;
    const submitScope = chatScopeKey(sessionId, agentId);

    const activeBeforeSubmit = isStreaming || activeTurnIdRef.current !== null;
    const controller = new AbortController();
    sendAbortRef.current = controller;
    sendInFlightRef.current = true;
    let settleSend!: () => void;
    const sendSettled = new Promise<void>(resolve => { settleSend = resolve; });
    sendSettledRef.current = sendSettled;
    if (!activeBeforeSubmit) {
      sendStartedAtRef.current = Date.now();
      lastStreamActivityAtRef.current = Date.now();
    }
    const shouldGenerateTitle = agentId === 'main' && !hasUserPromptRef.current;
    hasUserPromptRef.current = true;
    const visibleText = trimmed;
    const visibleImages = chatImagesFromPromptAttachments(attachments);
    const visibleFiles = chatFilesFromPromptAttachments(attachments);
    const localMessageId = `local-user-${agentId}-${Date.now()}`;
    const optimisticSteer = activeBeforeSubmit && behavior === 'steer';
    const insertedOptimisticMessage = !activeBeforeSubmit || optimisticSteer;
    if (!activeBeforeSubmit) {
      clearDraft();
      setMessages(previous => [...previous, {
        id: localMessageId,
        role: 'user',
        text: visibleText,
        images: visibleImages.length > 0 ? visibleImages : undefined,
        files: visibleFiles.length > 0 ? visibleFiles : undefined,
        createdAt: new Date().toISOString(),
      }]);
    } else if (optimisticSteer) {
      const boundaryTime = new Date().toISOString();
      const boundaryText = stripGeneratedSessionTitle(streamingRef.current);
      const boundaryThinking = thinkingRef.current;
      const boundaryProgress = createProgressBlock(`live-steer-progress-${sessionId}-${agentId}-${Date.now()}`, boundaryText);
      const boundaryWorkBlocks = [
        ...liveWorkBlocksRef.current,
        ...(boundaryProgress === undefined ? [] : [boundaryProgress]),
      ];
      const boundaryToolCalls = boundaryWorkBlocks.flatMap(block => block.type === 'tool' ? [block.tool] : []);
      const boundaryAssistant: ChatMessage | null =
        boundaryThinking || boundaryWorkBlocks.length > 0
          ? {
              id: `live-steer-boundary-${sessionId}-${agentId}-${Date.now()}`,
              role: 'assistant',
              text: '',
              thinking: boundaryThinking || undefined,
              workBlocks: boundaryWorkBlocks.length > 0 ? boundaryWorkBlocks : undefined,
              toolCalls: boundaryToolCalls.length > 0 ? boundaryToolCalls : undefined,
              usage: turnUsageRef.current,
              createdAt: boundaryTime,
            }
          : null;
      setMessages(previous => insertSteerBoundary(
        previous,
        boundaryAssistant,
        {
          id: localMessageId,
          role: 'user',
          text: visibleText,
          images: visibleImages.length > 0 ? visibleImages : undefined,
          files: visibleFiles.length > 0 ? visibleFiles : undefined,
          createdAt: boundaryTime,
        },
      ));

      // Keep raw stream accumulators for offset reconciliation. Only start a
      // fresh visible segment after the inserted user guidance.
      streamingRef.current = '';
      thinkingRef.current = '';
      liveWorkBlocksRef.current = [];
      setCurrentStreaming('');
      setCurrentThinking('');
      setCurrentWorkBlocks([]);
    }
    setIsStreaming(true);

    try {
      const subscribed = await waitForSubscription(controller.signal);
      if (!subscribed) throw new Error('Realtime connection is not ready. Please retry.');
      if (controller.signal.aborted) return false;
      const promptText = trimmed || 'Please inspect the attached files.';
      if (shouldGenerateTitle) titlePromptRef.current = promptText;
      const response = await api.sendPrompt(
        sessionId,
        shouldGenerateTitle ? firstPromptWithTitleInstruction(promptText) : promptText,
        attachments,
        { ...options, agentId },
        controller.signal,
      );
      if (scopeRef.current !== submitScope) {
        await releasePromptFileBlobs(attachments);
        return false;
      }
      if (response.status === 'queued') {
        setQueuedPrompts(previous => previous.some(item => item.id === response.prompt_id) ? previous : [...previous, { id: response.prompt_id, text: visibleText, createdAt: response.created_at }]);
        if (behavior === 'steer') {
          try {
            await api.sessions.prompts.steer(sessionId, [response.prompt_id], agentId);
          } catch (error) {
            // A failed immediate steer must not silently remain queued and run
            // later as an unrelated turn.
            await api.sessions.prompts.abort(sessionId, response.prompt_id, agentId).catch(() => undefined);
            setQueuedPrompts(previous => previous.filter(item => item.id !== response.prompt_id));
            throw error;
          }
          setQueuedPrompts(previous => previous.filter(item => item.id !== response.prompt_id));
        }
      } else {
        promptIdRef.current = response.prompt_id;
        if (!insertedOptimisticMessage) {
          setMessages(previous => mergeHistory(previous, [{
            id: response.user_message_id,
            role: 'user',
            text: visibleText,
            images: visibleImages.length > 0 ? visibleImages : undefined,
            files: visibleFiles.length > 0 ? visibleFiles : undefined,
            createdAt: response.created_at,
          }]));
        }
      }
      if (insertedOptimisticMessage) {
        setMessages(previous => confirmOptimisticUserMessage(
          previous,
          localMessageId,
          response.user_message_id,
          response.created_at,
        ));
      }
      await releasePromptFileBlobs(attachments);
      return true;
    } catch (error) {
      if (controller.signal.aborted) return false;
      if (shouldGenerateTitle) hasUserPromptRef.current = false;
      if (insertedOptimisticMessage) {
        setMessages(previous => previous.filter(message => message.id !== localMessageId));
      }
      setMessages(previous => [...previous, {
        id: `send-error-${Date.now()}`,
        role: 'system',
        text: `Error: ${error instanceof Error ? error.message : 'Failed to send message'}`,
        createdAt: new Date().toISOString(),
      }]);
      if (!activeBeforeSubmit) setIsStreaming(false);
      return false;
    } finally {
      settleSend();
      if (sendAbortRef.current === controller) sendAbortRef.current = null;
      if (sendSettledRef.current === sendSettled) sendSettledRef.current = null;
      sendInFlightRef.current = false;
    }
  }, [agentId, clearDraft, isStreaming, sessionId, waitForSubscription]);

  const cancelQueuedPrompt = useCallback(async (promptId: string) => {
    if (!sessionId) return;
    await api.sessions.prompts.abort(sessionId, promptId, agentId);
    setQueuedPrompts(previous => previous.filter(item => item.id !== promptId));
  }, [agentId, sessionId]);

  const abort = useCallback(async (): Promise<boolean> => {
    if (!sessionId) return false;
    const abortRequest = api.abortSession(sessionId, agentId);
    sendAbortRef.current?.abort();
    await sendSettledRef.current?.catch(() => undefined);
    try {
      await abortRequest;
      const stillRunning = await hydrateInFlight(sessionId, agentId).catch(() => true);
      if (!stillRunning) {
        finishLiveTurn(activeTurnIdRef.current ?? undefined);
      }
      return true;
    } catch (error) {
      setMessages(previous => [...previous, {
        id: `abort-error-${agentId}-${Date.now()}`,
        role: 'system',
        text: `Error: ${error instanceof Error ? error.message : 'Failed to stop response'}`,
        createdAt: new Date().toISOString(),
      }]);
      return false;
    }
  }, [agentId, finishLiveTurn, hydrateInFlight, sessionId]);

  const rewindToPrompt = useCallback(async (count: number) => {
    if (!sessionId || isStreaming) return undefined;
    const prompt = promptForRewind(messages, count);
    const result = await api.sessions.undo(sessionId, count, agentId);
    if (!hasCurrentScope(scopeRef, sessionId, agentId)) return undefined;
    clearDraft();
    setPendingApprovals([]);
    setPendingQuestions([]);
    setQueuedPrompts([]);
    setIsStreaming(false);
    hasUserPromptRef.current = true;
    applyHistoryItems(result.messages.items, sessionId, agentId, true);
    if (hasCurrentScope(scopeRef, sessionId, agentId)) {
      sessionStatusScopeRef.current = chatScopeKey(sessionId, agentId);
      setSessionStatus(previous => preserveEqual(previous, result.status));
    }
    return prompt;
  }, [agentId, applyHistoryItems, clearDraft, isStreaming, messages, sessionId]);

  const refreshMessages = useCallback(async () => {
    if (!sessionId) return;
    await refreshHistory(sessionId, agentId, true);
  }, [agentId, refreshHistory, sessionId]);

  const resolveApproval = useCallback(async (
    approvalId: string,
    decision: 'approved' | 'rejected' | 'cancelled',
    options: { remember?: boolean; feedback?: string; selectedLabel?: string } = {},
  ) => {
    if (!sessionId) return;
    try {
      await api.sessions.approvals.resolve(sessionId, approvalId, {
        decision,
        remember: options.remember,
        feedback: options.feedback,
        selected_label: options.selectedLabel,
        agent_id: agentId,
      });
      setPendingApprovals(previous => previous.filter(request => request.approval_id !== approvalId));
      setIsStreaming(true);
      await refreshApprovals();
    } catch (error) {
      await api.abortSession(sessionId, agentId).catch(() => undefined);
      setPendingApprovals([]);
      setIsStreaming(false);
      clearDraft();
      setMessages(previous => [...previous, {
        id: `approval-error-${agentId}-${Date.now()}`,
        role: 'system',
        text: error instanceof Error ? error.message : '工具授权失败，本轮已取消。',
        createdAt: new Date().toISOString(),
      }]);
    }
  }, [agentId, clearDraft, refreshApprovals, sessionId]);

  const resolveQuestion = useCallback(async (questionId: string, answers: Record<string, QuestionAnswer>) => {
    if (!sessionId) return;
    await api.sessions.questions.resolve(sessionId, questionId, answers, agentId);
    setPendingQuestions(previous => previous.filter(request => request.question_id !== questionId));
    setIsStreaming(true);
    await refreshQuestions();
  }, [agentId, refreshQuestions, sessionId]);

  const dismissQuestion = useCallback(async (questionId: string) => {
    if (!sessionId) return;
    await api.sessions.questions.dismiss(sessionId, questionId, agentId);
    setPendingQuestions(previous => previous.filter(request => request.question_id !== questionId));
    await refreshQuestions();
  }, [agentId, refreshQuestions, sessionId]);

  return { messages, messagesLoading, isStreaming, currentStreaming, currentThinking, currentWorkBlocks, sessionStatus: statusForSession(sessionStatus, sessionStatusScopeRef.current, chatScopeKey(sessionId, agentId)), agentTreeRevision, discussionTurnAgentId, refreshSessionStatus, compacting, pendingApprovals, pendingQuestions, queuedPrompts, todos, activeSubagentIds, codeChanges, resolveApproval, resolveQuestion, dismissQuestion, sendMessage, cancelQueuedPrompt, rewindToPrompt, refreshMessages, abort };
}

export function statusForSession(
  status: SessionRealtimeStatus | null,
  statusSessionId: string | null,
  currentSessionId: string | null,
): SessionRealtimeStatus | null {
  return currentSessionId !== null && statusSessionId === currentSessionId ? status : null;
}

export function removeTerminatedAgent(
  activeAgentIds: readonly string[],
  terminatedAgentId: string,
): string[] {
  return activeAgentIds.filter(id => id !== terminatedAgentId);
}

function preserveEqual<T>(previous: T, next: T): T {
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}

function serializeToolOutput(output: unknown): string | undefined {
  if (output === undefined) return undefined;
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output);
  } catch {
    return output instanceof Error ? output.message : '[unserializable tool output]';
  }
}

export function shouldIgnoreTranscriptEvent(
  type: string,
  eventAgentId?: string,
  selectedAgentId = 'main',
): boolean {
  return isMainTranscriptEvent(type) && (eventAgentId ?? 'main') !== selectedAgentId;
}

function isMainTranscriptEvent(type: string): boolean {
  return type.startsWith('turn.')
    || type.startsWith('assistant.')
    || type.startsWith('thinking.')
    || type.startsWith('tool.call.')
    || type === 'tool.progress'
    || type === 'tool.result'
    || type === 'prompt.completed'
    || type === 'prompt.aborted'
    || type === 'error';
}
