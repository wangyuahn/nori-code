import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getLiveLock: vi.fn(),
  classifyServerIdentity: vi.fn(),
}));

vi.mock('@nori-code/server', () => ({
  getLiveLock: mocks.getLiveLock,
  classifyServerIdentity: mocks.classifyServerIdentity,
}));

import { runningServerCoexistenceNotice } from '#/tui/utils/server-coexistence';

describe('runningServerCoexistenceNotice', () => {
  beforeEach(() => {
    mocks.getLiveLock.mockReset();
    mocks.classifyServerIdentity.mockReset();
  });

  it('returns undefined when no server lock is present', async () => {
    mocks.getLiveLock.mockReturnValue(undefined);
    await expect(runningServerCoexistenceNotice()).resolves.toBeUndefined();
  });

  it('warns when a Nori server already owns the home lock', async () => {
    mocks.getLiveLock.mockReturnValue({ host: '127.0.0.1', port: 58771, pid: 1 });
    mocks.classifyServerIdentity.mockResolvedValue({ kind: 'nori' });

    const notice = await runningServerCoexistenceNotice();
    expect(notice).toContain('Nori server is already running');
    expect(notice).toContain('http://127.0.0.1:58771');
    expect(notice).toContain('in-process');
  });

  it('warns about foreign listeners without claiming Nori ownership', async () => {
    mocks.getLiveLock.mockReturnValue({ host: '127.0.0.1', port: 58771, pid: 1 });
    mocks.classifyServerIdentity.mockResolvedValue({ kind: 'foreign' });

    const notice = await runningServerCoexistenceNotice();
    expect(notice).toContain('Another service is bound');
  });
});
