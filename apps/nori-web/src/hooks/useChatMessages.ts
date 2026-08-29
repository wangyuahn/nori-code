/**
 * Session chat state: REST history plus the live WebSocket event stream.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, getWebSocketProtocols, type ApprovalRequest, type GoalSnapshot, type Message, type MessageContent, type PromptAttachment, type PromptExecutionOptions, type QuestionAnswer, type QuestionRequest, type SessionAgentChatResponse, type SessionRealtimeStatus, type TokenUsage } from '../api/client';
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

export interface ContextInjectionBlock {
  id: string;
  type: 'context';
  source: string;
  content?: string;
  isError?: boolean;
}

export type WorkBlock =
  | { id: string; type: 'thinking'; text: string }
  | { id: string; type: 'progress'; text: string }
  | ContextInjectionBlock
  | { id: string; type: 'tool'; tool: ToolCall };

export interface TodoItem {
  title: string;
  status: 'pending' | 'in_progress' | 'done';
}

export interface ChatMessage {
  id: string;
  /** Logical model turn shared by all assistant steps in one response. */
  turnId?: string;
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
  /** Internal history marker. Folded into the matching assistant turn. */
  toolResult?: {
    toolCallId: string;
    output?: string;
    isError?: boolean;
    contextInjection?: boolean;
  };
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
  activeTurnId: string | null;
  sessionStatus: SessionRealtimeStatus | null;
  agentTreeRevision: number;
  discussionTurnAgentId: string | null | undefined;
  departmentChat: SessionAgentChatResponse;
  refreshDepartmentChat: () => Promise<void>;
  refreshSessionStatus: () => Promise<SessionRealtimeStatus | null>;
  compacting: boolean;
  pendingApprovals: ApprovalRequest[];
  pendingQuestions: QuestionRequest[];
  queuedPrompts: QueuedPrompt[];
  todos: TodoItem[];
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
  step?: number;
  /** `turn.step.completed`: why the step ended — `tool_use` means more is coming. */
  finishReason?: string;
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
  /**
   * Structured cause of an `error` event, spread from the core's
   * `summarizeTurnError`. Carries `turnId` when the failure belongs to a turn.
   */
  details?: Record<string, unknown>;
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
  discussionAgentId?: string;
  currentTurnAgentId?: string | null;
  kind?: string;
  runInBackground?: boolean;
  info?: {
    kind?: string;
    agentId?: string;
  };
  /** `session.meta.updated`: durable metadata patch (e.g. agents tree). */
  patch?: Record<string, unknown>;
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

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})[^\r\n]*$/;
const UNWRAPPABLE_FENCE_INFO = new Set(['', 'html', 'markdown', 'md']);

function isBareFenceLine(line: string, marker: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= marker.length && trimmed === marker[0].repeat(trimmed.length);
}

function looksLikeWrappedMarkdown(body: string, info: string): boolean {
  if (/^\s*<nori-session-title/i.test(body)) return true;
  // A nested fence inside the outer one is the smoking gun: its closing line is
  // what CommonMark used to end the outer block, which is why the prose leaked.
  if (body.split('\n').some(line => FENCE_LINE.test(line))) return true;
  // Markdown headings inside ```html mean prose, not a page's source. Not applied
  // to ```markdown, where showing the raw source is usually the whole point.
  return info === 'html' && /^ {0,3}#{1,6}\s/m.test(body);
}

/**
 * Models asked to open the reply with `<nori-session-title>` often conclude the
 * whole answer is markup and wrap it in a ```html fence. CommonMark then closes
 * that fence at the first bare ``` line — the *closing* line of a nested code
 * block — so everything above it renders as one preformatted blob with literal
 * `**` and backticks. Strip the outer fence so the answer renders as markdown.
 *
 * The closing fence is optional: streaming text has to unwrap as it arrives.
 */
export function unwrapWholeAnswerCodeFence(text: string): string {
  const lines = text.split('\n');
  let open = 0;
  while (open < lines.length && lines[open].trim() === '') open += 1;
  const opener = FENCE_LINE.exec(lines[open] ?? '');
  if (!opener) return text;
  const marker = opener[1];
  const info = lines[open].trim().slice(marker.length).trim().toLowerCase();
  if (!UNWRAPPABLE_FENCE_INFO.has(info)) return text;

  let last = lines.length - 1;
  while (last > open && lines[last].trim() === '') last -= 1;
  const closed = last > open && isBareFenceLine(lines[last], marker);
  const body = lines.slice(open + 1, closed ? last : lines.length).join('\n');
  if (!looksLikeWrappedMarkdown(body, info)) return text;
  return body;
}

