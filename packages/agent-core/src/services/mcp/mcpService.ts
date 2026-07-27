/**
 * `McpService` — implementation of `IMcpService`.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { McpServerConfigSchema, type McpServerConfig } from '../../config';
import { Disposable, InstantiationType, registerSingleton } from '../../di';
import { ErrorCodes, KimiError } from '../../errors';
import type {
  McpConfigurationResponse,
  McpServer,
  PatchMcpConfigurationRequest,
} from '@nori-code/protocol';

import { ICoreProcessService } from '../coreProcess/coreProcess';
import { IEnvironmentService } from '../environment/environment';
import {
  McpConfigInvalidError,
  IMcpService,
  McpServerNotFoundError,
  toProtocolMcpServer,
} from './mcp';

export class McpService extends Disposable implements IMcpService {
  readonly _serviceBrand: undefined;

  constructor(
    @ICoreProcessService private readonly core: ICoreProcessService,
    @IEnvironmentService private readonly environment: IEnvironmentService,
  ) {
    super();
  }

  async list(): Promise<readonly McpServer[]> {
    // `listMcpServers` is on the SessionAPI surface; we need a session id to
    // dispatch. Pick the most recently created one. If no sessions exist,
    // return an empty list (the MCP registrar may have started up but the
    // RPC plumbing isn't reachable until a session is open).
    const result = await this._withLoadedSession((sessionId) =>
      this.core.rpc.listMcpServers({ sessionId }),
    );
    return result?.value.map(toProtocolMcpServer) ?? [];
  }

  async getConfig(): Promise<McpConfigurationResponse> {
    const file = await this._readGlobalConfig();
    return {
      path: file.path,
      mcp_servers: file.servers,
    };
  }

  async setConfig(patch: PatchMcpConfigurationRequest): Promise<McpConfigurationResponse> {
    const file = await this._readGlobalConfig();
    const nextRawServers = { ...file.rawServers };

    for (const [name, config] of Object.entries(patch.mcp_servers)) {
      if (config === null) {
        delete nextRawServers[name];
        continue;
      }
      try {
        nextRawServers[name] = McpServerConfigSchema.parse(config);
      } catch (error) {
        throw new McpConfigInvalidError(`Invalid MCP server "${name}": ${describeError(error)}`, { cause: error });
      }
    }

    const nextRoot = { ...file.rawRoot, mcpServers: nextRawServers };
    await mkdir(this.environment.homeDir, { recursive: true, mode: 0o700 });
    await writeFile(file.path, `${JSON.stringify(nextRoot, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    return this.getConfig();
  }

  async restart(serverId: string): Promise<{ restarting: true }> {
    const result = await this._withLoadedSession((sessionId) =>
      this.core.rpc.listMcpServers({ sessionId }),
    );
    if (result === undefined) {
      // No session => no MCP registrar reachable => server can't be reached.
      throw new McpServerNotFoundError(serverId);
    }
    // Existence check: the wire id is the agent-core `name`. The reconnect
    // call will reject for unknown names; we pre-check so the route can
    // emit a deterministic 40408 envelope without depending on agent-core
    // error message shape.
    if (!result.value.some((s) => s.name === serverId)) {
      throw new McpServerNotFoundError(serverId);
    }
    await this.core.rpc.reconnectMcpServer({ sessionId: result.sessionId, name: serverId });
    return { restarting: true };
  }

  /**
   * Find a usable session id for dispatching SessionAPI calls. Returns the
   * most recently created session id, or `undefined` when no sessions exist.
   */
  private async _withLoadedSession<T>(
    operation: (sessionId: string) => Promise<T>,
  ): Promise<{ sessionId: string; value: T } | undefined> {
    const all = await this.core.rpc.listSessions({});
    if (all.length === 0) return undefined;
    // Sort by createdAt desc — newest sessions are the most likely to have
    // an active MCP RPC binding.
    const sorted = [...all].sort((a, b) => b.createdAt - a.createdAt);
    for (const session of sorted) {
      try {
        return { sessionId: session.id, value: await operation(session.id) };
      } catch (error) {
        if (error instanceof KimiError && error.code === ErrorCodes.SESSION_NOT_FOUND) {
          continue;
        }
        throw error;
      }
    }
    return undefined;
  }

  private async _readGlobalConfig(): Promise<{
    path: string;
    rawRoot: Record<string, unknown>;
    rawServers: Record<string, unknown>;
    servers: Record<string, McpServerConfig>;
  }> {
    const path = join(this.environment.homeDir, 'mcp.json');
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return { path, rawRoot: {}, rawServers: {}, servers: {} };
      }
      throw new McpConfigInvalidError(`Failed to read ${path}: ${describeError(error)}`, { cause: error });
    }

    if (text.trim().length === 0) {
      return { path, rawRoot: {}, rawServers: {}, servers: {} };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new McpConfigInvalidError(`Invalid JSON in ${path}: ${describeError(error)}`, { cause: error });
    }
    if (!isRecord(parsed)) {
      throw new McpConfigInvalidError(`Invalid MCP configuration in ${path}: expected a JSON object.`);
    }
    const rawServersValue = parsed['mcpServers'];
    if (rawServersValue !== undefined && !isRecord(rawServersValue)) {
      throw new McpConfigInvalidError(`Invalid MCP configuration in ${path}: "mcpServers" must be an object.`);
    }

    const rawServers = rawServersValue ?? {};
    const servers: Record<string, McpServerConfig> = {};
    for (const [name, config] of Object.entries(rawServers)) {
      try {
        servers[name] = McpServerConfigSchema.parse(config);
      } catch (error) {
        throw new McpConfigInvalidError(`Invalid MCP server "${name}" in ${path}: ${describeError(error)}`, { cause: error });
      }
    }
    return { path, rawRoot: parsed, rawServers, servers };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): unknown {
  return isRecord(error) ? error['code'] : undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Self-register under the global singleton registry. All ctor deps are
// `@I…`-injected; `staticArguments = []`. `supportsDelayedInstantiation =
// false` preserves current reverse-dispose semantics.
registerSingleton(IMcpService, McpService, InstantiationType.Delayed);
