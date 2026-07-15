import { afterEach, describe, expect, it, vi } from 'vitest';

import { getServerToken } from '../src/api/client';

afterEach(() => {
  window.history.replaceState(null, '', '/');
  delete window.noriDesktop;
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
});
