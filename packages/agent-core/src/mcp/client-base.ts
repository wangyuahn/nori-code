import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/index.js';
import type { RequestTaskStore } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  CallToolResultSchema,
  CreateMessageRequestSchema,
  ElicitationCompleteNotificationSchema,
  ElicitRequestSchema,
  ListRootsRequestSchema,
  LoggingMessageNotificationSchema,
  ProgressNotificationSchema,
  ResourceUpdatedNotificationSchema,
  TaskStatusNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';

import {
  buildRequestOptions,
  KIMI_MCP_CLIENT_NAME,
  KIMI_MCP_CLIENT_VERSION,
  toMcpToolDefinition,
  toMcpToolResult,
} from './client-shared';
import type {
  MCPClient,
  MCPHost,
  MCPLogListener,
  MCPLoggingLevel,
  MCPProgressListener,
  MCPCompletionArgument,
  MCPCompletionReference,
  MCPCompletionResult,
  MCPGetPromptResult,
  MCPListChangedListener,
  MCPListKind,
  MCPPromptDefinition,
  MCPReadResourceResult,
  MCPResource,
  MCPResourceTemplate,
  MCPResourceUpdatedListener,
  MCPServerInfo,
  MCPTask,
  MCPTaskCreationOptions,
  MCPTaskStatusListener,
  MCPToolDefinition,
  MCPToolResult,
} from './types';

export interface McpSdkClientOptions {
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly serverName?: string;
  readonly toolCallTimeoutMs?: number;
  readonly host?: MCPHost;
}

interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

/** Shared MCP protocol implementation used by every transport wrapper. */
export class McpSdkClientBase implements MCPClient {
  protected readonly client: Client;
  private readonly toolCallTimeoutMs?: number;
  private readonly listChangedListeners = new Set<MCPListChangedListener>();
  private readonly resourceUpdatedListeners = new Set<MCPResourceUpdatedListener>();
  private readonly logListeners = new Set<MCPLogListener>();
  private readonly progressListeners = new Set<MCPProgressListener>();
  private readonly taskStatusListeners = new Set<MCPTaskStatusListener>();
  private readonly pendingListChanges = new Set<MCPListKind>();
  private readonly disposeHostSubscriptions: Array<() => void> = [];
  private readonly hostTaskStore?: HostTaskStore;
  private readonly hostTaskAbortControllers = new Map<string, AbortController>();
  private taskRequiredTools = new Set<string>();

