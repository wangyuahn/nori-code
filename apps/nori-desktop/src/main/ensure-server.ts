import { execFile } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  classifyServerIdentity,
  isServerLockV2,
  pidAlive,
  readLockContents,
  removeLockIfOwnerDead,
  removeLockIfOwnerMatches,
  sameLockOwner,
  serverOriginFromLock,
  serverOwnerStartupDeadline,
  waitForServerOwnerExit,
  waitForServerReady,
  SERVER_STARTUP_TIMEOUT_MS,
  type LockContents,
} from '@nori-code/server/control';

import {
  SERVER_WORKER_CONFIG_ENV,
  isServerWorkerMessage,
  type ServerWorkerConfig,
  type ServerWorkerMessage,
} from '../server/protocol';

const SHUTDOWN_REQUEST_TIMEOUT_MS = 1_500;
const SHUTDOWN_STEP_TIMEOUT_MS = 2_000;
const FORCE_STOP_TIMEOUT_MS = 2_000;

export interface UtilityProcessHandle {
  readonly pid: number | undefined;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  postMessage(message: unknown): void;
  kill(): boolean;
  on(event: 'message', listener: (message: unknown) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  on(event: 'error', listener: (type: string, location: string, report: string) => void): this;
  once(event: 'exit', listener: (code: number) => void): this;
  off(event: 'message', listener: (message: unknown) => void): this;
  off(event: 'exit', listener: (code: number) => void): this;
}

export interface ForkServerWorkerOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly stdio: 'pipe';
  readonly serviceName: string;
}

export type ForkServerWorker = (
  modulePath: string,
  args: string[],
  options: ForkServerWorkerOptions,
) => UtilityProcessHandle;

export interface EnsureServerOptions {
  readonly workerPath: string;
  readonly webAssetsDir: string;
  readonly expectedVersion: string;
  readonly forkWorker: ForkServerWorker;
  readonly modulesDir?: string;
  readonly host?: string;
  readonly port?: number;
  readonly lockPath?: string;
  readonly startupTimeoutMs?: number;
}

export interface EnsureServerResult {
  readonly origin: string;
  readonly reused: boolean;
}

interface ManagedWorker {
  readonly process: UtilityProcessHandle;
  readonly owner: LockContents;
  readonly lockPath: string;
}

interface WorkerStartFailureOptions {
  readonly code: string;
  readonly logPath: string;
}

class WorkerStartFailure extends Error {
  override readonly name = 'WorkerStartFailure';
  readonly code: string;
  readonly logPath: string;

  constructor(message: string, options: WorkerStartFailureOptions) {
    super(message);
    this.code = options.code;
    this.logPath = options.logPath;
  }
}

let managedWorker: ManagedWorker | undefined;

export function noriHome(): string {
  const override = process.env['NORI_CODE_HOME'];
  return override !== undefined && override.trim().length > 0
    ? override
    : join(homedir(), '.nori-code');
}

export function serverLockPath(): string {
  return join(noriHome(), 'server', 'lock');
}

export function serverLogPath(): string {
  return join(noriHome(), 'server', 'server.log');
}

export function ensureServerLogFile(): void {
  const logPath = serverLogPath();
  try {
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    if (!existsSync(logPath)) writeFileSync(logPath, '', { mode: 0o600 });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to prepare the Nori server log at ${logPath}: ${reason}`, {
      cause: error,
    });
  }
}

function appendServerDiagnostic(message: string): void {
  try {
    appendFileSync(serverLogPath(), `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // Keep the original lifecycle error when logging is unavailable.
  }
}

