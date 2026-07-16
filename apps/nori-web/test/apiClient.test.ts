import { afterEach, describe, expect, it, vi } from 'vitest';

import { createClient, getServerToken, getWebSocketProtocols } from '../src/api/client';

afterEach(() => {
  window.history.replaceState(null, '', '/');
  delete window.noriDesktop;
  vi.unstubAllGlobals();
});

describe('prompt execution options', () => {
  it('maps goal and swarm commands to the existing prompt API fields', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      msg: 'ok',
      data: {
        prompt_id: 'prompt-1',
        user_message_id: 'message-1',
        status: 'running',
        content: [{ type: 'text', text: 'ship the release' }],
        created_at: '2026-07-15T00:00:00.000Z',
      },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createClient('http://localhost:3000');

    await client.sendPrompt('session-1', 'ship the release', [], {
      goalObjective: 'ship the release',
      swarmMode: true,
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      goal_objective: 'ship the release',
      swarm_mode: true,
      content: [{ type: 'text', text: 'ship the release' }],
    });
  });

  it('forwards a cancellation signal to the prompt request', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      await new Promise<void>((_resolve, reject) => {
        const rejectAbort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (init?.signal?.aborted) rejectAbort();
        else init?.signal?.addEventListener('abort', rejectAbort, { once: true });
      });
      throw new Error('prompt request unexpectedly completed');
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = createClient('http://localhost:3000');
    const controller = new AbortController();

    const sending = client.sendPrompt('session-1', 'keep working', [], {}, controller.signal);
    controller.abort();

    await expect(sending).rejects.toMatchObject({ name: 'AbortError' });
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(true);
  });
});

describe('getServerToken', () => {
  it('reads the token from the URL hash used by nori web', async () => {
    window.history.replaceState(null, '', '/#token=hash-token');
    window.noriDesktop = { getServerToken: vi.fn(async () => 'desktop-token') };

    await expect(getServerToken()).resolves.toBe('hash-token');
    expect(window.noriDesktop.getServerToken).not.toHaveBeenCalled();
  });

  it('supports a query token and falls back to the desktop bridge', async () => {
    window.history.replaceState(null, '', '/?token=query-token');
    await expect(getServerToken()).resolves.toBe('query-token');

    window.history.replaceState(null, '', '/');
    window.noriDesktop = { getServerToken: vi.fn(async () => 'desktop-token') };
    await expect(getServerToken()).resolves.toBe('desktop-token');
  });

  it('uses the bearer WebSocket subprotocol required by browser clients', async () => {
    window.history.replaceState(null, '', '/#token=stream-token');
    await expect(getWebSocketProtocols()).resolves.toEqual([
      'nori-code.bearer.stream-token',
    ]);
  });
});
