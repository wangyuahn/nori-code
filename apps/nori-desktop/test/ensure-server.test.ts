import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  ensureServer,
  ensureServerLogFile,
  stopServerForDesktopExit,
} from '../src/main/ensure-server';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

const homes: string[] = [];
const originalHome = process.env['NORI_CODE_HOME'];

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function noriHealthResponse(version = '1.0.0-pre.3'): Response {
  return new Response(JSON.stringify({
    code: 0,
    data: { app: 'nori-code', version },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = requestUrl(input);
    if (url.includes(':58628/')) {
      return noriHealthResponse();
    }
    throw new Error('unhealthy');
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalHome === undefined) delete process.env['NORI_CODE_HOME'];
  else process.env['NORI_CODE_HOME'] = originalHome;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

it('stops the daemon when Nori Work exits and clears only its matching lock', async () => {
  const home = join(tmpdir(), `nori-desktop-exit-${String(Date.now())}-${Math.random().toString(36).slice(2)}`);
  homes.push(home);
  process.env['NORI_CODE_HOME'] = home;
  const serverDir = join(home, 'server');
  const lock = join(serverDir, 'lock');
  const seaPath = join(home, 'nori.exe');
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(seaPath, 'test');
  writeFileSync(lock, JSON.stringify({
    pid: 999_999_999,
    started_at: '2026-07-24T00:00:00.000Z',
    host: '127.0.0.1',
    port: 58627,
    host_version: '1.0.0-pre.6',
  }));

  vi.mocked(execFile).mockImplementation((_file, args, _options, callback) => {
    expect(args?.slice(0, 2)).toEqual(['server', 'kill']);
    callback?.(null, '', '');
    return undefined as never;
  });

  await expect(stopServerForDesktopExit(seaPath)).resolves.toBeUndefined();
  expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
  expect(existsSync(lock)).toBe(false);
});

it('replaces an unhealthy stale lock from an older bundled server', async () => {
  const home = join(tmpdir(), `nori-desktop-server-${String(Date.now())}-${Math.random().toString(36).slice(2)}`);
  homes.push(home);
  process.env['NORI_CODE_HOME'] = home;
  const serverDir = join(home, 'server');
  const lock = join(serverDir, 'lock');
  const seaPath = join(home, 'nori.exe');
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(seaPath, 'test');
  writeFileSync(lock, JSON.stringify({
    pid: 999_999_999,
    started_at: '2026-07-15T00:00:00.000Z',
    host: '127.0.0.1',
    port: 58627,
    host_version: '0.1.17',
  }));

  vi.mocked(execFile).mockImplementation((_file, args, _options, callback) => {
    const command = args?.[1];
    if (command === 'run') {
      writeFileSync(lock, JSON.stringify({
        pid: process.pid,
        started_at: '2026-07-15T00:00:01.000Z',
        host: '127.0.0.1',
        port: 58628,
        host_version: '0.1.18',
      }));
    }
    callback?.(null, '', '');
    return undefined as never;
  });

  await expect(ensureServer(seaPath, '0.1.18')).resolves.toEqual({
    origin: 'http://127.0.0.1:58628',
  });
  expect(vi.mocked(execFile).mock.calls.map(([, args]) => args?.slice(0, 2))).toEqual([
    ['server', 'kill'],
    ['server', 'run'],
  ]);
  const runOptions = vi.mocked(execFile).mock.calls.find(([, args]) => args?.[1] === 'run')?.[2];
  expect(runOptions?.env).toMatchObject({
    NORI_CODE_NODE_EXECUTABLE: process.execPath,
    NORI_CODE_NODE_RUN_AS_NODE: '1',
  });
});

it('writes server replacement failures to the server log', async () => {
  const home = join(tmpdir(), `nori-desktop-kill-error-${String(Date.now())}-${Math.random().toString(36).slice(2)}`);
  homes.push(home);
  process.env['NORI_CODE_HOME'] = home;
  const serverDir = join(home, 'server');
  const lock = join(serverDir, 'lock');
  const seaPath = join(home, 'nori.exe');
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(seaPath, 'test');
  writeFileSync(lock, JSON.stringify({
    pid: process.pid,
    host: '127.0.0.1',
    port: 58627,
    host_version: '0.1.17',
  }));

  // Make the existing server respond as healthy so we enter the
  // versionMismatch → kill path, not the !existingHealthy fast path.
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = requestUrl(input);
    if (url.includes(':58627/')) {
      return noriHealthResponse('0.1.17');
    }
    throw new Error('unhealthy');
  }));

  vi.mocked(execFile).mockImplementation((_file, args, _options, callback) => {
    expect(args?.slice(0, 2)).toEqual(['server', 'kill']);
    callback?.(new Error('permission denied'), 'kill stdout', 'kill stderr');
    return undefined as never;
  });

  await expect(ensureServer(seaPath, '0.1.18')).rejects.toThrow('nori server kill failed: permission denied');
  const log = readFileSync(join(home, 'server', 'server.log'), 'utf8');
  expect(log).toContain('[desktop] bundled Nori server replacement could not stop the existing server');
  expect(log).toContain('kill stderr');
});

