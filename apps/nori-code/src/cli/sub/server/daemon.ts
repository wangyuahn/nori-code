/** `nori server run` daemon orchestration (parent/spawner side). */

import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import {
  DEFAULT_LOCK_DIR,
  DEFAULT_LOCK_PATH,
  isServerLockV2,
  pidAlive,
  readLockContents,
  removeLockIfOwnerDead,
  removeLockIfOwnerMatches,
  serverOwnerStartupDeadline,
  waitForServerReady,
  SERVER_STARTUP_TIMEOUT_MS,
  type LockContents,
} from '@nori-code/server';

import { getDataDir } from '#/utils/paths';

import {
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  LOCAL_SERVER_HOST,
  tryResolveServerToken,
} from './shared';
import { getVersion } from '../../version';

const SERVER_LOG_FILENAME = 'server.log';
const DEFAULT_DAEMON_LOG_LEVEL = 'info';
const LAUNCH_ID_ENV = 'NORI_CODE_SERVER_LAUNCH_ID';
const STARTED_AT_ENV = 'NORI_CODE_SERVER_STARTED_AT';

export interface EnsureDaemonOptions {
  host?: string;
  port?: number;
  logLevel?: string;
  debugEndpoints?: boolean;
  insecureNoTls?: boolean;
  allowRemoteShutdown?: boolean;
  allowRemoteTerminals?: boolean;
  allowedHosts?: readonly string[];
  idleGraceMs?: number;
  hostVersion?: string;
}

export interface EnsureDaemonResult {
  readonly origin: string;
  readonly reused: boolean;
  readonly host: string;
  readonly port: number;
}

export function daemonLogPath(): string {
  return join(DEFAULT_LOCK_DIR, SERVER_LOG_FILENAME);
}

