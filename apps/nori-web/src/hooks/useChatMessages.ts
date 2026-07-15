/**
 * Session chat state: REST history plus the live WebSocket event stream.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, getWebSocketProtocols, type ApprovalRequest, type GoalSnapshot, type Message, type MessageContent, type PromptAttachment, type PromptExecutionOptions, type QuestionAnswer, type QuestionRequest, type SessionRealtimeStatus, type TokenUsage } from '../api/client';

export interface ToolCall {
  id?: string;
  name: string;
  args: unknown;
  result?: string;
}

export type WorkBlock =
  | { id: string; type: 'thinking'; text: string }
  | { id: string; type: 'tool'; tool: ToolCall };

export interface TodoItem {
  title: string;
  status: 'pending' | 'in_progress' | 'done';
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  images?: ChatImage[];
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

interface RealtimeSubscriptionWaiter {
  resolve: (ready: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
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

  wait(timeoutMs = 30_000): Promise<boolean> {
    if (this.ready) return Promise.resolve(true);
    return new Promise(resolve => {
      const waiter: RealtimeSubscriptionWaiter = {
        resolve,
        timer: setTimeout(() => {
          this.finish(waiter, false);
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  private settle(ready: boolean): void {
    for (const waiter of this.waiters) this.finish(waiter, ready);
  }

  private finish(waiter: RealtimeSubscriptionWaiter, ready: boolean): void {
    if (!this.waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    waiter.resolve(ready);
  }
}

export interface CodeChange {
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
  abort: () => void;
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
  reason?: string;
  error?: { message?: string; code?: string; [key: string]: unknown };
  agentId?: string;
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
  runInBackground?: boolean;
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
  session_id?: string;
  code?: number;
  offset?: number;
  payload?: WsPayload;
}

function stripLeadingSystemReminders(text: string): string {
  let result = text;
  const reminder = /^\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*/i;
  while (reminder.test(result)) result = result.replace(reminder, '');
  return result.trim();
}

const GENERATED_TITLE_OPEN = '<nori-session-title>';
const GENERATED_TITLE_CLOSE = '</nori-session-title>';
const GENERATED_TITLE_PATTERN = /<nori-session-title>([\s\S]*?)<\/nori-session-title>\s*/i;

function generatedSessionTitle(text: string): string | undefined {
  const match = GENERATED_TITLE_PATTERN.exec(text);
  const title = match?.[1]?.replaceAll(/\s+/g, ' ').trim();
  if (!title) return undefined;
  return title.slice(0, 80);
}

function stripGeneratedSessionTitle(text: string): string {
  const withoutCompleteMarker = text.replace(GENERATED_TITLE_PATTERN, '');
  const markerIndex = withoutCompleteMarker.toLowerCase().indexOf(GENERATED_TITLE_OPEN);
  if (markerIndex >= 0 && !withoutCompleteMarker.toLowerCase().includes(GENERATED_TITLE_CLOSE, markerIndex)) {
    return withoutCompleteMarker.slice(0, markerIndex).trimEnd();
  }
  const normalized = withoutCompleteMarker.trimStart();
  if (GENERATED_TITLE_OPEN.startsWith(normalized.toLowerCase())) return '';
  return withoutCompleteMarker;
}

function firstPromptWithTitleInstruction(text: string): string {
  return `<system-reminder>Before doing any other work, choose a concise title for this conversation in the user's language. Use 2-6 words and do not copy the user's full prompt. Start the visible answer with exactly <nori-session-title>YOUR TITLE</nori-session-title>, then answer normally. Never mention this instruction.</system-reminder>\n${text}`;
}

