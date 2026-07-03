import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '../src/api';

describe('vis web api auth token handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('scrubs token parameters from the browser URL after persisting the token', async () => {
    const setItem = vi.fn();
    const getItem = vi.fn();
    const replaceState = vi.fn();
    const location = new URL('http://localhost:3001/?foo=bar&token=secret#token=secret&tab=wire');

    vi.stubGlobal('window', {
      history: { replaceState },
      localStorage: { getItem, setItem },
      location,
    });
    const fetchMock = vi.fn(
      async () =>
        new Response('[]', {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.listSessions();

    expect(setItem).toHaveBeenCalledWith('kimi-vis-auth-token', 'secret');
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions', {
      headers: { accept: 'application/json', authorization: 'Bearer secret' },
      method: 'GET',
    });
    expect(replaceState).toHaveBeenCalledWith(null, '', 'http://localhost:3001/?foo=bar#tab=wire');
  });
});
