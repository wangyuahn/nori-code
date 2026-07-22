import { afterEach, describe, expect, it, vi } from 'vitest';

import { classifyServerIdentity, probeNoriServer } from '../src/identity';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('server product identity', () => {
  it('accepts a current Nori health response', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ code: 0, data: { app: 'nori-code', version: '1.0.0-pre.5' } }),
    );

    await expect(probeNoriServer('http://127.0.0.1:58771', 100)).resolves.toBe(true);
    await expect(
      classifyServerIdentity('http://127.0.0.1:58771', undefined, 100),
    ).resolves.toBe('nori');
  });

  it('classifies a bare upstream health response as foreign without a token', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ code: 0 }),
    );

    await expect(
      classifyServerIdentity('http://127.0.0.1:58627', undefined, 100),
    ).resolves.toBe('foreign');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('classifies invalid health JSON as a reachable foreign service', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not-json', { status: 200 }),
    );

    await expect(
      classifyServerIdentity('http://127.0.0.1:58627', undefined, 100),
    ).resolves.toBe('foreign');
  });

  it('recognizes a legacy Nori server through its token-gated meta route', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ code: 0 }))
      .mockImplementationOnce(async (_input, init) => {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer legacy-token');
        return jsonResponse({ code: 0, data: { version: '1.0.0-pre.3' } });
      });

    await expect(
      classifyServerIdentity('http://127.0.0.1:58627', 'legacy-token', 100),
    ).resolves.toBe('nori');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps a reachable foreign classification when its meta route times out', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ code: 0 }))
      .mockRejectedValueOnce(new Error('connection reset'));

    await expect(
      classifyServerIdentity('http://127.0.0.1:58627', 'nori-token', 100),
    ).resolves.toBe('foreign');
  });

  it('reports unreachable only when no HTTP service answers', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      classifyServerIdentity('http://127.0.0.1:58771', undefined, 100),
    ).resolves.toBe('unreachable');
  });
});
