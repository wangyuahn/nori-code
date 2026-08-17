import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureServer,
  serverLockPath,
  stopServerForDesktopExit,
  type ForkServerWorker,
  type UtilityProcessHandle,
} from '../src/main/ensure-server';
import {
  SERVER_WORKER_CONFIG_ENV,
  type ServerWorkerConfig,
} from '../src/server/protocol';

class FakeUtilityProcess extends EventEmitter implements UtilityProcessHandle {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  posted: unknown[] = [];

  constructor(public pid: number | undefined, private readonly onPost?: (message: unknown) => void) {
    super();
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
    this.onPost?.(message);
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

let homeDir: string;
let workerPath: string;
let webAssetsDir: string;
let oldHome: string | undefined;
let child: ChildProcess | undefined;

function writeLock(config: ServerWorkerConfig, state: 'starting' | 'ready', pid: number): void {
  mkdirSync(join(config.homeDir, 'server'), { recursive: true });
  writeFileSync(config.lockPath, JSON.stringify({
    schema_version: 2,
    launch_id: config.launchId,
    state,
    pid,
    started_at: config.startedAt,
    ready_at: state === 'ready' ? new Date().toISOString() : undefined,
    host: config.host,
    port: config.port,
    host_version: config.version,
    entry: 'test/server-worker',
  }));
}

function parseConfig(options: { env: NodeJS.ProcessEnv }): ServerWorkerConfig {
  return JSON.parse(options.env[SERVER_WORKER_CONFIG_ENV] ?? '{}') as ServerWorkerConfig;
}

function readyFork(pid = 0x7ffffffe): { fork: ForkServerWorker; workers: FakeUtilityProcess[] } {
  const workers: FakeUtilityProcess[] = [];
  const fork: ForkServerWorker = (_modulePath, _args, options) => {
    const config = parseConfig(options);
    const worker = new FakeUtilityProcess(pid);
    workers.push(worker);
    setTimeout(() => {
      writeLock(config, 'starting', pid);
      worker.emit('message', {
        type: 'starting',
        launchId: config.launchId,
        pid,
        startedAt: config.startedAt,
      });
      writeLock(config, 'ready', pid);
      worker.emit('message', {
        type: 'ready',
        launchId: config.launchId,
        origin: `http://${config.host}:${String(config.port)}`,
        pid,
        version: config.version,
      });
    }, 0);
    return worker;
  };
  return { fork, workers };
}

function baseOptions(forkWorker: ForkServerWorker) {
  return {
    workerPath,
    webAssetsDir,
    expectedVersion: '1.0.4-pre.0',
    forkWorker,
    lockPath: serverLockPath(),
    startupTimeoutMs: 250,
  } as const;
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'nori-desktop-server-'));
  workerPath = join(homeDir, 'server-worker.cjs');
  webAssetsDir = join(homeDir, 'web');
  writeFileSync(workerPath, '');
  mkdirSync(webAssetsDir, { recursive: true });
  oldHome = process.env['NORI_CODE_HOME'];
  process.env['NORI_CODE_HOME'] = homeDir;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await stopServerForDesktopExit();
  if (child?.pid !== undefined) {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      // Already exited.
    }
  }
  child = undefined;
  if (oldHome === undefined) delete process.env['NORI_CODE_HOME'];
  else process.env['NORI_CODE_HOME'] = oldHome;
  rmSync(homeDir, { recursive: true, force: true });
});

