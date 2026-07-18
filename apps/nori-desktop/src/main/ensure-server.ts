import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Overall budget for the bundled `nori server run` to finish ensuring a daemon. */
const RUN_TIMEOUT_MS = 30_000;
/** How long to keep polling `/healthz` before declaring the daemon unhealthy. */
const HEALTH_TIMEOUT_MS = 20_000;
const HEALTH_POLL_MS = 200;

/** Subset of the server lock JSON we read (apps/nori-code writes the full shape). */
interface LockContents {
  pid: number;
  host?: string;
  port: number;
  host_version?: string;
}

/** `<NORI_CODE_HOME>` or `~/.nori-code` — must match the server's home directory resolver. */
export function noriHome(): string {
  const override = process.env['NORI_CODE_HOME'];
  if (override !== undefined && override.trim().length > 0) {
    return override;
  }
  return join(homedir(), '.nori-code');
}

function lockPath(): string {
  return join(noriHome(), 'server', 'lock');
}

function removeMatchingLock(expected: LockContents): void {
  const current = readLock();
  if (
    current === null
    || current.pid !== expected.pid
    || current.port !== expected.port
    || current.host_version !== expected.host_version
  ) {
    return;
  }
  try {
    unlinkSync(lockPath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function serverLogPath(): string {
  return join(noriHome(), 'server', 'server.log');
}

/**
 * Create the diagnostic path before launching the bundled server. A server
 * can fail before its own logger initializes; keeping an empty file here
 * prevents the startup error page from pointing at a path that does not exist.
 */
export function ensureServerLogFile(): void {
  const logPath = serverLogPath();
  try {
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    if (!existsSync(logPath)) writeFileSync(logPath, '', { mode: 0o600 });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to prepare the Nori server log at ${logPath}: ${reason}`);
  }
}

function appendServerDiagnostic(message: string): void {
  try {
    appendFileSync(serverLogPath(), `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // The original startup error is more useful than masking it with a log I/O error.
  }
}

function readServerLogTail(maxLines = 30): string {
  try {
    return readFileSync(serverLogPath(), 'utf-8')
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .slice(-maxLines)
      .join('\n');
  } catch {
    return '';
  }
}

/** Read the daemon's bearer token from `<NORI_CODE_HOME>/server.token` (the server's
 *  `persistentToken.ts` writes the token at the home-dir root, not under `server/`). */
export function readServerToken(): string | undefined {
  try {
    const token = readFileSync(join(noriHome(), 'server.token'), 'utf-8').trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

export function readLock(): LockContents | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath(), 'utf-8')) as Partial<LockContents>;
    if (typeof parsed.port === 'number' && typeof parsed.pid === 'number') {
      return {
        pid: parsed.pid,
        port: parsed.port,
        host: typeof parsed.host === 'string' ? parsed.host : undefined,
        host_version: typeof parsed.host_version === 'string' ? parsed.host_version : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function runServerKill(seaPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(seaPath, ['server', 'kill'], { timeout: RUN_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) {
        appendServerDiagnostic(
          [
            '[desktop] bundled Nori server replacement could not stop the existing server',
            `error: ${error.stack ?? error.message}`,
            `stdout: ${String(stdout).trim() || '<empty>'}`,
            `stderr: ${String(stderr).trim() || '<empty>'}`,
          ].join('\n'),
        );
        reject(new Error(`nori server kill failed: ${error.message}\n${stderr}`.trim()));
        return;
      }
      resolve();
    });
  });
}

export function originFromLock(lock: LockContents): string {
  const host = lock.host !== undefined && lock.host !== '0.0.0.0' ? lock.host : '127.0.0.1';
  return `http://${host}:${lock.port}`;
}

async function isHealthy(origin: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetch(`${origin}/api/v1/healthz`, { signal: controller.signal });
    if (!res.ok) {
      return false;
    }
    const body = (await res.json()) as { code?: unknown };
    return body.code === 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function supportsRequiredRoutes(origin: string): Promise<boolean> {
  const token = readServerToken();
  if (token === undefined) return true;
  try {
    const response = await fetch(
      `${origin}/api/v1/sessions/__nori_capability_probe__/cron`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    return response.status !== 404;
  } catch {
    return false;
  }
}

/**
 * Run the bundled Nori SEA's `server run`, which reuses a live shared daemon or
 * spawns one and exits once it is healthy. All discovery / port / lock logic
 * lives in apps/nori-code's `ensureDaemon`; we do not reimplement it.
 */
function runServerRun(seaPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      seaPath,
      ['server', 'run', '--log-level', 'error'],
      {
        timeout: RUN_TIMEOUT_MS,
        env: {
          ...process.env,
          NORI_CODE_NODE_EXECUTABLE: process.execPath,
          NORI_CODE_NODE_RUN_AS_NODE: '1',
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          const processError = error as NodeJS.ErrnoException & {
            killed?: boolean;
            signal?: NodeJS.Signals | null;
          };
          const logTail = readServerLogTail();
          appendServerDiagnostic(
            [
              '[desktop] bundled Nori server failed to start',
              `error: ${error.stack ?? error.message}`,
              `exitCode: ${String(processError.code ?? '<unknown>')}`,
              `signal: ${String(processError.signal ?? '<none>')}`,
              `killed: ${String(processError.killed ?? false)}`,
              `stdout: ${String(stdout).trim() || '<empty>'}`,
              `stderr: ${String(stderr).trim() || '<empty>'}`,
              `serverLogTail: ${logTail || '<empty>'}`,
            ].join('\n'),
          );
          reject(new Error(`nori server run failed: ${error.message}\n${stderr}`.trim()));
          return;
        }
        resolve();
      },
    );
  });
}

export interface EnsureServerResult {
  origin: string;
}

/**
 * Ensure the shared nori-code daemon is running and return its origin.
 *
 * The desktop app participates in the same local-server ecosystem as the CLI,
 * the browser and the TUI: it reuses a running daemon or starts one that the
 * others can reuse — never a private, app-only server.
 */
export async function ensureServer(seaPath: string, expectedVersion?: string): Promise<EnsureServerResult> {
  ensureServerLogFile();

  // Development mode: if the SEA binary doesn't exist, don't try to start it.
  // Instead, check if the user already has a Nori dev server running
  // (started via `pnpm -C apps/nori-code dev:server` in another terminal).
  if (!existsSync(seaPath)) {
    // Check if a server is already running
    const existingLock = readLock();
    if (existingLock !== null) {
      const origin = originFromLock(existingLock);
      if (await isHealthy(origin, 3000)) {
        process.stdout.write(`[nori-desktop] connected to existing server at ${origin}\n`);
        return { origin };
      }
    }
    const message =
      `Nori server binary not found at: ${seaPath}\n` +
      `\n` +
      `For development, start the Nori server in another terminal first:\n` +
      `  pnpm -C apps/nori-code dev:server\n` +
      `\n` +
      `Then re-run the desktop app.`;
    appendServerDiagnostic(`[desktop] ${message}`);
    throw new Error(message);
  }

  // Production / SEA-available path
  const existingLock = readLock();
  if (existingLock !== null) {
    const existingOrigin = originFromLock(existingLock);
    const existingHealthy = await isHealthy(existingOrigin, 3000);
    const versionMismatch = expectedVersion !== undefined
      && existingLock.host_version !== undefined
      && existingLock.host_version !== expectedVersion;
    const missingRequiredRoutes = existingHealthy
      && !versionMismatch
      && !(await supportsRequiredRoutes(existingOrigin));
    if (!existingHealthy) {
      // Server is not responding — the lock is stale regardless of whether the
      // recorded PID is alive (recycled) or dead. Skip the kill command entirely:
      // on Windows a recycled PID may belong to an unrelated process, and trying
      // to kill it either fails with EPERM or kills something innocent.
      removeMatchingLock(existingLock);
    } else if (versionMismatch || missingRequiredRoutes) {
      // Server IS healthy but needs replacement (wrong version or missing routes).
      process.stdout.write(
        versionMismatch
          ? `[nori-desktop] replacing server ${existingLock.host_version} with ${expectedVersion}\n`
          : '[nori-desktop] replacing server that is missing required desktop routes\n',
      );
      await runServerKill(seaPath);
      if (!await isHealthy(originFromLock(existingLock), 500)) removeMatchingLock(existingLock);
    }
  }
  await runServerRun(seaPath);

  const lock = readLock();
  if (lock === null) {
    const message = `Nori server lock not found at ${lockPath()} after starting the server.`;
    appendServerDiagnostic(`[desktop] ${message}`);
    throw new Error(message);
  }
  const origin = originFromLock(lock);
  if (
    expectedVersion !== undefined &&
    lock.host_version !== undefined &&
    lock.host_version !== expectedVersion
  ) {
    const message =
      `Nori server version ${lock.host_version} is incompatible with Nori Work ${expectedVersion}.`;
    appendServerDiagnostic(`[desktop] ${message}`);
    throw new Error(message);
  }

  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isHealthy(origin, 500)) {
      if (!(await supportsRequiredRoutes(origin))) {
        const message = 'The bundled Nori server is missing required desktop routes.';
        appendServerDiagnostic(`[desktop] ${message}`);
        throw new Error(message);
      }
      process.stdout.write(`[nori-desktop] connected to ${origin}\n`);
      return { origin };
    }
    await new Promise((resolve) => {
      setTimeout(resolve, HEALTH_POLL_MS);
    });
  }
  const message = `Nori server at ${origin} did not become healthy within ${HEALTH_TIMEOUT_MS}ms.`;
  appendServerDiagnostic(`[desktop] ${message}`);
  throw new Error(message);
}