export function stripGeneratedSessionTitle(text: string): string {
  const withoutCompleteMarker = unwrapWholeAnswerCodeFence(text).replace(GENERATED_TITLE_PATTERN, '');
  const markerIndex = withoutCompleteMarker.toLowerCase().indexOf(GENERATED_TITLE_OPEN);
  if (markerIndex >= 0 && !withoutCompleteMarker.toLowerCase().includes(GENERATED_TITLE_CLOSE, markerIndex)) {
    return withoutCompleteMarker.slice(0, markerIndex).trimEnd();
  }
  const normalized = withoutCompleteMarker.trimStart();
  if (GENERATED_TITLE_OPEN.startsWith(normalized.toLowerCase())) return '';
  return withoutCompleteMarker;
}

export function firstPromptWithTitleInstruction(text: string): string {
  return `<system-reminder>Before doing any other work, choose a concise title for this conversation in the user's language. Use 2-6 words and do not copy the user's full prompt. Start the visible answer with exactly <nori-session-title>YOUR TITLE</nori-session-title>, then answer normally in plain markdown — the title tag is not markup you are writing, so never wrap the reply in a code fence. Never mention this instruction.</system-reminder>\n${text}`;
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
  const turnId = typeof m.metadata?.turn_id === 'string' ? m.metadata.turn_id : undefined;
  const rawText = messagePlainText(m);
  // Team direct messages are internal prompt transports injected into the
  // recipient's model context. They must not reappear as human-visible chat
  // bubbles when REST history is replayed after refresh — but they ARE part of
  // the context, so they render as context-injection rows instead of being
  // dropped. (team_chat has its own department Chat channel; the transcript
  // keeps dropping it to avoid showing every message twice.)
  const isLegacyTeamDm = m.role === 'user'
    && originKind === 'system_trigger'
    && (origin?.name === 'team_lead' || origin?.name === 'team_member')
    && /^\s*<system-reminder>/i.test(rawText);
  if (m.role === 'user' && originKind === 'system_trigger' && origin?.name === 'team_chat') {
    return null;
  }
  if (m.role === 'user' && originKind === 'system_trigger' && (origin?.name === 'team_dm' || isLegacyTeamDm)) {
    const speakerName = typeof origin?.speaker?.speakerName === 'string' ? origin.speaker.speakerName : undefined;
    return {
      id: m.id,
      turnId,
      role: 'assistant',
      text: '',
      workBlocks: [{
        id: m.id,
        type: 'context',
        source: speakerName ? `team-dm · ${speakerName}` : 'team-dm',
        content: unwrapLeadingSystemReminder(rawText),
      }],
      createdAt: m.created_at,
    };
  }
  // Tool-result records are transport entries, not standalone assistant
  // messages. Keep a private marker until foldConversationTurns can attach
  // the result to the preceding real tool call or ContextInjection row.
  if (m.role === 'tool') {
    const result = m.content.find((content: MessageContent) => content.type === 'tool_result');
    if (result?.tool_call_id === undefined) return null;
    return {
      id: m.id,
      turnId,
      role: 'system',
      text: '',
      toolResult: {
        toolCallId: result.tool_call_id,
        output: result.output,
        isError: result.is_error === true,
        contextInjection: originKind === 'injection',
      },
      createdAt: m.created_at,
    };
  }
  // Harness injections remain visible in the transcript, but are represented
  // as context rows rather than user bubbles or callable tools.
  if (m.role === 'user' && originKind === 'injection') {
    return {
      id: m.id,
      turnId,
      role: 'assistant',
      text: '',
      workBlocks: [{
        id: m.id,
        type: 'context',
        source: typeof origin?.variant === 'string' ? origin.variant : 'harness',
        content: unwrapLeadingSystemReminder(rawText),
      }],
      createdAt: m.created_at,
    };
  }
  const speaker = toDiscussionSpeaker(origin?.speaker);
  if (m.role === 'user' && originKind !== undefined && originKind !== 'user') {
    if (isSilentWakeOrigin(originKind)) {
      return { id: m.id, turnId, role: 'system', text: '', createdAt: m.created_at, turnBoundary: true };
    }
    if (speaker !== undefined) {
      return {
        id: m.id,
        turnId,
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

  const contextInjections: ContextInjectionBlock[] = [];
  let toolCalls: ToolCall[] = [];

  for (const tc of m.tool_calls ?? []) {
    if (tc.name === 'ContextInjection') {
      contextInjections.push({
        id: tc.id ?? `${m.id}-context-${contextInjections.length}`,
        type: 'context',
        source: contextInjectionSource(tc.args, origin?.variant),
        content: tc.result,
        isError: tc.is_error,
      });
      continue;
    }
    // `tool` was an old UI fallback, never a real callable tool. Do not
    // resurrect it from stale protocol data.
    if (!isRenderableToolName(tc.name)) continue;
    toolCalls = mergeToolCalls(toolCalls, [{
      id: tc.id,
      name: tc.name,
      args: tc.args,
      result: tc.result,
      isError: tc.is_error,
    }]);
  }

  if (Array.isArray(m.content)) {
    for (const c of m.content) {
      if (c.type === 'tool_use') {
        const name = c.tool_name ?? c.name;
        if (name === 'ContextInjection') {
          const id = c.tool_call_id ?? `${m.id}-context-${contextInjections.length}`;
          const existing = contextInjections.find(block => block.id === id);
          if (existing === undefined) {
            contextInjections.push({
              id,
              type: 'context',
              source: contextInjectionSource(c.input, origin?.variant),
            });
          }
        } else if (name !== undefined && isRenderableToolName(name)) {
          toolCalls = mergeToolCalls(toolCalls, [{ id: c.tool_call_id, name, args: c.input }]);
        }
      } else if (c.type === 'tool_result') {
        const matching = toolCalls.find(tool => tool.id && tool.id === c.tool_call_id);
        if (matching) {
          matching.result = c.output;
          matching.isError = c.is_error === true;
        } else {
          const context = contextInjections.find(block => block.id === c.tool_call_id);
          if (context !== undefined) {
            context.content = c.output;
            context.isError = c.is_error === true;
          }
        }
      }
    }
  }

  const thinking = m.thinking || thinkingFromContent || undefined;
  const textIsProgress = m.role === 'assistant' && toolCalls.length > 0 && Boolean(text.trim());
  const workBlocks = workBlocksFromMessage(m, toolCalls, contextInjections, thinking, textIsProgress ? text : undefined);
  const parsedUploads = m.role === 'user' ? splitUploadedFileMarkup(text) : { text, files: [] as ChatFile[] };
  const files = [...contentFileParts(m.content), ...parsedUploads.files];
  const visibleText = textIsProgress ? '' : (m.role === 'user' ? parsedUploads.text : text);
  if (!visibleText && !thinking && toolCalls.length === 0 && contextInjections.length === 0 && images.length === 0 && files.length === 0) return null;

  return {
    id: m.id,
    turnId,
    role: m.role,
    text: visibleText,
    images: images.length > 0 ? images : undefined,
    files: files.length > 0 ? files : undefined,
    thinking,
    workBlocks: workBlocks.length > 0 ? workBlocks : undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    createdAt: m.created_at,
};
}

function isRenderableToolName(name: string): boolean {
  const normalized = name.trim();
  return normalized.length > 0 && normalized !== 'tool';
}

function contextInjectionSource(args: unknown, fallback: unknown): string {
  if (typeof args === 'object' && args !== null) {
    const source = (args as { source?: unknown }).source;
    if (typeof source === 'string' && source.length > 0) return source;
    const variant = (args as { variant?: unknown }).variant;
    if (typeof variant === 'string' && variant.length > 0) return variant;
  }
  return typeof fallback === 'string' && fallback.length > 0 ? fallback : 'harness';
}

/**
 * Fold everything one user command produced into a single UI response.
 *
 * The grouping key is the command itself, not the model turn id: one command
 * can legitimately span several server turns (a retry after a failure, work
 * continued after a discussion round), and all of it belongs to the same work
 * process. Only a real user message — or a silent wake-up boundary, which
 * answers a background event rather than the command — starts a new row.
 * Interleaved rows (discussion statements, failure notices) keep their
 * transcript position; they render where they happened without breaking the
 * group around them.
 */
export function foldConversationTurns(messages: ChatMessage[]): ChatMessage[] {
  const folded: ChatMessage[] = [];
  /** Index in `folded` of the row collecting the current command's work. */
  let commandRowIndex: number | undefined;
  for (const message of messages) {
    if (message.turnBoundary) {
      commandRowIndex = undefined;
      continue;
    }
    if (message.role === 'user') {
      commandRowIndex = undefined;
      folded.push(message);
      continue;
    }
    if (message.toolResult !== undefined) {
      // A result lands in the row that holds its call. Scanning backwards makes
      // the call's row — not the turn id — the anchor, so results that arrive
      // after a turn boundary inside the same command still reach their call.
      // An orphan result is transport noise; never invent a fake `tool` row.
      for (let index = folded.length - 1; index >= 0; index--) {
        const target = folded[index];
        if (target === undefined) continue;
        const merged = mergeToolResultIntoChat(target, message.toolResult);
        if (merged === undefined) continue;
        folded[index] = merged;
        break;
      }
      continue;
    }
    if (message.role === 'assistant') {
      const current = commandRowIndex === undefined ? undefined : folded[commandRowIndex];
      // Transient live rows are ephemeral UI state for the in-flight answer, not
      // additional work: they never join a confirmed row, and a confirmed row
      // never joins a live one — otherwise a refreshed history would duplicate
      // the answer inside the live row it confirms.
      const joinable = current !== undefined
        && !isTransientChatMessageId(current.id)
        && !isTransientChatMessageId(message.id);
      if (current === undefined || !joinable) {
        commandRowIndex = folded.length;
        folded.push(message);
      } else if (commandRowIndex !== undefined) {
        folded[commandRowIndex] = mergeAssistantWork(current, message);
      }
      continue;
    }
    folded.push(message);
  }
  return folded;
}

function mergeAssistantWork(previous: ChatMessage, incoming: ChatMessage): ChatMessage {
  const previousText = previous.text.trim();
  const incomingText = incoming.text.trim();
  // 合并意味着 previous 的文本不再是这一轮的结尾输出，所以它必须变成流水里的
  // 一段输出块留在原位；否则它会被顶到所有工具行的后面，显示位置就错了。
  const previousProgress = previousText && previousText !== incomingText
    ? createProgressBlock(`${previous.id}-turn-progress`, previous.text)
    : undefined;
  const blocks = mergeWorkBlocks(previous.workBlocks ?? [], [
    ...(previousProgress === undefined ? [] : [previousProgress]),
    ...(incoming.workBlocks ?? []),
  ]);
  return {
    ...previous,
    // The latest turn id wins: the live stream attaches to the row carrying the
    // turn that is currently running, which is the last one folded in.
    turnId: incoming.turnId ?? previous.turnId,
    text: incomingText ? incoming.text : previousProgress === undefined ? previous.text : '',
    thinking: incoming.thinking ?? previous.thinking,
    workBlocks: blocks,
    toolCalls: mergeToolCalls(previous.toolCalls ?? [], incoming.toolCalls ?? []),
    usage: incoming.usage ?? previous.usage,
    createdAt: incoming.createdAt ?? previous.createdAt,
  };
}

function mergeToolResultIntoChat(
  message: ChatMessage,
  result: NonNullable<ChatMessage['toolResult']>,
): ChatMessage | undefined {
  if (result.contextInjection) {
    const blocks = message.workBlocks ?? [];
    const index = blocks.findIndex(block => block.type === 'context' && block.id === result.toolCallId);
    if (index < 0) return undefined;
    return {
      ...message,
      workBlocks: blocks.map((block, blockIndex) => blockIndex === index && block.type === 'context'
        ? { ...block, content: result.output, isError: result.isError }
        : block),
    };
  }

  const calls = message.toolCalls ?? [];
  const callIndex = calls.findIndex(call => call.id === result.toolCallId);
  if (callIndex < 0) return undefined;
  const nextCalls = calls.map((call, index) => index === callIndex
    ? { ...call, result: result.output, isError: result.isError }
    : call);
  const nextBlocks = (message.workBlocks ?? []).map(block => block.type === 'tool' && block.tool.id === result.toolCallId
    ? { ...block, tool: { ...block.tool, result: result.output, isError: result.isError } }
    : block);
  return {
    ...message,
    toolCalls: nextCalls,
    workBlocks: nextBlocks.length > 0 ? nextBlocks : message.workBlocks,
  };
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
  contextInjections: ContextInjectionBlock[],
  thinking: string | undefined,
  progressText?: string,
): WorkBlock[] {
  const blocks: WorkBlock[] = [];
  let thinkingIndex = 0;
  const representedToolIds = new Set<string>();
  const representedContextIds = new Set<string>();
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
    const context = id ? contextInjections.find(candidate => candidate.id === id) : undefined;
    if (context !== undefined) {
      if (!representedContextIds.has(context.id)) {
        blocks.push({ ...context });
        representedContextIds.add(context.id);
      }
      continue;
    }
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
  for (const context of contextInjections) {
    if (representedContextIds.has(context.id)) continue;
    blocks.push({ ...context });
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

export function mergeWorkBlocks(previous: WorkBlock[], incoming: WorkBlock[]): WorkBlock[] {
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
    if (block.type === 'context') {
      const index = merged.findIndex(candidate => candidate.type === 'context' && candidate.id === block.id);
      if (index >= 0) {
        merged[index] = { ...block };
        continue;
      }
    }
    if (block.type === 'thinking' || block.type === 'progress') {
      const index = merged.findIndex(candidate =>
        candidate.type === block.type
        && (candidate.id === block.id
          || candidate.text === block.text
          || candidate.text.startsWith(block.text)
          || block.text.startsWith(candidate.text)),
      );
      if (index >= 0) {
        const existing = merged[index];
        if (existing?.type === block.type && block.text.length >= existing.text.length) merged[index] = { ...block };
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
    if (local.role === 'assistant' && local.turnId !== undefined && isTransientChatMessageId(local.id)) {
      const authoritativeTurn = remote.find(message =>
        message.role === 'assistant' && message.turnId === local.turnId,
      );
      if (authoritativeTurn !== undefined) continue;
    }
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

/**
 * A REST replace is authoritative for everything the server records — but a
 * failure notice is not recorded anywhere: it is signalled once, on the socket.
 * Dropping it on the next refresh is how a failed round ends up looking like it
 * simply never happened, with no way to see what went wrong.
 */
export function isClientNoticeId(id: string): boolean {
  return id.startsWith('turn-error-') || id.startsWith('stream-error-');
}

/**
 * What the reader gets to see about a failed turn. The provider's own wording is
 * the useful part — "max output tokens exceeded", an auth failure, a rate limit —
 * so it leads, with the code kept for anything that has to be looked up or
 * reported, and a fallback for a failure that arrived with no detail at all.
 */
export function turnFailureText(error: { message?: string; code?: string; details?: unknown } | undefined): string {
  const message = error?.message?.trim();
  const code = error?.code?.trim();
  if (message && code) return `${message}\n\n\`${code}\``;
  if (message) return message;
  if (code) return `Turn failed: \`${code}\``;
  return 'Turn failed without a reported cause.';
}

/**
 * Whether a stream `error` event was already rendered by the `turn.ended` branch.
 *
 * A failed turn emits BOTH `turn.ended{reason:'failed', error}` and a trailing
 * `error` event carrying the same `summarizeTurnError` payload — the core emits
 * the second one deliberately just past the turn boundary. Rendering both printed
 * every provider failure as two near-identical red blocks, one with the error code
 * and one without. `summarizeTurnError` stamps `details.turnId` on anything
 * turn-scoped, so that field is the reliable way to tell the two apart. Errors
 * without it — MCP startup, compaction, a rejected launch — have no `turn.ended`
 * to ride on and must still be shown.
 */
export function isTurnScopedError(payload: { details?: unknown } | undefined): boolean {
  const details = payload?.details;
  if (typeof details !== 'object' || details === null) return false;
  return (details as Record<string, unknown>)['turnId'] !== undefined;
}

export function reconcileHistory(previous: ChatMessage[], remote: ChatMessage[]): ChatMessage[] {
  // A replace is an authoritative REST snapshot. Never rename its stable
  // message ids to temporary UI ids by matching message text.
  const folded = foldConversationTurns(remote);
  const notices = previous.filter(message => isClientNoticeId(message.id)
    && !folded.some(candidate => candidate.id === message.id));
  if (notices.length === 0) return folded;
  const result = [...folded];
  for (const notice of notices) {
    const at = notice.createdAt === undefined
      ? result.length
      : result.findIndex(candidate => messageTime(candidate) > messageTime(notice));
    result.splice(at < 0 ? result.length : at, 0, notice);
  }
  return result;
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
  turnId?: string;
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
    turnId: input.turnId,
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

/** The agent every session starts with. Its id is the transcript's default scope. */
export const MAIN_AGENT_ID = 'main';

export function chatScopeKey(sessionId: string | null, agentId = MAIN_AGENT_ID): string | null {
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
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionRealtimeStatus | null>(null);
  const [agentTreeRevision, setAgentTreeRevision] = useState(0);
  const [discussionTurnAgentId, setDiscussionTurnAgentId] = useState<string | null | undefined>(undefined);
  const [departmentChat, setDepartmentChat] = useState<SessionAgentChatResponse>({ department_leader_agent_id: null, messages: [] });
  const [compacting, setCompacting] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([]);
  const [pendingQuestions, setPendingQuestions] = useState<QuestionRequest[]>([]);
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([]);
  const [todos, setTodos] = useState<TodoItem[]>([]);
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
  const activeTurnIdRef = useRef<string | null>(null);
  const completedTurnIdsRef = useRef(new Set<string>());
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

  const finishLiveTurn = useCallback((turnId?: string) => {
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
        turnId,
        text: stripGeneratedSessionTitle(streamingRef.current),
        thinking: thinkingRef.current,
        workBlocks: liveWorkBlocksRef.current,
        usage: turnUsageRef.current,
      });
      if (completed) setMessages(previous => mergeHistory(previous, [completed]));
    }

    setIsStreaming(false);
    activeTurnIdRef.current = null;
    setActiveTurnId(null);
    promptIdRef.current = null;
    turnUsageRef.current = undefined;
    clearDraft();
  }, [agentId, applyGeneratedTitle, clearDraft, sessionId]);

  const hydrateInFlight = useCallback(async (targetSessionId: string, targetAgentId = agentId) => {
    const snapshot = await api.sessions.getSnapshot(targetSessionId, targetAgentId);
    if (!hasCurrentScope(scopeRef, targetSessionId, targetAgentId)) return false;
    setPendingApprovals(previous => preserveEqual(previous, snapshot.pending_approvals ?? []));
    setPendingQuestions(previous => preserveEqual(previous, snapshot.pending_questions ?? []));
    const inFlight = snapshot.in_flight_turn;
    if (!inFlight) return false;
    const snapshotTurnId = String(inFlight.turn_id);
    const isSameTurn = activeTurnIdRef.current === snapshotTurnId;
    // Only the open step is missing from history: every completed step of this
    // turn is durable and arrives through refreshHistory, already interleaved
    // with the tools that ran between the narrations. Rendering the turn-wide
    // text here would repeat all of it as one block below those tools.
    const stepAssistantText = inFlight.step_assistant_text ?? inFlight.assistant_text;
    const stepThinkingText = inFlight.step_thinking_text ?? inFlight.thinking_text;
    const restoredProgress = inFlight.running_tools.length > 0
      ? createProgressBlock(`snapshot-progress-${inFlight.turn_id}`, stepAssistantText)
      : undefined;
    // The refs stay turn-wide: a delta's offset is measured against the whole turn.
    assistantRawRef.current = inFlight.assistant_text;
    thinkingRawRef.current = inFlight.thinking_text;
    activeTurnIdRef.current = snapshotTurnId;
    setActiveTurnId(snapshotTurnId);
    activeToolCallsRef.current.clear();
    const snapshotBlocks: WorkBlock[] = [
      ...(stepThinkingText.trim()
        ? [{ id: `snapshot-thinking-${inFlight.turn_id}`, type: 'thinking' as const, text: stepThinkingText }]
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
      streamingRef.current = restoredProgress === undefined ? stepAssistantText : '';
      thinkingRef.current = stepThinkingText;
      setCurrentStreaming(restoredProgress === undefined ? stripGeneratedSessionTitle(stepAssistantText) : '');
      setCurrentThinking(stepThinkingText);
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

  const refreshDepartmentChat = useCallback(async (targetSessionId = sessionId, targetAgentId = agentId) => {
    if (!targetSessionId || targetAgentId === 'main') return;
    try {
      const chat = await api.sessions.getDepartmentChat(targetSessionId, targetAgentId);
      if (hasCurrentScope(scopeRef, targetSessionId, targetAgentId)) {
        setDepartmentChat(previous => preserveEqual(previous, chat));
      }
    } catch (error) {
      console.error('Failed to load department chat:', error);
    }
  }, [agentId, sessionId]);

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
    setActiveTurnId(null);
    completedTurnIdsRef.current.clear();
    if (historyRefreshTimerRef.current) clearTimeout(historyRefreshTimerRef.current);
    historyRefreshTimerRef.current = null;
    compactTriggeredRef.current = false;
    compactingRef.current = false;
    sessionStatusScopeRef.current = null;
    setSessionStatus(null);
    setAgentTreeRevision(0);
    setDiscussionTurnAgentId(undefined);
    setDepartmentChat({ department_leader_agent_id: null, messages: [] });
    setPendingQuestions([]);
    attentionRequestIdsRef.current = new Set([
      ...pendingApprovals.map(request => `approval:${request.approval_id}`),
      ...pendingQuestions.map(request => `question:${request.question_id}`),
    ]);
    setQueuedPrompts([]);
    setTodos([]);
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
    // 打开一个页面时，那一轮已经流过的思考与输出不会重播：订阅只送后续事件，而
    // 历史记录要等这一步结束才成形。所以进入任何一个 agent 都必须先取一次
    // in-flight 快照，否则切到正在工作的成员就是一片空白——团队里的成员几乎总是
    // 在页面打开之前就已经开始跑了。
    void hydrateInFlight(sessionId, agentId).catch(error => {
      if (hasCurrentScope(scopeRef, sessionId, agentId)) console.error('Failed to sync in-flight turn:', error);
    });
    void refreshDepartmentChat(sessionId, agentId);
  }, [agentId, clearDraft, hydrateInFlight, refreshDepartmentChat, refreshHistory, sessionId]);

  // Sibling Chat arrives as `team.chat.updated`, which the gateway only sends
  // over a live socket. A reconnect drops whatever was posted while the socket
  // was down, so poll the log as well — `preserveEqual` keeps the identity when
  // nothing changed, so an unchanged poll causes no re-render.
  useEffect(() => {
    if (!sessionId || agentId === 'main') return;
    const timer = window.setInterval(() => { void refreshDepartmentChat(sessionId, agentId); }, 8_000);
    return () => { window.clearInterval(timer); };
  }, [agentId, refreshDepartmentChat, sessionId]);

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
    // Do not treat wire `expires_at` as a client-side kill switch. The broker
    // waits for an explicit resolve; aborting here labeled tool failures as a
    // deliberate user interrupt while the permission dock never got answered.
    setPendingApprovals(previous => preserveEqual(previous, result.items));
  }, [agentId, sessionId]);

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

    const finishTurn = (turnId?: string, refresh = false) => {
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
              activeTurnIdRef.current = payload.turnId === undefined ? null : String(payload.turnId);
              setActiveTurnId(activeTurnIdRef.current);
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
            case 'turn.step.completed': {
              turnUsageRef.current = addTokenUsage(turnUsageRef.current, normalizeWireUsage(payload.usage));
              // A step that ends in tool calls narrated its work: that text is
              // durable now and history carries it as one block in this
              // position, so close the live block here too. Otherwise the next
              // step keeps growing it, and one blob of every narration ends up
              // rendering after all the tools that ran between them. A step
              // that ended the turn holds the final answer, which belongs to
              // the row itself, so it stays in the stream buffer.
              const stepProgress = payload.finishReason !== 'tool_use' ? undefined : createProgressBlock(
                `live-step-progress-${payload.turnId ?? 'turn'}-${payload.step ?? liveWorkBlocksRef.current.length}`,
                streamingRef.current,
              );
              if (stepProgress !== undefined) {
                streamingRef.current = '';
                setCurrentStreaming('');
                liveWorkBlocksRef.current = [...liveWorkBlocksRef.current, stepProgress];
                setCurrentWorkBlocks(liveWorkBlocksRef.current);
              }
              break;
            }
            case 'turn.ended':
              if (payload.reason === 'failed') {
                setMessages(previous => mergeHistory(previous, [{
                  id: `turn-error-${sessionId}-${agentId}-${String(payload.turnId ?? Date.now())}`,
                  role: 'system',
                  text: turnFailureText(payload.error),
                  createdAt: new Date().toISOString(),
                }]));
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
            case 'approval.requested': {
              const request = approvalRequestFromEvent(payload, data.session_id ?? sessionId);
              if (request === null) break;
              if ((request.agent_id ?? 'main') !== agentId) break;
              setPendingApprovals(previous => {
                if (previous.some(item => item.approval_id === request.approval_id)) {
                  return previous.map(item => item.approval_id === request.approval_id ? request : item);
                }
                return [...previous, request];
              });
              setIsStreaming(true);
              break;
            }
            case 'approval.resolved': {
              const raw = payload as WsPayload & { approval_id?: string; approvalId?: string; agent_id?: string };
              const approvalId = typeof raw.approval_id === 'string'
                ? raw.approval_id
                : typeof raw.approvalId === 'string' ? raw.approvalId : undefined;
              if (!approvalId) break;
              const eventAgentId = typeof raw.agent_id === 'string'
                ? raw.agent_id
                : typeof raw.agentId === 'string' ? raw.agentId : 'main';
              if (eventAgentId !== agentId) break;
              setPendingApprovals(previous => previous.filter(item => item.approval_id !== approvalId));
              break;
            }
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
              }
              // Bump on every discussion event, not only on the ones without a
              // turn hint: a new statement is what the department rail has to
              // refetch for, and those arrive with the turn handoff.
              setAgentTreeRevision(previous => previous + 1);
              void refreshSessionStatus()
                .catch(error => console.error('Discussion status refresh failed:', error));
              if (payload.discussionAgentId === agentId) {
                void refreshHistory(sessionId, agentId, true)
                  .catch(error => console.error('Discussion history refresh failed:', error));
              }
              break;
            case 'team.chat.updated':
              void refreshDepartmentChat(sessionId, agentId);
              break;
            case 'session.meta.updated':
              // TeamCreate/TeamDismiss update the durable agent tree without
              // changing the selected transcript. Refresh the tree immediately
              // instead of waiting for the four-second poll.
              if (payload.patch?.['agents'] !== undefined) {
                setAgentTreeRevision(previous => previous + 1);
              }
              break;
            case 'session.mount_changed':
              setAgentTreeRevision(previous => previous + 1);
              window.dispatchEvent(new CustomEvent('nori:session-mount-changed', {
                detail: payload,
              }));
              break;
            case 'error': {
              if (isTurnScopedError(payload)) {
                finishTurn(activeTurnIdRef.current ?? undefined, true);
                break;
              }
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
            }
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
  }, [agentId, clearDraft, finishLiveTurn, hydrateInFlight, refreshDepartmentChat, refreshHistory, refreshSessionStatus, sessionId]);

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
            activeTurnIdRef.current = null;
            setActiveTurnId(null);
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

  return { messages, messagesLoading, isStreaming, currentStreaming, currentThinking, currentWorkBlocks, activeTurnId, sessionStatus: statusForSession(sessionStatus, sessionStatusScopeRef.current, chatScopeKey(sessionId, agentId)), agentTreeRevision, discussionTurnAgentId, departmentChat, refreshDepartmentChat: () => refreshDepartmentChat(), refreshSessionStatus, compacting, pendingApprovals, pendingQuestions, queuedPrompts, todos, codeChanges, resolveApproval, resolveQuestion, dismissQuestion, sendMessage, cancelQueuedPrompt, rewindToPrompt, refreshMessages, abort };
}

export function statusForSession(
  status: SessionRealtimeStatus | null,
  statusSessionId: string | null,
  currentSessionId: string | null,
): SessionRealtimeStatus | null {
  return currentSessionId !== null && statusSessionId === currentSessionId ? status : null;
}

function preserveEqual<T>(previous: T, next: T): T {
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}

function approvalRequestFromEvent(
  payload: unknown,
  fallbackSessionId: string,
): ApprovalRequest | null {
  if (payload === null || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const approvalId = typeof record.approval_id === 'string'
    ? record.approval_id
    : typeof record.approvalId === 'string' ? record.approvalId : undefined;
  const toolCallId = typeof record.tool_call_id === 'string'
    ? record.tool_call_id
    : typeof record.toolCallId === 'string' ? record.toolCallId : undefined;
  const toolName = typeof record.tool_name === 'string'
    ? record.tool_name
    : typeof record.toolName === 'string' ? record.toolName : undefined;
  if (!approvalId || !toolCallId || !toolName) return null;

  const sessionId = typeof record.session_id === 'string'
    ? record.session_id
    : typeof record.sessionId === 'string' ? record.sessionId : fallbackSessionId;
  const agentId = typeof record.agent_id === 'string'
    ? record.agent_id
    : typeof record.agentId === 'string' ? record.agentId : undefined;
  const turnId = typeof record.turn_id === 'number'
    ? record.turn_id
    : typeof record.turnId === 'number' ? record.turnId : undefined;
  const action = typeof record.action === 'string' ? record.action : '';
  const createdAt = typeof record.created_at === 'string'
    ? record.created_at
    : typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString();
  const expiresAt = typeof record.expires_at === 'string'
    ? record.expires_at
    : typeof record.expiresAt === 'string'
      ? record.expiresAt
      : new Date(Date.now() + 60_000).toISOString();

  return {
    approval_id: approvalId,
    session_id: sessionId,
    agent_id: agentId,
    turn_id: turnId,
    tool_call_id: toolCallId,
    tool_name: toolName,
    action,
    tool_input_display: record.tool_input_display ?? record.toolInputDisplay ?? record.display,
    created_at: createdAt,
    expires_at: expiresAt,
  };
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
