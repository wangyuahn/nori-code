import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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
  started_at?: string;
  host?: string;
  port: number;
  host_version?: string;
  entry?: string;
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
    || current.started_at !== expected.started_at
    || current.host !== expected.host
    || current.port !== expected.port
    || current.host_version !== expected.host_version
    || current.entry !== expected.entry
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
    throw new Error(`Unable to prepare the Nori server log at ${logPath}: ${reason}`, {
      cause: error,
    });
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

function serverLogSize(): number {
  try {
    return statSync(serverLogPath()).size;
  } catch {
    return 0;
  }
}

function readServerLogSince(offset: number): string {
  try {
    const bytes = readFileSync(serverLogPath());
    if (bytes.byteLength <= offset) return '';
    return bytes.subarray(offset).toString('utf-8');
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
        started_at: typeof parsed.started_at === 'string' ? parsed.started_at : undefined,
        port: parsed.port,
        host: typeof parsed.host === 'string' ? parsed.host : undefined,
        host_version: typeof parsed.host_version === 'string' ? parsed.host_version : undefined,
        entry: typeof parsed.entry === 'string' ? parsed.entry : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function runServerKill(seaPath: string, expected: LockContents): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      seaPath,
      ['server', 'kill'],
      {
        timeout: RUN_TIMEOUT_MS,
        env: {
          ...process.env,
          NORI_CODE_EXPECT_SERVER_PID: String(expected.pid),
          NORI_CODE_EXPECT_SERVER_PORT: String(expected.port),
          ...(expected.started_at === undefined
            ? {}
            : { NORI_CODE_EXPECT_SERVER_STARTED_AT: expected.started_at }),
          ...(expected.host === undefined
            ? {}
            : { NORI_CODE_EXPECT_SERVER_HOST: expected.host }),
          ...(expected.host_version === undefined
            ? {}
            : { NORI_CODE_EXPECT_SERVER_HOST_VERSION: expected.host_version }),
          ...(expected.entry === undefined
            ? {}
            : { NORI_CODE_EXPECT_SERVER_ENTRY: expected.entry }),
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          appendServerDiagnostic(
            [
              '[desktop] bundled Nori server replacement could not stop the existing server',
              `error: ${error.stack ?? error.message}`,
              `stdout: ${stdout.trim() || '<empty>'}`,
              `stderr: ${stderr.trim() || '<empty>'}`,
            ].join('\n'),
          );
          reject(new Error(`nori server kill failed: ${error.message}\n${stderr}`.trim()));
          return;
        }
        resolve();
      },
    );
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
 * Find a compatible shared daemon that is already healthy.
 */
async function findReusableServerOrigin(
  expectedVersion?: string,
  healthTimeoutMs = 1_000,
): Promise<string | null> {
  const lock = readLock();
  if (lock === null) return null;
  if (
    expectedVersion !== undefined &&
    lock.host_version !== expectedVersion
  ) {
    return null;
  }
  const origin = originFromLock(lock);
  if (!await isHealthy(origin, healthTimeoutMs)) return null;
  if (!await supportsRequiredRoutes(origin)) return null;
  return origin;
}

class ServerRunError extends Error {
  override readonly name = 'ServerRunError';

  constructor(message: string, readonly alreadyRunning: boolean) {
    super(message);
  }
}

/** Run the bundled Nori SEA's `server run` command. */
function runServerRun(seaPath: string): Promise<void> {
  const logOffset = serverLogSize();
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
          const invocationLog = readServerLogSince(logOffset);
          const logTail = readServerLogTail();
          appendServerDiagnostic(
            [
              '[desktop] bundled Nori server failed to start',
              `error: ${error.stack ?? error.message}`,
              `exitCode: ${processError.code ?? '<unknown>'}`,
              `signal: ${processError.signal ?? '<none>'}`,
              `killed: ${String(processError.killed ?? false)}`,
              `stdout: ${stdout.trim() || '<empty>'}`,
              `stderr: ${stderr.trim() || '<empty>'}`,
              `serverLogTail: ${logTail || '<empty>'}`,
            ].join('\n'),
          );
          const details = [
            `nori server run failed: ${error.message}`,
            stdout.trim(),
            stderr.trim(),
            logTail,
          ].filter((part) => part.length > 0);
          const alreadyRunning = [error.message, stdout, stderr, invocationLog]
            .some((part) => /server already running/i.test(part));
          reject(new ServerRunError(details.join('\n'), alreadyRunning));
          return;
        }
        resolve();
      },
    );
  });
}