it('replaces an unreachable incompatible lock through the guarded kill command', async () => {
  const home = join(tmpdir(), `nori-desktop-old-unhealthy-${String(Date.now())}-${Math.random().toString(36).slice(2)}`);
  homes.push(home);
  process.env['NORI_CODE_HOME'] = home;
  const serverDir = join(home, 'server');
  const lock = join(serverDir, 'lock');
  const seaPath = join(home, 'nori.exe');
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(seaPath, 'test');
  writeFileSync(lock, JSON.stringify({
    pid: process.pid,
    host: '127.0.0.1',
    port: 58627,
    host_version: '1.0.0-pre.2',
  }));

  vi.mocked(execFile).mockImplementation((_file, args, _options, callback) => {
    if (args?.[1] === 'kill') {
      callback?.(null, '', '');
      return undefined as never;
    }
    expect(args?.[1]).toBe('run');
    writeFileSync(lock, JSON.stringify({
      pid: process.pid,
      host: '127.0.0.1',
      port: 58628,
      host_version: '1.0.0-pre.3',
    }));
    callback?.(null, '', '');
    return undefined as never;
  });

  await expect(ensureServer(seaPath, '1.0.0-pre.3')).resolves.toEqual({
    origin: 'http://127.0.0.1:58628',
  });
  expect(vi.mocked(execFile).mock.calls.map(([, args]) => args?.slice(0, 2))).toEqual([
    ['server', 'kill'],
    ['server', 'run'],
  ]);
});

it('does not reuse a server lock without a version field', async () => {
  const home = join(tmpdir(), `nori-desktop-unknown-version-${String(Date.now())}-${Math.random().toString(36).slice(2)}`);
  homes.push(home);
  process.env['NORI_CODE_HOME'] = home;
  const serverDir = join(home, 'server');
  const lock = join(serverDir, 'lock');
  const seaPath = join(home, 'nori.exe');
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(seaPath, 'test');
  writeFileSync(lock, JSON.stringify({
    pid: process.pid,
    host: '127.0.0.1',
    port: 58627,
  }));

  vi.stubGlobal('fetch', vi.fn(async () => noriHealthResponse()));
  vi.mocked(execFile).mockImplementation((_file, args, _options, callback) => {
    if (args?.[1] === 'kill') {
      rmSync(lock, { force: true });
      callback?.(null, '', '');
      return undefined as never;
    }
    expect(args?.[1]).toBe('run');
    writeFileSync(lock, JSON.stringify({
      pid: process.pid,
      host: '127.0.0.1',
      port: 58628,
      host_version: '1.0.0-pre.3',
    }));
    callback?.(null, '', '');
    return undefined as never;
  });

  await expect(ensureServer(seaPath, '1.0.0-pre.3')).resolves.toEqual({
    origin: 'http://127.0.0.1:58628',
  });
  expect(vi.mocked(execFile).mock.calls.map(([, args]) => args?.slice(0, 2))).toEqual([
    ['server', 'kill'],
    ['server', 'run'],
  ]);
});

