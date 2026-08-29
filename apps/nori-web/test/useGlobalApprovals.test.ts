import { act, createElement, useEffect, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type ApprovalRequest } from '../src/api/client';
import { useGlobalApprovals, type GlobalApprovalsResult } from '../src/hooks/useGlobalApprovals';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

class TestWebSocket {
  static latest: TestWebSocket;
  readonly OPEN = 1;
  readyState = 1;
  onopen: (() => void) | undefined;
  onmessage: ((event: MessageEvent) => void) | undefined;
  onclose: (() => void) | undefined;
  readonly send = vi.fn();
  readonly close = vi.fn();

  constructor() {
    TestWebSocket.latest = this;
  }

  emitOpen(): void {
    this.onopen?.();
  }

  emitApproval(request: ApprovalRequest): void {
    this.onmessage?.(new MessageEvent('message', {
      data: JSON.stringify({
        type: 'event.approval.requested',
        session_id: request.session_id,
        payload: request,
      }),
    }));
  }

  emitResolved(approvalId: string, sessionId: string): void {
    this.onmessage?.(new MessageEvent('message', {
      data: JSON.stringify({
        type: 'event.approval.resolved',
        session_id: sessionId,
        payload: { approval_id: approvalId },
      }),
    }));
  }
}

const request = (id: string, sessionId: string): ApprovalRequest => ({
  approval_id: id,
  session_id: sessionId,
  agent_id: 'background_agent',
  tool_call_id: `tool-${id}`,
  tool_name: 'shell.run',
  action: `Run ${id}`,
  tool_input_display: { kind: 'generic', summary: id },
  created_at: '2026-08-18T12:00:00.000Z',
  expires_at: '2026-08-18T12:01:00.000Z',
});

function Probe({ currentSessionId, onState }: { currentSessionId: string; onState: (state: GlobalApprovalsResult) => void }): ReactElement {
  const state = useGlobalApprovals();
  useEffect(() => onState(state), [onState, state]);
  return createElement(
    'ul',
    { 'data-current-session': currentSessionId },
    state.requests.map(item => createElement('li', { key: item.approval_id }, `${item.session_id}:${item.approval_id}`)),
  );
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('useGlobalApprovals', () => {
  it('keeps a non-current session approval visible, deduplicates events, and resolves its source', async () => {
    const sourceRequest = request('approval-background', 'session-background');
    vi.spyOn(api.approvals, 'list').mockResolvedValue({ items: [] });
    vi.spyOn(api.approvals, 'resolve').mockResolvedValue({ resolved: true });
    vi.spyOn(api, 'getWsUrl').mockResolvedValue('ws://localhost/api/v1/ws');
    globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;

    let latest!: GlobalApprovalsResult;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(createElement(Probe, {
        currentSessionId: 'session-current',
        onState: state => { latest = state; },
      }));
      await Promise.resolve();
    });
    TestWebSocket.latest.emitOpen();
    await act(async () => {
      TestWebSocket.latest.emitApproval(sourceRequest);
      TestWebSocket.latest.emitApproval(sourceRequest);
    });

    expect(document.body.textContent).toContain('session-background:approval-background');
    expect(latest.requests).toHaveLength(1);

    await act(async () => {
      root.render(createElement(Probe, {
        currentSessionId: 'session-other',
        onState: state => { latest = state; },
      }));
      await Promise.resolve();
    });
    expect(latest.requests[0]?.session_id).toBe('session-background');

    await act(async () => {
      await latest.resolveApproval(sourceRequest, 'rejected', { feedback: 'no' });
    });
    expect(api.approvals.resolve).toHaveBeenCalledWith('approval-background', expect.objectContaining({
      decision: 'rejected',
      agent_id: 'background_agent',
      feedback: 'no',
    }));
    expect(latest.requests).toHaveLength(0);
  });

  it('restores pending approvals from the global snapshot and removes resolved events', async () => {
    const restored = { ...request('approval-restored', 'session-restored'), expires_at: '2099-08-18T12:01:00.000Z' };
    const list = vi.spyOn(api.approvals, 'list')
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValue({ items: [restored] });
    vi.spyOn(api, 'getWsUrl').mockResolvedValue('ws://localhost/api/v1/ws');
    globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;

    let latest!: GlobalApprovalsResult;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(createElement(Probe, {
        currentSessionId: 'session-current',
        onState: state => { latest = state; },
      }));
      await Promise.resolve();
    });
    TestWebSocket.latest.emitOpen();
    await act(async () => { await latest.refresh(); });
    expect(list).toHaveBeenCalled();
    expect(latest.requests.map(item => item.approval_id)).toEqual(['approval-restored']);

    await act(async () => {
      TestWebSocket.latest.emitResolved('approval-restored', 'session-restored');
    });
    expect(latest.requests).toHaveLength(0);
  });

  it('keeps past-expires_at approvals visible and never aborts the session on refresh', async () => {
    const stale = request('approval-stale', 'session-stale');
    const list = vi.spyOn(api.approvals, 'list').mockResolvedValue({ items: [stale] });
    const abortSession = vi.spyOn(api, 'abortSession').mockResolvedValue(undefined as never);
    vi.spyOn(api, 'getWsUrl').mockResolvedValue('ws://localhost/api/v1/ws');
    globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;

    let latest!: GlobalApprovalsResult;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(createElement(Probe, {
        currentSessionId: 'session-current',
        onState: state => { latest = state; },
      }));
      await Promise.resolve();
    });
    TestWebSocket.latest.emitOpen();
    await act(async () => { await latest.refresh(); });

    expect(list).toHaveBeenCalled();
    expect(stale.expires_at < new Date().toISOString()).toBe(true);
    expect(latest.requests.map(item => item.approval_id)).toEqual(['approval-stale']);
    expect(abortSession).not.toHaveBeenCalled();
  });
});
