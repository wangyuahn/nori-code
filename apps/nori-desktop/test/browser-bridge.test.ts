import { afterEach, describe, expect, it, vi } from 'vitest';

import { startBrowserBridge } from '../src/main/browser-bridge';
import type { BrowserViewManager } from '../src/main/browser-view';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('browser bridge', () => {
  it('keeps the server registration alive while a browser action is running', async () => {
    let heartbeatCount = 0;
    let actionPolled = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/heartbeat')) {
        heartbeatCount += 1;
        return response({ connected: true, paused: false, pending: 1 });
      }
      if (url.endsWith('/actions?wait_ms=20000')) {
        if (!actionPolled) {
          actionPolled = true;
          return response({ action: { id: 'slow-action', sessionId: 'session-1', agentId: 'agent-1', request: { action: 'wait' } } });
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      return response(true);
    });
    vi.stubGlobal('fetch', fetchMock);

    const manager = {
      getState: () => ({ automation: { paused: false } }),
      executeAction: () => new Promise(() => undefined),
    } as unknown as BrowserViewManager;
    const bridge = startBrowserBridge({
      origin: 'http://127.0.0.1:58627',
      token: 'test-token',
      manager,
      heartbeatIntervalMs: 5,
    });

    await bridge.ready;
    await vi.waitFor(() => expect(heartbeatCount).toBeGreaterThan(0));
    bridge.stop();
  });

  it('retries an executed action result until the server accepts it', async () => {
    let actionPolled = false;
    let resultAttempts = 0;
    let markDelivered: (() => void) | undefined;
    const delivered = new Promise<void>(resolve => { markDelivered = resolve; });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/actions?wait_ms=20000')) {
        if (!actionPolled) {
          actionPolled = true;
          return response({
            action: {
              id: 'action-1',
              sessionId: 'session-1',
              agentId: 'agent-1',
              request: { action: 'snapshot' },
            },
          });
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      if (url.endsWith('/actions/action-1')) {
        resultAttempts += 1;
        if (resultAttempts === 1) throw new Error('temporary network failure');
        markDelivered?.();
        return response(true);
      }
      return response(true);
    });
    vi.stubGlobal('fetch', fetchMock);

    const manager = {
      getState: () => ({ automation: { paused: false } }),
      executeAction: vi.fn().mockResolvedValue({ ok: true, output: 'snapshot' }),
    } as unknown as BrowserViewManager;
    const bridge = startBrowserBridge({
      origin: 'http://127.0.0.1:58627',
      token: 'test-token',
      manager,
    });

    await bridge.ready;
    await Promise.race([
      delivered,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('result retry timed out')), 3_000)),
    ]);
    bridge.stop();

    expect(manager.executeAction).toHaveBeenCalledTimes(1);
    expect(resultAttempts).toBe(2);
  });
});

function response(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, msg: '', data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
