import { unlinkSync } from 'node:fs';

import { classifyServerIdentity } from './identity';
import {
  DEFAULT_LOCK_PATH,
  isServerLockV2,
  pidAlive,
  readLockContents,
  sameLockOwner,
  type LockContents,
} from './lock';

export { classifyServerIdentity } from './identity';
export {
  isServerLockV2,
  pidAlive,
  readLockContents,
  sameLockOwner,
  type LockContents,
} from './lock';

export const SERVER_STARTUP_TIMEOUT_MS = 30_000;
export const SERVER_CONTROL_POLL_MS = 200;

export type ServerReadyWaitResult =
  | { status: 'ready'; lock: LockContents; origin: string }
  | { status: 'missing' }
  | { status: 'dead'; lock: LockContents }
  | { status: 'incompatible'; lock: LockContents }
  | { status: 'foreign'; lock: LockContents; origin: string }
  | { status: 'unhealthy'; lock: LockContents; origin: string }
  | { status: 'timed_out'; lock: LockContents };

export function serverOriginFromLock(lock: LockContents): string {
  const host = lock.host !== undefined && lock.host !== '0.0.0.0'
    ? lock.host
    : '127.0.0.1';
  return `http://${host}:${String(lock.port)}`;
}

export function serverOwnerStartupDeadline(
  lock: LockContents,
  timeoutMs: number = SERVER_STARTUP_TIMEOUT_MS,
): number {
  const startedAt = Date.parse(lock.started_at);
  return Number.isFinite(startedAt) ? startedAt + timeoutMs : Date.now();
}

export function removeLockIfOwnerDead(
  expected: LockContents,
  lockPath: string = DEFAULT_LOCK_PATH,
): boolean {
  if (pidAlive(expected.pid)) return false;
  const current = readLockContents(lockPath);
  if (current === undefined || !sameLockOwner(current, expected)) return false;
  try {
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

export function removeLockIfOwnerMatches(
  expected: LockContents,
  lockPath: string = DEFAULT_LOCK_PATH,
): boolean {
  const current = readLockContents(lockPath);
  if (current === undefined || !sameLockOwner(current, expected)) return false;
  try {
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

export async function waitForServerOwnerExit(
  expected: LockContents,
  options: {
    lockPath?: string;
    timeoutMs: number;
    pollMs?: number;
  },
): Promise<boolean> {
  const lockPath = options.lockPath ?? DEFAULT_LOCK_PATH;
  const pollMs = options.pollMs ?? SERVER_CONTROL_POLL_MS;
  const deadline = Date.now() + options.timeoutMs;
  do {
    const current = readLockContents(lockPath);
    if (current === undefined || !sameLockOwner(current, expected)) return true;
    if (!pidAlive(expected.pid)) {
      removeLockIfOwnerDead(expected, lockPath);
      return true;
    }
    await sleep(pollMs);
  } while (Date.now() < deadline);
  return false;
}

export async function waitForServerReady(options: {
  expectedVersion?: string;
  token?: string;
  lockPath?: string;
  timeoutMs?: number;
  startupTimeoutMs?: number;
  healthTimeoutMs?: number;
  pollMs?: number;
  waitForLock?: boolean;
  signal?: AbortSignal;
} = {}): Promise<ServerReadyWaitResult> {
  const lockPath = options.lockPath ?? DEFAULT_LOCK_PATH;
  const timeoutMs = options.timeoutMs ?? SERVER_STARTUP_TIMEOUT_MS;
  const startupTimeoutMs = options.startupTimeoutMs ?? SERVER_STARTUP_TIMEOUT_MS;
  const healthTimeoutMs = options.healthTimeoutMs ?? 500;
  const pollMs = options.pollMs ?? SERVER_CONTROL_POLL_MS;
  const absoluteDeadline = Date.now() + timeoutMs;
  let lastLock: LockContents | undefined;

  while (Date.now() < absoluteDeadline) {
    if (options.signal?.aborted === true) return { status: 'missing' };
    const lock = readLockContents(lockPath);
    if (lock === undefined) {
      if (options.waitForLock !== true) return { status: 'missing' };
      await sleep(pollMs);
      continue;
    }
    lastLock = lock;
    if (!pidAlive(lock.pid)) return { status: 'dead', lock };
    if (
      options.expectedVersion !== undefined
      && lock.host_version !== options.expectedVersion
    ) {
      return { status: 'incompatible', lock };
    }

    if (isServerLockV2(lock) && lock.state === 'starting') {
      if (Date.now() >= serverOwnerStartupDeadline(lock, startupTimeoutMs)) {
        return { status: 'timed_out', lock };
      }
      await sleep(pollMs);
      continue;
    }

    const origin = serverOriginFromLock(lock);
    const identity = await classifyServerIdentity(origin, options.token, healthTimeoutMs);
    if (identity === 'nori') return { status: 'ready', lock, origin };
    if (identity === 'foreign') return { status: 'foreign', lock, origin };
    return { status: 'unhealthy', lock, origin };
  }

  return lastLock === undefined
    ? { status: 'missing' }
    : { status: 'timed_out', lock: lastLock };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
