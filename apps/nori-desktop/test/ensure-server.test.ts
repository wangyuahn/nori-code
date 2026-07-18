import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ensureServer, ensureServerLogFile } from '../src/main/ensure-server';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

const homes: string[] = [];
const originalHome = process.env['NORI_CODE_HOME'];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes(':58628/')) {
      return new Response(JSON.stringify({ code: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
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
    const url = String(input);
    if (url.includes(':58627/')) {
      return new Response(JSON.stringify({ code: 0 }), { status: 200 });
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

it('replaces a live same-version server that is no longer healthy', async () => {
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
    ['server', 'run'],
  ]);
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
    const url = String(input);
    if (url.includes(':58627/') && url.endsWith('/cron')) return new Response('', { status: 404 });
    if (url.includes(':58627/')) return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    if (url.includes(':58628/')) return new Response(JSON.stringify({ code: 0 }), { status: 200 });
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
    pid: 999_999_999,
    started_at: '2026-07-15T00:00:00.000Z',
    host: '127.0.0.1',
    port: 58627,
    host_version: '1.0.0-pre.2',
  }));

  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes(':58627/') || url.includes(':58628/')) {
      return new Response(JSON.stringify({ code: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
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
    pid: 999_999_999,
    started_at: '2026-07-15T00:00:00.000Z',
    host: '127.0.0.1',
    port: 58627,
    host_version: '1.0.0-pre.2',
  }));

  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes(':58627/')) {
      return new Response(JSON.stringify({ code: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
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
