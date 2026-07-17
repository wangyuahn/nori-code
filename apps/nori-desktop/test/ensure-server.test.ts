import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ensureServer } from '../src/main/ensure-server';

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
    ['server', 'kill'],
    ['server', 'run'],
  ]);
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
    host_version: '1.0.0-pre.1',
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
        host_version: '1.0.0-pre.1',
      }));
    }
    callback?.(null, '', '');
    return undefined as never;
  });

  await expect(ensureServer(seaPath, '1.0.0-pre.1')).resolves.toEqual({
    origin: 'http://127.0.0.1:58628',
  });
  expect(vi.mocked(execFile).mock.calls.map(([, args]) => args?.slice(0, 2))).toEqual([
    ['server', 'kill'],
    ['server', 'run'],
  ]);
});
