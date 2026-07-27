import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IMcpElicitationService } from '@nori-code/agent-core';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IRestGateway, startServer, type RunningServer } from '../src';
import { McpElicitationService } from '#/services/mcpElicitation';
import { fixedTokenAuth } from './helpers/serverHarness';

let tempDir: string;
let homeDir: string;
let server: RunningServer | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'nori-mcp-elicitation-'));
  homeDir = mkdtempSync(join(tmpdir(), 'nori-mcp-elicitation-home-'));
});

afterEach(async () => {
  await server?.close().catch(() => undefined);
  server = undefined;
  rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  rmSync(homeDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

async function boot() {
  server = await startServer({
    serviceOverrides: [fixedTokenAuth()],
    host: '127.0.0.1',
    port: 0,
    lockPath: join(tempDir, 'server.lock'),
    logger: pino({ level: 'silent' }),
    coreProcessOptions: { homeDir },
  });
  return server;
}

function appOf(running: RunningServer) {
  const app = running.services.invokeFunction(
    (accessor) => accessor.get(IRestGateway).app,
  ) as unknown as FastifyInstance;
  return {
    inject(input: InjectOptions) {
      const headers = input['headers'] as Record<string, string> | undefined;
      return app.inject({
        ...input,
        headers: { authorization: 'Bearer test-token', ...headers },
      });
    },
  };
}

async function createSession(running: RunningServer): Promise<string> {
  const response = await appOf(running).inject({
    method: 'POST',
    url: '/api/v1/sessions',
    payload: { metadata: { cwd: tempDir } },
  });
  const body = response.json() as { code: number; data: { id: string } };
  expect(body.code).toBe(0);
  return body.data.id;
}

describe('MCP elicitation REST broker', () => {
  it('lists and resolves validated form requests', async () => {
    const running = await boot();
    const sessionId = await createSession(running);
    const service = running.services.invokeFunction(
      (accessor) => accessor.get(IMcpElicitationService) as McpElicitationService,
    );
    const pendingResult = service.request({
      sessionId,
      agentId: 'main',
      requestId: 'rpc-1',
      serverName: 'example-server',
      mode: 'form',
      message: 'Connection details',
      requestedSchema: {
        type: 'object',
        properties: {
          email: { type: 'string', format: 'email' },
          retries: { type: 'integer', minimum: 0 },
        },
        required: ['email'],
      },
    });

    const list = await appOf(running).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/mcp-elicitations?status=pending`,
    });
    const listBody = list.json() as {
      code: number;
      data: { items: Array<{ elicitation_id: string }> };
    };
    expect(listBody.code).toBe(0);
    expect(listBody.data.items).toHaveLength(1);
    const elicitationId = listBody.data.items[0]!.elicitation_id;

    const invalid = await appOf(running).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/mcp-elicitations/${elicitationId}`,
      payload: { action: 'accept', content: { retries: 2 } },
    });
    expect((invalid.json() as { code: number }).code).toBe(40001);

    const resolved = await appOf(running).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/mcp-elicitations/${elicitationId}`,
      payload: {
        action: 'accept',
        content: { email: 'dev@example.com', retries: 2 },
      },
    });
    expect(resolved.json()).toMatchObject({
      code: 0,
      data: { resolved: true, status: 'resolved' },
    });
    await expect(pendingResult).resolves.toEqual({
      action: 'accept',
      content: { email: 'dev@example.com', retries: 2 },
    });
  });

  it('keeps accepted URL requests until the MCP completion notification arrives', async () => {
    const running = await boot();
    const sessionId = await createSession(running);
    const service = running.services.invokeFunction(
      (accessor) => accessor.get(IMcpElicitationService) as McpElicitationService,
    );
    const pendingResult = service.request({
      sessionId,
      agentId: 'main',
      requestId: 'rpc-2',
      serverName: 'example-server',
      mode: 'url',
      message: 'Authorize access',
      serverElicitationId: 'server-flow-1',
      url: 'https://example.com/oauth',
    });
    const elicitationId = service.listPending(sessionId)[0]!.elicitation_id;

    const accepted = await appOf(running).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/mcp-elicitations/${elicitationId}`,
      payload: { action: 'accept' },
    });
    expect(accepted.json()).toMatchObject({
      code: 0,
      data: { status: 'awaiting_completion' },
    });
    await expect(pendingResult).resolves.toEqual({ action: 'accept' });
    expect(service.listPending(sessionId)[0]).toMatchObject({
      status: 'awaiting_completion',
    });

    service.complete({
      sessionId,
      agentId: 'main',
      serverName: 'example-server',
      serverElicitationId: 'server-flow-1',
    });
    expect(service.listPending(sessionId)).toEqual([]);
  });
});