function appendDaemonDiagnostic(message: string): void {
  try {
    mkdirSync(dirname(daemonLogPath()), { recursive: true });
    appendFileSync(daemonLogPath(), `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // Preserve the lifecycle error if logging is unavailable.
  }
}

function formatStartupError(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

export function lockConnectHost(lock: LockContents): string {
  const host = lock.host ?? LOCAL_SERVER_HOST;
  return host === '0.0.0.0' ? LOCAL_SERVER_HOST : host;
}

interface NodeSeaModule {
  isSea(): boolean;
}

const nodeRequire = createRequire(import.meta.url);
let cachedSea: NodeSeaModule | null | undefined;

function loadSeaModule(): NodeSeaModule | null {
  if (cachedSea !== undefined) return cachedSea;
  try {
    cachedSea = nodeRequire('node:sea') as NodeSeaModule;
  } catch {
    cachedSea = null;
  }
  return cachedSea;
}

function detectSea(): boolean {
  const sea = loadSeaModule();
  if (sea === null) return false;
  try {
    return sea.isSea();
  } catch {
    return false;
  }
}

export function resolveDaemonProgram(
  argv: readonly string[] = process.argv,
  cwd: string = process.cwd(),
  execPath: string = process.execPath,
  isSea: boolean = detectSea(),
): string {
  if (isSea) return execPath;
  const candidate = argv[1] === 'server' ? execPath : (argv[1] ?? execPath);
  return isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
}

interface SpawnDaemonChildOptions {
  host?: string;
  port: number;
  logLevel: string;
  debugEndpoints?: boolean;
  insecureNoTls?: boolean;
  allowRemoteShutdown?: boolean;
  allowRemoteTerminals?: boolean;
  allowedHosts?: readonly string[];
  idleGraceMs?: number;
  launchId?: string;
  startedAt?: string;
}

export function spawnDaemonChild(options: SpawnDaemonChildOptions): ChildProcess {
  const program = resolveDaemonProgram();
  const logPath = daemonLogPath();
  const logDir = dirname(logPath);
  mkdirSync(logDir, { recursive: true });
  const args = [
    'server',
    'run',
    '--daemon',
    '--port',
    String(options.port),
    '--log-level',
    options.logLevel,
  ];
  if (options.host !== undefined) args.push('--host', options.host);
  if (options.debugEndpoints === true) args.push('--debug-endpoints');
  if (options.insecureNoTls === true) args.push('--insecure-no-tls');
  if (options.allowRemoteShutdown === true) args.push('--allow-remote-shutdown');
  if (options.allowRemoteTerminals === true) args.push('--allow-remote-terminals');
  if (options.idleGraceMs !== undefined) {
    args.push('--idle-grace-ms', String(options.idleGraceMs));
  }
  if (options.allowedHosts !== undefined && options.allowedHosts.length > 0) {
    args.push('--allowed-host', ...options.allowedHosts);
  }

  const execPath = process.execPath;
  const spawnArgs = program === execPath ? args : [program, ...args];
  const logFd = openSync(logPath, 'a');
  try {
    const child = spawn(execPath, spawnArgs, {
      detached: true,
      cwd: logDir,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        [LAUNCH_ID_ENV]: options.launchId ?? randomUUID(),
        [STARTED_AT_ENV]: options.startedAt ?? new Date().toISOString(),
      },
    });
    child.once('error', (error) => {
      appendDaemonDiagnostic(`[spawner] failed to launch daemon: ${error.message}`);
    });
    child.unref();
    return child;
  } finally {
    closeSync(logFd);
  }
}

async function stopRecordedOwner(lock: LockContents): Promise<void> {
  const { stopServerOwner } = await import('./kill');
  await stopServerOwner(lock);
}

async function reconcileExisting(hostVersion: string): Promise<EnsureDaemonResult | undefined> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const lock = readLockContents(DEFAULT_LOCK_PATH);
    if (lock === undefined) return undefined;
    if (!pidAlive(lock.pid)) {
      removeLockIfOwnerDead(lock, DEFAULT_LOCK_PATH);
      continue;
    }

    if (!isServerLockV2(lock)) {
      await stopRecordedOwner(lock);
      continue;
    }

    const ownerDeadline = serverOwnerStartupDeadline(lock);
    if (lock.state === 'starting' && Date.now() >= ownerDeadline) {
      await stopRecordedOwner(lock);
      continue;
    }
    const result = await waitForServerReady({
      lockPath: DEFAULT_LOCK_PATH,
      expectedVersion: hostVersion,
      token: tryResolveServerToken(getDataDir()),
      timeoutMs: lock.state === 'starting'
        ? Math.max(1, ownerDeadline - Date.now())
        : SERVER_STARTUP_TIMEOUT_MS,
    });
    if (result.status === 'ready') {
      return {
        origin: result.origin,
        reused: true,
        host: result.lock.host ?? DEFAULT_SERVER_HOST,
        port: result.lock.port,
      };
    }
    if (result.status === 'missing') continue;
    if (result.status === 'dead') {
      removeLockIfOwnerDead(result.lock, DEFAULT_LOCK_PATH);
      continue;
    }
    if (result.status === 'foreign') {
      removeLockIfOwnerMatches(result.lock, DEFAULT_LOCK_PATH);
      continue;
    }
    await stopRecordedOwner(result.lock);
  }
  throw new Error('Unable to reconcile the existing Nori server owner.');
}

function childExitPromise(child: ChildProcess): Promise<never> {
  return new Promise((_, reject) => {
    child.once('exit', (code, signal) => {
      appendDaemonDiagnostic(
        `[daemon] process exited during startup: code=${String(code)}, signal=${String(signal)}`,
      );
      reject(new Error(formatDaemonBootFailure({ code, signal }, daemonLogPath())));
    });
    child.once('error', (error) => reject(error));
  });
}

function stopSpawnedChild(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(child.pid, 'SIGTERM');
  } catch {
    // Already exited.
  }
}

export async function ensureDaemon(options: EnsureDaemonOptions = {}): Promise<EnsureDaemonResult> {
  const host = options.host ?? DEFAULT_SERVER_HOST;
  const port = options.port ?? DEFAULT_SERVER_PORT;
  const logLevel = options.logLevel ?? DEFAULT_DAEMON_LOG_LEVEL;
  const hostVersion = options.hostVersion ?? getVersion();

  const reusable = await reconcileExisting(hostVersion);
  if (reusable !== undefined) return reusable;

  const launchId = randomUUID();
  const startedAt = new Date().toISOString();
  let child: ChildProcess;
  try {
    child = spawnDaemonChild({
      host,
      port,
      logLevel,
      debugEndpoints: options.debugEndpoints,
      insecureNoTls: options.insecureNoTls,
      allowRemoteShutdown: options.allowRemoteShutdown,
      allowRemoteTerminals: options.allowRemoteTerminals,
      allowedHosts: options.allowedHosts,
      idleGraceMs: options.idleGraceMs,
      launchId,
      startedAt,
    });
  } catch (error) {
    appendDaemonDiagnostic(`[daemon] failed to spawn the server process: ${formatStartupError(error)}`);
    throw error;
  }

  const controller = new AbortController();
  const killSpawnedChild = (): void => stopSpawnedChild(child);
  const onSigterm = (): void => {
    killSpawnedChild();
    process.exit(143);
  };
  const onSigint = (): void => {
    killSpawnedChild();
    process.exit(130);
  };
  process.once('SIGTERM', onSigterm);
  process.once('SIGINT', onSigint);
  let startupSucceeded = false;

  try {
    const readyPromise = waitForServerReady({
      lockPath: DEFAULT_LOCK_PATH,
      expectedVersion: hostVersion,
      token: tryResolveServerToken(getDataDir()),
      timeoutMs: SERVER_STARTUP_TIMEOUT_MS,
      waitForLock: true,
      signal: controller.signal,
    });
    let result;
    try {
      result = await Promise.race([readyPromise, childExitPromise(child)]);
    } catch (error) {
      controller.abort();
      const winner = await reconcileExisting(hostVersion);
      if (winner !== undefined) {
        startupSucceeded = true;
        return winner;
      }
      throw error;
    }

    if (result.status === 'ready') {
      const reused = result.lock.launch_id !== launchId;
      if (reused) stopSpawnedChild(child);
      startupSucceeded = true;
      return {
        origin: result.origin,
        reused,
        host: result.lock.host ?? DEFAULT_SERVER_HOST,
        port: result.lock.port,
      };
    }

    const current = readLockContents(DEFAULT_LOCK_PATH);
    if (current !== undefined && current.launch_id === launchId) {
      await stopRecordedOwner(current).catch(() => {});
    }
    throw new Error(
      `Nori server daemon failed to start within ${String(SERVER_STARTUP_TIMEOUT_MS)}ms.\n\n` +
        formatLogTail(daemonLogPath()),
    );
  } finally {
    controller.abort();
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGINT', onSigint);
    if (!startupSucceeded) stopSpawnedChild(child);
    const current = readLockContents(DEFAULT_LOCK_PATH);
    if (current?.launch_id === launchId && !pidAlive(current.pid)) {
      removeLockIfOwnerDead(current, DEFAULT_LOCK_PATH);
    }
  }
}

function formatDaemonBootFailure(
  exit: { code: number | null; signal: NodeJS.Signals | null },
  logPath: string,
): string {
  const reason = exit.signal === null
    ? `exited with code ${String(exit.code)}`
    : `was terminated by signal ${exit.signal}`;
  return `Nori server daemon ${reason} during startup.\n\n${formatLogTail(logPath)}`;
}

function formatLogTail(logPath: string): string {
  const tail = tailFile(logPath, 30);
  return tail.length === 0
    ? `Check the log for details: ${logPath}`
    : `Last log lines (${logPath}):\n${tail}`;
}

function tailFile(filePath: string, maxLines: number): string {
  try {
    return readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .slice(-maxLines)
      .join('\n');
  } catch {
    return '';
  }
}

export function daemonLaunchIdentityFromEnv(env: NodeJS.ProcessEnv = process.env): {
  launchId?: string;
  startedAt?: string;
} {
  return {
    launchId: env[LAUNCH_ID_ENV],
    startedAt: env[STARTED_AT_ENV],
  };
}
