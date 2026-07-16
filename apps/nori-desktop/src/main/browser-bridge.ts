import { randomUUID } from 'node:crypto';

import type { BrowserViewManager, BrowserAutomationCommand } from './browser-view';

interface Envelope<T> {
  readonly code: number;
  readonly msg: string;
  readonly data: T;
}

interface PollResult {
  readonly action: BrowserAutomationCommand | null;
}

export interface BrowserBridgeHandle {
  readonly ready: Promise<void>;
  stop(): void;
}

export function startBrowserBridge(input: {
  readonly origin: string;
  readonly token: string;
  readonly manager: BrowserViewManager;
  readonly heartbeatIntervalMs?: number;
}): BrowserBridgeHandle {
  const clientId = `nori-work-${randomUUID()}`;
  const controller = new AbortController();
  let stopped = false;
  let heartbeatInFlight = false;
  let markReady: (() => void) | undefined;
  const ready = new Promise<void>(resolve => { markReady = resolve; });

  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${input.origin}/api/v1${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${input.token}`,
        'content-type': 'application/json',
        ...init?.headers,
      },
      signal: controller.signal,
    });
    const envelope = await response.json() as Envelope<T>;
    if (!response.ok || envelope.code !== 0) throw new Error(envelope.msg || `Browser bridge HTTP ${String(response.status)}`);
    return envelope.data;
  };

  const loop = async () => {
    await request(`/browser/clients/${encodeURIComponent(clientId)}`, { method: 'POST', body: '{}' });
    markReady?.();
    markReady = undefined;
    let reportedPaused: boolean | undefined;
    while (!stopped) {
      const paused = input.manager.getState().automation.paused;
      if (paused !== reportedPaused) {
        await request(`/browser/clients/${encodeURIComponent(clientId)}/pause`, {
          method: 'POST',
          body: JSON.stringify({ paused }),
        });
        reportedPaused = paused;
      }
      if (paused) {
        await delay(250, controller.signal);
        continue;
      }
      const { action } = await request<PollResult>(
        `/browser/clients/${encodeURIComponent(clientId)}/actions?wait_ms=20000`,
      );
      if (action === null) continue;
      const result = await input.manager.executeAction(action);
      await reportResult(action.id, result);
    }
  };

  const reportResult = async (actionId: string, result: unknown) => {
    let attempt = 0;
    while (!stopped) {
      try {
        await request(`/browser/clients/${encodeURIComponent(clientId)}/actions/${encodeURIComponent(actionId)}`, {
          method: 'POST',
          body: JSON.stringify(result),
        });
        return;
      } catch (error) {
        const message = formatError(error);
        if (message.includes('not found') || message.includes('another client')) return;
        attempt += 1;
        process.stderr.write(`[nori-desktop] retrying browser action result (${String(attempt)}): ${message}\n`);
        await delay(Math.min(250 * 2 ** Math.min(attempt, 5), 5_000), controller.signal);
      }
    }
  };

  const heartbeatTimer = setInterval(() => {
    if (stopped || heartbeatInFlight) return;
    heartbeatInFlight = true;
    const paused = input.manager.getState().automation.paused;
    void request(`/browser/clients/${encodeURIComponent(clientId)}/heartbeat`, {
      method: 'POST',
      body: JSON.stringify({ paused }),
    }).catch(error => {
      if (!stopped) process.stderr.write(`[nori-desktop] browser bridge heartbeat failed: ${formatError(error)}\n`);
    }).finally(() => {
      heartbeatInFlight = false;
    });
  }, input.heartbeatIntervalMs ?? 10_000);
  heartbeatTimer.unref?.();

  void (async () => {
    while (!stopped) {
      try {
        await loop();
      } catch (error) {
        if (stopped || controller.signal.aborted) return;
        process.stderr.write(`[nori-desktop] browser bridge reconnecting: ${formatError(error)}\n`);
        await delay(1_000, controller.signal).catch(() => undefined);
      }
    }
  })();

  return {
    ready,
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeatTimer);
      controller.abort();
    },
  };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error('Browser bridge stopped.'));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
