/**
 * Product identity advertised by the Nori server in `GET /api/v1/healthz`.
 *
 * The local-server ecosystem (CLI, TUI, web, desktop) shares the machine with
 * other products that speak the same response envelope — most notably upstream
 * Kimi Code, whose daemon historically used the same default port and returns
 * the same `{code: 0}` health payload. Probes must therefore verify
 * `data.app` instead of treating any `code: 0` as a live Nori server;
 * otherwise a stale lock pointing at a foreign server is mistaken for a live
 * owner (and `server kill` can signal a recycled PID owned by that process).
 */

export const NORI_SERVER_APP_ID = 'nori-code';

async function probeHealthIdentity(
  origin: string,
  timeoutMs: number,
): Promise<ServerIdentityClass> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(`${origin}/api/v1/healthz`, { signal: controller.signal });
    if (!response.ok) return 'foreign';
    try {
      const body = (await response.json()) as { code?: unknown; data?: { app?: unknown } };
      return body.code === 0 && body.data?.app === NORI_SERVER_APP_ID ? 'nori' : 'foreign';
    } catch {
      return 'foreign';
    }
  } catch {
    return 'unreachable';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe `origin`'s health endpoint and report whether it answers as a Nori
 * server (`code: 0` and `data.app === NORI_SERVER_APP_ID`). Any transport
 * error, timeout, non-200 status, or missing/foreign identity returns false —
 * callers treat that as "no live Nori server here" and recover the lock.
 */
export async function probeNoriServer(origin: string, timeoutMs: number): Promise<boolean> {
  return (await probeHealthIdentity(origin, timeoutMs)) === 'nori';
}

/** Result of identifying which product, if any, serves an origin. */
export type ServerIdentityClass =
  /** A Nori server (current build via healthz `app`, or a legacy build via token-gated `/meta`). */
  | 'nori'
  /** Something answers HTTP but is not a Nori server (e.g. upstream Kimi Code). */
  | 'foreign'
  /** Nothing answers (dead port, wedged process, or unidentifiable without a token). */
  | 'unreachable';

/**
 * Identify whether `origin` is served by a Nori server of ANY build.
 *
 * Discriminating legacy Nori builds from foreign products matters before
 * destructive actions (`server kill`, lock takeover): pre-identity Nori
 * builds return the same bare `{code: 0}` healthz as upstream Kimi Code, but
 * they accept the local `~/.nori-code/server.token` on `/api/v1/meta` while a
 * foreign product (different token file) rejects it with 401.
 *
 * `token` is the caller's local persistent server token; when undefined the
 * legacy path is skipped and only current (self-identifying) servers are
 * recognized.
 */
export async function classifyServerIdentity(
  origin: string,
  token: string | undefined,
  timeoutMs: number,
): Promise<ServerIdentityClass> {
  // Fast path: current builds self-identify in healthz. Preserve the
  // reachable-but-foreign result so a bare Kimi health response is never
  // mistaken for a dead port when the local Nori token is unavailable.
  const healthIdentity = await probeHealthIdentity(origin, timeoutMs);
  if (healthIdentity === 'nori') return 'nori';

  // Legacy path: pre-identity Nori builds pass the token-gated meta route;
  // foreign products reject our token.
  if (token !== undefined && token.length > 0) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetch(`${origin}/api/v1/meta`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      return response.ok ? 'nori' : 'foreign';
    } catch {
      return healthIdentity;
    } finally {
      clearTimeout(timer);
    }
  }
  return healthIdentity;
}
