import { useCallback, useEffect, useRef, useState } from 'react';
import { api, getWebSocketProtocols, type ApprovalRequest } from '../api/client';

interface GlobalApprovalEvent {
  version: number;
  request?: ApprovalRequest;
  removed: boolean;
}

interface WsFrame {
  type?: string;
  session_id?: string;
  payload?: Record<string, unknown>;
}

export interface GlobalApprovalsResult {
  requests: ApprovalRequest[];
  resolvingIds: ReadonlySet<string>;
  errors: Readonly<Record<string, string>>;
  refresh: () => Promise<void>;
  resolveApproval: (
    request: ApprovalRequest,
    decision: 'approved' | 'rejected' | 'cancelled',
    options?: { remember?: boolean; feedback?: string; selectedLabel?: string },
  ) => Promise<void>;
}

export function useGlobalApprovals(): GlobalApprovalsResult {
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [resolvingIds, setResolvingIds] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const requestRef = useRef<ApprovalRequest[]>([]);
  const liveVersionRef = useRef(0);
  const liveEventsRef = useRef(new Map<string, GlobalApprovalEvent>());
  const resolvingRef = useRef(new Set<string>());
  const expiredIdsRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  const refreshRef = useRef<(() => Promise<void>) | null>(null);

  const applyRequests = useCallback((next: ApprovalRequest[]) => {
    const deduped = dedupeApprovals(next);
    requestRef.current = deduped;
    setRequests(previous => sameApprovals(previous, deduped) ? previous : deduped);
  }, []);

  const refresh = useCallback(async () => {
    const versionAtStart = liveVersionRef.current;
    const result = await api.approvals.list();
    if (!mountedRef.current) return;

    const expired = result.items.filter(request => {
      const expiresAt = Date.parse(request.expires_at);
      return Number.isFinite(expiresAt) && expiresAt <= Date.now();
    });
    for (const request of expired) {
      if (expiredIdsRef.current.has(request.approval_id)) continue;
      expiredIdsRef.current.add(request.approval_id);
      void api.abortSession(request.session_id, request.agent_id).catch(() => undefined);
    }

    const snapshot = result.items.filter(request => !expired.some(item => item.approval_id === request.approval_id));
    const liveChanges = [...liveEventsRef.current.entries()]
      .filter(([, event]) => event.version > versionAtStart);
    const next = [...snapshot];
    for (const [approvalId, event] of liveChanges) {
      if (event.removed) {
        const index = next.findIndex(request => request.approval_id === approvalId);
        if (index >= 0) next.splice(index, 1);
      } else if (event.request !== undefined) {
        const index = next.findIndex(request => request.approval_id === approvalId);
        if (index >= 0) next[index] = event.request;
        else next.push(event.request);
      }
    }
    for (const [approvalId, event] of liveEventsRef.current) {
      if (event.version <= versionAtStart) liveEventsRef.current.delete(approvalId);
    }
    applyRequests(next);
  }, [applyRequests]);
  refreshRef.current = refresh;

  const removeApproval = useCallback((approvalId: string) => {
    const version = ++liveVersionRef.current;
    liveEventsRef.current.set(approvalId, { version, removed: true });
    const next = requestRef.current.filter(request => request.approval_id !== approvalId);
    applyRequests(next);
    setErrors(previous => {
      if (!(approvalId in previous)) return previous;
      const nextErrors = { ...previous };
      delete nextErrors[approvalId];
      return nextErrors;
    });
  }, [applyRequests]);

  const resolveApproval = useCallback(async (
    request: ApprovalRequest,
    decision: 'approved' | 'rejected' | 'cancelled',
    options: { remember?: boolean; feedback?: string; selectedLabel?: string } = {},
  ) => {
    const approvalId = request.approval_id;
    if (resolvingRef.current.has(approvalId)) return;
    resolvingRef.current.add(approvalId);
    setResolvingIds(previous => new Set(previous).add(approvalId));
    setErrors(previous => {
      if (!(approvalId in previous)) return previous;
      const next = { ...previous };
      delete next[approvalId];
      return next;
    });
    try {
      await api.approvals.resolve(approvalId, {
        decision,
        remember: options.remember,
        feedback: options.feedback,
        selected_label: options.selectedLabel,
        agent_id: request.agent_id,
      });
      removeApproval(approvalId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to resolve approval.';
      if (message.includes('404') || message.includes('409')) {
        removeApproval(approvalId);
      } else {
        setErrors(previous => ({ ...previous, [approvalId]: message }));
      }
    } finally {
      resolvingRef.current.delete(approvalId);
      setResolvingIds(previous => {
        const next = new Set(previous);
        next.delete(approvalId);
        return next;
      });
    }
  }, [removeApproval]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh().catch(() => undefined);
    const poll = window.setInterval(() => {
      void refresh().catch(() => undefined);
    }, 1_500);
    return () => {
      mountedRef.current = false;
      window.clearInterval(poll);
    };
  }, [refresh]);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectAttempt = 0;
    let socket: WebSocket | null = null;

    const connect = async () => {
      try {
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
            id: `global-approvals-${Date.now()}`,
            payload: { client_id: 'nori-web-global-approvals', subscriptions: [] },
          }));
          void refreshRef.current?.().catch(() => undefined);
        };
        ws.onmessage = event => {
          if (disposed) return;
          let frame: WsFrame;
          try {
            frame = JSON.parse(event.data as string) as WsFrame;
          } catch {
            return;
          }
          if (frame.type !== 'event.approval.requested' && frame.type !== 'event.approval.resolved') return;
          const payload = frame.payload ?? {};
          const approvalId = typeof payload.approval_id === 'string' ? payload.approval_id : undefined;
          if (!approvalId) return;
          const version = ++liveVersionRef.current;
          if (frame.type === 'event.approval.resolved') {
            liveEventsRef.current.set(approvalId, { version, removed: true });
            removeApproval(approvalId);
            return;
          }
          const sessionId = typeof payload.session_id === 'string'
            ? payload.session_id
            : frame.session_id;
          if (!sessionId) return;
          const request: ApprovalRequest = {
            approval_id: approvalId,
            session_id: sessionId,
            agent_id: typeof payload.agent_id === 'string'
              ? payload.agent_id
              : typeof payload.agentId === 'string' ? payload.agentId : undefined,
            turn_id: typeof payload.turn_id === 'number' ? payload.turn_id : undefined,
            tool_call_id: typeof payload.tool_call_id === 'string' ? payload.tool_call_id : '',
            tool_name: typeof payload.tool_name === 'string' ? payload.tool_name : 'tool',
            action: typeof payload.action === 'string' ? payload.action : '',
            tool_input_display: payload.tool_input_display,
            created_at: typeof payload.created_at === 'string' ? payload.created_at : new Date().toISOString(),
            expires_at: typeof payload.expires_at === 'string' ? payload.expires_at : new Date(Date.now() + 60_000).toISOString(),
          };
          liveEventsRef.current.set(approvalId, { version, request, removed: false });
          applyRequests([...requestRef.current, request]);
        };
        ws.onclose = () => {
          if (socket === ws) socket = null;
          if (disposed) return;
          const delay = Math.min(1_000 * 2 ** reconnectAttempt, 8_000);
          reconnectAttempt += 1;
          reconnectTimer = setTimeout(() => void connect(), delay);
        };
      } catch {
        if (!disposed) {
          const delay = Math.min(1_000 * 2 ** reconnectAttempt, 8_000);
          reconnectAttempt += 1;
          reconnectTimer = setTimeout(() => void connect(), delay);
        }
      }
    };

    void connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [applyRequests, removeApproval]);

  return { requests, resolvingIds, errors, refresh, resolveApproval };
}

export function dedupeApprovals(requests: readonly ApprovalRequest[]): ApprovalRequest[] {
  const byId = new Map<string, ApprovalRequest>();
  for (const request of requests) byId.set(request.approval_id, request);
  return [...byId.values()].sort((left, right) => left.created_at.localeCompare(right.created_at));
}

function sameApprovals(left: readonly ApprovalRequest[], right: readonly ApprovalRequest[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
