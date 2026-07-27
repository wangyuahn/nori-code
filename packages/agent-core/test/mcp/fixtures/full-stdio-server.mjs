import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  InMemoryTaskMessageQueue,
  InMemoryTaskStore,
} from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import {
  CreateMessageResultSchema,
  ElicitResultSchema,
  ListRootsResultSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const resourceOnly = process.env['NORI_TEST_MCP_RESOURCE_ONLY'] === '1';
const rootsEnabled = process.env['NORI_TEST_MCP_ROOTS'] === '1';
const samplingEnabled = process.env['NORI_TEST_MCP_SAMPLING'] === '1';
const elicitationEnabled = process.env['NORI_TEST_MCP_ELICITATION'] === '1';
const tasksEnabled = process.env['NORI_TEST_MCP_TASKS'] === '1';
const subscriptions = new Set();
const taskStore = tasksEnabled ? new InMemoryTaskStore() : undefined;
const server = new McpServer(
  {
    name: 'full-stdio',
    version: '1.2.3',
    title: 'Full MCP fixture',
  },
  {
    instructions: 'Use the fixture resources and prompts for MCP integration tests.',
    capabilities: {
      resources: { subscribe: true, listChanged: true },
      tools: resourceOnly ? undefined : { listChanged: true },
      prompts: { listChanged: true },
      logging: {},
      ...(tasksEnabled ? { tasks: { requests: { tools: { call: {} } } } } : {}),
    },
    ...(tasksEnabled
      ? { taskStore, taskMessageQueue: new InMemoryTaskMessageQueue() }
      : {}),
  },
);

server.server.setRequestHandler(SubscribeRequestSchema, ({ params }) => {
  subscriptions.add(params.uri);
  return {};
});
server.server.setRequestHandler(UnsubscribeRequestSchema, ({ params }) => {
  subscriptions.delete(params.uri);
  return {};
});

server.registerResource(
  'readme',
  'nori://docs/readme',
  {
    title: 'Fixture readme',
    description: 'A static text resource',
    mimeType: 'text/markdown',
  },
  (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'text/markdown', text: '# MCP fixture' }],
  }),
);

server.registerResource(
  'user-profile',
  new ResourceTemplate('nori://users/{name}', {
    list: async () => ({
      resources: [
        { uri: 'nori://users/alice', name: 'Alice', mimeType: 'application/json' },
        { uri: 'nori://users/bob', name: 'Bob', mimeType: 'application/json' },
      ],
    }),
    complete: {
      name: async (value) => ['alice', 'bob'].filter((name) => name.startsWith(value)),
    },
  }),
  {
    title: 'User profile',
    description: 'A templated user profile',
    mimeType: 'application/json',
  },
  (uri, variables) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify({ name: variables.name }),
      },
    ],
  }),
);

server.registerPrompt(
  'review',
  {
    title: 'Review code',
    description: 'Builds a code review prompt',
    argsSchema: {
      language: completable(z.string(), async (value) =>
        ['typescript', 'javascript', 'rust'].filter((item) => item.startsWith(value)),
      ),
    },
  },
  ({ language }) => ({
    description: `Review ${language}`,
    messages: [
      {
        role: 'user',
        content: { type: 'text', text: `Review this ${language} code.` },
      },
    ],
  }),
);