describe('desktop server coordinator', () => {
  it('starts one utility worker and accepts its ready IPC only with a matching ready lock', async () => {
    const { fork, workers } = readyFork();

    await expect(ensureServer(baseOptions(fork))).resolves.toEqual({
      origin: 'http://127.0.0.1:58771',
      reused: false,
    });
    expect(workers).toHaveLength(1);
  });

  it('reuses a same-version ready server after one identity check', async () => {
    const lockPath = serverLockPath();
    mkdirSync(join(homeDir, 'server'), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      schema_version: 2,
      launch_id: 'existing-ready',
      state: 'ready',
      pid: process.pid,
      started_at: new Date().toISOString(),
      ready_at: new Date().toISOString(),
      host: '127.0.0.1',
      port: 58771,
      host_version: '1.0.4-pre.0',
    }));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 0, data: { app: 'nori-code' } }), { status: 200 }),
    );
    const fork = vi.fn<ForkServerWorker>();

    await expect(ensureServer(baseOptions(fork))).resolves.toEqual({
      origin: 'http://127.0.0.1:58771',
      reused: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fork).not.toHaveBeenCalled();
  });

  it('waits for a live starting owner instead of deleting or replacing it', async () => {
    const lockPath = serverLockPath();
    const starting = {
      schema_version: 2,
      launch_id: 'existing-starting',
      state: 'starting',
      pid: process.pid,
      started_at: new Date().toISOString(),
      host: '127.0.0.1',
      port: 58771,
      host_version: '1.0.4-pre.0',
    } as const;
    mkdirSync(join(homeDir, 'server'), { recursive: true });
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
    const fork = vi.fn<ForkServerWorker>();

    await expect(ensureServer(baseOptions(fork))).resolves.toMatchObject({ reused: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fork).not.toHaveBeenCalled();
  });

  it('falls back to the concurrent winner when its worker loses the lock race', async () => {
    const fork = vi.fn<ForkServerWorker>((_modulePath, _args, options) => {
      const config = parseConfig(options);
      const worker = new FakeUtilityProcess(0x7ffffffd);
      setTimeout(() => {
        const winner = {
          ...config,
          launchId: 'concurrent-winner',
        };
        writeLock(winner, 'starting', process.pid);
        worker.emit('message', {
          type: 'fatal',
          launchId: config.launchId,
          code: 'SERVER_LOCKED',
          message: 'server already running',
          logPath: join(homeDir, 'server', 'server.log'),
        });
        setTimeout(() => writeLock(winner, 'ready', process.pid), 10);
      }, 0);
      return worker;
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 0, data: { app: 'nori-code' } }), { status: 200 }),
    );

    await expect(ensureServer(baseOptions(fork))).resolves.toEqual({
      origin: 'http://127.0.0.1:58771',
      reused: true,
    });
    expect(fork).toHaveBeenCalledTimes(1);
  });

  it('stops an exact incompatible owner before starting the current worker', async () => {
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      child?.once('spawn', resolve);
      child?.once('error', reject);
    });
    const pid = child.pid;
    if (pid === undefined) throw new Error('test child did not start');
    const lockPath = serverLockPath();
    mkdirSync(join(homeDir, 'server'), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      schema_version: 2,
      launch_id: 'old-version',
      state: 'ready',
      pid,
      started_at: new Date().toISOString(),
      ready_at: new Date().toISOString(),
      host: '127.0.0.1',
      port: 58771,
      host_version: '1.0.0',
    }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      if (url.endsWith('/api/v1/shutdown')) {
        process.kill(pid, 'SIGTERM');
      }
      return new Response(JSON.stringify({ code: 0, data: { app: 'nori-code' } }), { status: 200 });
    });
    const { fork } = readyFork();

    await expect(ensureServer(baseOptions(fork))).resolves.toMatchObject({ reused: false });
    expect(existsSync(lockPath)).toBe(true);
  });

  it('uses worker shutdown IPC and removes the exact lock on desktop exit', async () => {
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      child?.once('spawn', resolve);
      child?.once('error', reject);
    });
    const pid = child.pid;
    if (pid === undefined) throw new Error('test child did not start');
    let worker: FakeUtilityProcess;
    const fork: ForkServerWorker = (_modulePath, _args, options) => {
      const config = parseConfig(options);
      worker = new FakeUtilityProcess(pid, (message) => {
        if ((message as { type?: unknown }).type !== 'shutdown') return;
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // Already exited.
        }
        try {
          unlinkSync(config.lockPath);
        } catch {
          // Already removed.
        }
      });
      setTimeout(() => {
        writeLock(config, 'ready', pid);
        worker.emit('message', {
          type: 'ready',
          launchId: config.launchId,
          origin: `http://${config.host}:${String(config.port)}`,
          pid,
          version: config.version,
        });
      }, 0);
      return worker;
    };

    await ensureServer(baseOptions(fork));
    await stopServerForDesktopExit();

    expect(worker!.posted).toContainEqual({ type: 'shutdown' });
    expect(existsSync(serverLockPath())).toBe(false);
  });
});