it('replaces an unhealthy same-version lock before starting the new daemon', async () => {
  const home = join(tmpdir(), `nori-desktop-unresponsive-${String(Date.now())}-${Math.random().toString(36).slice(2)}`);
  homes.push(home);
  process.env['NORI_CODE_HOME'] = home;
  const serverDir = join(home, 'server');
  const lock = join(serverDir, 'lock');
  const seaPath = join(home, 'nori.exe');
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(seaPath, 'test');
  writeFileSync(lock, JSON.stringify({
    pid: process.pid,
    host: '127.0.0.1',
    port: 58627,
    host_version: '1.0.0-pre.2',
  }));

  vi.mocked(execFile).mockImplementation((_file, args, _options, callback) => {
    if (args?.[1] === 'kill') {
      callback?.(null, '', '');
      return undefined as never;
    }
    expect(args?.[1]).toBe('run');
    writeFileSync(lock, JSON.stringify({
      pid: process.pid,
      host: '127.0.0.1',
      port: 58628,
      host_version: '1.0.0-pre.2',
    }));
    callback?.(null, '', '');
    return undefined as never;
  });

  await expect(ensureServer(seaPath, '1.0.0-pre.2')).resolves.toEqual({
    origin: 'http://127.0.0.1:58628',
  });
  expect(vi.mocked(execFile).mock.calls.map(([, args]) => args?.slice(0, 2))).toEqual([
    ['server', 'kill'],
    ['server', 'run'],
  ]);
  expect(readFileSync(join(home, 'server', 'server.log'), 'utf8')).toContain(
    'same-version server is unhealthy',
  );
});

it('creates the server log path before the first bundled server launch', () => {
  const home = join(tmpdir(), `nori-desktop-first-launch-${String(Date.now())}-${Math.random().toString(36).slice(2)}`);
  homes.push(home);
  process.env['NORI_CODE_HOME'] = home;

  expect(() => ensureServerLogFile()).not.toThrow();
  expect(readFileSync(join(home, 'server', 'server.log'), 'utf8')).toBe('');
});

it('writes bundled server startup errors to the server log', async () => {
  const home = join(tmpdir(), `nori-desktop-server-error-${String(Date.now())}-${Math.random().toString(36).slice(2)}`);
  homes.push(home);
  process.env['NORI_CODE_HOME'] = home;
  const seaPath = join(home, 'nori.exe');
  mkdirSync(home, { recursive: true });
  writeFileSync(seaPath, 'test');

  const startupError = new Error('unable to bind server port');
  vi.mocked(execFile).mockImplementation((_file, args, _options, callback) => {
    expect(args?.slice(0, 2)).toEqual(['server', 'run']);
    callback?.(startupError, 'boot stdout', 'EADDRINUSE');
    return undefined as never;
  });

  await expect(ensureServer(seaPath)).rejects.toThrow('nori server run failed: unable to bind server port');
  const log = readFileSync(join(home, 'server', 'server.log'), 'utf8');
  expect(log).toContain('[desktop] bundled Nori server failed to start');
  expect(log).toContain('unable to bind server port');
  expect(log).toContain('exitCode:');
  expect(log).toContain('serverLogTail:');
  expect(log).toContain('EADDRINUSE');
});

it('does not treat an old server-already-running log line as a current lock conflict', async () => {
  const home = join(tmpdir(), `nori-desktop-old-log-${String(Date.now())}-${Math.random().toString(36).slice(2)}`);
  homes.push(home);
  process.env['NORI_CODE_HOME'] = home;
  const serverDir = join(home, 'server');
  const seaPath = join(home, 'nori.exe');
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(seaPath, 'test');
  writeFileSync(
    join(serverDir, 'server.log'),
    'server already running (pid=4228, port=58627, started=old)\n',
  );

  vi.mocked(execFile).mockImplementation((_file, args, _options, callback) => {
    expect(args?.slice(0, 2)).toEqual(['server', 'run']);
    callback?.(new Error('current configuration failure'), '', '');
    return undefined as never;
  });

  await expect(ensureServer(seaPath)).rejects.toThrow('current configuration failure');
  expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
});

it('replaces a healthy same-version server that lacks required desktop routes', async () => {
  const home = join(tmpdir(), `nori-desktop-server-${String(Date.now())}-${Math.random().toString(36).slice(2)}`);
  homes.push(home);
  process.env['NORI_CODE_HOME'] = home;
  const serverDir = join(home, 'server');
  const lock = join(serverDir, 'lock');
  const seaPath = join(home, 'nori.exe');
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(seaPath, 'test');
  writeFileSync(join(home, 'server.token'), 'test-token');
  writeFileSync(lock, JSON.stringify({
    pid: process.pid,
    host: '127.0.0.1',
    port: 58627,
    host_version: '1.0.0-pre.2',
  }));

  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = requestUrl(input);
    if (url.includes(':58627/') && url.endsWith('/cron')) return new Response('', { status: 404 });
    if (url.includes(':58627/')) return noriHealthResponse('1.0.0-pre.2');
    if (url.includes(':58628/')) return noriHealthResponse('1.0.0-pre.2');
    throw new Error('unhealthy');
  }));

  vi.mocked(execFile).mockImplementation((_file, args, _options, callback) => {
    if (args?.[1] === 'run') {
      writeFileSync(lock, JSON.stringify({
        pid: process.pid,
        host: '127.0.0.1',
        port: 58628,
        host_version: '1.0.0-pre.2',
      }));
    }
    callback?.(null, '', '');
    return undefined as never;
  });

  await expect(ensureServer(seaPath, '1.0.0-pre.2')).resolves.toEqual({
    origin: 'http://127.0.0.1:58628',
  });
  expect(vi.mocked(execFile).mock.calls.map(([, args]) => args?.slice(0, 2))).toEqual([
    ['server', 'kill'],
    ['server', 'run'],
  ]);
});

