export type AppErrorSource = 'agent' | 'tool' | 'provider' | 'websocket' | 'api' | 'runtime' | 'map';

export interface AppErrorRecord {
  id: string;
  fingerprint: string;
  eventId?: string;
  source: AppErrorSource;
  message: string;
  code?: string | number;
  httpStatus?: number;
  requestId?: string;
  sessionId?: string;
  agentId?: string;
  operation?: string;
  details?: unknown;
  retryable?: boolean;
  turnId?: string | number;
  toolCallId?: string;
  timestamp: string;
  count: number;
}

export interface WebSocketErrorPayload {
  code?: string | number;
  message?: string;
  name?: string;
  details?: Record<string, unknown>;
  retryable?: boolean;
  agentId?: string;
}

type AppErrorInput = Omit<AppErrorRecord, 'id' | 'fingerprint' | 'message' | 'timestamp' | 'count'> & {
  message: unknown;
};

const ERROR_EVENT = 'nori:app-error';
const MAX_ERRORS = 100;
const records: AppErrorRecord[] = [];
const storeListeners = new Set<(errors: readonly AppErrorRecord[]) => void>();
const eventListeners = new Set<(error: AppErrorRecord) => void>();

function textOf(value: unknown): string {
  if (value instanceof Error) return value.message || value.name;
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object' && 'message' in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(value);
}

function stablePart(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' ? json : '';
  } catch {
    return textOf(value);
  }
}

function fingerprintFor(input: AppErrorInput, message: string): string {
  // One failed turn is emitted as both `turn.ended{reason:'failed'}` and a
  // trailing `error` event. Their wire sequence numbers differ, so eventId
  // cannot be the identity when a turn id is available. Keep toolCallId in the
  // semantic key so two failed tools in the same turn remain separate.
  if (input.eventId !== undefined && input.turnId === undefined) {
    return [input.source, 'event', input.eventId].map(stablePart).join('\u0000');
  }
  return [
    input.source,
    input.code,
    input.httpStatus,
    input.sessionId,
    input.agentId,
    input.turnId,
    input.toolCallId,
    message,
  ].map(stablePart).join('\u0000');
}

function notifyStore(): void {
  const snapshot = records.slice();
  for (const listener of storeListeners) listener(snapshot);
}

export function getAppErrors(): readonly AppErrorRecord[] {
  return records.slice();
}

export function subscribeAppErrors(listener: (errors: readonly AppErrorRecord[]) => void): () => void {
  storeListeners.add(listener);
  listener(records.slice());
  return () => storeListeners.delete(listener);
}

export function clearAppErrors(): void {
  if (records.length === 0) return;
  records.length = 0;
  notifyStore();
}

export function reportAppError(input: AppErrorInput): AppErrorRecord {
  const message = textOf(input.message);
  const fingerprint = fingerprintFor(input, message);
  const timestamp = new Date().toISOString();
  const existingIndex = records.findIndex((record) => record.fingerprint === fingerprint);
  let record: AppErrorRecord;
  if (existingIndex >= 0) {
    const existing = records[existingIndex]!;
    if (input.eventId !== undefined && existing.eventId === input.eventId) {
      return existing;
    }
    record = {
      ...existing,
      ...input,
      id: existing.id,
      fingerprint,
      message,
      eventId: existing.eventId ?? input.eventId,
      timestamp,
      count: existing.count + 1,
    };
    records.splice(existingIndex, 1);
  } else {
    record = {
      ...input,
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      fingerprint,
      message,
      timestamp,
      count: 1,
    };
  }
  records.unshift(record);
  if (records.length > MAX_ERRORS) records.length = MAX_ERRORS;
  notifyStore();
  for (const listener of eventListeners) listener(record);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(ERROR_EVENT, { detail: record }));
  }
  return record;
}

/** Compatibility listener for callers that only need newly reported errors. */
export function onAppError(listener: (error: AppErrorRecord) => void): () => void {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

export function errorSourceForEvent(type: string): AppErrorSource {
  if (type.startsWith('provider.')) return 'provider';
  if (type.startsWith('tool.') || type.includes('tool')) return 'tool';
  if (type === 'error' || type.startsWith('turn.')) return 'agent';
  return 'runtime';
}

export function reportWebSocketError(input: {
  payload: WebSocketErrorPayload;
  sessionId?: string;
  eventId?: string;
  operation?: string;
}): AppErrorRecord {
  const { payload } = input;
  const turnId = payload.details?.['turnId'];
  return reportAppError({
    source: errorSourceForEvent('error'),
    eventId: input.eventId,
    message: payload.message ?? '服务端实时事件失败',
    code: payload.code,
    sessionId: input.sessionId,
    agentId: payload.agentId,
    turnId: typeof turnId === 'string' || typeof turnId === 'number' ? turnId : undefined,
    operation: input.operation ?? 'stream',
    details: payload.details,
    retryable: payload.retryable,
  });
}

export function websocketEventId(input: {
  sessionId?: string;
  seq?: number;
  epoch?: string;
}): string | undefined {
  if (input.sessionId === undefined || input.seq === undefined) return undefined;
  return [input.epoch ?? 'unknown', input.sessionId, String(input.seq)].join(':');
}