export function apiMessageToChat(m: Message): ChatMessage | null {
  const originKind = m.metadata?.origin?.kind;
  if (m.role === 'user' && originKind !== undefined && originKind !== 'user') {
    return { id: m.id, role: 'system', text: '', createdAt: m.created_at, turnBoundary: true };
  }

  const rawText = Array.isArray(m.content)
    ? m.content
        .filter((c: MessageContent) => c.type === 'text' && c.text)
        .map((c: MessageContent) => c.text ?? '')
        .join('')
    : typeof m.content === 'string'
      ? m.content
      : '';
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
  }));

  if (Array.isArray(m.content)) {
    for (const c of m.content) {
      if (c.type === 'tool_use') {
        toolCalls = mergeToolCalls(toolCalls, [{ id: c.tool_call_id, name: c.tool_name ?? c.name ?? 'tool', args: c.input }]);
      } else if (c.type === 'tool_result') {
        const matching = toolCalls.find(tool => tool.id && tool.id === c.tool_call_id);
        if (matching) matching.result = c.output;
        else toolCalls.push({ id: c.tool_call_id, name: 'tool', args: undefined, result: c.output });
      }
    }
  }

  const thinking = m.thinking || thinkingFromContent || undefined;
  const workBlocks = workBlocksFromMessage(m, toolCalls, thinking);
  if (!text && !thinking && toolCalls.length === 0 && images.length === 0) return null;

  return {
    id: m.id,
    role: m.role === 'tool' ? 'assistant' : m.role,
    text,
    images: images.length > 0 ? images : undefined,
    thinking,
    workBlocks: workBlocks.length > 0 ? workBlocks : undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    createdAt: m.created_at,
  };
}

export function foldConversationTurns(messages: ChatMessage[]): ChatMessage[] {
  const folded: ChatMessage[] = [];
  let assistantIndex = -1;

  for (const message of messages) {
    if (message.turnBoundary) {
      // Hidden reminders wake the same top-level user turn. They are not a
      // second visible answer and must not create another Nori avatar.
      continue;
    }
    if (message.role !== 'assistant') {
      folded.push(message);
      assistantIndex = message.role === 'user' ? -1 : assistantIndex;
      continue;
    }

    if (assistantIndex < 0) {
      assistantIndex = folded.length;
      folded.push(message);
      continue;
    }

    const previous = folded[assistantIndex]!;
    const toolCalls = mergeToolCalls(previous.toolCalls ?? [], message.toolCalls ?? []);
    const thinking = [previous.thinking, message.thinking].filter(Boolean).join('\n\n');
    const workBlocks = mergeWorkBlocks(previous.workBlocks ?? [], message.workBlocks ?? []);
    const text = [previous.text.trimEnd(), message.text.trimStart()].filter(Boolean).join('\n\n');
    folded[assistantIndex] = {
      ...previous,
      text,
      thinking: thinking || undefined,
      workBlocks: workBlocks.length > 0 ? workBlocks : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      createdAt: message.createdAt ?? previous.createdAt,
      usage: addTokenUsage(previous.usage, message.usage),
    };
  }

  return folded;
}

