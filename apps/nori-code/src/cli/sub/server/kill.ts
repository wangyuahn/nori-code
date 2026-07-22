/**
 * `nori server kill` — terminate the running server.
 *
 * Combines two independent mechanisms so the server dies even if one path
 * fails:
 *
 *   1. API path  — `POST /api/v1/shutdown` for a graceful, in-process shutdown
 *                  (best-effort; older builds or a wedged server may not answer).
 *   2. PID path  — signal the pid recorded in the lock (SIGTERM → wait →
 *                  SIGKILL). SIGKILL / TerminateProcess is the hard guarantee:
 *                  it cannot be caught or ignored.
 *
 * The only honest failure mode is insufficient permissions (a process owned by
 * another user), which surfaces as an error rather than a silent miss.
 */

import type { Command } from 'commander';
import { unlinkSync } from 'node:fs';

import {
  classifyServerIdentity,
  DEFAULT_LOCK_PATH,
  getLiveLock,
  type LockContents,
  type ServerIdentityClass,
} from '@nori-code/server';

import { getDataDir } from '#/utils/paths';

import { lockConnectHost } from './daemon';
import { authHeaders, serverOrigin, tryResolveServerToken } from './shared';

/** How long to wait for the graceful API shutdown request. */
const API_TIMEOUT_MS = 2000;
/** Grace period after SIGTERM before escalating to SIGKILL. */
const TERM_GRACE_MS = 3000;
/** Grace period after SIGKILL before giving up. */
const KILL_GRACE_MS = 2000;
/** Poll cadence while waiting for the pid to exit. */
const POLL_INTERVAL_MS = 100;

export interface KillCommandDeps {
  getLiveLock(): LockContents | undefined;
  requestShutdown(origin: string, token: string | undefined): Promise<void>;
  /** Best-effort read of the persistent bearer token; undefined on miss. */
  resolveToken(): string | undefined;
  /**
   * Identify which product serves the origin ('nori' | 'foreign' |
   * 'unreachable'). Guards the forced PID path against signaling a foreign
   * process that recycled the recorded PID or shares the port.
   */
  probeIdentity(origin: string, token: string | undefined): Promise<ServerIdentityClass>;
  /** Remove the stale lock file after a foreign owner was detected. */
  discardLock(): void;
  signalPid(pid: number, signal: NodeJS.Signals): boolean;
  pidAlive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  now(): number;
}

export interface ExpectedServerOwner {
  readonly pid: number;
  readonly started_at?: string;
  readonly host?: string;
  readonly port: number;
  readonly host_version?: string;
  readonly entry?: string;
}

const EXPECTED_OWNER_ENV = {
  pid: 'NORI_CODE_EXPECT_SERVER_PID',
  started_at: 'NORI_CODE_EXPECT_SERVER_STARTED_AT',
  host: 'NORI_CODE_EXPECT_SERVER_HOST',
  port: 'NORI_CODE_EXPECT_SERVER_PORT',
  host_version: 'NORI_CODE_EXPECT_SERVER_HOST_VERSION',
  entry: 'NORI_CODE_EXPECT_SERVER_ENTRY',
} as const;

function parseExpectedInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  minimum: number,
): number | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`Invalid ${key}: expected an integer >= ${String(minimum)}.`);
  }
  return value;
}

export function expectedServerOwnerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ExpectedServerOwner | undefined {
  const hasExpectedOwner = Object.values(EXPECTED_OWNER_ENV)
    .some((key) => env[key] !== undefined);
  if (!hasExpectedOwner) return undefined;
  const pid = parseExpectedInteger(env, EXPECTED_OWNER_ENV.pid, 1);
  const port = parseExpectedInteger(env, EXPECTED_OWNER_ENV.port, 0);
  if (pid === undefined || port === undefined) {
    throw new Error(
      `${EXPECTED_OWNER_ENV.pid} and ${EXPECTED_OWNER_ENV.port} must be provided together.`,
    );
  }
  return {
    pid,
    started_at: env[EXPECTED_OWNER_ENV.started_at],
    host: env[EXPECTED_OWNER_ENV.host],
    port,
    host_version: env[EXPECTED_OWNER_ENV.host_version],
    entry: env[EXPECTED_OWNER_ENV.entry],
  };
}

function matchesExpectedOwner(lock: LockContents, expected: ExpectedServerOwner): boolean {
  return (
    lock.pid === expected.pid &&
    lock.started_at === expected.started_at &&
    lock.host === expected.host &&
    lock.port === expected.port &&
    lock.host_version === expected.host_version &&
    lock.entry === expected.entry
  );
}

function sameLockOwner(left: LockContents, right: LockContents): boolean {
  return (
    left.pid === right.pid &&
    left.started_at === right.started_at &&
    left.host === right.host &&
    left.port === right.port &&
    left.host_version === right.host_version &&
    left.entry === right.entry
  );
}

function serverOwnerChangedError(): Error {
  return new Error('Nori server owner changed; refusing to signal a different process.');
}

