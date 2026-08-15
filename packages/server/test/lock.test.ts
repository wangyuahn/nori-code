/**
 * Lock file semantics (ROADMAP P0.12 AC).
 *
 * Hermetic strategy: every test uses a tmpdir lock path so production
 * `~/.kimi/server/lock` is never touched. We mint pid values that don't
 * collide with the real process (we ARE the test process, so use a clearly
 * dead high pid like 0x7fffffff for stale-takeover tests; `process.kill(pid,
 * 0)` returns ESRCH for any unallocated pid on Linux/macOS).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_LOCK_PATH,
  ServerLockedError,
  acquireLock,
  acquireLockSafe,
  getLiveLock,
  sameLockOwner,
  type LockContents,
} from '../src/lock';
import {
  removeLockIfOwnerDead,
  waitForServerReady,
} from '../src/control';

let tmpDir: string;
let lockPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'nori-server-lock-test-'));
  lockPath = join(tmpDir, 'lock');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('acquireLock — basic acquire / release', () => {
  it('writes pid/started_at/port JSON and release deletes the file', () => {
    const handle = acquireLock({
      lockPath,
      port: 58627,
      nowIso: '2026-06-05T00:00:00.000Z',
      launchId: 'launch-test',
    });
    expect(handle.lockPath).toBe(lockPath);
    expect(existsSync(lockPath)).toBe(true);

    const stored = JSON.parse(readFileSync(lockPath, 'utf8')) as LockContents;
    expect(stored).toEqual({
      schema_version: 2,
      launch_id: 'launch-test',
      state: 'starting',
      pid: process.pid,
      started_at: '2026-06-05T00:00:00.000Z',
      port: 58627,
    });

    handle.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('defaults nowIso + pid when not provided', () => {
    const handle = acquireLock({ lockPath, port: 1234 });
    const stored = JSON.parse(readFileSync(lockPath, 'utf8')) as LockContents;
    expect(stored.pid).toBe(process.pid);
    expect(stored.port).toBe(1234);
    // ISO 8601 with milliseconds + Z. Loose check — full format coverage lives in protocol/time.test.ts.
    expect(stored.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    handle.release();
  });

  it('release is idempotent — second call is a no-op', () => {
    const handle = acquireLock({ lockPath, port: 9 });
    handle.release();
    handle.release(); // would throw if not guarded
    expect(existsSync(lockPath)).toBe(false);
  });

  it('release tolerates a missing lock file (best-effort)', () => {
    const handle = acquireLock({ lockPath, port: 9 });
    // Operator manually rm'd it between acquire and release.
    rmSync(lockPath);
    expect(() => handle.release()).not.toThrow();
  });

  it.skipIf(process.platform === 'win32')('creates the lock file with 0600 permissions (ROADMAP M5.2)', () => {
    const handle = acquireLock({ lockPath, port: 58627 });
    // The lock file lives next to the per-pid bearer token; it must not be
    // group/world readable.
    expect(statSync(lockPath).mode & 0o777).toBe(0o600);
    handle.release();
  });
});

describe('acquireLock — concurrent-instance protection', () => {
  it('throws ServerLockedError when a live owner already holds the lock', () => {
    // Simulate "another live server" by writing a lock file with our own pid
    // (which is definitely alive — this test runner) but a fake port.
    const existing: LockContents = {
      pid: process.pid,
      started_at: '2026-06-05T00:00:00.000Z',
      port: 58627,
    };
    writeFileSync(lockPath, JSON.stringify(existing));

    // Same-pid double-acquire is also a conflict (single-server-per-process
    // invariant). Caller must release the previous handle first.
    expect(() => acquireLock({ lockPath, port: 58627 })).toThrow(ServerLockedError);

    try {
      acquireLock({ lockPath, port: 58627 });
    } catch (err) {
      const e = err as ServerLockedError;
      expect(e.code).toBe('ESERVER_LOCKED');
      expect(e.exitCode).toBe(2);
      expect(e.message).toContain(`pid=${process.pid}`);
      expect(e.message).toContain('port=58627');
      expect(e.existing).toEqual(existing);
    }
  });

  it('takes over a stale lock whose recorded pid is dead', () => {
    // 0x7fffffff (2147483647) is the max signed-32 pid on Linux/macOS; the
    // kernel never allocates pids that high in normal operation. ESRCH guaranteed.
    const stalePid = 0x7fffffff;
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: stalePid,
        started_at: '2025-01-01T00:00:00.000Z',
        port: 58627,
      } satisfies LockContents),
    );

    const handle = acquireLock({ lockPath, port: 58627 });
    const stored = JSON.parse(readFileSync(lockPath, 'utf8')) as LockContents;
    expect(stored.pid).toBe(process.pid);
    expect(stored.port).toBe(58627);
    handle.release();
  });

  it('takes over an unparseable lock file', () => {
    writeFileSync(lockPath, '{garbage');
    const handle = acquireLock({ lockPath, port: 4242 });
    const stored = JSON.parse(readFileSync(lockPath, 'utf8')) as LockContents;
    expect(stored.pid).toBe(process.pid);
    handle.release();
  });

  it('does NOT delete the lock if a third party stole ownership between acquire and release', () => {
    const handle = acquireLock({ lockPath, port: 9999 });
    // Simulate another server clobbering the file with its own pid+port.
    const otherPid = 0x7ffffff0;
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: otherPid, started_at: 'x', port: 1234 } satisfies LockContents),
    );

    handle.release();
    expect(existsSync(lockPath)).toBe(true); // mismatched pid → preserved
  });
});

describe('acquireLock — updatePort', () => {
  it('rewrites the recorded port when our pid owns the lock', () => {
    const handle = acquireLock({ lockPath, port: 7878 });

    handle.updatePort(7879);

    const stored = JSON.parse(readFileSync(lockPath, 'utf8')) as LockContents;
    expect(stored.port).toBe(7879);
    expect(stored.pid).toBe(process.pid);
    handle.release();
  });

  it('preserves unrelated fields when rewriting the port', () => {
    const handle = acquireLock({
      lockPath,
      port: 7878,
      host: '127.0.0.1',
      hostVersion: '1.2.3',
      entry: '/usr/local/bin/kimi',
      nowIso: '2026-06-05T00:00:00.000Z',
      launchId: 'launch-test',
    });

    handle.updatePort(7880);

    const stored = JSON.parse(readFileSync(lockPath, 'utf8')) as LockContents;
    expect(stored).toEqual({
      schema_version: 2,
      launch_id: 'launch-test',
      state: 'starting',
      pid: process.pid,
      started_at: '2026-06-05T00:00:00.000Z',
      host: '127.0.0.1',
      port: 7880,
      host_version: '1.2.3',
      entry: '/usr/local/bin/kimi',
    });
    handle.release();
  });

  it('is a no-op when the port is unchanged', () => {
    const handle = acquireLock({ lockPath, port: 7878 });
    const before = readFileSync(lockPath, 'utf8');

    handle.updatePort(7878);

    expect(readFileSync(lockPath, 'utf8')).toBe(before);
    handle.release();
  });

  it('is a no-op when the lock file is missing', () => {
    const handle = acquireLock({ lockPath, port: 7878 });
    rmSync(lockPath);

    expect(() => {
      handle.updatePort(7879);
    }).not.toThrow();
    expect(existsSync(lockPath)).toBe(false);
    handle.release();
  });

  it('does NOT rewrite the port when a third party owns the lock', () => {
    const handle = acquireLock({ lockPath, port: 7878 });
    // Simulate another server clobbering the file with its own pid+port.
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 0x7ffffff0, started_at: 'x', port: 7878 } satisfies LockContents),
    );

    handle.updatePort(7879);

    const stored = JSON.parse(readFileSync(lockPath, 'utf8')) as LockContents;
    expect(stored.port).toBe(7878); // untouched — we don't own it anymore
    handle.release();
  });
});

describe('acquireLockSafe - product identity', () => {
  it('never probes or takes over a lock owned by a live pid', async () => {
    const customLockPath = join(tmpDir, 'server', 'lock');
    mkdirSync(join(tmpDir, 'server'), { recursive: true });
    writeFileSync(join(tmpDir, 'server.token'), 'legacy-token\n');
    writeFileSync(
      customLockPath,
      JSON.stringify({
        pid: process.pid,
        started_at: '2026-07-20T00:00:00.000Z',
        host: '127.0.0.1',
        port: 58627,
      } satisfies LockContents),
    );

    const fetchMock = vi.spyOn(globalThis, 'fetch');

    try {
      await expect(
        acquireLockSafe({
          lockPath: customLockPath,
          port: 58771,
        }),
      ).rejects.toBeInstanceOf(ServerLockedError);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(readFileSync(customLockPath, 'utf8')).toContain('"port":58627');
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe('acquireLock - ready transition', () => {
  it('publishes the actual port and ready timestamp atomically', () => {
    const handle = acquireLock({
      lockPath,
      port: 58771,
      launchId: 'launch-ready',
      nowIso: '2026-07-25T00:00:00.000Z',
    });

    handle.markReady(58772, '2026-07-25T00:00:01.000Z');

    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({
      schema_version: 2,
      launch_id: 'launch-ready',
      state: 'ready',
      port: 58772,
      ready_at: '2026-07-25T00:00:01.000Z',
    });
    handle.release();
  });

  it('does not publish ready after another launch takes ownership', () => {
    const handle = acquireLock({ lockPath, port: 58771, launchId: 'launch-old' });
    const replacement = {
      schema_version: 2,
      launch_id: 'launch-new',
      state: 'starting',
      pid: process.pid,
      started_at: '2026-07-25T00:00:00.000Z',
      port: 58771,
    } satisfies LockContents;
    writeFileSync(lockPath, JSON.stringify(replacement));

    handle.markReady(58772);

    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(replacement);
  });
});

describe('acquireLock — defaults', () => {
  it('DEFAULT_LOCK_PATH points under the kimi-code home', () => {
    expect(DEFAULT_LOCK_PATH).toMatch(/[/\\]\.nori-code[/\\]server[/\\]lock$/);
  });
});

describe('getLiveLock', () => {
  it('returns undefined when the lock file is missing', () => {
    expect(getLiveLock(lockPath)).toBeUndefined();
  });

  it('returns undefined for an unparseable lock file', () => {
    writeFileSync(lockPath, '{garbage');
    expect(getLiveLock(lockPath)).toBeUndefined();
  });

  it('returns undefined for a stale lock whose recorded pid is dead', () => {
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 0x7fffffff,
        started_at: '2025-01-01T00:00:00.000Z',
        port: 58627,
      } satisfies LockContents),
    );
    expect(getLiveLock(lockPath)).toBeUndefined();
  });

  it('returns the contents when the recorded pid is alive', () => {
    const live: LockContents = {
      pid: process.pid,
      started_at: '2026-06-05T00:00:00.000Z',
      port: 9000,
    };
    writeFileSync(lockPath, JSON.stringify(live));
    expect(getLiveLock(lockPath)).toEqual(live);
  });
});

describe('server control', () => {
  it('never treats a V2 owner as the same owner as a legacy-shaped lock', () => {
    const v2 = {
      schema_version: 2,
      launch_id: 'launch-v2',
      state: 'starting',
      pid: process.pid,
      started_at: '2026-07-25T00:00:00.000Z',
      host: '127.0.0.1',
      port: 58771,
      host_version: '1.0.1',
    } satisfies LockContents;
    const legacy = {
      pid: v2.pid,
      started_at: v2.started_at,
      host: v2.host,
      port: v2.port,
      host_version: v2.host_version,
    } satisfies LockContents;

    expect(sameLockOwner(v2, legacy)).toBe(false);
    expect(sameLockOwner(legacy, v2)).toBe(false);
  });

  it('uses launch_id to distinguish owners that reuse the same pid', () => {
    const owner = {
      schema_version: 2,
      launch_id: 'launch-old',
      state: 'ready',
      pid: process.pid,
      started_at: '2026-07-25T00:00:00.000Z',
      port: 58771,
    } satisfies LockContents;

    expect(sameLockOwner(owner, { ...owner, launch_id: 'launch-new' })).toBe(false);
  });

  it('waits for a live starting owner instead of deleting its lock', async () => {
    const starting = {
      schema_version: 2,
      launch_id: 'launch-starting',
      state: 'starting',
      pid: process.pid,
      started_at: new Date().toISOString(),
      host: '127.0.0.1',
      port: 58771,
      host_version: '1.0.0',
    } satisfies LockContents;
    writeFileSync(lockPath, JSON.stringify(starting));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 0, data: { app: 'nori-code' } }), { status: 200 }),
    );
    setTimeout(() => {
      writeFileSync(lockPath, JSON.stringify({
        ...starting,
        state: 'ready',
        ready_at: new Date().toISOString(),
      }));
    }, 10);

    const result = await waitForServerReady({
      lockPath,
      expectedVersion: '1.0.0',
      timeoutMs: 250,
      pollMs: 5,
    });

    expect(result.status).toBe('ready');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockRestore();
  });

  it('reports a timed-out live starting owner without removing it', async () => {
    const starting = {
      schema_version: 2,
      launch_id: 'launch-stuck',
      state: 'starting',
      pid: process.pid,
      started_at: '2020-01-01T00:00:00.000Z',
      port: 58771,
      host_version: '1.0.0',
    } satisfies LockContents;
    writeFileSync(lockPath, JSON.stringify(starting));

    await expect(waitForServerReady({ lockPath, expectedVersion: '1.0.0' }))
      .resolves.toMatchObject({ status: 'timed_out', lock: starting });
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(starting);
  });

  it('only removes a lock after its exact owner pid is dead', () => {
    const dead = {
      schema_version: 2,
      launch_id: 'launch-dead',
      state: 'starting',
      pid: 0x7fffffff,
      started_at: '2026-07-25T00:00:00.000Z',
      port: 58771,
    } satisfies LockContents;
    writeFileSync(lockPath, JSON.stringify(dead));

    expect(removeLockIfOwnerDead(dead, lockPath)).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });
});