it('replaces a healthy old-version server with a lock matching the desktop expected version', async () => {
  const home = join(tmpdir(), `nori-desktop-old-version-${String(Date.now())}-${Math.random().toString(36).slice(2)}`);
  homes.push(home);
  process.env['NORI_CODE_HOME'] = home;
  const serverDir = join(home, 'server');
  const lock = join(serverDir, 'lock');
  const seaPath = join(home, 'nori.exe');
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(seaPath, 'test');
  writeFileSync(lock, JSON.stringify({
    pid: process.pid,
    started_at: '2026-07-15T00:00:00.000Z',
    host: '127.0.0.1',
    port: 58627,
    host_version: '1.0.0-pre.2',
    entry: 'C:\\old\\nori.exe',
  }));

  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = requestUrl(input);
    if (url.includes(':58627/') || url.includes(':58628/')) {
      return noriHealthResponse(url.includes(':58627/') ? '1.0.0-pre.2' : '1.0.0-pre.3');
    }
    throw new Error('unhealthy');
  }));

  vi.mocked(execFile).mockImplementation((_file, args, options, callback) => {
    if (args?.[1] === 'kill') {
      const env = (options as { env?: NodeJS.ProcessEnv }).env;
      expect(env).toEqual(expect.objectContaining({
        NORI_CODE_EXPECT_SERVER_PID: String(process.pid),
        NORI_CODE_EXPECT_SERVER_STARTED_AT: '2026-07-15T00:00:00.000Z',
        NORI_CODE_EXPECT_SERVER_HOST: '127.0.0.1',
        NORI_CODE_EXPECT_SERVER_PORT: '58627',
        NORI_CODE_EXPECT_SERVER_HOST_VERSION: '1.0.0-pre.2',
        NORI_CODE_EXPECT_SERVER_ENTRY: 'C:\\old\\nori.exe',
      }));
    }
    if (args?.[1] === 'run') {
      writeFileSync(lock, JSON.stringify({
        pid: process.pid,
        started_at: '2026-07-15T00:00:01.000Z',
        host: '127.0.0.1',
        port: 58628,
        host_version: '1.0.0-pre.3',
      }));
    }
    callback?.(null, '', '');
    return undefined as never;
  });

  await expect(ensureServer(seaPath, '1.0.0-pre.3')).resolves.toEqual({
    origin: 'http://127.0.0.1:58628',
  });
  expect(vi.mocked(execFile).mock.calls.map(([, args]) => args?.slice(0, 2))).toEqual([
    ['server', 'kill'],
    ['server', 'run'],
  ]);
});

it('throws an incompatibility error when the replaced lock still has the old CLI version', async () => {
  const home = join(tmpdir(), `nori-desktop-stale-cli-version-${String(Date.now())}-${Math.random().toString(36).slice(2)}`);
  homes.push(home);
  process.env['NORI_CODE_HOME'] = home;
  const serverDir = join(home, 'server');
  const lock = join(serverDir, 'lock');
  const seaPath = join(home, 'nori.exe');
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(seaPath, 'test');
  writeFileSync(lock, JSON.stringify({
    pid: process.pid,
    started_at: '2026-07-15T00:00:00.000Z',
    host: '127.0.0.1',
    port: 58627,
    host_version: '1.0.0-pre.2',
  }));

  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = requestUrl(input);
    if (url.includes(':58627/')) {
      return noriHealthResponse('1.0.0-pre.2');
    }
    throw new Error('unhealthy');
  }));

  vi.mocked(execFile).mockImplementation((_file, args, _options, callback) => {
    if (args?.[1] === 'run') {
      writeFileSync(lock, JSON.stringify({
        pid: process.pid,
        started_at: '2026-07-15T00:00:01.000Z',
        host: '127.0.0.1',
        port: 58628,
        host_version: '1.0.0-pre.2',
      }));
    }
    callback?.(null, '', '');
    return undefined as never;
  });

  await expect(ensureServer(seaPath, '1.0.0-pre.3')).rejects.toThrow(
    'Nori server version 1.0.0-pre.2 is incompatible with Nori Work 1.0.0-pre.3',
  );
  expect(vi.mocked(execFile).mock.calls.map(([, args]) => args?.slice(0, 2))).toEqual([
    ['server', 'kill'],
    ['server', 'run'],
  ]);
});