export function registerKillCommand(server: Command): void {
  server
    .command('kill')
    .description('Stop the running Nori server (graceful API + forced PID kill).')
    .action(async () => {
      try {
        await handleKillCommand(DEFAULT_KILL_DEPS, expectedServerOwnerFromEnv());
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    });
}

export async function handleKillCommand(
  deps: KillCommandDeps,
  expectedOwner?: ExpectedServerOwner,
): Promise<void> {
  const lock = deps.getLiveLock();
  if (!lock) {
    deps.stdout.write('No running Nori server.\n');
    return;
  }
  if (expectedOwner !== undefined && !matchesExpectedOwner(lock, expectedOwner)) {
    throw serverOwnerChangedError();
  }

  const { pid } = lock;
  const origin = serverOrigin(lockConnectHost(lock), lock.port);
  const token = deps.resolveToken();

  // Identify the product before any destructive request or signal. Upstream
  // Kimi Code historically shared both this port and the bare `{code: 0}`
  // health envelope, so even POSTing /shutdown before this check can stop the
  // wrong product. An unreachable owner still takes the forced PID path: that
  // is how a wedged Nori daemon recorded by this lock is recovered.
  const identity = await deps.probeIdentity(origin, token);
  if (identity === 'foreign') {
    deps.discardLock();
    deps.stdout.write(
      `The port recorded in the Nori server lock is now served by a different product; ` +
        `discarded the stale lock without signaling pid ${String(pid)}.\n`,
    );
    return;
  }

  // 1. API path — best-effort graceful shutdown. Ignore every outcome: the
  //    server may be an older build without the route, already wedged, or may
  //    drop the connection as it exits. The bearer token (M5.1) is best-effort
  //    too: if it can't be read the API call 401s and the PID path below still
  //    guarantees the kill.
  if (identity === 'nori') {
    await deps.requestShutdown(origin, token).catch(() => {});
  }

  // The graceful request may stop the original owner or another launcher may
  // replace its lock. Re-read before signaling so a stale decision can never
  // terminate the new owner.
  const currentLock = deps.getLiveLock();
  if (currentLock === undefined) {
    deps.stdout.write(`Nori server (pid ${String(pid)}) stopped.\n`);
    return;
  }
  if (
    !sameLockOwner(lock, currentLock) ||
    (expectedOwner !== undefined && !matchesExpectedOwner(currentLock, expectedOwner))
  ) {
    throw serverOwnerChangedError();
  }

  // 2. PID path — SIGTERM, wait, then SIGKILL.
  // The graceful request can close the original server while another product
  // wins the same port before the lock release is observed. Re-check the
  // product immediately before the first PID signal as a second safety gate.
  if (identity === 'nori' && (await deps.probeIdentity(origin, token)) === 'foreign') {
    deps.discardLock();
    deps.stdout.write(
      `The port recorded in the Nori server lock is now served by a different product; ` +
        `discarded the stale lock without signaling pid ${String(pid)}.\n`,
    );
    return;
  }

  deps.signalPid(pid, 'SIGTERM');

  if (await waitForExit(pid, TERM_GRACE_MS, deps)) {
    deps.stdout.write(`Nori server (pid ${String(pid)}) stopped.\n`);
    return;
  }

  // The process may exit and Windows may recycle its PID during the TERM
  // grace period. Re-check the lock before a forced signal so SIGKILL can
  // never target a replacement that inherited the same numeric PID.
  const forceLock = deps.getLiveLock();
  if (forceLock === undefined) {
    deps.stdout.write(`Nori server (pid ${String(pid)}) stopped.\n`);
    return;
  }
  if (
    !sameLockOwner(lock, forceLock) ||
    (expectedOwner !== undefined && !matchesExpectedOwner(forceLock, expectedOwner))
  ) {
    throw serverOwnerChangedError();
  }

  deps.signalPid(pid, 'SIGKILL');

  if (await waitForExit(pid, KILL_GRACE_MS, deps)) {
    deps.stdout.write(`Nori server (pid ${String(pid)}) killed.\n`);
    return;
  }

  throw new Error(
    `Failed to stop Nori server (pid ${String(pid)}); insufficient permissions?`,
  );
}

async function waitForExit(
  pid: number,
  timeoutMs: number,
  deps: Pick<KillCommandDeps, 'pidAlive' | 'sleep' | 'now'>,
): Promise<boolean> {
  const deadline = deps.now() + timeoutMs;
  do {
    if (!deps.pidAlive(pid)) return true;
    await deps.sleep(POLL_INTERVAL_MS);
  } while (deps.now() < deadline);
  return !deps.pidAlive(pid);
}

/** `process.kill(pid, 0)` probe — true if the pid exists, false on ESRCH. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // EPERM = process exists but we can't signal it. Treat as alive.
    return true;
  }
}

/** Send `signal` to `pid`. Returns false if the signal could not be sent. */
export function signalPid(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** POST the shutdown endpoint; resolves once the request completes or times out. */
export async function requestShutdownViaApi(
  origin: string,
  token: string | undefined,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, API_TIMEOUT_MS);
  try {
    await fetch(`${origin}/api/v1/shutdown`, {
      method: 'POST',
      headers: token !== undefined ? authHeaders(token) : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

const DEFAULT_KILL_DEPS: KillCommandDeps = {
  getLiveLock,
  requestShutdown: requestShutdownViaApi,
  resolveToken: () => tryResolveServerToken(getDataDir()),
  probeIdentity: (origin, token) => classifyServerIdentity(origin, token, API_TIMEOUT_MS),
  discardLock: () => {
    try {
      unlinkSync(DEFAULT_LOCK_PATH);
    } catch {
      // Best effort — a concurrent release/takeover may have removed it.
    }
  },
  signalPid,
  pidAlive,
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
  stdout: process.stdout,
  now: () => Date.now(),
};
