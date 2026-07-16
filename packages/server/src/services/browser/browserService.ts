import { randomUUID } from 'node:crypto';

import type {
  BrowserActionRequest,
  BrowserActionResult,
  BrowserExecutionScope,
  BrowserExecutor,
} from '@nori-code/agent-core';

import type { BrowserBridgeAction, IBrowserAutomationService } from './browser';

const CLIENT_TTL_MS = 45_000;
const ACTION_TIMEOUT_MS = 90_000;

interface PendingAction {
  readonly action: BrowserBridgeAction;
  readonly resolve: (result: BrowserActionResult) => void;
  readonly reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  assignedClientId?: string;
}

interface ClientState {
  lastSeenAt: number;
  paused: boolean;
}

export class BrowserAutomationService implements IBrowserAutomationService {
  readonly _serviceBrand: undefined;

  private readonly clients = new Map<string, ClientState>();
  private readonly pending = new Map<string, PendingAction>();
  private readonly queue: string[] = [];
  private readonly waiters = new Set<() => void>();
  private disposed = false;

  bind(scope: BrowserExecutionScope): BrowserExecutor {
    return {
      execute: (request, options) => this.request(scope, request, options.toolCallId, options.signal),
    };
  }

  registerClient(clientId: string): void {
    this.assertActive();
    const current = this.clients.get(clientId);
    this.clients.set(clientId, { lastSeenAt: Date.now(), paused: current?.paused ?? false });
    this.wakeWaiters();
  }

  heartbeat(clientId: string, paused?: boolean): void {
    this.assertActive();
    const client = this.clients.get(clientId);
    if (client === undefined) {
      this.clients.set(clientId, { lastSeenAt: Date.now(), paused: paused ?? false });
      this.wakeWaiters();
      return;
    }
    client.lastSeenAt = Date.now();
    if (paused !== undefined) client.paused = paused;
  }

  unregisterClient(clientId: string): void {
    this.clients.delete(clientId);
    for (const pending of this.pending.values()) {
      if (pending.assignedClientId !== clientId) continue;
      pending.assignedClientId = undefined;
      this.queue.unshift(pending.action.id);
    }
    this.wakeWaiters();
  }

  async nextAction(clientId: string, waitMs: number): Promise<BrowserBridgeAction | null> {
    this.heartbeat(clientId);
    const immediate = this.takeNext(clientId);
    if (immediate !== null || waitMs <= 0) return immediate;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.min(waitMs, 25_000));
      this.waiters.add(done);
    });
    this.heartbeat(clientId);
    return this.takeNext(clientId);
  }

  resolveAction(clientId: string, actionId: string, result: BrowserActionResult): boolean {
    this.heartbeat(clientId);
    const pending = this.pending.get(actionId);
    if (pending === undefined || pending.assignedClientId !== clientId) return false;
    clearTimeout(pending.timeout);
    this.pending.delete(actionId);
    pending.resolve(result);
    return true;
  }

  setPaused(clientId: string, paused: boolean): void {
    const client = this.clients.get(clientId);
    if (client === undefined) return;
    client.lastSeenAt = Date.now();
    client.paused = paused;
    if (!paused) this.wakeWaiters();
  }

  getState(): { connected: boolean; paused: boolean; pending: number } {
    this.pruneClients();
    const clients = [...this.clients.values()];
    return {
      connected: clients.length > 0,
      paused: clients.length > 0 && clients.every(client => client.paused),
      pending: this.pending.size,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Browser automation service stopped.'));
    }
    this.pending.clear();
    this.queue.length = 0;
    this.clients.clear();
    this.wakeWaiters();
  }

  private request(
    scope: BrowserExecutionScope,
    request: BrowserActionRequest,
    toolCallId: string,
    signal: AbortSignal,
  ): Promise<BrowserActionResult> {
    this.assertActive();
    this.pruneClients();
    if (this.clients.size === 0) {
      return Promise.resolve({
        ok: false,
        output: 'Nori Work browser bridge is unavailable. Keep the desktop app running while it reconnects, then retry.',
      });
    }
    const id = randomUUID();
    const action: BrowserBridgeAction = {
      id,
      sessionId: scope.sessionId,
      agentId: scope.agentId,
      toolCallId,
      createdAt: new Date().toISOString(),
      request,
    };
    return new Promise<BrowserActionResult>((resolve, reject) => {
      const onAbort = () => this.rejectAction(id, new Error('Browser action aborted.'));
      const settle = (result: BrowserActionResult) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const fail = (error: Error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      };
      const timeout = setTimeout(
        () => this.rejectAction(id, new Error('Browser action timed out.')),
        ACTION_TIMEOUT_MS,
      );
      timeout.unref?.();
      this.pending.set(id, { action, resolve: settle, reject: fail, timeout });
      this.queue.push(id);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      this.wakeWaiters();
    });
  }

  private takeNext(clientId: string): BrowserBridgeAction | null {
    this.pruneClients();
    const client = this.clients.get(clientId);
    if (client === undefined || client.paused) return null;
    while (this.queue.length > 0) {
      const id = this.queue.shift();
      if (id === undefined) break;
      const pending = this.pending.get(id);
      if (pending === undefined || pending.assignedClientId !== undefined) continue;
      pending.assignedClientId = clientId;
      return pending.action;
    }
    return null;
  }

  private rejectAction(id: string, error: Error): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    clearTimeout(pending.timeout);
    this.pending.delete(id);
    const queueIndex = this.queue.indexOf(id);
    if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
    pending.reject(error);
  }

  private pruneClients(): void {
    const expiredBefore = Date.now() - CLIENT_TTL_MS;
    for (const [id, client] of this.clients) {
      if (client.lastSeenAt < expiredBefore) this.unregisterClient(id);
    }
  }

  private wakeWaiters(): void {
    for (const wake of this.waiters) wake();
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Browser automation service is disposed.');
  }
}