if (!resourceOnly) {
  if (tasksEnabled) {
    server.experimental.tasks.registerToolTask(
      'delayed_result',
      {
        description: 'Returns a result through the MCP Tasks protocol',
        inputSchema: {
          message: z.string(),
          delayMs: z.number().int().nonnegative().default(10),
        },
        execution: { taskSupport: 'required' },
      },
      {
        async createTask({ message, delayMs }, { taskStore: store, taskRequestedTtl }) {
          const task = await store.createTask({ ttl: taskRequestedTtl ?? 60_000 });
          void (async () => {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            const current = await store.getTask(task.taskId);
            if (current.status === 'cancelled') return;
            await store.storeTaskResult(task.taskId, 'completed', {
              content: [{ type: 'text', text: message }],
            });
          })();
          return { task };
        },
        async getTask(_args, { taskId, taskStore: store }) {
          return store.getTask(taskId);
        },
        async getTaskResult(_args, { taskId, taskStore: store }) {
          return store.getTaskResult(taskId);
        },
      },
    );
  }

  let dynamicTool;
  server.registerTool(
    'enable_dynamic',
    { description: 'Adds a dynamic tool and emits tools/list_changed', inputSchema: {} },
    async () => {
      if (dynamicTool === undefined) {
        dynamicTool = server.registerTool(
          'dynamic_tool',
          { description: 'A dynamically registered tool', inputSchema: {} },
          async () => ({ content: [{ type: 'text', text: 'dynamic' }] }),
        );
        server.sendToolListChanged();
      }
      return { content: [{ type: 'text', text: 'enabled' }] };
    },
  );

  if (rootsEnabled) {
    server.registerTool(
      'get_roots',
      { description: 'Requests the client roots/list response', inputSchema: {} },
      async () => {
        const result = await server.server.request(
          { method: 'roots/list', params: {} },
          ListRootsResultSchema,
        );
        return { content: [{ type: 'text', text: JSON.stringify(result.roots) }] };
      },
    );
  }

  if (samplingEnabled) {
    server.registerTool(
      'sample_current_model',
      { description: 'Requests sampling from the MCP client', inputSchema: {} },
      async (_args, extra) => {
        const result = await server.server.request(
          {
            method: 'sampling/createMessage',
            params: {
              messages: [
                {
                  role: 'user',
                  content: { type: 'text', text: 'Summarize this MCP sampling request.' },
                },
              ],
              systemPrompt: 'Fixture sampling system prompt',
              maxTokens: 8_192,
            },
          },
          CreateMessageResultSchema,
          { signal: extra.signal },
        );
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    );

    if (tasksEnabled) {
      server.registerTool(
        'sample_current_model_task',
        { description: 'Requests task-augmented sampling from the MCP client', inputSchema: {} },
        async (_args, extra) => {
          const stream = server.server.experimental.tasks.createMessageStream(
            {
              messages: [{ role: 'user', content: { type: 'text', text: 'Run task sampling.' } }],
              maxTokens: 256,
            },
            { signal: extra.signal, task: { ttl: 60_000 } },
          );
          for await (const message of stream) {
            if (message.type === 'error') throw message.error;
            if (message.type === 'result') {
              return { content: [{ type: 'text', text: JSON.stringify(message.result) }] };
            }
          }
          throw new Error('Task sampling ended without a result');
        },
      );

      server.registerTool(
        'cancel_sampling_task',
        { description: 'Cancels task-augmented sampling on the MCP client', inputSchema: {} },
        async (_args, extra) => {
          const stream = server.server.experimental.tasks.createMessageStream(
            {
              messages: [{ role: 'user', content: { type: 'text', text: 'Wait for cancellation.' } }],
              maxTokens: 256,
            },
            { signal: extra.signal, task: { ttl: 60_000 } },
          );
          for await (const message of stream) {
            if (message.type === 'taskCreated') {
              await server.server.experimental.tasks.cancelTask(message.task.taskId);
            }
            if (message.type === 'error') {
              return { content: [{ type: 'text', text: message.error.message }] };
            }
          }
          throw new Error('Cancelled sampling task ended without an error');
        },
      );
    }
  }

  if (elicitationEnabled && tasksEnabled) {
    server.registerTool(
      'elicit_task_input',
      { description: 'Requests task-augmented elicitation from the MCP client', inputSchema: {} },
      async (_args, extra) => {
        const stream = server.server.experimental.tasks.elicitInputStream(
          {
            mode: 'form',
            message: 'Confirm task elicitation',
            requestedSchema: {
              type: 'object',
              properties: { approved: { type: 'boolean' } },
              required: ['approved'],
            },
          },
          { signal: extra.signal, task: { ttl: 60_000 } },
        );
        for await (const message of stream) {
          if (message.type === 'error') throw message.error;
          if (message.type === 'result') {
            return { content: [{ type: 'text', text: JSON.stringify(message.result) }] };
          }
        }
        throw new Error('Task elicitation ended without a result');
      },
    );
  }

  server.registerTool(
    'update_resource',
    { description: 'Emits resources/updated', inputSchema: {} },
    async (_args, extra) => {
      await server.sendLoggingMessage({
        level: 'info',
        logger: 'full-stdio-fixture',
        data: { action: 'update_resource' },
      });
      if (extra._meta?.progressToken !== undefined) {
        await extra.sendNotification({
          method: 'notifications/progress',
          params: {
            progressToken: extra._meta.progressToken,
            progress: 1,
            total: 1,
            message: 'Resource update complete',
          },
        });
      }
      if (subscriptions.has('nori://docs/readme')) {
        await server.server.sendResourceUpdated({ uri: 'nori://docs/readme' });
      }
      return { content: [{ type: 'text', text: 'updated' }] };
    },
  );
}

await server.connect(new StdioServerTransport());