function workBlocksFromMessage(message: Message, toolCalls: ToolCall[], thinking: string | undefined): WorkBlock[] {
  const blocks: WorkBlock[] = [];
  let thinkingIndex = 0;
  const representedToolIds = new Set<string>();

  for (const content of message.content) {
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
  for (const tool of toolCalls) {
    if (tool.id && representedToolIds.has(tool.id)) continue;
    blocks.push({ id: tool.id ?? `${message.id}-tool-${blocks.length}`, type: 'tool', tool });
  }
  return blocks;
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

function latestTodos(messages: ChatMessage[]): TodoItem[] {
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

function mergeHistory(previous: ChatMessage[], remote: ChatMessage[]): ChatMessage[] {
  const remoteIds = new Set(remote.map(message => message.id));
  const merged = [...remote];

  for (const local of previous) {
    if (remoteIds.has(local.id)) continue;
    const duplicateIndex = remote.findIndex(serverMessage =>
      serverMessage.role === local.role &&
      serverMessage.text === local.text &&
      Math.abs(messageTime(serverMessage) - messageTime(local)) < 15_000 &&
      (local.role === 'assistant' || (serverMessage.thinking ?? '') === (local.thinking ?? '')),
    );
    if (duplicateIndex >= 0) {
      if (local.usage !== undefined) {
        merged[duplicateIndex] = { ...merged[duplicateIndex]!, usage: local.usage };
      }
    } else {
      merged.push(local);
    }
  }

  return merged.sort((a, b) => messageTime(a) - messageTime(b));
}

function reconcileHistory(previous: ChatMessage[], remote: ChatMessage[]): ChatMessage[] {
  const claimed = new Set<string>();
  return remote.map(serverMessage => {
    const local = previous.find(candidate =>
      !claimed.has(candidate.id)
      && candidate.role === serverMessage.role
      && candidate.text === serverMessage.text
      && (candidate.thinking ?? '') === (serverMessage.thinking ?? '')
      && Math.abs(messageTime(candidate) - messageTime(serverMessage)) < 15_000,
    );
    if (!local) return serverMessage;
    claimed.add(local.id);
    return { ...serverMessage, id: local.id, usage: serverMessage.usage ?? local.usage };
  });
}

function normalizeEventType(type: string): string {
  return type.startsWith('event.') ? type.slice('event.'.length) : type;
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

export function useChatMessages(sessionId: string | null): UseChatMessagesResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [currentStreaming, setCurrentStreaming] = useState('');
  const [currentThinking, setCurrentThinking] = useState('');
  const [currentWorkBlocks, setCurrentWorkBlocks] = useState<WorkBlock[]>([]);
  const [sessionStatus, setSessionStatus] = useState<SessionRealtimeStatus | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([]);
  const [pendingQuestions, setPendingQuestions] = useState<QuestionRequest[]>([]);
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([]);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [activeSubagentIds, setActiveSubagentIds] = useState<string[]>([]);
  const [codeChanges, setCodeChanges] = useState<CodeChange[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const sessionRef = useRef(sessionId);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subscriptionGateRef = useRef(new RealtimeSubscriptionGate());
  const sendAbortRef = useRef<AbortController | null>(null);
  const promptIdRef = useRef<string | null>(null);
  const sendStartedAtRef = useRef(0);
  const lastStreamActivityAtRef = useRef(0);
  const streamingRef = useRef('');
  const assistantRawRef = useRef('');
  const thinkingRef = useRef('');
  const thinkingRawRef = useRef('');
  const hasUserPromptRef = useRef(false);
  const titleAppliedRef = useRef(false);
  const turnUsageRef = useRef<TokenUsage | undefined>(undefined);
  const activeTurnIdRef = useRef<number | null>(null);
  const completedTurnIdsRef = useRef(new Set<number>());
  const historyRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const compactTriggeredRef = useRef(false);
  const compactingRef = useRef(false);
  const activeToolCallsRef = useRef(new Map<string, ToolCall>());
  const liveWorkBlocksRef = useRef<WorkBlock[]>([]);

  sessionRef.current = sessionId;

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

  const hydrateInFlight = useCallback(async (targetSessionId: string) => {
    const snapshot = await api.sessions.getSnapshot(targetSessionId);
    if (sessionRef.current !== targetSessionId) return false;
    setPendingApprovals(previous => preserveEqual(previous, snapshot.pending_approvals ?? []));
    setPendingQuestions(previous => preserveEqual(previous, snapshot.pending_questions ?? []));
    const inFlight = snapshot.in_flight_turn;
    if (!inFlight) return false;
    streamingRef.current = inFlight.assistant_text;
    assistantRawRef.current = inFlight.assistant_text;
    thinkingRef.current = inFlight.thinking_text;
    thinkingRawRef.current = inFlight.thinking_text;
    setCurrentStreaming(stripGeneratedSessionTitle(inFlight.assistant_text));
    setCurrentThinking(inFlight.thinking_text);
    setIsStreaming(true);
    return true;
  }, []);

  const refreshHistory = useCallback(async (targetSessionId = sessionId, replace = false) => {
    if (!targetSessionId) return [] as ChatMessage[];
    const data = await api.getMessages(targetSessionId, { page_size: 100 });
    const history = foldConversationTurns((data?.items ?? [])
      .map(apiMessageToChat)
      .filter((message): message is ChatMessage => message !== null)
      .sort((a, b) => messageTime(a) - messageTime(b)));
    if (sessionRef.current === targetSessionId) {
      hasUserPromptRef.current = history.some(message => message.role === 'user');
      setTodos(latestTodos(history));
      setMessages(previous => {
        const next = replace ? reconcileHistory(previous, history) : mergeHistory(previous, history);
        return preserveEqual(previous, next);
      });
    }
    return history;
  }, [sessionId]);

  useEffect(() => {
    setMessages([]);
    setMessagesLoading(Boolean(sessionId));
    setIsStreaming(false);
    subscriptionGateRef.current.reset();
    promptIdRef.current = null;
    hasUserPromptRef.current = false;
    titleAppliedRef.current = false;
    turnUsageRef.current = undefined;
    activeTurnIdRef.current = null;
    completedTurnIdsRef.current.clear();
    if (historyRefreshTimerRef.current) clearTimeout(historyRefreshTimerRef.current);
    historyRefreshTimerRef.current = null;
    compactTriggeredRef.current = false;
    compactingRef.current = false;
    setSessionStatus(null);
    setPendingQuestions([]);
    setQueuedPrompts([]);
    setTodos([]);
    setActiveSubagentIds([]);
    activeToolCallsRef.current.clear();
    setCompacting(false);
    clearDraft();
    if (!sessionId) return;
    void refreshHistory(sessionId)
      .catch(error => {
        if (sessionRef.current === sessionId) console.error('Failed to load messages:', error);
      })
      .finally(() => {
        if (sessionRef.current === sessionId) setMessagesLoading(false);
      });
  }, [clearDraft, refreshHistory, sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const refreshStatus = async () => {
      try {
        let status = await api.sessions.getStatus(sessionId);
        if (disposed || sessionRef.current !== sessionId) return;
        setSessionStatus(previous => preserveEqual(previous, status));

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
            await api.sessions.compact(sessionId);
            status = await api.sessions.getStatus(sessionId);
            if (!disposed && sessionRef.current === sessionId) {
              setSessionStatus(previous => preserveEqual(previous, status));
            }
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
  }, [isStreaming, sessionId]);

  const refreshApprovals = useCallback(async () => {
    if (!sessionId) {
      setPendingApprovals([]);
      return;
    }
    const result = await api.sessions.approvals.list(sessionId);
    if (sessionRef.current !== sessionId) return;
    const now = Date.now();
    const expired = result.items.filter(request => Date.parse(request.expires_at) <= now);
    if (expired.length > 0) {
      await api.abortSession(sessionId).catch(() => undefined);
      setPendingApprovals([]);
      setIsStreaming(false);
      clearDraft();
      setMessages(previous => mergeHistory(previous, [{
        id: `approval-expired-${sessionId}-${now}`,
        role: 'system',
        text: '工具授权已过期，本轮已自动取消。可以继续发送消息并重试。',
        createdAt: new Date().toISOString(),
      }]));
      return;
    }
    setPendingApprovals(previous => preserveEqual(previous, result.items));
  }, [clearDraft, sessionId]);

  const refreshQuestions = useCallback(async () => {
    if (!sessionId) {
      setPendingQuestions([]);
      return;
    }
    const result = await api.sessions.questions.list(sessionId);
    if (sessionRef.current === sessionId) {
      setPendingQuestions(previous => preserveEqual(previous, result.items));
    }
  }, [sessionId]);

  const refreshPromptQueue = useCallback(async () => {
    if (!sessionId) {
      setQueuedPrompts([]);
      return;
    }
    const result = await api.sessions.prompts.list(sessionId);
    if (sessionRef.current !== sessionId) return;
    if (result.active) promptIdRef.current = result.active.prompt_id;
    const queued = result.queued.map(prompt => ({
      id: prompt.prompt_id,
      text: prompt.content.filter(part => part.type === 'text').map(part => part.text ?? '').join(''),
      createdAt: prompt.created_at,
    }));
    setQueuedPrompts(previous => preserveEqual(previous, queued));
  }, [sessionId]);

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
  }, [refreshApprovals, refreshPromptQueue, refreshQuestions, sessionId]);

  useEffect(() => {
    if (!sessionId) return;

    let disposed = false;
    let reconnectAttempt = 0;
    let subscribeRequestId: string | null = null;

    const applyGeneratedTitle = (text: string) => {
      if (titleAppliedRef.current) return;
      const title = generatedSessionTitle(text);
      if (!title) return;
      titleAppliedRef.current = true;
      void api.renameSession(sessionId, title).then(() => {
        window.dispatchEvent(new CustomEvent('nori:session-title-changed', { detail: { sessionId, title } }));
      }).catch(error => console.error('Failed to apply generated session title:', error));
    };

    const scheduleHistoryRefresh = () => {
      if (historyRefreshTimerRef.current) clearTimeout(historyRefreshTimerRef.current);
      historyRefreshTimerRef.current = setTimeout(() => {
        historyRefreshTimerRef.current = null;
        if (!disposed && sessionRef.current === sessionId) {
          void refreshHistory(sessionId, true).catch(error => console.error('Failed to refresh completed turn:', error));
        }
      }, 300);
    };

    const finishTurn = (turnId?: number, refresh = false) => {
      if (turnId !== undefined) {
        if (completedTurnIdsRef.current.has(turnId)) {
          if (refresh) scheduleHistoryRefresh();
          return;
        }
        completedTurnIdsRef.current.add(turnId);
        if (completedTurnIdsRef.current.size > 32) {
          const oldest = completedTurnIdsRef.current.values().next().value;
          if (oldest !== undefined) completedTurnIdsRef.current.delete(oldest);
        }
      }
      applyGeneratedTitle(assistantRawRef.current);
      const text = stripGeneratedSessionTitle(streamingRef.current);
      const thinking = thinkingRef.current;
      if (text || thinking) {
        const completed: ChatMessage = {
          id: `live-${sessionId}-${Date.now()}`,
          role: 'assistant',
          text,
          thinking: thinking || undefined,
          workBlocks: liveWorkBlocksRef.current.length > 0 ? liveWorkBlocksRef.current : undefined,
          usage: turnUsageRef.current,
          createdAt: new Date().toISOString(),
        };
        setMessages(previous => mergeHistory(previous, [completed]));
      }
      setIsStreaming(false);
      activeTurnIdRef.current = null;
      promptIdRef.current = null;
      turnUsageRef.current = undefined;
      clearDraft();

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
            payload: { session_ids: [sessionId] },
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
            void refreshHistory(sessionId).catch(error => console.error('WebSocket resync failed:', error));
            void hydrateInFlight(sessionId).catch(error => console.error('In-flight snapshot sync failed:', error));
            return;
          }

          const type = normalizeEventType(data.type);
          const payload = data.payload ?? {};
          if (data.session_id && data.session_id !== sessionId) return;
          if (shouldIgnoreTranscriptEvent(type, payload.agentId)) return;

          switch (type) {
            case 'turn.started':
              activeTurnIdRef.current = payload.turnId ?? null;
              lastStreamActivityAtRef.current = Date.now();
              turnUsageRef.current = undefined;
              clearDraft();
              setIsStreaming(true);
              break;
            case 'assistant.delta': {
              const delta = payload.delta ?? '';
              if (!delta) break;
              const reconciled = appendStreamDelta(assistantRawRef.current, delta, data.offset);
              if (reconciled === null) {
                void hydrateInFlight(sessionId).catch(error => console.error('Assistant stream gap recovery failed:', error));
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
                void hydrateInFlight(sessionId).catch(error => console.error('Thinking stream gap recovery failed:', error));
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
                  id: `turn-error-${sessionId}-${String(payload.turnId ?? Date.now())}`,
                  role: 'system',
                  text: errorMessage,
                  createdAt: new Date().toISOString(),
                }]));
                }
              }
              finishTurn(payload.turnId);
              break;
            case 'prompt.completed':
              if (streamingRef.current || thinkingRef.current) finishTurn(activeTurnIdRef.current ?? undefined);
              else setIsStreaming(false);
              scheduleHistoryRefresh();
              break;
            case 'tool.call.started':
              if (payload.toolCallId && payload.name) {
                const tool = { id: payload.toolCallId, name: payload.name, args: payload.args };
                activeToolCallsRef.current.set(payload.toolCallId, tool);
                liveWorkBlocksRef.current = [...liveWorkBlocksRef.current, { id: payload.toolCallId, type: 'tool', tool }];
                setCurrentWorkBlocks(liveWorkBlocksRef.current);
                if (payload.name === 'TodoList') {
                  const nextTodos = todosFromToolArgs(payload.args);
                  if (nextTodos !== undefined) setTodos(nextTodos);
                }
              }
              setIsStreaming(true);
              break;
            case 'tool.result':
              if (payload.toolCallId) {
                const result = serializeToolOutput(payload.output ?? payload.result);
                liveWorkBlocksRef.current = liveWorkBlocksRef.current.map(block => block.type === 'tool' && block.tool.id === payload.toolCallId
                  ? { ...block, tool: { ...block.tool, result } }
                  : block);
                setCurrentWorkBlocks(liveWorkBlocksRef.current);
                activeToolCallsRef.current.delete(payload.toolCallId);
              }
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
              break;
            case 'code.change':
              if (payload.path && payload.operation && payload.diff !== undefined) {
                const change: CodeChange = {
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
            case 'error':
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
  }, [clearDraft, hydrateInFlight, refreshHistory, sessionId]);

  useEffect(() => {
    if (!isStreaming || !sessionId) return;
    const timer = setInterval(() => {
      if (Date.now() - lastStreamActivityAtRef.current < 6000) return;
      void hydrateInFlight(sessionId)
        .then(inFlight => inFlight ? null : refreshHistory(sessionId))
        .then(history => {
          if (history === null) return;
          const completedAssistant = history.some(message =>
            message.role === 'assistant' &&
            messageTime(message) >= sendStartedAtRef.current - 2000 &&
            Boolean(message.text.trim() || message.thinking?.trim() || message.toolCalls?.length),
          );
          if (completedAssistant && sessionRef.current === sessionId) {
            setIsStreaming(false);
            clearDraft();
          }
        })
        .catch(() => undefined);
    }, 6000);
    return () => clearInterval(timer);
  }, [clearDraft, hydrateInFlight, isStreaming, refreshHistory, sessionId]);

  const waitForSubscription = useCallback(async (): Promise<boolean> => {
    return subscriptionGateRef.current.wait();
  }, []);

  const sendMessage = useCallback(async (text: string, attachments: PromptAttachment[] = [], behavior: 'queue' | 'steer' = 'queue', options: PromptExecutionOptions = {}) => {
    const trimmed = text.trim();
    if (!sessionId || (!trimmed && attachments.length === 0)) return false;

    const activeBeforeSubmit = isStreaming || activeTurnIdRef.current !== null;
    sendAbortRef.current?.abort();
    const controller = new AbortController();
    sendAbortRef.current = controller;
    if (!activeBeforeSubmit) {
      sendStartedAtRef.current = Date.now();
      lastStreamActivityAtRef.current = Date.now();
    }
    const shouldGenerateTitle = !hasUserPromptRef.current;
    hasUserPromptRef.current = true;
    const visibleText = trimmed || (attachments.length === 1 ? `[${attachments[0]?.name ?? 'attachment'}]` : `[${attachments.length} attachments]`);
    const visibleImages = attachments.flatMap(attachment => attachment.kind === 'image'
      ? [{
          src: `data:${attachment.source.media_type};base64,${attachment.source.data}`,
          alt: attachment.name,
        }]
      : []);
    const localMessageId = `local-user-${Date.now()}`;
    if (!activeBeforeSubmit) {
      clearDraft();
      setMessages(previous => [...previous, {
        id: localMessageId,
        role: 'user',
        text: visibleText,
        images: visibleImages.length > 0 ? visibleImages : undefined,
        createdAt: new Date().toISOString(),
      }]);
    }
    setIsStreaming(true);

    try {
      const subscribed = await waitForSubscription();
      if (!subscribed) throw new Error('Realtime connection is not ready. Please retry.');
      if (controller.signal.aborted) return false;
      const promptText = trimmed || 'Please inspect the attached files.';
      const response = await api.sendPrompt(
        sessionId,
        shouldGenerateTitle ? firstPromptWithTitleInstruction(promptText) : promptText,
        attachments,
        options,
      );
      if (response.status === 'queued') {
        setQueuedPrompts(previous => previous.some(item => item.id === response.prompt_id) ? previous : [...previous, { id: response.prompt_id, text: visibleText, createdAt: response.created_at }]);
        if (behavior === 'steer') {
          await api.sessions.prompts.steer(sessionId, [response.prompt_id]);
          setQueuedPrompts(previous => previous.filter(item => item.id !== response.prompt_id));
          setMessages(previous => [...previous, { id: response.user_message_id, role: 'user', text: visibleText, images: visibleImages.length > 0 ? visibleImages : undefined, createdAt: response.created_at }]);
        }
      } else {
        promptIdRef.current = response.prompt_id;
      }
      return true;
    } catch (error) {
      if (controller.signal.aborted) return false;
      if (shouldGenerateTitle) hasUserPromptRef.current = false;
      if (!activeBeforeSubmit) {
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
    }
  }, [clearDraft, isStreaming, sessionId, waitForSubscription]);

  const cancelQueuedPrompt = useCallback(async (promptId: string) => {
    if (!sessionId) return;
    await api.sessions.prompts.abort(sessionId, promptId);
    setQueuedPrompts(previous => previous.filter(item => item.id !== promptId));
  }, [sessionId]);

  const abort = useCallback(() => {
    sendAbortRef.current?.abort();
    if (sessionId) {
      void api.abortSession(sessionId).catch(error => console.error('Abort failed:', error));
    }
    const promptId = promptIdRef.current;
    if (promptId && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'abort',
        id: controlId('abort'),
        payload: { session_id: sessionId, prompt_id: promptId },
      }));
    }
    promptIdRef.current = null;
    setIsStreaming(false);
    clearDraft();
  }, [clearDraft, sessionId]);

  const rewindToPrompt = useCallback(async (count: number) => {
    if (!sessionId || isStreaming) return undefined;
    const prompt = promptForRewind(messages, count);
    await api.sessions.undo(sessionId, count);
    clearDraft();
    setPendingApprovals([]);
    setIsStreaming(false);
    hasUserPromptRef.current = true;
    await refreshHistory(sessionId, true);
    return prompt;
  }, [clearDraft, isStreaming, messages, refreshHistory, sessionId]);

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
      });
      setPendingApprovals(previous => previous.filter(request => request.approval_id !== approvalId));
      setIsStreaming(true);
      await refreshApprovals();
    } catch (error) {
      await api.abortSession(sessionId).catch(() => undefined);
      setPendingApprovals([]);
      setIsStreaming(false);
      clearDraft();
      setMessages(previous => [...previous, {
        id: `approval-error-${Date.now()}`,
        role: 'system',
        text: error instanceof Error ? error.message : '工具授权失败，本轮已取消。',
        createdAt: new Date().toISOString(),
      }]);
    }
  }, [clearDraft, refreshApprovals, sessionId]);

  const resolveQuestion = useCallback(async (questionId: string, answers: Record<string, QuestionAnswer>) => {
    if (!sessionId) return;
    await api.sessions.questions.resolve(sessionId, questionId, answers);
    setPendingQuestions(previous => previous.filter(request => request.question_id !== questionId));
    setIsStreaming(true);
    await refreshQuestions();
  }, [refreshQuestions, sessionId]);

  const dismissQuestion = useCallback(async (questionId: string) => {
    if (!sessionId) return;
    await api.sessions.questions.dismiss(sessionId, questionId);
    setPendingQuestions(previous => previous.filter(request => request.question_id !== questionId));
    await refreshQuestions();
  }, [refreshQuestions, sessionId]);

  return { messages, messagesLoading, isStreaming, currentStreaming, currentThinking, currentWorkBlocks, sessionStatus, compacting, pendingApprovals, pendingQuestions, queuedPrompts, todos, activeSubagentIds, codeChanges, resolveApproval, resolveQuestion, dismissQuestion, sendMessage, cancelQueuedPrompt, rewindToPrompt, abort };
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

export function shouldIgnoreTranscriptEvent(type: string, agentId?: string): boolean {
  return Boolean(agentId && agentId !== 'main' && isMainTranscriptEvent(type));
}

function isMainTranscriptEvent(type: string): boolean {
  return type.startsWith('turn.')
    || type.startsWith('assistant.')
    || type.startsWith('thinking.')
    || type.startsWith('tool.call.')
    || type === 'tool.progress'
    || type === 'tool.result'
    || type === 'prompt.completed'
    || type === 'error';
}