it('reuses a healthy compatible server without invoking server run again', async () => {
  const home = join(tmpdir(), 'nori-desktop-compatible-' + String(Date.now()) + '-' + Math.random().toString(36).slice(2));
  homes.push(home);
  process.env['NORI_CODE_HOME'] = home;
  const serverDir = join(home, 'server');
  const lock = join(serverDir, 'lock');
  const seaPath = join(home, 'nori.exe');
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(seaPath, 'test');
  writeFileSync(lock, JSON.stringify({
    pid: process.pid,
    host: '127.0.0.1',
    port: 58627,
    host_version: '1.0.0-pre.3',
  }));

  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    if (requestUrl(input).includes(':58627/')) {
      return noriHealthResponse();
    }
    throw new Error('unhealthy');
  }));

  await expect(ensureServer(seaPath, '1.0.0-pre.3')).resolves.toEqual({
    origin: 'http://127.0.0.1:58627',
  });
  expect(vi.mocked(execFile)).not.toHaveBeenCalled();
});

it('does not reuse or stop a foreign server that only returns the legacy health envelope', async () => {
  const home = join(
    tmpdir(),
    'nori-desktop-foreign-' + String(Date.now()) + '-' + Math.random().toString(36).slice(2),
  );
  homes.push(home);
  process.env['NORI_CODE_HOME'] = home;
  const serverDir = join(home, 'server');
  const lock = join(serverDir, 'lock');
  const seaPath = join(home, 'nori.exe');
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(seaPath, 'test');
  writeFileSync(join(home, 'server.token'), 'nori-token');
  writeFileSync(lock, JSON.stringify({
    pid: process.pid,
    host: '127.0.0.1',
    port: 58627,
    host_version: '1.0.0-pre.2',
  }));

  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = requestUrl(input);
    if (url.includes(':58627/') && url.endsWith('/meta')) {
      return new Response(JSON.stringify({ code: 401 }), { status: 401 });
    }
    if (url.includes(':58627/')) {
      return new Response(JSON.stringify({ code: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes(':58628/')) return noriHealthResponse();
    throw new Error('unhealthy');
  }));
  vi.mocked(execFile).mockImplementation((_file, args, _options, callback) => {
    expect(args?.[1]).toBe('run');
    writeFileSync(lock, JSON.stringify({
      pid: process.pid,
      host: '127.0.0.1',
      port: 58628,
      host_version: '1.0.0-pre.3',
    }));
    callback?.(null, '', '');
    return undefined as never;
  });

  await expect(ensureServer(seaPath, '1.0.0-pre.3')).resolves.toEqual({
    origin: 'http://127.0.0.1:58628',
  });
  expect(vi.mocked(execFile).mock.calls.map(([, args]) => args?.slice(0, 2))).toEqual([
    ['server', 'run'],
  ]);
});

it('recovers a healthy server that wins a startup lock race', async () => {
  const home = join(tmpdir(), 'nori-desktop-race-' + String(Date.now()) + '-' + Math.random().toString(36).slice(2));
  homes.push(home);
  process.env['NORI_CODE_HOME'] = home;
  const serverDir = join(home, 'server');
  const lock = join(serverDir, 'lock');
  const seaPath = join(home, 'nori.exe');
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(seaPath, 'test');

  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    if (requestUrl(input).includes(':58627/')) {
      return noriHealthResponse();
    }
    throw new Error('unhealthy');
  }));
  vi.mocked(execFile).mockImplementation((_file, args, _options, callback) => {
    expect(args?.slice(0, 2)).toEqual(['server', 'run']);
    writeFileSync(lock, JSON.stringify({
      pid: process.pid,
      host: '127.0.0.1',
      port: 58627,
      host_version: '1.0.0-pre.3',
    }));
    callback?.(new Error('server already running'), '', 'server already running');
    return undefined as never;
  });

  await expect(ensureServer(seaPath, '1.0.0-pre.3')).resolves.toEqual({
    origin: 'http://127.0.0.1:58627',
  });
});