export function readServerToken(): string | undefined {
  try {
    const token = readFileSync(join(noriHome(), 'server.token'), 'utf8').trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

function signalPid(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function requestServerShutdown(origin: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHUTDOWN_REQUEST_TIMEOUT_MS);
  try {
    const token = readServerToken();
    await fetch(`${origin}/api/v1/shutdown`, {
      method: 'POST',
      headers: token === undefined ? undefined : { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function taskkillProcessTree(pid: number): Promise<void> {
  if (process.platform !== 'win32') {
    signalPid(pid, 'SIGKILL');
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    execFile(
      'taskkill.exe',
      ['/PID', String(pid), '/T', '/F'],
      { timeout: FORCE_STOP_TIMEOUT_MS, windowsHide: true },
      (error, _stdout, stderr) => {
        if (error !== null && pidAlive(pid)) {
          appendServerDiagnostic(
            `[desktop] taskkill failed for pid=${String(pid)}: ${stderr.trim() || error.message}`,
          );
        }
        resolve();
      },
    );
  });
}

async function stopExactOwner(
  owner: LockContents,
  lockPath: string,
  worker?: UtilityProcessHandle,
): Promise<void> {
  const current = readLockContents(lockPath);
  if (current === undefined || !sameLockOwner(current, owner)) return;
  if (!pidAlive(owner.pid)) {
    removeLockIfOwnerDead(owner, lockPath);
    return;
  }

  const origin = serverOriginFromLock(owner);
  const identity = await classifyServerIdentity(origin, readServerToken(), 750);
  if (identity === 'foreign') {
    removeLockIfOwnerMatches(owner, lockPath);
    appendServerDiagnostic(
      `[desktop] removed foreign stale lock without signaling pid=${String(owner.pid)}`,
    );
    return;
  }

  if (worker !== undefined && worker.pid === owner.pid) {
    worker.postMessage({ type: 'shutdown' });
  }
  const gracefulRequest = identity === 'nori'
    ? requestServerShutdown(origin).catch(() => {})
    : Promise.resolve();
  const gracefulExit = waitForServerOwnerExit(owner, {
    lockPath,
    timeoutMs: SHUTDOWN_STEP_TIMEOUT_MS,
  });
  const [, exitedGracefully] = await Promise.all([gracefulRequest, gracefulExit]);
  if (exitedGracefully) return;

  const beforeTerminate = readLockContents(lockPath);
  if (beforeTerminate === undefined || !sameLockOwner(beforeTerminate, owner)) return;

  if (worker !== undefined && worker.pid === owner.pid) worker.kill();
  else signalPid(owner.pid, 'SIGTERM');
  if (await waitForServerOwnerExit(owner, { lockPath, timeoutMs: SHUTDOWN_STEP_TIMEOUT_MS })) {
    return;
  }

  const beforeForce = readLockContents(lockPath);
  if (beforeForce === undefined || !sameLockOwner(beforeForce, owner)) return;
  await taskkillProcessTree(owner.pid);
  removeLockIfOwnerDead(owner, lockPath);
}

function attachWorkerLogs(worker: UtilityProcessHandle): void {
  const append = (chunk: unknown): void => {
    try {
      appendFileSync(serverLogPath(), Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    } catch {
      // The worker IPC still reports fatal errors when file logging is unavailable.
    }
  };
  worker.stdout?.on('data', append);
  worker.stderr?.on('data', append);
}

function waitForWorkerReady(
  worker: UtilityProcessHandle,
  launchId: string,
  deadline: number,
): Promise<Extract<ServerWorkerMessage, { type: 'ready' }>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.off('message', onMessage);
      worker.off('exit', onExit);
      callback();
    };
    const onMessage = (value: unknown): void => {
      if (!isServerWorkerMessage(value) || value.launchId !== launchId) return;
      if (value.type === 'starting') {
        appendServerDiagnostic(
          `[desktop] worker acquired starting lock launch=${launchId} pid=${String(value.pid)}`,
        );
        return;
      }
      if (value.type === 'ready') {
        finish(() => resolve(value));
        return;
      }
      if (value.type === 'fatal') {
        finish(() => reject(new WorkerStartFailure(value.message, {
          code: value.code,
          logPath: value.logPath,
        })));
      }
    };
    const onExit = (code: number): void => {
      finish(() => reject(new WorkerStartFailure(
        `Nori server worker exited with code ${String(code)} before ready.`,
        { code: 'WORKER_EXITED', logPath: serverLogPath() },
      )));
    };
    const remaining = Math.max(0, deadline - Date.now());
    const timer = setTimeout(() => {
      finish(() => reject(new WorkerStartFailure(
        `Nori server worker did not become ready within ${String(SERVER_STARTUP_TIMEOUT_MS)}ms.`,
        { code: 'STARTUP_TIMEOUT', logPath: serverLogPath() },
      )));
    }, remaining);
    worker.on('message', onMessage);
    worker.on('exit', onExit);
  });
}

async function reconcileExisting(
  expectedVersion: string,
  lockPath: string,
  startupTimeoutMs: number,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const lock = readLockContents(lockPath);
    if (lock === undefined) return undefined;
    if (!pidAlive(lock.pid)) {
      removeLockIfOwnerDead(lock, lockPath);
      continue;
    }

    if (!isServerLockV2(lock)) {
      await stopExactOwner(lock, lockPath);
      continue;
    }

    const ownerDeadline = serverOwnerStartupDeadline(lock, startupTimeoutMs);
    if (lock.state === 'starting' && Date.now() >= ownerDeadline) {
      await stopExactOwner(lock, lockPath);
      continue;
    }
    const result = await waitForServerReady({
      lockPath,
      expectedVersion,
      token: readServerToken(),
      timeoutMs: Math.max(1, ownerDeadline - Date.now()),
      startupTimeoutMs,
    });
    if (result.status === 'ready') return result.origin;
    if (result.status === 'missing') continue;
    if (result.status === 'dead') {
      removeLockIfOwnerDead(result.lock, lockPath);
      continue;
    }
    if (result.status === 'foreign') {
      removeLockIfOwnerMatches(result.lock, lockPath);
      continue;
    }
    await stopExactOwner(result.lock, lockPath);
  }
  throw new Error('Unable to reconcile the existing Nori server owner.');
}

function workerEnvironment(config: ServerWorkerConfig, modulesDir?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NORI_CODE_HOME: config.homeDir,
    NORI_CODE_NODE_EXECUTABLE: process.execPath,
    NORI_CODE_NODE_RUN_AS_NODE: '1',
    NORI_CODE_BUNDLED_NODE_MODULES: modulesDir,
    [SERVER_WORKER_CONFIG_ENV]: JSON.stringify(config),
  };
}

export async function ensureServer(options: EnsureServerOptions): Promise<EnsureServerResult> {
  ensureServerLogFile();
  const lockPath = options.lockPath ?? serverLockPath();
  const startupTimeoutMs = options.startupTimeoutMs ?? SERVER_STARTUP_TIMEOUT_MS;
  const reusedOrigin = await reconcileExisting(
    options.expectedVersion,
    lockPath,
    startupTimeoutMs,
  );
  if (reusedOrigin !== undefined) {
    appendServerDiagnostic(`[desktop] reused server at ${reusedOrigin}`);
    return { origin: reusedOrigin, reused: true };
  }

  if (!existsSync(options.workerPath)) {
    throw new Error(`Nori server worker not found at ${options.workerPath}.`);
  }

  const launchId = randomUUID();
  const startedAt = new Date().toISOString();
  const deadline = Date.parse(startedAt) + startupTimeoutMs;
  const config: ServerWorkerConfig = {
    launchId,
    startedAt,
    version: options.expectedVersion,
    homeDir: noriHome(),
    lockPath,
    host: options.host ?? '127.0.0.1',
    port: options.port ?? 58771,
    webAssetsDir: options.webAssetsDir,
    logPath: serverLogPath(),
    parentPid: process.pid,
  };

  appendServerDiagnostic(`[desktop] starting server worker launch=${launchId}`);
  const worker = options.forkWorker(options.workerPath, [], {
    env: workerEnvironment(config, options.modulesDir),
    cwd: dirname(serverLogPath()),
    stdio: 'pipe',
    serviceName: 'Nori Server',
  });
  attachWorkerLogs(worker);
  worker.on('error', (type, location, report) => {
    appendServerDiagnostic(
      `[desktop] server worker fatal runtime error type=${type} location=${location}\n${report}`,
    );
  });

  try {
    const ready = await waitForWorkerReady(worker, launchId, deadline);
    const owner = readLockContents(lockPath);
    if (
      owner === undefined
      || !isServerLockV2(owner)
      || owner.state !== 'ready'
      || owner.launch_id !== launchId
      || owner.pid !== ready.pid
    ) {
      throw new WorkerStartFailure('Server worker reported ready without owning the ready lock.', {
        code: 'READY_LOCK_MISMATCH',
        logPath: serverLogPath(),
      });
    }
    managedWorker = { process: worker, owner, lockPath };
    worker.once('exit', () => {
      if (managedWorker?.process === worker) managedWorker = undefined;
    });
    appendServerDiagnostic(`[desktop] server worker ready at ${ready.origin}`);
    return { origin: ready.origin, reused: false };
  } catch (error) {
    const failedOwner = readLockContents(lockPath);
    if (
      failedOwner !== undefined
      && isServerLockV2(failedOwner)
      && failedOwner.launch_id === launchId
    ) {
      await stopExactOwner(failedOwner, lockPath, worker);
    }
    const winner = await reconcileExisting(
      options.expectedVersion,
      lockPath,
      startupTimeoutMs,
    );
    if (winner !== undefined) {
      appendServerDiagnostic(`[desktop] concurrent launcher won; reusing ${winner}`);
      return { origin: winner, reused: true };
    }
    const owner = readLockContents(lockPath);
    if (owner === undefined || !isServerLockV2(owner) || owner.launch_id !== launchId) {
      worker.kill();
    }
    throw error;
  }
}

export async function stopServerForDesktopExit(): Promise<void> {
  const current = managedWorker;
  if (current === undefined) return;
  managedWorker = undefined;
  appendServerDiagnostic(
    `[desktop] stopping managed server launch=${current.owner.launch_id ?? '<legacy>'}`,
  );
  await stopExactOwner(current.owner, current.lockPath, current.process);
}
