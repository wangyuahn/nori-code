/**
 * `ToolService` + `McpService` (Chain 7 / P1.7, W9.1) unit tests.
 *
 * Hermetic: mocks `ICoreProcessService` with an in-memory `rpc` proxy. Exercises:
 *   - tool source mapping: 'builtin' / 'user'→'skill' / 'mcp' + mcp_server_id parse
 *   - mcp server status mapping (all 5 agent-core literals → 4 wire literals)
 *   - transport pass-through
 *   - last_error surfaced via `error?`
 *   - McpServerNotFoundError raised for unknown server id
 *   - empty-session-list behavior (returns [] / throws not found)
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  CoreRPC,
  EmptyPayload,
  McpServerInfo,
  ReconnectMcpServerPayload,
  SessionSummary,
} from '../../src';
import { ErrorCodes, KimiError } from '../../src';

import {
  type IEnvironmentService,
  type ICoreProcessService,
  McpServerNotFoundError,
  McpService,
  ToolService,
  toProtocolMcpServer,
  toProtocolTool,
} from '../../src/services';
import type { AgentCoreToolInfoLike } from '../../src/services';

interface FakeBridgeState {
  sessions: SessionSummary[];
  tools: AgentCoreToolInfoLike[];
  mcpServers: McpServerInfo[];
  reconnectCalls: ReconnectMcpServerPayload[];
}

function makeFakeBridge(state: FakeBridgeState): ICoreProcessService {
  const rpc: Partial<CoreRPC> = {
    listSessions: async () => state.sessions,
    getTools: async (_p: unknown) => state.tools as unknown as readonly never[],
    listMcpServers: async (_p: EmptyPayload & { sessionId: string }) => state.mcpServers,
    reconnectMcpServer: async (
      p: ReconnectMcpServerPayload & { sessionId: string },
    ) => {
      state.reconnectCalls.push(p);
    },
  };
  return {
    rpc: rpc as CoreRPC,
    ready: async () => undefined,
    dispose: () => undefined,
    _serviceBrand: undefined,
  };
}

function fakeSession(id: string, createdAt: number): SessionSummary {
  return {
    id,
    workDir: '/tmp/wd',
    sessionDir: `/tmp/sd-${id}`,
    createdAt,
    updatedAt: createdAt,
  };
}

function freshState(): FakeBridgeState {
  return { sessions: [], tools: [], mcpServers: [], reconnectCalls: [] };
}

const testEnvironment: IEnvironmentService = {
  _serviceBrand: undefined,
  homeDir: '/tmp/nori-home',
  configPath: '/tmp/nori-home/config.toml',
};

const temporaryHomes: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryHomes.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function temporaryEnvironment(): Promise<IEnvironmentService> {
  const homeDir = await mkdtemp(join(tmpdir(), 'nori-mcp-config-'));
  temporaryHomes.push(homeDir);
  return {
    _serviceBrand: undefined,
    homeDir,
    configPath: join(homeDir, 'config.toml'),
  };
}

// --- Adapter tests ----------------------------------------------------------

describe('toProtocolTool adapter', () => {
  it("maps builtin source as-is and emits input_schema = null", () => {
    const out = toProtocolTool({ name: 'Bash', description: 'd', source: 'builtin' });
    expect(out.source).toBe('builtin');
    expect(out.input_schema).toBeNull();
    expect(out.mcp_server_id).toBeUndefined();
  });

  it("maps agent-core 'user' source to wire 'skill'", () => {
    const out = toProtocolTool({ name: 'mySkill', description: 'd', source: 'user' });
    expect(out.source).toBe('skill');
  });

  it("parses mcp_server_id from qualified mcp tool name 'mcp:lark:search'", () => {
    const out = toProtocolTool({
      name: 'mcp:lark:search',
      description: 'd',
      source: 'mcp',
    });
    expect(out.source).toBe('mcp');
    expect(out.mcp_server_id).toBe('lark');
  });

  it('omits mcp_server_id when the mcp tool name lacks the conventional prefix', () => {
    const out = toProtocolTool({
      name: 'oddly_named',
      description: 'd',
      source: 'mcp',
    });
    expect(out.mcp_server_id).toBeUndefined();
  });
});

describe('toProtocolMcpServer adapter', () => {
  function base(
    overrides: Partial<McpServerInfo> & Pick<McpServerInfo, 'status'>,
  ): McpServerInfo {
    return {
      name: 'lark',
      transport: 'stdio',
      toolCount: 3,
      ...overrides,
    } as McpServerInfo;
  }

  it("maps 'pending' → 'connecting'", () => {
    expect(toProtocolMcpServer(base({ status: 'pending' })).status).toBe('connecting');
  });
  it("passes 'connected' through", () => {
    expect(toProtocolMcpServer(base({ status: 'connected' })).status).toBe('connected');
  });
  it("maps 'failed' → 'error'", () => {
    expect(toProtocolMcpServer(base({ status: 'failed' })).status).toBe('error');
  });
  it("maps 'disabled' → 'disconnected'", () => {
    expect(toProtocolMcpServer(base({ status: 'disabled' })).status).toBe('disconnected');
  });
  it("maps 'needs-auth' → 'error' and surfaces last_error from error?", () => {
    const out = toProtocolMcpServer(
      base({ status: 'needs-auth', error: 'visit https://auth' }),
    );
    expect(out.status).toBe('error');
    expect(out.last_error).toBe('visit https://auth');
  });
  it('adopts name-as-id', () => {
    expect(toProtocolMcpServer(base({ status: 'connected', name: 'foo' })).id).toBe('foo');
  });
  it("does not set last_error when info.error is undefined or empty", () => {
    expect(toProtocolMcpServer(base({ status: 'connected' })).last_error).toBeUndefined();
    expect(
      toProtocolMcpServer(base({ status: 'connected', error: '' })).last_error,
    ).toBeUndefined();
  });
});

// --- Service impl tests -----------------------------------------------------

describe('ToolService.list', () => {
  it('returns [] when no sessions exist (CoreAPI gap)', async () => {
    const svc = new ToolService(makeFakeBridge(freshState()));
    const out = await svc.list();
    expect(out).toEqual([]);
  });

  it('returns adapted tools using the most-recent session id', async () => {
    const state = freshState();
    state.sessions.push(fakeSession('s_old', 1));
    state.sessions.push(fakeSession('s_new', 2));
    state.tools.push(
      { name: 'Bash', description: 'b', source: 'builtin' },
      { name: 'mcp:lark:search', description: 'l', source: 'mcp' },
    );
    const svc = new ToolService(makeFakeBridge(state));
    const out = await svc.list();
    expect(out).toHaveLength(2);
    expect(out[0]!.source).toBe('builtin');
    expect(out[1]!.source).toBe('mcp');
    expect(out[1]!.mcp_server_id).toBe('lark');
  });

  it('returns [] when getTools throws (session not loaded)', async () => {
    const state = freshState();
    state.sessions.push(fakeSession('s', 1));
    const bridge = makeFakeBridge(state);
    (bridge.rpc as CoreRPC).getTools = async () => {
      throw new Error('session not loaded');
    };
    const svc = new ToolService(bridge);
    expect(await svc.list()).toEqual([]);
  });
});

describe('McpService.list', () => {
  it('returns [] when no sessions exist (registrar not reachable)', async () => {
    const svc = new McpService(makeFakeBridge(freshState()), testEnvironment);
    expect(await svc.list()).toEqual([]);
  });

  it('returns adapted servers from the most-recent session', async () => {
    const state = freshState();
    state.sessions.push(fakeSession('s', 1));
    state.mcpServers.push({
      name: 'lark',
      transport: 'stdio',
      status: 'connected',
      toolCount: 7,
    });
    const svc = new McpService(makeFakeBridge(state), testEnvironment);
    const out = await svc.list();
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('lark');
    expect(out[0]!.tool_count).toBe(7);
  });

  it('skips unloaded historical sessions and uses the newest loaded session', async () => {
    const state = freshState();
    state.sessions.push(fakeSession('loaded', 1), fakeSession('unloaded', 2));
    state.mcpServers.push({
      name: 'filesystem',
      transport: 'stdio',
      status: 'connected',
      toolCount: 2,
    });
    const bridge = makeFakeBridge(state);
    const list = bridge.rpc.listMcpServers;
    bridge.rpc.listMcpServers = async (payload) => {
      if (payload.sessionId === 'unloaded') {
        throw new KimiError(ErrorCodes.SESSION_NOT_FOUND, 'session not loaded');
      }
      return list(payload);
    };

    await expect(new McpService(bridge, testEnvironment).list()).resolves.toEqual([
      expect.objectContaining({ id: 'filesystem', status: 'connected' }),
    ]);
  });
});

describe('McpService.restart', () => {
  it('throws McpServerNotFoundError when no sessions exist', async () => {
    const svc = new McpService(makeFakeBridge(freshState()), testEnvironment);
    await expect(svc.restart('lark')).rejects.toBeInstanceOf(McpServerNotFoundError);
  });

  it('throws McpServerNotFoundError when the id is not in the registrar', async () => {
    const state = freshState();
    state.sessions.push(fakeSession('s', 1));
    state.mcpServers.push({
      name: 'lark',
      transport: 'stdio',
      status: 'connected',
      toolCount: 1,
    });
    const svc = new McpService(makeFakeBridge(state), testEnvironment);
    await expect(svc.restart('unknown')).rejects.toBeInstanceOf(McpServerNotFoundError);
  });

  it('calls bridge.rpc.reconnectMcpServer({name}) and returns {restarting:true}', async () => {
    const state = freshState();
    state.sessions.push(fakeSession('s', 1));
    state.mcpServers.push({
      name: 'lark',
      transport: 'stdio',
      status: 'connected',
      toolCount: 1,
    });
    const svc = new McpService(makeFakeBridge(state), testEnvironment);
    const result = await svc.restart('lark');
    expect(result).toEqual({ restarting: true });
    expect(state.reconnectCalls).toHaveLength(1);
    expect(state.reconnectCalls[0]!.name).toBe('lark');
  });
});

describe('McpService global configuration', () => {
  it('reads legacy inferred transports from the global mcp.json', async () => {
    const environment = await temporaryEnvironment();
    await writeFile(join(environment.homeDir, 'mcp.json'), JSON.stringify({
      mcpServers: {
        local: { command: 'node', args: ['server.mjs'] },
        remote: { url: 'https://example.test/mcp' },
      },
    }));

    const config = await new McpService(makeFakeBridge(freshState()), environment).getConfig();

    expect(config.path).toBe(join(environment.homeDir, 'mcp.json'));
    expect(config.mcp_servers.local?.transport).toBe('stdio');
    expect(config.mcp_servers.remote?.transport).toBe('http');
  });

  it('merges updates, deletes null entries, and preserves unrelated JSON fields', async () => {
    const environment = await temporaryEnvironment();
    const configPath = join(environment.homeDir, 'mcp.json');
    await writeFile(configPath, JSON.stringify({
      metadata: { owner: 'user' },
      mcpServers: {
        keep: { command: 'node', args: ['keep.mjs'] },
        remove: { command: 'node', args: ['remove.mjs'] },
      },
    }));
    const service = new McpService(makeFakeBridge(freshState()), environment);

    const updated = await service.setConfig({
      mcp_servers: {
        remove: null,
        docs: {
          transport: 'http',
          url: 'https://example.test/mcp',
          enabledTools: ['search'],
        },
      },
    });

    expect(updated.mcp_servers.remove).toBeUndefined();
    expect(updated.mcp_servers.docs).toMatchObject({ transport: 'http', enabledTools: ['search'] });
    const persisted = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    expect(persisted['metadata']).toEqual({ owner: 'user' });
    expect(persisted['mcpServers']).toMatchObject({
      keep: { command: 'node', args: ['keep.mjs'] },
      docs: { transport: 'http', url: 'https://example.test/mcp' },
    });
  });
});