  constructor(options: McpSdkClientOptions = {}) {
    const host = options.host;
    const supportsHostTasks = host?.sampling !== undefined || host?.elicitation !== undefined;
    const hostTaskStore = supportsHostTasks
      ? new HostTaskStore((taskId) => this.hostTaskAbortControllers.get(taskId)?.abort())
      : undefined;
    this.hostTaskStore = hostTaskStore;
    const capabilities = {
      ...(host?.roots !== undefined
        ? { roots: { listChanged: host.roots.onChanged !== undefined } }
        : undefined),
      ...(host?.sampling !== undefined
        ? { sampling: host.sampling.supportsTools === true ? { tools: {} } : {} }
        : undefined),
      ...(host?.elicitation !== undefined
        ? {
            elicitation: {
              form: {},
              ...(host.elicitation.supportsUrl === true ? { url: {} } : undefined),
            },
          }
        : undefined),
      ...(supportsHostTasks
        ? {
            tasks: {
              list: {},
              cancel: {},
              requests: {
                ...(host?.sampling !== undefined
                  ? { sampling: { createMessage: {} } }
                  : undefined),
                ...(host?.elicitation !== undefined
                  ? { elicitation: { create: {} } }
                  : undefined),
              },
            },
          }
        : undefined),
    };
    this.client = new Client(
      {
        name: options.clientName ?? KIMI_MCP_CLIENT_NAME,
        version: options.clientVersion ?? KIMI_MCP_CLIENT_VERSION,
      },
      {
        capabilities,
        ...(hostTaskStore !== undefined ? { taskStore: hostTaskStore } : undefined),
        listChanged: {
          tools: {
            autoRefresh: false,
            onChanged: () => this.emitListChanged('tools'),
          },
          resources: {
            autoRefresh: false,
            onChanged: () => this.emitListChanged('resources'),
          },
          prompts: {
            autoRefresh: false,
            onChanged: () => this.emitListChanged('prompts'),
          },
        },
      },
    );
    this.client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
      this.emitResourceUpdated(notification.params.uri);
    });
    this.client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      this.emitLogMessage(notification.params);
    });
    this.client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
      this.emitProgress(notification.params);
    });
    this.client.setNotificationHandler(TaskStatusNotificationSchema, (notification) => {
      this.emitTaskStatus(notification.params);
    });
    if (host?.roots !== undefined) {
      this.client.setRequestHandler(ListRootsRequestSchema, async () => ({
        roots: await host.roots!.list(),
      }));
      if (host.roots.onChanged !== undefined) {
        this.disposeHostSubscriptions.push(
          host.roots.onChanged(() => {
            void this.sendRootsListChanged().catch(() => undefined);
          }),
        );
      }
    }
    if (host?.sampling !== undefined) {
      this.client.setRequestHandler(CreateMessageRequestSchema, async (request, extra) => {
        return this.runHostRequest(
          request.params.task,
          extra.taskStore,
          extra.taskRequestedTtl,
          extra.signal,
          (signal) => host.sampling!.createMessage(
            request.params as unknown as Parameters<NonNullable<MCPHost['sampling']>['createMessage']>[0],
            {
              serverName: options.serverName ?? 'direct',
              requestId: extra.requestId,
              signal,
            },
          ),
        ) as never;
      });
    }
    if (host?.elicitation !== undefined) {
      this.client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
        return this.runHostRequest(
          request.params.task,
          extra.taskStore,
          extra.taskRequestedTtl,
          extra.signal,
          (signal) => host.elicitation!.create(
            request.params as unknown as Parameters<NonNullable<MCPHost['elicitation']>['create']>[0],
            {
              serverName: options.serverName ?? 'direct',
              requestId: extra.requestId,
              signal,
            },
          ),
        ) as never;
      });
      if (host.elicitation.complete !== undefined) {
        this.client.setNotificationHandler(
          ElicitationCompleteNotificationSchema,
          async (notification) => {
            await host.elicitation!.complete!(notification.params.elicitationId, {
              serverName: options.serverName ?? 'direct',
            });
          },
        );
      }
    }
    this.toolCallTimeoutMs = options.toolCallTimeoutMs;
  }

  getServerInfo(): MCPServerInfo {
    return {
      serverInfo: this.client.getServerVersion(),
      capabilities: this.client.getServerCapabilities() ?? {},
      instructions: this.client.getInstructions(),
    };
  }

  async listTools(signal?: AbortSignal): Promise<MCPToolDefinition[]> {
    const tools = await collectCursorPages(async (cursor) => {
      const result = await this.client.listTools(
        cursor === undefined ? undefined : { cursor },
        this.requestOptions(undefined, signal),
      );
      return { items: result.tools, nextCursor: result.nextCursor };
    });
    const definitions = tools.map(toMcpToolDefinition);
    this.taskRequiredTools = new Set(
      definitions
        .filter((tool) => tool.execution?.taskSupport === 'required')
        .map((tool) => tool.name),
    );
    return definitions;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<MCPToolResult> {
    if (this.taskRequiredTools.has(name)) {
      return this.callToolAsTask(name, args, undefined, signal);
    }
    const requestOptions = this.requestOptions(this.toolCallTimeoutMs, signal);
    const result = await this.client.callTool({ name, arguments: args }, undefined, requestOptions);
    return toMcpToolResult(result);
  }

  async callToolAsTask(
    name: string,
    args: Record<string, unknown>,
    task?: MCPTaskCreationOptions,
    signal?: AbortSignal,
  ): Promise<MCPToolResult> {
    const requestOptions = {
      ...(this.requestOptions(this.toolCallTimeoutMs, signal) ?? {}),
      task: task ?? {},
    };
    const stream = this.client.experimental.tasks.callToolStream(
      { name, arguments: args },
      CallToolResultSchema,
      requestOptions,
    );
    for await (const message of stream) {
      if (message.type === 'taskCreated' || message.type === 'taskStatus') {
        this.emitTaskStatus(message.task);
        continue;
      }
      if (message.type === 'error') throw message.error;
      if (message.type === 'result') return toMcpToolResult(message.result);
    }
    throw new Error(`MCP task tool "${name}" ended without a result`);
  }

  async listTasks(signal?: AbortSignal): Promise<MCPTask[]> {
    return collectCursorPages(async (cursor) => {
      const result = await this.client.experimental.tasks.listTasks(
        cursor,
        this.requestOptions(undefined, signal),
      );
      return { items: result.tasks, nextCursor: result.nextCursor };
    });
  }

  async getTask(taskId: string, signal?: AbortSignal): Promise<MCPTask> {
    return this.client.experimental.tasks.getTask(
      taskId,
      this.requestOptions(undefined, signal),
    );
  }

  async getTaskResult(taskId: string, signal?: AbortSignal): Promise<MCPToolResult> {
    const result = await this.client.experimental.tasks.getTaskResult(
      taskId,
      CallToolResultSchema,
      this.requestOptions(undefined, signal),
    );
    return toMcpToolResult(result);
  }

  async cancelTask(taskId: string, signal?: AbortSignal): Promise<MCPTask> {
    return this.client.experimental.tasks.cancelTask(
      taskId,
      this.requestOptions(undefined, signal),
    );
  }

  async listResources(signal?: AbortSignal): Promise<MCPResource[]> {
    return collectCursorPages(async (cursor) => {
      const result = await this.client.listResources(
        cursor === undefined ? undefined : { cursor },
        this.requestOptions(undefined, signal),
      );
      return { items: result.resources, nextCursor: result.nextCursor };
    });
  }

  async listResourceTemplates(signal?: AbortSignal): Promise<MCPResourceTemplate[]> {
    return collectCursorPages(async (cursor) => {
      const result = await this.client.listResourceTemplates(
        cursor === undefined ? undefined : { cursor },
        this.requestOptions(undefined, signal),
      );
      return { items: result.resourceTemplates, nextCursor: result.nextCursor };
    });
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<MCPReadResourceResult> {
    return this.client.readResource({ uri }, this.requestOptions(undefined, signal));
  }

  async subscribeResource(uri: string, signal?: AbortSignal): Promise<void> {
    await this.client.subscribeResource({ uri }, this.requestOptions(undefined, signal));
  }

  async unsubscribeResource(uri: string, signal?: AbortSignal): Promise<void> {
    await this.client.unsubscribeResource({ uri }, this.requestOptions(undefined, signal));
  }

  async listPrompts(signal?: AbortSignal): Promise<MCPPromptDefinition[]> {
    return collectCursorPages(async (cursor) => {
      const result = await this.client.listPrompts(
        cursor === undefined ? undefined : { cursor },
        this.requestOptions(undefined, signal),
      );
      return { items: result.prompts, nextCursor: result.nextCursor };
    });
  }

  async getPrompt(
    name: string,
    args?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<MCPGetPromptResult> {
    return this.client.getPrompt(
      { name, arguments: args },
      this.requestOptions(undefined, signal),
    );
  }

  async complete(
    reference: MCPCompletionReference,
    argument: MCPCompletionArgument,
    context?: { arguments?: Record<string, string> },
    signal?: AbortSignal,
  ): Promise<MCPCompletionResult> {
    const result = await this.client.complete(
      { ref: reference, argument, context },
      this.requestOptions(undefined, signal),
    );
    return result.completion;
  }

  onListChanged(listener: MCPListChangedListener): () => void {
    this.listChangedListeners.add(listener);
    for (const kind of this.pendingListChanges) listener(kind);
    this.pendingListChanges.clear();
    return () => {
      this.listChangedListeners.delete(listener);
    };
  }

  onResourceUpdated(listener: MCPResourceUpdatedListener): () => void {
    this.resourceUpdatedListeners.add(listener);
    return () => {
      this.resourceUpdatedListeners.delete(listener);
    };
  }

  onLogMessage(listener: MCPLogListener): () => void {
    this.logListeners.add(listener);
    return () => {
      this.logListeners.delete(listener);
    };
  }

  onProgress(listener: MCPProgressListener): () => void {
    this.progressListeners.add(listener);
    return () => {
      this.progressListeners.delete(listener);
    };
  }

  onTaskStatus(listener: MCPTaskStatusListener): () => void {
    this.taskStatusListeners.add(listener);
    return () => {
      this.taskStatusListeners.delete(listener);
    };
  }

  async setLoggingLevel(level: MCPLoggingLevel, signal?: AbortSignal): Promise<void> {
    await this.client.setLoggingLevel(level, this.requestOptions(undefined, signal));
  }

  async sendRootsListChanged(): Promise<void> {
    await this.client.sendRootsListChanged();
  }

  private emitListChanged(kind: MCPListKind): void {
    if (this.listChangedListeners.size === 0) {
      this.pendingListChanges.add(kind);
      return;
    }
    for (const listener of this.listChangedListeners) listener(kind);
  }

  private emitResourceUpdated(uri: string): void {
    for (const listener of this.resourceUpdatedListeners) listener(uri);
  }

  private emitLogMessage(message: Parameters<MCPLogListener>[0]): void {
    for (const listener of this.logListeners) listener(message);
  }

  private emitProgress(update: Parameters<MCPProgressListener>[0]): void {
    for (const listener of this.progressListeners) listener(update);
  }

  private emitTaskStatus(task: MCPTask): void {
    for (const listener of this.taskStatusListeners) listener(task);
  }

  private requestOptions(
    timeout: number | undefined,
    signal: AbortSignal | undefined,
  ): ReturnType<typeof buildRequestOptions> {
    if (this.progressListeners.size === 0) {
      return buildRequestOptions(timeout, signal);
    }
    // The SDK uses the presence of `onprogress` to attach a progress token to
    // the request. Nori consumes the raw notification above so a final progress
    // update cannot race with the response removing the SDK's request handler.
    return buildRequestOptions(timeout, signal, () => undefined);
  }

  private async runHostRequest<TResult>(
    task: { ttl?: number } | undefined,
    taskStore: RequestTaskStore | undefined,
    taskRequestedTtl: number | undefined,
    requestSignal: AbortSignal,
    execute: (signal: AbortSignal) => TResult | Promise<TResult>,
  ): Promise<TResult | { task: MCPTask }> {
    if (task === undefined) return execute(requestSignal);
    if (taskStore === undefined) {
      throw new Error('MCP task request received without a client task store');
    }

    const created = await taskStore.createTask({ ttl: taskRequestedTtl });
    const controller = new AbortController();
    this.hostTaskAbortControllers.set(created.taskId, controller);
    const signal = AbortSignal.any([requestSignal, controller.signal]);

    void this.completeHostTask(taskStore, created.taskId, () => execute(signal));
    return { task: created as MCPTask };
  }

  private async completeHostTask<TResult>(
    taskStore: RequestTaskStore,
    taskId: string,
    execute: () => TResult | Promise<TResult>,
  ): Promise<void> {
    try {
      const result = await execute();
      const current = await taskStore.getTask(taskId);
      if (!isTerminalTask(current.status)) {
        await taskStore.storeTaskResult(taskId, 'completed', result as never);
      }
    } catch (error) {
      try {
        const current = await taskStore.getTask(taskId);
        if (!isTerminalTask(current.status)) {
          await taskStore.storeTaskResult(taskId, 'failed', {
            _meta: {},
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } catch {
        // Cancellation or cleanup may make the task terminal before its host work settles.
      }
    } finally {
      this.hostTaskAbortControllers.delete(taskId);
    }
  }

  protected closeProtocol(): void {
    while (this.disposeHostSubscriptions.length > 0) {
      this.disposeHostSubscriptions.pop()?.();
    }
    for (const controller of this.hostTaskAbortControllers.values()) controller.abort();
    this.hostTaskAbortControllers.clear();
    this.hostTaskStore?.cleanup();
  }
}

class HostTaskStore extends InMemoryTaskStore {
  constructor(private readonly onCancelled: (taskId: string) => void) {
    super();
  }

  override async updateTaskStatus(
    taskId: string,
    status: MCPTask['status'],
    statusMessage?: string,
    sessionId?: string,
  ): Promise<void> {
    await super.updateTaskStatus(taskId, status, statusMessage, sessionId);
    if (status === 'cancelled') this.onCancelled(taskId);
  }
}

function isTerminalTask(status: MCPTask['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

async function collectCursorPages<T>(
  loadPage: (cursor: string | undefined) => Promise<CursorPage<T>>,
): Promise<T[]> {
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await loadPage(cursor);
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      if (seenCursors.has(cursor)) {
        throw new Error(`MCP pagination returned a repeated cursor: ${cursor}`);
      }
      seenCursors.add(cursor);
    }
  } while (cursor !== undefined);
  return items;
}