function isServerAlreadyRunningError(error: unknown): boolean {
  return error instanceof ServerRunError && error.alreadyRunning;
}

async function stopExistingServer(
  seaPath: string,
  lock: LockContents,
  reason: string,
): Promise<void> {
  appendServerDiagnostic(
    '[desktop] replacing incompatible server (' +
      reason +
      ') pid=' +
      String(lock.pid) +
      ' port=' +
      String(lock.port) +
      ' version=' +
      (lock.host_version ?? '<unknown>'),
  );
  const origin = originFromLock(lock);
  if (!await isHealthy(origin, 3_000)) {
    // A live PID alone is not proof of ownership on Windows because PIDs are
    // recycled. Never pass an unverified stale owner to `server kill`, whose
    // forced fallback signals the PID recorded in the lock.
    appendServerDiagnostic(
      '[desktop] discarded stale server lock without signaling pid=' +
        String(lock.pid) +
        ' origin=' +
        origin,
    );
    removeMatchingLock(lock);
    return;
  }

  try {
    await runServerKill(seaPath, lock);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/server owner changed/i.test(message)) throw error;
    appendServerDiagnostic(
      '[desktop] server owner changed during replacement; deferring to startup race recovery',
    );
    return;
  }
  // The kill command normally releases the lock; this guarded cleanup handles
  // a process terminated before its release handler ran.
  removeMatchingLock(lock);
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

  // Production / SEA-available path. Reuse a compatible healthy daemon
  // before invoking the server-run command; the CLI intentionally refuses to
  // acquire a second lock and reports "server already running".
  const reusableOrigin = await findReusableServerOrigin(expectedVersion);
  if (reusableOrigin !== null) {
    process.stdout.write('[nori-desktop] connected to existing server at ' + reusableOrigin + '\n');
    return { origin: reusableOrigin };
  }

  const existingLock = readLock();
  if (existingLock !== null) {
    const versionMismatch = expectedVersion !== undefined
      && existingLock.host_version !== expectedVersion;
    if (versionMismatch) {
      await stopExistingServer(seaPath, existingLock, 'version mismatch');
    } else {
      const existingOrigin = originFromLock(existingLock);
      const existingHealthy = await isHealthy(existingOrigin, 3_000);
      const missingRequiredRoutes = existingHealthy
        && !(await supportsRequiredRoutes(existingOrigin));
      if (existingHealthy && missingRequiredRoutes) {
        await stopExistingServer(seaPath, existingLock, 'missing required desktop routes');
      }
    }
  }

  try {
    await runServerRun(seaPath);
  } catch (error) {
    // A concurrent desktop/CLI startup can win the lock between the checks
    // above and server run. Give that winner a little time to become healthy
    // before treating the conflict as a wedged owner.
    const racedOrigin = await findReusableServerOrigin(expectedVersion, 3_000);
    if (racedOrigin !== null) {
      appendServerDiagnostic('[desktop] reused a healthy server after startup race: ' + racedOrigin);
      process.stdout.write('[nori-desktop] connected to existing server at ' + racedOrigin + '\n');
      return { origin: racedOrigin };
    }

    if (!isServerAlreadyRunningError(error)) throw error;

    const conflictingLock = readLock();
    if (conflictingLock === null) throw error;
    appendServerDiagnostic(
      '[desktop] server run found an existing owner; recovering lock for pid=' +
        String(conflictingLock.pid) +
        ' port=' +
        String(conflictingLock.port),
    );
    await stopExistingServer(seaPath, conflictingLock, 'startup lock conflict');
    await runServerRun(seaPath);
  }
  const lock = readLock();
  if (lock === null) {
    const message = `Nori server lock not found at ${lockPath()} after starting the server.`;
    appendServerDiagnostic(`[desktop] ${message}`);
    throw new Error(message);
  }
  const origin = originFromLock(lock);
  if (
    expectedVersion !== undefined &&
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
