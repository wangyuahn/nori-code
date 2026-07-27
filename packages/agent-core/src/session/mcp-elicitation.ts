import { isIP } from 'node:net';

import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type {
  MCPElicitationRequestUnion,
  MCPElicitationResult,
  MCPHostNotificationContext,
  MCPHostRequestContext,
} from '../mcp';
import type { SDKSessionRPC } from '../rpc';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;

export interface SessionMcpElicitationHostOptions {
  readonly rpc: SDKSessionRPC;
  readonly timeoutMs?: number;
}

export class SessionMcpElicitationHost {
  private readonly timeoutMs: number;

  constructor(private readonly options: SessionMcpElicitationHostOptions) {
    this.timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  }

  readonly create = async (
    request: MCPElicitationRequestUnion,
    context: MCPHostRequestContext,
  ): Promise<MCPElicitationResult> => {
    const requestElicitation = this.options.rpc.requestMcpElicitation;
    if (requestElicitation === undefined) return { action: 'cancel' };

    const parsed = ElicitRequestSchema.parse({
      method: 'elicitation/create',
      params: request,
    }).params;
    const signal = AbortSignal.any([
      context.signal,
      AbortSignal.timeout(this.timeoutMs),
    ]);
    signal.throwIfAborted();

    if (parsed.mode === 'url') {
      assertAllowedUrl(parsed.url);
      return requestElicitation(
        {
          agentId: 'main',
          requestId: String(context.requestId),
          serverName: context.serverName,
          mode: 'url',
          message: parsed.message,
          serverElicitationId: parsed.elicitationId,
          url: parsed.url,
        },
        { signal },
      );
    }

    return requestElicitation(
      {
        agentId: 'main',
        requestId: String(context.requestId),
        serverName: context.serverName,
        mode: 'form',
        message: parsed.message,
        requestedSchema: parsed.requestedSchema,
      },
      { signal },
    );
  };

  readonly complete = async (
    elicitationId: string,
    context: MCPHostNotificationContext,
  ): Promise<void> => {
    const completeElicitation = this.options.rpc.completeMcpElicitation;
    if (completeElicitation === undefined) return;
    await completeElicitation({
      agentId: 'main',
      serverName: context.serverName,
      serverElicitationId: elicitationId,
    });
  };
}

function assertAllowedUrl(value: string): void {
  const url = new URL(value);
  if (url.username !== '' || url.password !== '') {
    throw new Error('MCP elicitation URLs must not contain credentials.');
  }
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return;
  throw new Error('MCP elicitation URLs must use HTTPS, except for loopback HTTP URLs.');
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) return normalized.startsWith('127.');
  return ipVersion === 6 && normalized === '::1';
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.floor(value));
}
