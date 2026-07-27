import { ulid } from 'ulid';

import {
  Disposable,
  DisposableMap,
  IEventService,
  ILogService,
  mcpElicitationToBrokerRequest,
  type IDisposable,
  type IMcpElicitationService,
  type McpElicitationResult,
  type SessionMcpElicitationComplete,
  type SessionMcpElicitationRequest,
} from '@nori-code/agent-core';
import type {
  Event,
  McpElicitationRequest as ProtocolMcpElicitationRequest,
} from '@nori-code/protocol';

export const MCP_ELICITATION_RECENTLY_RESOLVED_CAP = 1024;

class PendingMcpElicitation implements IDisposable {
  private responseSettled = false;
  private abortCleanup: (() => void) | undefined;

  constructor(
    readonly elicitationId: string,
    readonly sessionId: string,
    readonly agentId: string,
    readonly serverName: string,
    readonly serverElicitationId: string | undefined,
    public protocolRequest: ProtocolMcpElicitationRequest,
    private readonly resolveResponse: (result: McpElicitationResult) => void,
  ) {}

  get answerable(): boolean {
    return !this.responseSettled;
  }

  setAbortCleanup(cleanup: () => void): void {
    this.abortCleanup = cleanup;
  }

  settleResponse(result: McpElicitationResult): void {
    if (this.responseSettled) return;
    this.responseSettled = true;
    this.abortCleanup?.();
    this.abortCleanup = undefined;
    this.resolveResponse(result);
  }

  markAwaitingCompletion(): void {
    this.protocolRequest = {
      ...this.protocolRequest,
      status: 'awaiting_completion',
    };
  }

  dispose(): void {
    this.settleResponse({ action: 'cancel' });
  }
}

export class McpElicitationService
  extends Disposable
  implements IMcpElicitationService
{
  readonly _serviceBrand: undefined;

  private readonly pending: DisposableMap<string, PendingMcpElicitation>;
  private readonly recentlyResolved = new Set<string>();

  constructor(
    @ILogService private readonly logger: ILogService,
    @IEventService private readonly eventService: IEventService,
  ) {
    super();
    this.pending = this._register(
      new DisposableMap<string, PendingMcpElicitation>(),
    );
  }

  async request(
    request: SessionMcpElicitationRequest,
    options?: { signal?: AbortSignal },
  ): Promise<McpElicitationResult> {
    if (this._store.isDisposed) {
      return { action: 'cancel' };
    }

    const elicitationId = ulid();
    const protocolRequest = mcpElicitationToBrokerRequest(request, {
      elicitationId,
      createdAt: new Date().toISOString(),
    });

    const result = new Promise<McpElicitationResult>((resolve) => {
      const pending = new PendingMcpElicitation(
        elicitationId,
        request.sessionId,
        request.agentId,
        request.serverName,
        request.mode === 'url' ? request.serverElicitationId : undefined,
        protocolRequest,
        resolve,
      );
      this.pending.set(elicitationId, pending);

      const signal = options?.signal;
      if (signal !== undefined) {
        if (signal.aborted) {
          this.resolve(elicitationId, { action: 'cancel' });
        } else {
          const onAbort = () => this.resolve(elicitationId, { action: 'cancel' });
          signal.addEventListener('abort', onAbort, { once: true });
          pending.setAbortCleanup(() => signal.removeEventListener('abort', onAbort));
        }
      }
    });

    this.eventService.publish({
      type: 'event.mcp.elicitation.requested',
      sessionId: request.sessionId,
      agentId: request.agentId,
      ...protocolRequest,
    } as unknown as Event);
    this.logger.info(
      {
        elicitationId,
        sessionId: request.sessionId,
        serverName: request.serverName,
        mode: request.mode,
      },
      'MCP elicitation requested',
    );

    return result;
  }

  resolve(
    elicitationId: string,
    response: McpElicitationResult,
  ): 'resolved' | 'awaiting_completion' | undefined {
    const pending = this.pending.get(elicitationId);
    if (pending === undefined || !pending.answerable) return undefined;

    const waitsForCompletion =
      pending.protocolRequest.mode === 'url' && response.action === 'accept';
    pending.settleResponse(response);
    if (waitsForCompletion) {
      pending.markAwaitingCompletion();
    } else {
      this.pending.deleteAndLeak(elicitationId);
      this.markResolved(elicitationId);
    }

    const status = waitsForCompletion ? 'awaiting_completion' : 'resolved';
    this.eventService.publish({
      type: 'event.mcp.elicitation.resolved',
      sessionId: pending.sessionId,
      agentId: pending.agentId,
      elicitation_id: elicitationId,
      action: response.action,
      status,
      resolved_at: new Date().toISOString(),
    } as unknown as Event);
    return status;
  }

  complete(notification: SessionMcpElicitationComplete): void {
    const pending = Array.from(this.pending.values()).find(
      (entry) =>
        entry.sessionId === notification.sessionId &&
        entry.serverName === notification.serverName &&
        entry.serverElicitationId === notification.serverElicitationId &&
        entry.protocolRequest.status === 'awaiting_completion',
    );
    if (pending === undefined) {
      this.logger.warn(
        {
          sessionId: notification.sessionId,
          serverName: notification.serverName,
          serverElicitationId: notification.serverElicitationId,
        },
        'MCP elicitation completion did not match an accepted request',
      );
      return;
    }

    this.pending.deleteAndLeak(pending.elicitationId);
    this.markResolved(pending.elicitationId);
    this.eventService.publish({
      type: 'event.mcp.elicitation.completed',
      sessionId: pending.sessionId,
      agentId: pending.agentId,
      elicitation_id: pending.elicitationId,
      server_elicitation_id: notification.serverElicitationId,
      completed_at: new Date().toISOString(),
    } as unknown as Event);
  }

  listPending(sessionId: string): ProtocolMcpElicitationRequest[] {
    return Array.from(this.pending.values())
      .filter((entry) => entry.sessionId === sessionId)
      .map((entry) => entry.protocolRequest);
  }

  getPending(elicitationId: string): ProtocolMcpElicitationRequest | undefined {
    return this.pending.get(elicitationId)?.protocolRequest;
  }

  isAnswerable(elicitationId: string): boolean {
    return this.pending.get(elicitationId)?.answerable === true;
  }

  isRecentlyResolved(elicitationId: string): boolean {
    return this.recentlyResolved.has(elicitationId);
  }

  private markResolved(elicitationId: string): void {
    if (this.recentlyResolved.size >= MCP_ELICITATION_RECENTLY_RESOLVED_CAP) {
      const oldest = this.recentlyResolved.values().next().value;
      if (oldest !== undefined) this.recentlyResolved.delete(oldest);
    }
    this.recentlyResolved.add(elicitationId);
  }

  override dispose(): void {
    if (this._store.isDisposed) return;
    this.recentlyResolved.clear();
    super.dispose();
  }
}
