import { describe, expect, it, vi } from 'vitest';

import type { SDKSessionRPC } from '../../src/rpc';
import { SessionMcpElicitationHost } from '../../src/session/mcp-elicitation';

function context(requestId: string | number = 7) {
  return {
    serverName: 'example-server',
    requestId,
    signal: new AbortController().signal,
  };
}

describe('SessionMcpElicitationHost', () => {
  it('validates and forwards form requests to the session RPC', async () => {
    const requestMcpElicitation = vi.fn(async () => ({
      action: 'accept' as const,
      content: { email: 'dev@example.com' },
    }));
    const host = new SessionMcpElicitationHost({
      rpc: { requestMcpElicitation } as unknown as SDKSessionRPC,
    });

    await expect(host.create({
      message: 'Email',
      requestedSchema: {
        type: 'object',
        properties: { email: { type: 'string', format: 'email' } },
        required: ['email'],
      },
    }, context())).resolves.toEqual({
      action: 'accept',
      content: { email: 'dev@example.com' },
    });
    expect(requestMcpElicitation).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'main',
        requestId: '7',
        serverName: 'example-server',
        mode: 'form',
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('allows HTTPS and loopback HTTP URLs but rejects remote HTTP and credentials', async () => {
    const requestMcpElicitation = vi.fn(async () => ({ action: 'accept' as const }));
    const host = new SessionMcpElicitationHost({
      rpc: { requestMcpElicitation } as unknown as SDKSessionRPC,
    });
    const request = {
      mode: 'url' as const,
      message: 'Authorize',
      elicitationId: 'oauth-1',
      url: 'http://127.0.0.1:8787/callback',
    };

    await expect(host.create(request, context())).resolves.toEqual({ action: 'accept' });
    await expect(host.create({ ...request, url: 'https://example.com/oauth' }, context())).resolves.toEqual({ action: 'accept' });
    await expect(host.create({ ...request, url: 'http://example.com/oauth' }, context())).rejects.toThrow(/HTTPS/);
    await expect(host.create({ ...request, url: 'https://user:pass@example.com/oauth' }, context())).rejects.toThrow(/credentials/);
  });

  it('forwards URL completion notifications and cancels when the host lacks RPC support', async () => {
    const completeMcpElicitation = vi.fn(async () => undefined);
    const host = new SessionMcpElicitationHost({
      rpc: { completeMcpElicitation } as unknown as SDKSessionRPC,
    });

    await expect(host.create({
      message: 'Name',
      requestedSchema: { type: 'object', properties: {} },
    }, context())).resolves.toEqual({ action: 'cancel' });
    await host.complete('server-flow-1', { serverName: 'example-server' });
    expect(completeMcpElicitation).toHaveBeenCalledWith({
      agentId: 'main',
      serverName: 'example-server',
      serverElicitationId: 'server-flow-1',
    });
  });
});
