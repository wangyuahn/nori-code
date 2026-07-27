import type { ChatProvider } from '@nori-code/kosong';
import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../src/agent';
import type { MCPCreateMessageRequest, MCPHostRequestContext } from '../../src/mcp';
import type { ApprovalRequest, SDKSessionRPC } from '../../src/rpc';
import { SessionMcpSamplingHost } from '../../src/session/mcp-sampling';

const request: MCPCreateMessageRequest = {
  messages: [{ role: 'user', content: { type: 'text', text: 'sample this' } }],
  maxTokens: 8_192,
};

describe('SessionMcpSamplingHost', () => {
  it('does not call the model when the user rejects sampling', async () => {
    const { agent, generate } = fakeAgent();
    const host = new SessionMcpSamplingHost({
      getMainAgent: () => agent,
      rpc: fakeRpc(async () => ({ decision: 'rejected', feedback: 'not this server' })),
    });

    await expect(host.createMessage(request, context())).rejects.toThrow(
      'MCP sampling was rejected: not this server',
    );
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects a second request while the configured concurrency slot is occupied', async () => {
    const { agent } = fakeAgent();
    let releaseApproval!: () => void;
    const approvalStarted = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });
    let rejectPending!: (error: Error) => void;
    const pendingApproval = new Promise<never>((_resolve, reject) => {
      rejectPending = reject;
    });
    const host = new SessionMcpSamplingHost({
      getMainAgent: () => agent,
      maxConcurrency: 1,
      rpc: fakeRpc(() => {
        releaseApproval();
        return pendingApproval;
      }),
    });

    const first = host.createMessage(request, context('one'));
    await approvalStarted;
    await expect(host.createMessage(request, context('two'))).rejects.toThrow(
      'MCP sampling concurrency limit reached (1)',
    );
    rejectPending(new Error('test cleanup'));
    await expect(first).rejects.toThrow('test cleanup');
  });

  it('propagates its timeout signal into the approval lifecycle', async () => {
    const { agent } = fakeAgent();
    let observedSignal: AbortSignal | undefined;
    const host = new SessionMcpSamplingHost({
      getMainAgent: () => agent,
      timeoutMs: 20,
      rpc: fakeRpc((_request, options) => {
        observedSignal = options?.signal;
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason ?? new Error('aborted')),
            { once: true },
          );
        });
      }),
    });

    await expect(host.createMessage(request, context())).rejects.toThrow();
    expect(observedSignal?.aborted).toBe(true);
  });

  it('propagates caller cancellation into the approval lifecycle', async () => {
    const { agent } = fakeAgent();
    const controller = new AbortController();
    let approvalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      approvalStarted = resolve;
    });
    const host = new SessionMcpSamplingHost({
      getMainAgent: () => agent,
      rpc: fakeRpc((_request, options) => {
        approvalStarted();
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason ?? new Error('aborted')),
            { once: true },
          );
        });
      }),
    });

    const sampling = host.createMessage(request, {
      ...context(),
      signal: controller.signal,
    });
    await started;
    controller.abort(new Error('caller cancelled'));
    await expect(sampling).rejects.toThrow('caller cancelled');
  });

  it('rejects recursive sampling within the same async request', async () => {
    const { agent, generate } = fakeAgent();
    let host!: SessionMcpSamplingHost;
    host = new SessionMcpSamplingHost({
      getMainAgent: () => agent,
      rpc: fakeRpc(() => host.createMessage(request, context('nested'))),
    });

    await expect(host.createMessage(request, context('outer'))).rejects.toThrow(
      'Nested MCP sampling is not allowed',
    );
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects MCP-provided tools before approval or generation', async () => {
    const { agent, generate } = fakeAgent();
    const approval = vi.fn(async () => ({ decision: 'approved' as const }));
    const host = new SessionMcpSamplingHost({
      getMainAgent: () => agent,
      rpc: fakeRpc(approval),
    });

    await expect(
      host.createMessage(
        {
          ...request,
          tools: [{ name: 'hidden', description: 'hidden tool', inputSchema: {} }],
        },
        context(),
      ),
    ).rejects.toThrow('hidden tool loops are not allowed');
    expect(approval).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });
});

function context(requestId: string = 'request-1'): MCPHostRequestContext {
  return {
    serverName: 'fixture-server',
    requestId,
    signal: new AbortController().signal,
  };
}

function fakeAgent(): { readonly agent: Agent; readonly generate: ReturnType<typeof vi.fn> } {
  const provider: ChatProvider = {
    name: 'fixture-provider',
    modelName: 'fixture-model',
    thinkingEffort: null,
    generate: vi.fn(),
    withThinking() {
      return this;
    },
    withMaxCompletionTokens() {
      return this;
    },
  };
  const generate = vi.fn();
  return {
    agent: {
      config: {
        hasProvider: true,
        modelAlias: 'fixture-model',
        provider,
      },
      generate,
    } as unknown as Agent,
    generate,
  };
}

type ApprovalHandler = (
  request: ApprovalRequest & { readonly agentId: string },
  options?: { readonly signal?: AbortSignal },
) => unknown;

function fakeRpc(requestApproval: ApprovalHandler): SDKSessionRPC {
  return {
    emitEvent: async () => undefined,
    requestApproval,
    requestQuestion: async () => null,
    toolCall: async () => ({ output: '' }),
  } as unknown as SDKSessionRPC;
}
