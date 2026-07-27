import { mkdtempSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'pathe';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { KimiError } from '../../src/errors';
import { mergeStdioEnv, StdioMcpClient } from '../../src/mcp/client-stdio';
import type { MCPTask } from '../../src/mcp/types';

const here = import.meta.dirname;
const fixture = join(here, 'fixtures', 'mock-stdio-server.mjs');
const cwdFixture = join(here, 'fixtures', 'cwd-stdio-server.mjs');
const stderrThenExitFixture = join(here, 'fixtures', 'stderr-then-exit-stdio-server.mjs');
const crashAfterConnectFixture = join(here, 'fixtures', 'crash-after-connect-stdio-server.mjs');
const fullFixture = join(here, 'fixtures', 'full-stdio-server.mjs');
const paginatedFixture = join(here, 'fixtures', 'paginated-stdio-server.mjs');

describe('StdioMcpClient', () => {
  it('rejects unsupported executor at construction time', () => {
    expect(
      () =>
        new StdioMcpClient({
          transport: 'stdio',
          command: 'true',
          executor: 'kaos',
        }),
    ).toThrow(
      expect.objectContaining({ name: 'KimiError', code: 'not_implemented' }) as unknown as Error,
    );
    // Sanity-check the error class identity too.
    let thrown: unknown;
    try {
      const client = new StdioMcpClient({ transport: 'stdio', command: 'true', executor: 'kaos' });
      void client;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(KimiError);
  });

  it('uses defaultCwd when config.cwd is omitted', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'kimi-mcp-default-cwd-'));
    const client = new StdioMcpClient(
      {
        transport: 'stdio',
        command: process.execPath,
        args: [cwdFixture],
      },
      { defaultCwd: cwd },
    );
    try {
      await client.connect();
      const result = await client.callTool('get_cwd', {});
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(realpathSync(text)).toBe(realpathSync(cwd));
    } finally {
      await client.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }, 15000);

  it('prefers explicit config.cwd over defaultCwd', async () => {
    const defaultCwd = mkdtempSync(join(tmpdir(), 'kimi-mcp-default-cwd-'));
    const configuredCwd = mkdtempSync(join(tmpdir(), 'kimi-mcp-configured-cwd-'));
    const client = new StdioMcpClient(
      {
        transport: 'stdio',
        command: process.execPath,
        args: [cwdFixture],
        cwd: configuredCwd,
      },
      { defaultCwd },
    );
    try {
      await client.connect();
      const result = await client.callTool('get_cwd', {});
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(realpathSync(text)).toBe(realpathSync(configuredCwd));
    } finally {
      await client.close();
      await rm(defaultCwd, { recursive: true, force: true });
      await rm(configuredCwd, { recursive: true, force: true });
    }
  }, 15000);

  it('connects, lists tools, and round-trips a text result', async () => {
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
    });
    try {
      await client.connect();
      const tools = await client.listTools();
      expect(tools.map((t) => t.name).toSorted()).toEqual(['boom', 'echo', 'read_env']);
      const echo = tools.find((t) => t.name === 'echo');
      expect(echo?.description).toBe('Echoes input text');
      expect(echo?.inputSchema).toMatchObject({ type: 'object' });

      const result = await client.callTool('echo', { text: 'hello mcp' });
      expect(result.isError).toBe(false);
      expect(result.content).toEqual([{ type: 'text', text: 'hello mcp' }]);
    } finally {
      await client.close();
    }
  }, 15000);

  it('supports server metadata, resources, prompts, completions, and protocol events', async () => {
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [fullFixture],
      env: { NORI_TEST_MCP_ROOTS: '1' },
    }, {
      host: {
        roots: {
          list: () => [{ uri: 'file:///workspace', name: 'workspace' }],
        },
      },
    });
    const listChanges: string[] = [];
    const resourceUpdates: string[] = [];
    const logMessages: Array<{ level: string; logger?: string; data: unknown }> = [];
    const progressUpdates: Array<{
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    }> = [];
    client.onListChanged((kind) => listChanges.push(kind));
    client.onResourceUpdated((uri) => resourceUpdates.push(uri));
    client.onLogMessage((message) => logMessages.push(message));
    client.onProgress((update) => progressUpdates.push(update));
    try {
      await client.connect();

      expect(client.getServerInfo()).toMatchObject({
        serverInfo: { name: 'full-stdio', version: '1.2.3', title: 'Full MCP fixture' },
        capabilities: {
          tools: { listChanged: true },
          resources: { subscribe: true, listChanged: true },
          prompts: { listChanged: true },
          completions: {},
          logging: {},
        },
        instructions: 'Use the fixture resources and prompts for MCP integration tests.',
      });
      await expect(client.callTool('get_roots', {})).resolves.toMatchObject({
        content: [
          {
            type: 'text',
            text: JSON.stringify([{ uri: 'file:///workspace', name: 'workspace' }]),
          },
        ],
      });

      const resources = await client.listResources();
      expect(resources.map((resource) => resource.uri).toSorted()).toEqual([
        'nori://docs/readme',
        'nori://users/alice',
        'nori://users/bob',
      ]);
      const templates = await client.listResourceTemplates();
      expect(templates).toEqual([
        expect.objectContaining({
          name: 'user-profile',
          uriTemplate: 'nori://users/{name}',
          title: 'User profile',
        }),
      ]);
      await expect(client.readResource('nori://docs/readme')).resolves.toMatchObject({
        contents: [{ uri: 'nori://docs/readme', text: '# MCP fixture' }],
      });

      const prompts = await client.listPrompts();
      expect(prompts).toEqual([
        expect.objectContaining({
          name: 'review',
          title: 'Review code',
          arguments: [expect.objectContaining({ name: 'language', required: true })],
        }),
      ]);
      await expect(client.getPrompt('review', { language: 'typescript' })).resolves.toMatchObject({
        description: 'Review typescript',
        messages: [
          { role: 'user', content: { type: 'text', text: 'Review this typescript code.' } },
        ],
      });
      await expect(
        client.complete(
          { type: 'ref/prompt', name: 'review' },
          { name: 'language', value: 'ty' },
        ),
      ).resolves.toEqual({ values: ['typescript'], total: 1, hasMore: false });

      await client.subscribeResource('nori://docs/readme');
      await client.callTool('update_resource', {});
      await waitUntil(() => resourceUpdates.includes('nori://docs/readme'));
      await waitUntil(() => logMessages.length > 0 && progressUpdates.length > 0);
      expect(logMessages).toContainEqual({
        level: 'info',
        logger: 'full-stdio-fixture',
        data: { action: 'update_resource' },
      });
      expect(progressUpdates).toContainEqual({
        progressToken: expect.any(Number),
        progress: 1,
        total: 1,
        message: 'Resource update complete',
      });
      await client.unsubscribeResource('nori://docs/readme');

      await client.callTool('enable_dynamic', {});
      await waitUntil(() => listChanges.includes('tools'));
      expect((await client.listTools()).map((tool) => tool.name)).toContain('dynamic_tool');
    } finally {
      await client.close();
    }
  }, 20000);

  it('handles a real server-initiated sampling request with server identity and cancellation context', async () => {
    const requests: unknown[] = [];
    const contexts: Array<{ serverName: string; requestId: string | number; signal: AbortSignal }> = [];
    const client = new StdioMcpClient(
      {
        transport: 'stdio',
        command: process.execPath,
        args: [fullFixture],
        env: { NORI_TEST_MCP_SAMPLING: '1' },
      },
      {
        serverName: 'sampling-fixture',
        host: {
          sampling: {
            createMessage: (request, context) => {
              requests.push(request);
              contexts.push(context);
              return {
                role: 'assistant',
                content: { type: 'text', text: 'sampled by Nori' },
                model: 'fixture-model',
                stopReason: 'endTurn',
              };
            },
          },
        },
      },
    );

    try {
      await client.connect();
      const result = await client.callTool('sample_current_model', {});
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(JSON.parse(text)).toMatchObject({
        role: 'assistant',
        content: { type: 'text', text: 'sampled by Nori' },
        model: 'fixture-model',
        stopReason: 'endTurn',
      });
      expect(requests).toEqual([
        expect.objectContaining({
          systemPrompt: 'Fixture sampling system prompt',
          maxTokens: 8_192,
          messages: [
            {
              role: 'user',
              content: { type: 'text', text: 'Summarize this MCP sampling request.' },
            },
          ],
        }),
      ]);
      expect(contexts).toHaveLength(1);
      expect(contexts[0]).toMatchObject({ serverName: 'sampling-fixture' });
      expect(contexts[0]?.requestId).toEqual(expect.any(Number));
      expect(contexts[0]?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      await client.close();
    }
  }, 20_000);

  it('runs required task tools and exposes their lifecycle through the task API', async () => {
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [fullFixture],
      env: { NORI_TEST_MCP_TASKS: '1' },
    });
    const updates: MCPTask[] = [];
    client.onTaskStatus((task) => updates.push(task));
    try {
      await client.connect();
      const tools = await client.listTools();
      expect(tools.find((tool) => tool.name === 'delayed_result')).toMatchObject({
        execution: { taskSupport: 'required' },
      });

      await expect(
        client.callTool('delayed_result', { message: 'task complete', delayMs: 20 }),
      ).resolves.toMatchObject({
        isError: false,
        content: [{ type: 'text', text: 'task complete' }],
      });

      expect(updates.some((task) => task.status === 'working')).toBe(true);
      expect(updates.some((task) => task.status === 'completed')).toBe(true);
      const tasks = await client.listTasks();
      const completed = tasks.find((task) => task.status === 'completed');
      expect(completed).toBeDefined();
      await expect(client.getTask(completed!.taskId)).resolves.toMatchObject({
        taskId: completed!.taskId,
        status: 'completed',
      });
      await expect(client.getTaskResult(completed!.taskId)).resolves.toMatchObject({
        content: [{ type: 'text', text: 'task complete' }],
      });
    } finally {
      await client.close();
    }
  }, 20_000);

  it('hosts task-augmented sampling and elicitation requested by a real MCP server', async () => {
    const client = new StdioMcpClient(
      {
        transport: 'stdio',
        command: process.execPath,
        args: [fullFixture],
        env: {
          NORI_TEST_MCP_TASKS: '1',
          NORI_TEST_MCP_SAMPLING: '1',
          NORI_TEST_MCP_ELICITATION: '1',
        },
      },
      {
        serverName: 'host-task-fixture',
        host: {
          sampling: {
            createMessage: () => ({
              role: 'assistant',
              content: { type: 'text', text: 'task sampled by Nori' },
              model: 'fixture-task-model',
              stopReason: 'endTurn',
            }),
          },
          elicitation: {
            create: () => ({ action: 'accept', content: { approved: true } }),
          },
        },
      },
    );

    try {
      await client.connect();
      const sampling = await client.callTool('sample_current_model_task', {});
      expect(JSON.parse((sampling.content[0] as { type: 'text'; text: string }).text)).toMatchObject({
        content: { type: 'text', text: 'task sampled by Nori' },
        model: 'fixture-task-model',
      });

      const elicitation = await client.callTool('elicit_task_input', {});
      expect(JSON.parse((elicitation.content[0] as { type: 'text'; text: string }).text)).toMatchObject({
        action: 'accept',
        content: { approved: true },
      });
    } finally {
      await client.close();
    }
  }, 20_000);

  it('aborts client host work when the MCP server cancels its task', async () => {
    let hostAborted = false;
    const client = new StdioMcpClient(
      {
        transport: 'stdio',
        command: process.execPath,
        args: [fullFixture],
        env: { NORI_TEST_MCP_TASKS: '1', NORI_TEST_MCP_SAMPLING: '1' },
      },
      {
        host: {
          sampling: {
            createMessage: (_request, context) => new Promise((_resolve, reject) => {
              context.signal.addEventListener('abort', () => {
                hostAborted = true;
                reject(context.signal.reason);
              }, { once: true });
            }),
          },
        },
      },
    );

    try {
      await client.connect();
      const result = await client.callTool('cancel_sampling_task', {});
      expect((result.content[0] as { type: 'text'; text: string }).text).toContain('cancelled');
      expect(hostAborted).toBe(true);
    } finally {
      await client.close();
    }
  }, 20_000);

  it('aggregates every page returned by list methods', async () => {
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [paginatedFixture],
    });
    try {
      await client.connect();
      await expect(client.listTools()).resolves.toEqual([
        expect.objectContaining({ name: 'page_one' }),
        expect.objectContaining({ name: 'page_two' }),
      ]);
    } finally {
      await client.close();
    }
  }, 15000);

  it('propagates server-reported isError', async () => {
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
    });
    try {
      await client.connect();
      const result = await client.callTool('boom', {});
      expect(result.isError).toBe(true);
      expect(result.content[0]).toEqual({ type: 'text', text: 'boom!' });
    } finally {
      await client.close();
    }
  }, 15000);

  it('forwards configured env to the spawned server', async () => {
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
      env: { KIMI_TEST_ENV: 'forwarded-value' },
    });
    try {
      await client.connect();
      const result = await client.callTool('read_env', { name: 'KIMI_TEST_ENV' });
      expect(result.content).toEqual([{ type: 'text', text: 'forwarded-value' }]);
    } finally {
      await client.close();
    }
  }, 15000);

  it('inherits parent process env so PATH/HOME survive; config.env overrides on conflict', async () => {
    const parentOnly = `KIMI_TEST_PARENT_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const shared = `KIMI_TEST_SHARED_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    process.env[parentOnly] = 'from-parent';
    process.env[shared] = 'from-parent';
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
      env: { [shared]: 'from-config' },
    });
    try {
      await client.connect();
      const inherited = await client.callTool('read_env', { name: parentOnly });
      expect(inherited.content).toEqual([{ type: 'text', text: 'from-parent' }]);
      const overridden = await client.callTool('read_env', { name: shared });
      expect(overridden.content).toEqual([{ type: 'text', text: 'from-config' }]);
    } finally {
      delete process.env[parentOnly];
      delete process.env[shared];
      await client.close();
    }
  }, 15000);

  it('captures recent stderr into a snapshot the manager can attach to errors', async () => {
    const banner = `kimi-test-stderr-${Date.now()}`;
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [stderrThenExitFixture],
      env: { KIMI_TEST_MCP_STDERR: banner },
    });
    try {
      await expect(client.connect()).rejects.toThrow();
      // Even when connect fails, the buffered stderr must be retrievable so
      // higher layers can include it in the user-facing error message.
      expect(client.stderrSnapshot()).toContain(banner);
    } finally {
      await client.close();
    }
  }, 15000);

  it('keeps the stderr buffer bounded so noisy servers cannot exhaust memory', async () => {
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
    });
    try {
      await client.connect();
      // Confirm the buffer cap is documented and finite (4 KB is plenty for a
      // useful tail). The exact value is an implementation detail but
      // exposing it for tests prevents unbounded growth from regressing.
      expect(StdioMcpClient.stderrBufferCapacity).toBeLessThanOrEqual(16 * 1024);
      expect(StdioMcpClient.stderrBufferCapacity).toBeGreaterThanOrEqual(1024);
    } finally {
      await client.close();
    }
  }, 15000);

  it('notifies an unexpected-close listener when the child exits after connect', async () => {
    const banner = `kimi-test-crash-${Date.now()}`;
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [crashAfterConnectFixture],
      env: { KIMI_TEST_MCP_EXIT_AFTER_MS: '500', KIMI_TEST_MCP_STDERR: banner },
    });
    const closes: Array<{ stderr?: string; error?: string }> = [];
    client.onUnexpectedClose((reason) => {
      closes.push({ stderr: reason.stderr, error: reason.error?.message });
    });
    try {
      await client.connect();
      // Wait for the child to exit and onclose to fire.
      for (let i = 0; i < 100; i++) {
        if (closes.length > 0) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(closes).toHaveLength(1);
      expect(closes[0]?.stderr ?? '').toContain(banner);
    } finally {
      await client.close();
    }
  }, 15000);

  it('buffers an early close and replays it on listener registration', async () => {
    const banner = `kimi-test-early-${Date.now()}`;
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [crashAfterConnectFixture],
      env: { KIMI_TEST_MCP_STDERR: banner, KIMI_TEST_MCP_EXIT_CODE: '0' },
    });
    try {
      await client.connect();
      // Drive the child to exit AFTER a successful tool response. The fixture
      // schedules `process.exit` via setImmediate so the reply is fully
      // flushed before the pipe closes; this exercises the post-handshake
      // disconnect path with no startup-timing race.
      const reply = await client.callTool('exit_after_reply', {});
      expect(reply.isError).toBe(false);
      // Wait deterministically for the child to actually exit. The fixture
      // writes `banner\n` to stderr sync-before `process.exit`, so observing
      // the banner is proof the exit syscall has been issued.
      const exitDeadline = Date.now() + 5000;
      while (Date.now() < exitDeadline && !client.stderrSnapshot().includes(banner)) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(client.stderrSnapshot()).toContain(banner);
      // Drain probe: send a fresh request that the dead transport must
      // reject. Once it does, we know the SDK has processed `_onclose`,
      // which means our hook has already populated `pendingUnexpectedClose`.
      // This is what gives us a buffer to replay — registering the listener
      // first would intercept the close as a live fire instead.
      const drainDeadline = Date.now() + 5000;
      let transportConfirmedDead = false;
      while (Date.now() < drainDeadline) {
        try {
          await client.callTool('echo', { text: 'probe' });
        } catch {
          transportConfirmedDead = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(transportConfirmedDead).toBe(true);
      // `pendingUnexpectedClose` is set; registering the listener must
      // invoke it synchronously inside the call.
      let received: { stderr?: string } | undefined;
      let syncedOnRegister = false;
      client.onUnexpectedClose((reason) => {
        syncedOnRegister = true;
        received = { stderr: reason.stderr };
      });
      expect(syncedOnRegister).toBe(true);
      expect(received?.stderr ?? '').toContain(banner);
    } finally {
      await client.close();
    }
  }, 15000);

  it('does not fire unexpected-close when the caller closes the client itself', async () => {
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
    });
    const closes: number[] = [];
    client.onUnexpectedClose(() => closes.push(Date.now()));
    await client.connect();
    await client.close();
    // Give any pending onclose listener a chance to fire so we are sure it is
    // suppressed and not merely racing.
    await new Promise((r) => setTimeout(r, 100));
    expect(closes).toEqual([]);
  }, 15000);
});

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`);
}

describe('mergeStdioEnv', () => {
  it('enables NODE_USE_ENV_PROXY for a proxy set only in the server config.env', () => {
    const merged = mergeStdioEnv({ HTTP_PROXY: 'http://corp:3128' }, { PATH: '/usr/bin' });
    expect(merged['HTTP_PROXY']).toBe('http://corp:3128');
    expect(merged['NODE_USE_ENV_PROXY']).toBe('1');
    expect(merged['NO_PROXY']).toBe('localhost,127.0.0.1,::1,[::1]');
    expect(merged['PATH']).toBe('/usr/bin');
  });

  it('does not inject NODE_USE_ENV_PROXY when no proxy is configured', () => {
    const merged = mergeStdioEnv(undefined, { PATH: '/usr/bin' });
    expect(merged['NODE_USE_ENV_PROXY']).toBeUndefined();
    expect(merged['PATH']).toBe('/usr/bin');
  });

  it('lets config.env override the parent env', () => {
    const merged = mergeStdioEnv({ FOO: 'override' }, { FOO: 'parent', PATH: '/x' });
    expect(merged['FOO']).toBe('override');
  });
});
