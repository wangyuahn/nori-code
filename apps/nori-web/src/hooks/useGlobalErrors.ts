import { useEffect } from 'react';
import { api, getWebSocketProtocols } from '../api/client';
import {
  reportAppError,
  reportWebSocketError,
  websocketEventId,
  type WebSocketErrorPayload,
} from '../utils/error-center';

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  const json = JSON.stringify(value);
  return typeof json === 'string' ? json : '';
}

export interface GlobalErrorFrame {
  type?: string;
  seq?: number;
  epoch?: string;
  volatile?: boolean;
  session_id?: string;
  payload?: WebSocketErrorPayload & {
    reason?: string;
    turnId?: string | number;
    toolCallId?: string;
    name?: string;
    output?: unknown;
    isError?: boolean;
    result?: { isError?: boolean; output?: unknown };
    error?: { message?: string; code?: string | number; details?: unknown; retryable?: boolean };
  };
}

export function reportGlobalFailure(frame: GlobalErrorFrame): void {
  const payload = frame.payload;
  if (payload === undefined) return;
  const eventId = websocketEventId({
    sessionId: frame.session_id,
    seq: frame.seq,
    epoch: frame.epoch,
  });
  const type = frame.type?.startsWith('event.') ? frame.type.slice('event.'.length) : frame.type;
  if (type === 'error') {
    reportWebSocketError({ payload, sessionId: frame.session_id, eventId, operation: 'global event' });
    return;
  }
  if (type === 'turn.ended' && payload.reason === 'failed') {
    const failure = payload.error;
    reportAppError({
      source: 'agent',
      eventId,
      message: failure?.message ?? payload.message ?? 'Agent turn failed',
      code: failure?.code ?? payload.code,
      sessionId: frame.session_id,
      agentId: payload.agentId,
      turnId: payload.turnId,
      operation: 'turn',
      details: failure?.details ?? payload.details,
      retryable: failure?.retryable ?? payload.retryable,
    });
    return;
  }
  if (type === 'tool.result' && payload.isError === true) {
    reportAppError({
      source: 'tool',
      eventId,
      message: payload.message ?? stringifyUnknown(payload.output ?? payload.result?.output ?? 'Tool call failed'),
      sessionId: frame.session_id,
      agentId: payload.agentId,
      turnId: payload.turnId,
      toolCallId: payload.toolCallId,
      operation: payload.name ?? 'tool',
      details: payload.output ?? payload.result?.output ?? payload.details,
      retryable: false,
    });
  }
}

/**
 * Receives server error events without a session/agent subscription filter.
 * Errors are global diagnostics: a background member may fail while the user
 * is looking at another transcript, and that failure still needs to be visible.
 */
export function useGlobalErrors(): void {
  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectAttempt = 0;
    let socket: WebSocket | null = null;
    const cursors: Record<string, { seq: number; epoch?: string }> = {};

    const scheduleReconnect = () => {
      if (disposed) return;
      const delay = Math.min(1_000 * 2 ** reconnectAttempt, 8_000);
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => void connect(), delay);
    };

    const connect = async () => {
      try {
        let sessionIds: string[] = [];
        try {
          const response = await api.sessions.list({ include_archive: true });
          sessionIds = response.items.map(session => session.id);
        } catch (error) {
          reportAppError({
            source: 'api',
            message: error,
            operation: 'load sessions for error replay',
            retryable: true,
          });
        }
        if (disposed) return;
        const ws = new WebSocket(await api.getWsUrl(), await getWebSocketProtocols());
        socket = ws;
        ws.onopen = () => {
          if (disposed) {
            ws.close();
            return;
          }
          reconnectAttempt = 0;
          ws.send(JSON.stringify({
            type: 'client_hello',
            id: `global-errors-${Date.now()}`,
            payload: {
              client_id: 'nori-web-global-errors',
              subscriptions: sessionIds,
              cursors: Object.keys(cursors).length > 0 ? cursors : undefined,
              failure_only: true,
            },
          }));
        };
        ws.onmessage = event => {
          if (disposed) return;
          let frame: GlobalErrorFrame;
          try {
            frame = JSON.parse(String(event.data)) as GlobalErrorFrame;
          } catch (error) {
            reportAppError({ source: 'websocket', message: error, operation: 'parse global event', retryable: true });
            return;
          }
          if (frame.type === 'ack') {
            const ackCursors = (frame.payload as { cursors?: Record<string, { seq: number; epoch?: string }> } | undefined)?.cursors;
            if (ackCursors !== undefined) Object.assign(cursors, ackCursors);
          } else if (frame.type === 'resync_required') {
            const resync = frame.payload as { session_id?: string; current_seq?: number; epoch?: string } | undefined;
            if (resync?.session_id !== undefined && typeof resync.current_seq === 'number') {
              cursors[resync.session_id] = {
                seq: resync.current_seq,
                ...(resync.epoch === undefined ? {} : { epoch: resync.epoch }),
              };
            }
          } else if (frame.session_id !== undefined && typeof frame.seq === 'number' && frame.volatile !== true) {
            const current = cursors[frame.session_id];
            if (current === undefined || frame.seq > current.seq) {
              cursors[frame.session_id] = {
                seq: frame.seq,
                ...(frame.epoch === undefined ? {} : { epoch: frame.epoch }),
              };
            }
          }
          reportGlobalFailure(frame);
        };
        ws.onerror = () => {
          if (!disposed) {
            reportAppError({
              source: 'websocket',
              message: '全局错误通道连接失败',
              operation: 'global events connect',
              retryable: true,
            });
          }
        };
        ws.onclose = () => {
          if (socket === ws) socket = null;
          scheduleReconnect();
        };
      } catch (error) {
        if (!disposed) {
          reportAppError({
            source: 'websocket',
            message: error,
            operation: 'global events connect',
            retryable: true,
          });
          scheduleReconnect();
        }
      }
    };

    void connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);
}
