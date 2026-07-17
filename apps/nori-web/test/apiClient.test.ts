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
      loopMode: true,
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(typeof init.body).toBe('string');
    expect(JSON.parse(init.body as string)).toEqual({
      goal_objective: 'ship the release',
      swarm_mode: true,
      loop_mode: true,
      content: [{ type: 'text', text: 'ship the release' }],
    });
  });

  it('uses the collection steer endpoint for queued guidance', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      msg: 'ok',
      data: { steered: true, prompt_ids: ['prompt-1'] },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createClient('http://localhost:3000');

    await expect(client.sessions.prompts.steer('session/1', ['prompt-1'])).resolves.toEqual({
      steered: true,
      prompt_ids: ['prompt-1'],
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://localhost:3000/api/v1/sessions/session%2F1/prompts:steer',
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ prompt_ids: ['prompt-1'] });
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

describe('filesystem actions', () => {
  it('reveals a session-relative path in the local file manager', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      msg: 'ok',
      data: { revealed: true },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createClient('http://localhost:3000');

    await expect(client.sessions.fs.reveal('session/1', 'src/App.tsx')).resolves.toEqual({ revealed: true });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:3000/api/v1/sessions/session%2F1/fs:reveal');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(typeof init.body).toBe('string');
    expect(JSON.parse(init.body as string)).toEqual({ path: 'src/App.tsx' });
  });
});

describe('Cron Job actions', () => {
  it('uses the session-scoped Cron REST endpoints', async () => {
    const responses = [
      { items: [] },
      { id: 'deadbeef', cron: '0 9 * * 1-5', prompt: 'Review changes', createdAt: 1, recurring: true, humanSchedule: 'weekdays', nextFireAt: 2, ageDays: 0, stale: false },
      { deleted: true },
    ];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      msg: 'ok',
      data: responses.shift(),
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createClient('http://localhost:3000');

    await client.sessions.cron.list('session/1');
    await client.sessions.cron.create('session/1', {
      cron: '0 9 * * 1-5',
      prompt: 'Review changes',
      recurring: true,
    });
    await client.sessions.cron.delete('session/1', 'deadbeef');

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'http://localhost:3000/api/v1/sessions/session%2F1/cron',
      'http://localhost:3000/api/v1/sessions/session%2F1/cron',
      'http://localhost:3000/api/v1/sessions/session%2F1/cron/deadbeef',
    ]);
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).method).toBe('POST');
    expect(JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string)).toEqual({
      cron: '0 9 * * 1-5',
      prompt: 'Review changes',
      recurring: true,
    });
    expect((fetchMock.mock.calls[2]?.[1] as RequestInit).method).toBe('DELETE');
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
