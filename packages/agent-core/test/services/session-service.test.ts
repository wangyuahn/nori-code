import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type AgentContextData,
  type AgentRuntimeState,
  type CoreRPC,
  type ContextMessage,
  type CreateSessionPayload,
  Emitter,
  type ForkSessionPayload,
  IInstantiationService,
  type RenameSessionPayload,
  type ResumeSessionResult,
  type SessionMeta,
  type SessionSummary,
  type UpdateSessionMetadataPayload,
} from '../../src';
import { TestInstantiationService } from '../../src/di/test';
import {
  emptySessionUsage,
  type Event,
  type Session,
  type UsageStatus,
} from '@nori-code/protocol';

import {
  IApprovalService,
  type IAuthSummaryService,
  type ICoreProcessService,
  type IEventService,
  IPromptService,
  IQuestionService,
  type ISessionService,
  PromptService,
  SessionNotFoundError,
  SessionUndoUnavailableError,
  SessionService,
  toProtocolSession,
} from '../../src/services';

type WithSessionId<T> = T & { readonly sessionId: string };

interface FakeBridgeState {
  sessions: SessionSummary[];
  createPayloads: CreateSessionPayload[];
  metas: Map<string, SessionMeta>;
  archivedIds: string[];
  deletedIds: string[];
  closedIds: string[];
  renamedTitles: Map<string, string>;
  metadataPatches: Map<string, UpdateSessionMetadataPayload['metadata']>;
  forkPayloads: Array<WithSessionId<Omit<ForkSessionPayload, 'sessionId'>>>;
  compactions: Array<{ sessionId: string; agentId: string; instruction?: string }>;
  undoPayloads: Array<{ sessionId: string; agentId: string; count: number }>;
  resumedIds: string[];
  contexts: Map<string, AgentContextData>;
  postUndoContexts: Map<string, AgentContextData>;
  usages: Map<string, UsageStatus>;
  /** Live per-agent runtime phase, keyed `sessionId:agentId`. Absent = idle. */
  runtimePhases: Map<string, AgentRuntimeState>;
  injectedReminders: Array<{ sessionId: string; agentId: string; content: string; variant?: string }>;
}

function makeFakeBridge(state: FakeBridgeState): ICoreProcessService {
  const rpc: Partial<CoreRPC> = {
    createSession: vi
      .fn()
      .mockImplementation(async (payload: CreateSessionPayload): Promise<SessionSummary> => {
        state.createPayloads.push(payload);
        const id = payload.id ?? `sess_${state.sessions.length + 1}`;
        const created: SessionSummary = {
          id,
          workDir: payload.workDir,
          sessionDir: `/tmp/sessions/${id}`,
          createdAt: 1_000_000 + state.sessions.length * 1_000,
          updatedAt: 1_000_000 + state.sessions.length * 1_000,
          metadata: payload.metadata,
          title: undefined,
        };
        state.sessions.push(created);
        state.metas.set(id, {
          title: '',
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          isCustomTitle: false,
          agents: {},
          custom: { ...(payload.metadata ?? {}) },
        });
        return created;
      }),
    listSessions: vi
      .fn()
      .mockImplementation(
        async (
          input?: { workDir?: string },
        ): Promise<readonly SessionSummary[]> => {
          if (input?.workDir !== undefined) {
            return state.sessions.filter((s) => s.workDir === input.workDir);
          }
          return state.sessions;
        },
      ),
    forkSession: vi
      .fn()
      .mockImplementation(async (payload: ForkSessionPayload): Promise<ResumeSessionResult> => {
        const source = state.sessions.find((s) => s.id === payload.sessionId);
        if (source === undefined) {
          throw new Error(`missing source ${payload.sessionId}`);
        }
        state.forkPayloads.push({
          sessionId: payload.sessionId,
          id: payload.id,
          title: payload.title,
          metadata: payload.metadata,
        });
        const id = payload.id ?? `sess_fork_${state.sessions.length + 1}`;
        const created: SessionSummary = {
          id,
          workDir: source.workDir,
          sessionDir: `/tmp/sessions/${id}`,
          createdAt: 2_000_000 + state.sessions.length * 1_000,
          updatedAt: 2_000_000 + state.sessions.length * 1_000,
          metadata: {
            ...source.metadata,
            ...payload.metadata,
          },
          title: payload.title,
        };
        state.sessions.push(created);
        const sourceMeta = state.metas.get(source.id);
        const sessionMetadata: SessionMeta = {
          title: payload.title ?? `Fork: ${source.title ?? source.id}`,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          isCustomTitle: payload.title !== undefined,
          agents: {},
          custom: {
            ...sourceMeta?.custom,
            ...payload.metadata,
          },
          forkedFrom: source.id,
        };
        state.metas.set(id, sessionMetadata);
        return {
          ...created,
          sessionMetadata,
          agents: {},
        };
      }),
    archiveSession: vi.fn().mockImplementation(async ({ sessionId }: { sessionId: string }) => {
      state.archivedIds.push(sessionId);
    }),
    deleteSession: vi.fn().mockImplementation(async ({ sessionId }: { sessionId: string }) => {
      state.deletedIds.push(sessionId);
      state.sessions = state.sessions.filter(session => session.id !== sessionId);
    }),
    renameSession: vi
      .fn()
      .mockImplementation(async (payload: WithSessionId<RenameSessionPayload>) => {
        state.renamedTitles.set(payload.sessionId, payload.title);
        const existing = state.metas.get(payload.sessionId);
        if (existing !== undefined) {
          state.metas.set(payload.sessionId, { ...existing, title: payload.title });
        } else {
          state.metas.set(payload.sessionId, {
            title: payload.title,
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
            isCustomTitle: true,
            agents: {},
            custom: {},
          });
        }
      }),
    updateSessionMetadata: vi
      .fn()
      .mockImplementation(
        async (payload: WithSessionId<UpdateSessionMetadataPayload>) => {
          state.metadataPatches.set(payload.sessionId, payload.metadata);
          const custom = payload.metadata.custom;
          if (custom !== undefined && typeof custom === 'object' && custom !== null) {
            const index = state.sessions.findIndex((s) => s.id === payload.sessionId);
            if (index >= 0) {
              const summary = state.sessions[index]!;
              state.sessions[index] = {
                ...summary,
                metadata: { ...custom } as SessionSummary['metadata'],
              };
            }
            const existing = state.metas.get(payload.sessionId);
            if (existing !== undefined) {
              state.metas.set(payload.sessionId, {
                ...existing,
                custom: { ...custom } as SessionMeta['custom'],
              });
            } else {
              state.metas.set(payload.sessionId, {
                title: '',
                createdAt: new Date(0).toISOString(),
                updatedAt: new Date(0).toISOString(),
                isCustomTitle: false,
                agents: {},
                custom: { ...custom } as SessionMeta['custom'],
              });
            }
          }
        },
      ),
    getSessionMetadata: vi
      .fn()
      .mockImplementation(async ({ sessionId }: { sessionId: string }): Promise<SessionMeta> => {
        const found = state.metas.get(sessionId);
        if (found === undefined) {
          throw new Error(`no metadata for ${sessionId}`);
        }
        return found;
      }),
    beginCompaction: vi
      .fn()
      .mockImplementation(async (payload: { sessionId: string; agentId: string; instruction?: string }) => {
        state.compactions.push(payload);
      }),
    resumeSession: vi.fn().mockImplementation(async ({ sessionId }: { sessionId: string }) => {
      state.resumedIds.push(sessionId);
      const found = state.sessions.find((session) => session.id === sessionId);
      if (found === undefined) throw new Error(`missing session ${sessionId}`);
      return found as ResumeSessionResult;
    }),
    undoHistory: vi
      .fn()
      .mockImplementation(async (payload: { sessionId: string; agentId: string; count: number }) => {
        state.undoPayloads.push(payload);
        const next = state.postUndoContexts.get(payload.sessionId);
        if (next !== undefined) {
          state.contexts.set(payload.sessionId, next);
        }
      }),
    getContext: vi
      .fn()
      .mockImplementation(async ({ sessionId }: { sessionId: string }): Promise<AgentContextData> => {
        return state.contexts.get(sessionId) ?? { history: [], tokenCount: 0 };
      }),
    getConfig: vi.fn().mockResolvedValue({
      modelAlias: 'kimi-k2',
      thinkingEffort: 'auto',
      modelCapabilities: { max_context_tokens: 100 },
    }),
    getRuntimeState: vi
      .fn()
      .mockImplementation(
        async ({ sessionId, agentId }: { sessionId: string; agentId: string }): Promise<AgentRuntimeState> => {
          return state.runtimePhases.get(`${sessionId}:${agentId}`) ?? { phase: 'idle' };
        },
      ),
    getPermission: vi.fn().mockResolvedValue({ mode: 'manual' }),
    getDiscussMode: vi.fn().mockResolvedValue(false),
    getUsage: vi
      .fn()
      .mockImplementation(async ({ sessionId }: { sessionId: string }) => {
        return state.usages.get(sessionId) ?? {};
      }),
    getNoriRuntimeSettings: vi.fn().mockResolvedValue({
      coderWriteEnabled: true,
      toolsReadonly: false,
    }),
    getGoal: vi.fn().mockResolvedValue({ goal: null }),
    injectSystemReminder: vi.fn().mockImplementation(
      async (payload: {
        sessionId: string;
        agentId: string;
        content: string;
        variant?: string;
      }) => {
        state.injectedReminders.push(payload);
        const ctx = state.contexts.get(payload.sessionId) ?? { history: [], tokenCount: 0 };
        state.contexts.set(payload.sessionId, {
          ...ctx,
          history: [
            ...ctx.history,
            {
              role: 'user',
              content: [{ type: 'text', text: `<system-reminder>\n${payload.content}\n</system-reminder>` }],
              toolCalls: [],
              origin: { kind: 'injection', variant: payload.variant ?? 'mount_changed' },
            },
          ],
        });
      },
    ),
    detachMountedTeamMember: vi.fn().mockImplementation(
      async (payload: { sessionId: string; mountedSessionId: string }) => {
        const meta = state.metas.get(payload.sessionId);
        if (meta === undefined) {
          return { detachedAgentIds: [] };
        }
        const detachedAgentIds: string[] = [];
        const nextAgents = { ...meta.agents };
        for (const [agentId, agent] of Object.entries(meta.agents)) {
          if (agent.kind === 'team' && agent.mountedSessionId === payload.mountedSessionId) {
            delete nextAgents[agentId];
            detachedAgentIds.push(agentId);
          }
        }
        if (detachedAgentIds.length > 0) {
          state.metas.set(payload.sessionId, { ...meta, agents: nextAgents });
        }
        return { detachedAgentIds };
      },
    ),
    attachMountedTeamMember: vi.fn().mockImplementation(
      async (payload: {
        sessionId: string;
        mountedSessionId: string;
        identity: { name: string; role: string; mandate: string };
        teamLeaderAgentId?: string;
      }) => {
        const meta = state.metas.get(payload.sessionId) ?? {
          title: '',
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          isCustomTitle: false,
          agents: {},
          custom: {},
        };
        const leaderAgentId = payload.teamLeaderAgentId ?? 'main';
        const agents = { ...meta.agents };
        if (agents['main'] === undefined) {
          agents['main'] = {
            homedir: '/tmp/main',
            type: 'main',
            parentAgentId: null,
          };
        }
        const existingId = Object.entries(agents).find(
          ([, agent]) => agent.kind === 'team' && agent.mountedSessionId === payload.mountedSessionId,
        )?.[0];
        const agentId = existingId ?? `agent_mount_${Object.keys(agents).length}`;
        agents[agentId] = {
          homedir: `/tmp/${agentId}`,
          type: 'sub',
          parentAgentId: leaderAgentId,
          kind: 'team',
          teamLeaderAgentId: leaderAgentId,
          name: payload.identity.name,
          role: payload.identity.role,
          mandate: payload.identity.mandate,
          mountedSessionId: payload.mountedSessionId,
        };
        state.metas.set(payload.sessionId, { ...meta, agents });
        return { agentId };
      },
    ),
  };
  return {
    rpc: rpc as CoreRPC,
    ready: async () => undefined,
    dispose: () => undefined,
    _serviceBrand: undefined,
  };
}

function freshState(): FakeBridgeState {
  return {
    sessions: [],
    createPayloads: [],
    metas: new Map(),
    archivedIds: [],
    deletedIds: [],
    closedIds: [],
    renamedTitles: new Map(),
    metadataPatches: new Map(),
    forkPayloads: [],
    compactions: [],
    undoPayloads: [],
    resumedIds: [],
    contexts: new Map(),
    postUndoContexts: new Map(),
    usages: new Map(),
    runtimePhases: new Map(),
    injectedReminders: [],
  };
}

function textMessage(
  role: ContextMessage['role'],
  text: string,
  origin?: ContextMessage['origin'],
): ContextMessage {
  return {
    role,
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin,
  };
}

let state: FakeBridgeState;
let bridge: ICoreProcessService;
let svc: SessionService;
let promptStub: ReturnType<typeof makePromptServiceStub>;
let approvalStub: ReturnType<typeof makeApprovalServiceStub>;
let questionStub: ReturnType<typeof makeQuestionServiceStub>;
let eventBus: ReturnType<typeof makeEventServiceStub>;
let instantiation: TestInstantiationService;

function makeEventServiceStub(): {
  eventService: IEventService;
  events: unknown[];
} {
  const events: unknown[] = [];
  const emitter = new Emitter<never>();
  return {
    events,
    eventService: {
      _serviceBrand: undefined,
      publish: vi.fn((event: unknown) => {
        events.push(event);
        emitter.fire(event as never);
      }) as IEventService['publish'],
      onDidPublish: emitter.event as unknown as IEventService['onDidPublish'],
    },
  };
}

function makePromptServiceStub(): {
  promptService: IPromptService;
  calls: Array<{ sid: string; patch: Record<string, unknown>; source: string; promptId: string | undefined; agentId: string | undefined }>;
  activePromptIds: Map<string, string | undefined>;
} {
  const calls: Array<{
    sid: string;
    patch: Record<string, unknown>;
    source: string;
    promptId: string | undefined;
    agentId: string | undefined;
  }> = [];
  const activePromptIds = new Map<string, string | undefined>();
  const agentStates = new Map<string, import('../../src/services/prompt/prompt').AgentStateSnapshot>();
  const applyAgentState = vi
    .fn()
    .mockImplementation(async (sid: string, patch: Record<string, unknown>, source: string, promptId?: string, agentId?: string) => {
      calls.push({ sid, patch, source, promptId, agentId });
      const current = agentStates.get(sid) ?? {};
      agentStates.set(sid, {
        ...current,
        ...(typeof patch['model'] === 'string' ? { model: patch['model'] } : {}),
        ...(typeof patch['thinking'] === 'string' ? { thinking: patch['thinking'] } : {}),
        ...(typeof patch['permission_mode'] === 'string' ? { permissionMode: patch['permission_mode'] } : {}),
        ...(typeof patch['discuss_mode'] === 'boolean' ? { discussMode: patch['discuss_mode'] } : {}),
      });
    });
  const emitter = new Emitter<never>();
  const promptService: IPromptService = {
    _serviceBrand: undefined,
    list: vi.fn() as unknown as IPromptService['list'],
    submit: vi.fn() as unknown as IPromptService['submit'],
    startBtw: vi.fn().mockResolvedValue('btw_test') as unknown as IPromptService['startBtw'],
    steer: vi.fn() as unknown as IPromptService['steer'],
    abort: vi.fn() as unknown as IPromptService['abort'],
    abortBySession: vi.fn() as unknown as IPromptService['abortBySession'],
    getCurrentPromptId: vi.fn().mockImplementation((sid: string) => activePromptIds.get(sid)) as unknown as IPromptService['getCurrentPromptId'],
    applyAgentState,
    onDidComplete: emitter.event as unknown as IPromptService['onDidComplete'],
    onDidAbort: emitter.event as unknown as IPromptService['onDidAbort'],
    getAgentStateSnapshot: vi.fn().mockImplementation((sid: string) => agentStates.get(sid)) as unknown as IPromptService['getAgentStateSnapshot'],
  };
  return { promptService, calls, activePromptIds };
}

function makeApprovalServiceStub(): {
  approvalService: IApprovalService;
  pending: Map<string, unknown[]>;
} {
  const pending = new Map<string, unknown[]>();
  const approvalService: IApprovalService = {
    _serviceBrand: undefined,
    request: vi.fn() as unknown as IApprovalService['request'],
    resolve: vi.fn() as unknown as IApprovalService['resolve'],
    listPending: vi.fn().mockImplementation((sessionId: string) => {
      return (pending.get(sessionId) ?? []) as unknown as ReturnType<IApprovalService['listPending']>;
    }),
  } as unknown as IApprovalService;
  return { approvalService, pending };
}

function makeQuestionServiceStub(): {
  questionService: IQuestionService;
  pending: Map<string, unknown[]>;
} {
  const pending = new Map<string, unknown[]>();
  const questionService: IQuestionService = {
    _serviceBrand: undefined,
    request: vi.fn() as unknown as IQuestionService['request'],
    resolve: vi.fn() as unknown as IQuestionService['resolve'],
    dismiss: vi.fn() as unknown as IQuestionService['dismiss'],
    listPending: vi.fn().mockImplementation((sessionId: string) => {
      return (pending.get(sessionId) ?? []) as unknown as ReturnType<IQuestionService['listPending']>;
    }),
  } as unknown as IQuestionService;
  return { questionService, pending };
}

function makeTestInstantiation(stubs: {
  promptService: IPromptService;
  approvalService: IApprovalService;
  questionService: IQuestionService;
}): TestInstantiationService {
  const ix = new TestInstantiationService(undefined, true);
  ix.stub(IInstantiationService, ix);
  ix.stub(IPromptService, stubs.promptService);
  ix.stub(IApprovalService, stubs.approvalService);
  ix.stub(IQuestionService, stubs.questionService);
  return ix;
}

beforeEach(() => {
  state = freshState();
  promptStub = makePromptServiceStub();
  approvalStub = makeApprovalServiceStub();
  questionStub = makeQuestionServiceStub();
  eventBus = makeEventServiceStub();
  instantiation = makeTestInstantiation({
    promptService: promptStub.promptService,
    approvalService: approvalStub.approvalService,
    questionService: questionStub.questionService,
  });
  bridge = makeFakeBridge(state);
  svc = new SessionService(
    bridge,
    eventBus.eventService,
    instantiation,
    approvalStub.approvalService,
    questionStub.questionService,
  );
});

afterEach(() => {
  svc.dispose();
  instantiation.dispose();
});

describe('toProtocolSession adapter', () => {
  it('converts camelCase + number timestamps to snake_case + ISO Z', () => {
    const summary: SessionSummary = {
      id: 'sess_01',
      title: 'Hello',
      workDir: '/tmp/wd',
      sessionDir: '/tmp/sd',
      createdAt: 1_000_000_000_000,
      updatedAt: 1_000_000_001_000,
    };
    const proto = toProtocolSession(summary);
    expect(proto.id).toBe('sess_01');
    expect(proto.title).toBe('Hello');
    expect(proto.metadata.cwd).toBe('/tmp/wd');
    expect(proto.created_at).toBe(new Date(1_000_000_000_000).toISOString());
    expect(proto.updated_at).toBe(new Date(1_000_000_001_000).toISOString());
    expect(proto.created_at.endsWith('Z')).toBe(true);
  });

  it('surfaces last_prompt from the summary when present', () => {
    const withPrompt: SessionSummary = {
      id: 'sess_lp_1',
      workDir: '/tmp/wd',
      sessionDir: '/tmp/sd',
      createdAt: 0,
      updatedAt: 0,
      lastPrompt: 'what is 2 + 2?',
    };
    expect(toProtocolSession(withPrompt).last_prompt).toBe('what is 2 + 2?');

    const withoutPrompt: SessionSummary = {
      id: 'sess_lp_2',
      workDir: '/tmp/wd',
      sessionDir: '/tmp/sd',
      createdAt: 0,
      updatedAt: 0,
    };
    expect(toProtocolSession(withoutPrompt).last_prompt).toBeUndefined();
  });

  it('fills documented defaults when CoreAPI does not surface a field', () => {
    const summary: SessionSummary = {
      id: 'sess_02',
      workDir: '/tmp/wd2',
      sessionDir: '/tmp/sd2',
      createdAt: 0,
      updatedAt: 0,
    };
    const proto = toProtocolSession(summary);
    expect(proto.status).toBe('idle');
    expect(proto.usage).toEqual(emptySessionUsage());
    expect(proto.permission_rules).toEqual([]);
    expect(proto.message_count).toBe(0);
    expect(proto.last_seq).toBe(0);
    expect(proto.agent_config.model).toBe('');
    expect(proto.title).toBe('');
  });

  it('maps persisted usage, prompt count, and model from the summary', () => {
    const summary: SessionSummary = {
      id: 'sess_persisted_usage',
      workDir: '/tmp/wd-usage',
      sessionDir: '/tmp/sd-usage',
      createdAt: 0,
      updatedAt: 0,
      model: 'kimi-k2.5',
      messageCount: 3,
      usage: {
        byModel: {
          'kimi-k2.5': {
            inputOther: 11,
            output: 22,
            inputCacheRead: 33,
            inputCacheCreation: 44,
          },
        },
        total: {
          inputOther: 11,
          output: 22,
          inputCacheRead: 33,
          inputCacheCreation: 44,
        },
      },
    };

    expect(toProtocolSession(summary)).toMatchObject({
      agent_config: { model: 'kimi-k2.5' },
      message_count: 3,
      usage: {
        input_tokens: 11,
        output_tokens: 22,
        cache_read_tokens: 33,
        cache_creation_tokens: 44,
        turn_count: 3,
      },
    });
  });

  it('enriches title + cwd from SessionMeta when available', () => {
    const summary: SessionSummary = {
      id: 'sess_03',
      workDir: '/tmp/orig',
      sessionDir: '/tmp/sd3',
      createdAt: 0,
      updatedAt: 0,
    };
    const meta: SessionMeta = {
      title: 'Renamed via meta',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      isCustomTitle: true,
      agents: {},
      custom: { cwd: '/tmp/cwd-from-meta', other_key: 'x' },
    };
    const proto = toProtocolSession(summary, meta);
    expect(proto.title).toBe('Renamed via meta');
    expect(proto.metadata.cwd).toBe('/tmp/cwd-from-meta');
    expect(proto.metadata['other_key']).toBe('x');
  });

  it('does not expose a hidden title instruction from persisted metadata', () => {
    const summary: SessionSummary = {
      id: 'sess_hidden_title',
      workDir: '/tmp/wd',
      sessionDir: '/tmp/sd',
      createdAt: 0,
      updatedAt: 0,
    };
    const meta: SessionMeta = {
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      title: '<system-reminder>Generate a title.</system-reminder>',
      isCustomTitle: false,
      agents: {},
      custom: {},
    };

    expect(toProtocolSession(summary, meta).title).toBe('');
  });

  it('preserves custom metadata from the summary when SessionMeta is unavailable', () => {
    const summary: SessionSummary = {
      id: 'sess_summary_meta',
      workDir: '/tmp/orig',
      sessionDir: '/tmp/sd-summary-meta',
      createdAt: 0,
      updatedAt: 0,
      metadata: {
        cwd: '/tmp/from-summary',
        parent_session_id: 'sess_parent',
        child_session_kind: 'child',
        topic: 'btw',
      },
    };
    const proto = toProtocolSession(summary);
    expect(proto.metadata).toMatchObject({
      cwd: '/tmp/from-summary',
      parent_session_id: 'sess_parent',
      child_session_kind: 'child',
      topic: 'btw',
    });
  });

  it('strips the internal "goal" metadata key', () => {
    const summary: SessionSummary = {
      id: 'sess_04',
      workDir: '/tmp/wd',
      sessionDir: '/tmp/sd',
      createdAt: 0,
      updatedAt: 0,
    };
    const meta: SessionMeta = {
      title: 't',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      isCustomTitle: false,
      agents: {},
      custom: { goal: { secret: 'state' }, keep: 'me' },
    };
    const proto = toProtocolSession(summary, meta);
    expect(proto.metadata['goal']).toBeUndefined();
    expect(proto.metadata['keep']).toBe('me');
  });

  it('derives workspace_id from summary.workDir via encodeWorkDirKey', async () => {
    const { encodeWorkDirKey } = await import('../../src/session/store');
    const summary: SessionSummary = {
      id: 'sess_ws',
      workDir: '/tmp/wd-ws',
      sessionDir: '/tmp/sd-ws',
      createdAt: 0,
      updatedAt: 0,
    };
    const proto = toProtocolSession(summary);
    expect(proto.workspace_id).toBe(encodeWorkDirKey('/tmp/wd-ws'));
    expect(proto.workspace_id).toMatch(/^wd_[A-Za-z0-9._-]+_[0-9a-f]{12}$/);
  });
});

describe('SessionService.create', () => {
  it('calls bridge.rpc.createSession with workDir = metadata.cwd and returns a protocol Session', async () => {
    const session = await svc.create({
      metadata: { cwd: '/tmp/foo' },
      title: 'My session',
    });
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]!.workDir).toBe('/tmp/foo');
    expect(session.metadata.cwd).toBe('/tmp/foo');
    expect(session.title).toBe('My session');
    expect(session.created_at.endsWith('Z')).toBe(true);
  });

  it('passes model through to the agent_config when supplied', async () => {
    await svc.create({
      metadata: { cwd: '/tmp/x' },
      agent_config: { model: 'moonshot-v1-128k' },
    });
    expect(state.sessions[0]!.metadata?.['cwd']).toBe('/tmp/x');
  });

  it('passes client telemetry metadata through to core createSession', async () => {
    await svc.create(
      { metadata: { cwd: '/tmp/web' } },
      {
        client: {
          id: 'web_test_client',
          name: 'kimi-code-web',
          version: '0.1.1',
          uiMode: 'web',
        },
      },
    );

    expect(state.createPayloads[0]!.client).toEqual({
      id: 'web_test_client',
      name: 'kimi-code-web',
      version: '0.1.1',
      uiMode: 'web',
    });
  });

  it('rejects when metadata.cwd is absent (daemon route must pre-resolve workspace_id → cwd)', async () => {
    await expect(svc.create({} as unknown as Parameters<typeof svc.create>[0])).rejects.toThrow(
      /metadata\.cwd is required/,
    );
  });
});

describe('SessionService.list', () => {
  beforeEach(async () => {
    await svc.create({ metadata: { cwd: '/tmp/a' } });
    await svc.create({ metadata: { cwd: '/tmp/b' } });
    await svc.create({ metadata: { cwd: '/tmp/c' } });
  });

  it('returns descending-by-updatedAt order with default page size', async () => {
    const page = await svc.list({});
    expect(page.items).toHaveLength(3);
    expect(page.items[0]!.metadata.cwd).toBe('/tmp/c');
    expect(page.items[2]!.metadata.cwd).toBe('/tmp/a');
    expect(page.has_more).toBe(false);
  });

  it('honors page_size and surfaces has_more', async () => {
    const page = await svc.list({ page_size: 2 });
    expect(page.items.map((s) => s.metadata.cwd)).toEqual(['/tmp/c', '/tmp/b']);
    expect(page.has_more).toBe(true);
  });

  it('before_id returns less-recent sessions only', async () => {
    const all = await svc.list({});
    const pivotId = all.items[0]!.id;
    const olderPage = await svc.list({ before_id: pivotId });
    expect(olderPage.items.map((s) => s.metadata.cwd)).toEqual(['/tmp/b', '/tmp/a']);
  });

  it('after_id returns more-recent sessions only', async () => {
    const all = await svc.list({});
    const pivotId = all.items[2]!.id;
    const newerPage = await svc.list({ after_id: pivotId });
    expect(newerPage.items.map((s) => s.metadata.cwd)).toEqual(['/tmp/c', '/tmp/b']);
  });

  it('status filter applies post-hydration', async () => {
    const empty = await svc.list({ status: 'running' });
    expect(empty.items).toEqual([]);
    const idle = await svc.list({ status: 'idle' });
    expect(idle.items.length).toBe(3);
  });

  it('forwards workDir to the underlying core.rpc.listSessions for the workspace fast path', async () => {
    const page = await svc.list({ workDir: '/tmp/b' });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.metadata.cwd).toBe('/tmp/b');
    const calls = (state as unknown as { sessions: SessionSummary[] }).sessions;
    void calls;
  });

  it('returns an empty page when workDir matches no sessions', async () => {
    const page = await svc.list({ workDir: '/tmp/nonexistent' });
    expect(page.items).toEqual([]);
    expect(page.has_more).toBe(false);
  });

  it('keeps persisted usage for cold sessions and lets live usage override it', async () => {
    const original = state.sessions.find((session) => session.workDir === '/tmp/b')!;
    state.sessions = state.sessions.map((session) =>
      session.id === original.id
        ? {
            ...session,
            model: 'persisted-model',
            messageCount: 4,
            usage: {
              total: {
                inputOther: 10,
                output: 20,
                inputCacheRead: 30,
                inputCacheCreation: 40,
              },
            },
          }
        : session
    );

    const cold = (await svc.list({ workDir: '/tmp/b' })).items[0]!;
    expect(cold).toMatchObject({
      agent_config: { model: 'persisted-model' },
      message_count: 4,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_tokens: 30,
        cache_creation_tokens: 40,
      },
    });

    state.usages.set(original.id, {
      total: {
        inputOther: 100,
        output: 200,
        inputCacheRead: 300,
        inputCacheCreation: 400,
      },
    });
    const loaded = (await svc.list({ workDir: '/tmp/b' })).items[0]!;
    expect(loaded).toMatchObject({
      message_count: 4,
      usage: {
        input_tokens: 100,
        output_tokens: 200,
        cache_read_tokens: 300,
        cache_creation_tokens: 400,
      },
    });
  });

  it('excludeEmpty drops sessions without a lastPrompt before pagination', async () => {
    const ts = (n: number) => 1_000_000 + n * 1_000;
    const summary = (
      id: string,
      updatedAt: number,
      lastPrompt?: string,
    ): SessionSummary => ({
      id,
      workDir: '/tmp/a',
      sessionDir: `/tmp/sessions/${id}`,
      createdAt: updatedAt,
      updatedAt,
      metadata: { cwd: '/tmp/a' },
      title: undefined,
      lastPrompt,
    });
    state.sessions = [
      summary('e1', ts(3)),
      summary('u1', ts(2), 'hi'),
      summary('e2', ts(1)),
      summary('u2', ts(0), 'yo'),
    ];

    const all = await svc.list({});
    expect(all.items.map((s) => s.id)).toEqual(['e1', 'u1', 'e2', 'u2']);

    const visible = await svc.list({ excludeEmpty: true });
    expect(visible.items.map((s) => s.id)).toEqual(['u1', 'u2']);
    expect(visible.has_more).toBe(false);

    // Pagination + cursor operate on the filtered set.
    const first = await svc.list({ excludeEmpty: true, page_size: 1 });
    expect(first.items.map((s) => s.id)).toEqual(['u1']);
    expect(first.has_more).toBe(true);

    const next = await svc.list({ excludeEmpty: true, page_size: 1, before_id: 'u1' });
    expect(next.items.map((s) => s.id)).toEqual(['u2']);
    expect(next.has_more).toBe(false);
  });
});

describe('SessionService.get', () => {
  it('returns the matching session', async () => {
    const created = await svc.create({ metadata: { cwd: '/tmp/x' } });
    const found = await svc.get(created.id);
    expect(found.id).toBe(created.id);
    expect(found.metadata.cwd).toBe('/tmp/x');
  });

  it('throws SessionNotFoundError for an unknown id', async () => {
    await expect(svc.get('does-not-exist')).rejects.toBeInstanceOf(SessionNotFoundError);
    await expect(svc.get('does-not-exist')).rejects.toThrow(/does not exist/);
  });
});

describe('SessionService.update', () => {
  let created: Session;

  beforeEach(async () => {
    created = await svc.create({ metadata: { cwd: '/tmp/u' } });
  });

  it('rejects updates to missing sessions with SessionNotFoundError', async () => {
    await expect(svc.update('does-not-exist', { title: 'x' })).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
  });

  it('routes title through bridge.rpc.renameSession', async () => {
    await svc.update(created.id, { title: 'Renamed' });
    expect(state.renamedTitles.get(created.id)).toBe('Renamed');
    expect(state.metadataPatches.has(created.id)).toBe(false);
  });

  it('routes metadata patch through bridge.rpc.updateSessionMetadata (into .custom)', async () => {
    await svc.update(created.id, { metadata: { custom_field: 'x' } });
    const patch = state.metadataPatches.get(created.id);
    expect(patch).toEqual({ custom: { custom_field: 'x' } });
  });

  it('handles both title + metadata in a single update', async () => {
    await svc.update(created.id, { title: 'New', metadata: { tag: 'a' } });
    expect(state.renamedTitles.get(created.id)).toBe('New');
    expect(state.metadataPatches.get(created.id)).toEqual({ custom: { tag: 'a' } });
  });

  it('is a no-op when update body is empty', async () => {
    await svc.update(created.id, {});
    expect(state.renamedTitles.size).toBe(0);
    expect(state.metadataPatches.size).toBe(0);
    expect(promptStub.calls).toEqual([]);
  });

  it('forwards agent_config.model through IPromptService.applyAgentState (source="meta")', async () => {
    const updated = await svc.update(created.id, { agent_config: { model: 'kimi-code/k9' } });
    expect(promptStub.calls).toEqual([
      { sid: created.id, patch: { model: 'kimi-code/k9' }, source: 'meta', promptId: undefined, agentId: 'main' },
    ]);
    expect(updated.agent_config.model).toBe('kimi-code/k9');
  });

  it('ignores agent_config.model when empty string (legacy quirk preserved)', async () => {
    await svc.update(created.id, { agent_config: { model: '' } });
    expect(promptStub.calls).toEqual([]);
  });

  it('forwards thinking + permission_mode + discuss_mode through applyAgentState in one call', async () => {
    await svc.update(created.id, {
      agent_config: {
        thinking: 'high',
        permission_mode: 'yolo',
        discuss_mode: true,
      },
    });
    expect(promptStub.calls).toEqual([
      {
        sid: created.id,
        patch: { thinking: 'high', permission_mode: 'yolo', discuss_mode: true },
        source: 'meta',
        promptId: undefined,
        agentId: 'main',
      },
    ]);
  });

  it('combines model + runtime controls into a single applyAgentState call', async () => {
    await svc.update(created.id, {
      agent_config: { model: 'kimi-code/k9', discuss_mode: false },
    });
    expect(promptStub.calls).toHaveLength(1);
    expect(promptStub.calls[0]?.patch).toEqual({ model: 'kimi-code/k9', discuss_mode: false });
    expect(promptStub.calls[0]?.source).toBe('meta');
  });

  it('routes a child profile control to that agent without mutating session metadata', async () => {
    await svc.update(
      created.id,
      { agent_config: { model: 'kimi-code/reviewer', discuss_mode: true } },
      'team_reviewer',
    );
    expect(promptStub.calls).toEqual([
      {
        sid: created.id,
        patch: { model: 'kimi-code/reviewer', discuss_mode: true },
        source: 'meta',
        promptId: undefined,
        agentId: 'team_reviewer',
      },
    ]);
    expect(state.metadataPatches.has(created.id)).toBe(false);
  });

  it('does not call applyAgentState when agent_config carries no runtime fields', async () => {
    await svc.update(created.id, { agent_config: {} });
    expect(promptStub.calls).toEqual([]);
  });

  it('returns the post-update Session shape', async () => {
    const after = await svc.update(created.id, { title: 'Renamed' });
    expect(after.id).toBe(created.id);
    expect(after.metadata.cwd).toBe('/tmp/u');
  });
});

describe('SessionService.fork', () => {
  it('forks through core.rpc.forkSession with TUI-compatible default title', async () => {
    const source = await svc.create({
      metadata: { cwd: '/tmp/fork', source: true },
      title: 'Source title',
    });

    const fork = await svc.fork(source.id, { metadata: { child: true } });

    expect(state.forkPayloads).toEqual([
      {
        sessionId: source.id,
        id: undefined,
        title: 'Fork: Source title',
        metadata: { child: true },
      },
    ]);
    expect(fork.id).toMatch(/^sess_fork_/);
    expect(fork.title).toBe('Fork: Source title');
    expect(fork.metadata).toMatchObject({
      cwd: '/tmp/fork',
      child: true,
    });
  });

  it('passes an explicit title through to core.rpc.forkSession', async () => {
    const source = await svc.create({ metadata: { cwd: '/tmp/fork-explicit' } });

    const fork = await svc.fork(source.id, {
      title: 'Custom fork',
      metadata: { origin: 'web' },
    });

    expect(state.forkPayloads[0]).toEqual({
      sessionId: source.id,
      id: undefined,
      title: 'Custom fork',
      metadata: { origin: 'web' },
    });
    expect(fork.id).toMatch(/^sess_fork_/);
    expect(fork.title).toBe('Custom fork');
  });

  it('throws SessionNotFoundError when the source session is missing', async () => {
    await expect(svc.fork('missing', {})).rejects.toBeInstanceOf(SessionNotFoundError);
    expect(state.forkPayloads).toEqual([]);
  });
});

describe('SessionService children', () => {
  it('creates an empty child session and mounts it under the parent', async () => {
    const source = await svc.create({
      metadata: { cwd: '/tmp/child', source: true },
      title: 'Parent title',
    });

    const child = await svc.createChild(source.id, {
      metadata: {
        parent_session_id: 'spoofed-parent',
        child_session_kind: 'spoofed-kind',
        topic: 'btw',
      },
    });

    expect(state.forkPayloads).toEqual([]);
    expect(state.createPayloads.at(-1)).toMatchObject({
      workDir: '/tmp/child',
      metadata: {
        cwd: '/tmp/child',
        topic: 'btw',
      },
    });
    expect(child.id).toMatch(/^sess_/);
    expect(child.title).toBe('Child: Parent title');
    expect(child.metadata).toMatchObject({
      cwd: '/tmp/child',
      parent_session_id: source.id,
      child_session_kind: 'child',
      topic: 'btw',
    });
    expect(child.metadata).not.toHaveProperty('source');
  });

  it('deletes the created child when mounting fails', async () => {
    const source = await svc.create({
      metadata: { cwd: '/tmp/child-rollback' },
      title: 'Parent',
    });
    vi.mocked(bridge.rpc.attachMountedTeamMember).mockRejectedValueOnce(
      new Error('team-agent attach failed'),
    );

    await expect(svc.createChild(source.id, { title: 'Child' }))
      .rejects.toThrow('team-agent attach failed');

    expect(state.sessions).toHaveLength(1);
    expect(state.deletedIds).toHaveLength(1);
  });

  it('lists only direct children for a parent session', async () => {
    const parent = await svc.create({
      metadata: { cwd: '/tmp/children' },
      title: 'Parent',
    });
    const child = await svc.createChild(parent.id, { title: 'Child one' });
    await svc.fork(parent.id, { metadata: { forked: true } });
    const grandchild = await svc.createChild(child.id, { title: 'Grandchild' });

    const page = await svc.listChildren(parent.id, {});

    expect(page.has_more).toBe(false);
    expect(page.items.map((item) => item.id)).toEqual([child.id]);
    expect(page.items.map((item) => item.id)).not.toContain(grandchild.id);
  });

  it('lists children from persisted summary metadata when SessionMeta is unavailable', async () => {
    const parent = await svc.create({
      metadata: { cwd: '/tmp/persisted-child' },
      title: 'Parent',
    });
    const child = await svc.createChild(parent.id, { title: 'Child one' });
    state.metas.delete(child.id);

    const page = await svc.listChildren(parent.id, {});

    expect(page.items.map((item) => item.id)).toEqual([child.id]);
    expect(page.items[0]!.metadata).toMatchObject({
      cwd: '/tmp/persisted-child',
      parent_session_id: parent.id,
      child_session_kind: 'child',
    });
  });

  it('throws SessionNotFoundError when listing children for a missing parent', async () => {
    await expect(svc.listChildren('missing', {})).rejects.toBeInstanceOf(SessionNotFoundError);
  });
});

describe('SessionService mount', () => {
  it('mounts, remounts, rejects cycles, and promotes children on delete', async () => {
    const { SessionMountCycleError } = await import('../../src/services/session/session');
    const a = await svc.create({ metadata: { cwd: '/tmp/mount' }, title: 'A' });
    const b = await svc.create({ metadata: { cwd: '/tmp/mount' }, title: 'B' });
    const c = await svc.create({ metadata: { cwd: '/tmp/mount' }, title: 'C' });

    const mounted = await svc.mount(b.id, { parent_session_id: a.id, role: 'member' });
    expect(mounted.metadata).toMatchObject({
      parent_session_id: a.id,
      child_session_kind: 'child',
      mount_role: 'member',
    });

    await svc.mount(c.id, { parent_session_id: b.id });
    await expect(svc.mount(a.id, { parent_session_id: c.id })).rejects.toBeInstanceOf(
      SessionMountCycleError,
    );

    const remounted = await svc.remount(c.id, { parent_session_id: a.id });
    expect(remounted.metadata['parent_session_id']).toBe(a.id);

    const underA = await svc.listChildren(a.id, {});
    expect(underA.items.map((item) => item.id).toSorted()).toEqual([b.id, c.id].toSorted());

    await svc.delete(a.id);
    expect(state.deletedIds).toContain(a.id);
    const bAfter = await svc.get(b.id);
    const cAfter = await svc.get(c.id);
    expect(bAfter.metadata['parent_session_id']).toBeUndefined();
    expect(cAfter.metadata['parent_session_id']).toBeUndefined();
    expect(bAfter.metadata['mount_role']).toBeUndefined();
    expect(cAfter.metadata['mount_role']).toBeUndefined();
    expect(bAfter.metadata['mount_mandate']).toBeUndefined();
    expect(cAfter.metadata['mount_mandate']).toBeUndefined();

    const graph = await svc.getGraph({});
    expect(graph.nodes.map((n) => n.id)).toEqual(
      expect.arrayContaining([b.id, c.id]),
    );
    expect(graph.edges).toEqual([]);
  });

  it('repairs a missing same-parent Team agent on an idempotent remount', async () => {
    const parent = await svc.create({ metadata: { cwd: '/tmp/remount-repair' }, title: 'Parent' });
    const child = await svc.create({ metadata: { cwd: '/tmp/remount-repair' }, title: 'Child' });
    await svc.mount(child.id, {
      parent_session_id: parent.id,
      role: 'reviewer',
      mandate: 'Review changes',
    });

    const parentMeta = state.metas.get(parent.id)!;
    state.metas.set(parent.id, { ...parentMeta, agents: {} });

    await svc.remount(child.id, { parent_session_id: parent.id });

    expect(
      Object.values(state.metas.get(parent.id)?.agents ?? {}).some(
        (agent) => agent.kind === 'team' && agent.mountedSessionId === child.id,
      ),
    ).toBe(true);
  });

  it('unmounts a session back to top-level', async () => {
    const parent = await svc.create({ metadata: { cwd: '/tmp/unmount' }, title: 'P' });
    const child = await svc.create({ metadata: { cwd: '/tmp/unmount' }, title: 'C' });
    await svc.mount(child.id, { parent_session_id: parent.id });
    const unmounted = await svc.unmount(child.id);
    expect(unmounted.metadata['parent_session_id']).toBeUndefined();
    expect((await svc.listChildren(parent.id, {})).items).toEqual([]);
  });

  it('rolls an unmount back when team-agent synchronization fails', async () => {
    const parent = await svc.create({ metadata: { cwd: '/tmp/unmount-rollback' }, title: 'P' });
    const child = await svc.create({ metadata: { cwd: '/tmp/unmount-rollback' }, title: 'C' });
    await svc.mount(child.id, {
      parent_session_id: parent.id,
      role: 'reviewer',
      mandate: 'Review changes',
    });
    vi.spyOn(bridge.rpc, 'detachMountedTeamMember').mockRejectedValueOnce(
      new Error('detach failed'),
    );

    await expect(svc.unmount(child.id)).rejects.toThrow('detach failed');

    expect((await svc.get(child.id)).metadata).toMatchObject({
      parent_session_id: parent.id,
      mount_role: 'reviewer',
      mount_mandate: 'Review changes',
    });
    expect(
      Object.values(state.metas.get(parent.id)?.agents ?? {}).some(
        (agent) => agent.kind === 'team' && agent.mountedSessionId === child.id,
      ),
    ).toBe(true);
  });

  it('syncs dual-write team agents so Discuss/Assign members match the mount tree', async () => {
    const oldParent = await svc.create({ metadata: { cwd: '/tmp/sync-team' }, title: 'Old' });
    const newParent = await svc.create({ metadata: { cwd: '/tmp/sync-team' }, title: 'New' });
    const child = await svc.create({ metadata: { cwd: '/tmp/sync-team' }, title: 'Worker' });

    await svc.mount(child.id, {
      parent_session_id: oldParent.id,
      role: 'reviewer',
      mandate: 'Review PRs',
    });
    const oldMembers = Object.values(state.metas.get(oldParent.id)?.agents ?? {}).filter(
      (agent) => agent.kind === 'team' && agent.mountedSessionId === child.id,
    );
    expect(oldMembers).toHaveLength(1);
    expect(oldMembers[0]).toMatchObject({
      teamLeaderAgentId: 'main',
      role: 'reviewer',
      mandate: 'Review PRs',
      name: 'Worker',
    });

    await svc.remount(child.id, {
      parent_session_id: newParent.id,
      role: 'owner',
      mandate: 'Own the module',
    });
    expect(
      Object.values(state.metas.get(oldParent.id)?.agents ?? {}).filter(
        (agent) => agent.kind === 'team' && agent.mountedSessionId === child.id,
      ),
    ).toHaveLength(0);
    const newMembers = Object.values(state.metas.get(newParent.id)?.agents ?? {}).filter(
      (agent) => agent.kind === 'team' && agent.mountedSessionId === child.id,
    );
    expect(newMembers).toHaveLength(1);
    expect(newMembers[0]).toMatchObject({
      teamLeaderAgentId: 'main',
      role: 'owner',
      mandate: 'Own the module',
      name: 'Worker',
    });

    await svc.unmount(child.id);
    expect(
      Object.values(state.metas.get(newParent.id)?.agents ?? {}).filter(
        (agent) => agent.kind === 'team' && agent.mountedSessionId === child.id,
      ),
    ).toHaveLength(0);
  });

  it('detaches dual-write team agents when delete promotes children to top-level', async () => {
    const parent = await svc.create({ metadata: { cwd: '/tmp/promote-team' }, title: 'Parent' });
    const child = await svc.create({ metadata: { cwd: '/tmp/promote-team' }, title: 'Child' });
    await svc.mount(child.id, { parent_session_id: parent.id, role: 'member' });
    expect(
      Object.values(state.metas.get(parent.id)?.agents ?? {}).some(
        (agent) => agent.kind === 'team' && agent.mountedSessionId === child.id,
      ),
    ).toBe(true);

    // Seed a stale dual-write on an unrelated host (nested TeamCreate style).
    const host = await svc.create({ metadata: { cwd: '/tmp/promote-team' }, title: 'Host' });
    state.metas.set(host.id, {
      title: 'Host',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      isCustomTitle: true,
      agents: {
        main: { homedir: '/tmp/main', type: 'main', parentAgentId: null },
        agent_stale: {
          homedir: '/tmp/stale',
          type: 'sub',
          parentAgentId: 'main',
          kind: 'team',
          teamLeaderAgentId: 'main',
          name: 'Stale',
          role: 'member',
          mandate: 'stale',
          mountedSessionId: child.id,
        },
      },
      custom: {},
    });

    await svc.delete(parent.id);
    expect((await svc.get(child.id)).metadata['parent_session_id']).toBeUndefined();
    expect(
      Object.values(state.metas.get(host.id)?.agents ?? {}).some(
        (agent) => agent.mountedSessionId === child.id,
      ),
    ).toBe(false);
  });

  it('detaches a mounted team agent when its session is deleted directly', async () => {
    const parent = await svc.create({ metadata: { cwd: '/tmp/delete-mounted' }, title: 'Parent' });
    const child = await svc.create({ metadata: { cwd: '/tmp/delete-mounted' }, title: 'Child' });
    await svc.mount(child.id, {
      parent_session_id: parent.id,
      role: 'worker',
      mandate: 'Own the task',
    });

    await svc.delete(child.id);

    expect(state.sessions.some((session) => session.id === child.id)).toBe(false);
    expect(
      Object.values(state.metas.get(parent.id)?.agents ?? {}).some(
        (agent) => agent.kind === 'team' && agent.mountedSessionId === child.id,
      ),
    ).toBe(false);
  });

  it('cleans stale team agents even when the deleted session has no parent link', async () => {
    const host = await svc.create({ metadata: { cwd: '/tmp/delete-stale-mounted' }, title: 'Host' });
    const child = await svc.create({ metadata: { cwd: '/tmp/delete-stale-mounted' }, title: 'Child' });
    const hostMeta = state.metas.get(host.id)!;
    state.metas.set(host.id, {
      ...hostMeta,
      agents: {
        ...hostMeta.agents,
        stale_member: {
          homedir: '/tmp/stale-member',
          type: 'sub',
          parentAgentId: 'main',
          kind: 'team',
          teamLeaderAgentId: 'main',
          name: 'Stale member',
          role: 'reviewer',
          mandate: 'Review changes',
          mountedSessionId: child.id,
        },
      },
    });

    await svc.delete(child.id);

    expect(state.metas.get(host.id)?.agents['stale_member']).toBeUndefined();
  });

  it('rolls session deletion back when the core delete fails', async () => {
    const parent = await svc.create({ metadata: { cwd: '/tmp/delete-rollback' }, title: 'Parent' });
    const child = await svc.create({ metadata: { cwd: '/tmp/delete-rollback' }, title: 'Child' });
    const grandchild = await svc.create({ metadata: { cwd: '/tmp/delete-rollback' }, title: 'Grandchild' });
    await svc.mount(child.id, { parent_session_id: parent.id, role: 'worker' });
    await svc.mount(grandchild.id, { parent_session_id: child.id, role: 'reviewer' });
    vi.mocked(bridge.rpc.deleteSession).mockRejectedValueOnce(new Error('delete failed'));

    await expect(svc.delete(child.id)).rejects.toThrow('delete failed');

    expect((await svc.get(child.id)).metadata).toMatchObject({
      parent_session_id: parent.id,
      mount_role: 'worker',
    });
    expect((await svc.get(grandchild.id)).metadata).toMatchObject({
      parent_session_id: child.id,
      mount_role: 'reviewer',
    });
    expect(
      Object.values(state.metas.get(parent.id)?.agents ?? {}).some(
        (agent) => agent.kind === 'team' && agent.mountedSessionId === child.id,
      ),
    ).toBe(true);
    expect(
      Object.values(state.metas.get(child.id)?.agents ?? {}).some(
        (agent) => agent.kind === 'team' && agent.mountedSessionId === grandchild.id,
      ),
    ).toBe(true);
  });

  it('notifies subject, new parent, old parent, and direct children on remount', async () => {
    const oldParent = await svc.create({ metadata: { cwd: '/tmp/notify' }, title: 'Old' });
    const newParent = await svc.create({ metadata: { cwd: '/tmp/notify' }, title: 'New' });
    const subject = await svc.create({ metadata: { cwd: '/tmp/notify' }, title: 'Subject' });
    const child = await svc.create({ metadata: { cwd: '/tmp/notify' }, title: 'Child' });
    await svc.mount(subject.id, { parent_session_id: oldParent.id, role: 'reviewer' });
    await svc.mount(child.id, { parent_session_id: subject.id });
    state.injectedReminders = [];
    eventBus.events.length = 0;

    await svc.remount(subject.id, {
      parent_session_id: newParent.id,
      role: 'owner',
      mandate: 'Own the module',
    });
    await vi.waitFor(() => {
      expect(state.injectedReminders.length).toBeGreaterThanOrEqual(4);
    });

    const mountEvents = eventBus.events.filter(
      (event) => (event as { type?: string }).type === 'event.session.mount_changed',
    ) as Array<{
      sessionId: string;
      recipient_role: string;
      change: { session_id: string; reason: string };
    }>;
    const rolesBySession = Object.fromEntries(
      mountEvents.map((event) => [event.sessionId, event.recipient_role]),
    );
    expect(rolesBySession[subject.id]).toBe('subject');
    expect(rolesBySession[oldParent.id]).toBe('old_parent');
    expect(rolesBySession[newParent.id]).toBe('new_parent');
    expect(rolesBySession[child.id]).toBe('direct_child');
    expect(mountEvents[0]?.change.reason).toBe('remount');

    const notified = new Set(state.injectedReminders.map((entry) => entry.sessionId));
    expect(notified).toEqual(new Set([subject.id, oldParent.id, newParent.id, child.id]));
    expect(state.injectedReminders.some((entry) => entry.content.includes('<session_mount_changed>'))).toBe(true);
    expect(state.metas.get(subject.id)?.custom['session_self']).toContain('<session_self>');
  });
});

describe('SessionService agent tree', () => {
  it('lists metadata agents with per-agent runtime status and best-effort usage', async () => {
    const created = await svc.create({ metadata: { cwd: '/tmp/agent-tree' } });
    state.metas.set(created.id, {
      title: 'Agent tree',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(2_000_000).toISOString(),
      isCustomTitle: true,
      agents: {
        main: { homedir: '/tmp/main', type: 'main', parentAgentId: null },
        agent_reviewer: {
          homedir: '/tmp/agent_reviewer',
          type: 'sub',
          kind: 'team',
          parentAgentId: 'main',
          name: 'Reviewer',
          role: 'reviewer',
          mandate: 'Review behavior',
          title: 'Legacy title',
          intro: 'Legacy intro',
          mountedSessionId: 'sess_mounted_reviewer',
        },
      },
      custom: {},
    });
    state.usages.set(created.id, {
      total: { inputOther: 10, output: 4, inputCacheRead: 2, inputCacheCreation: 1 },
    });
    state.runtimePhases.set(`${created.id}:agent_reviewer`, { phase: 'running', turnId: 3 });
    eventBus.eventService.publish({
      type: 'turn.started',
      sessionId: created.id,
      agentId: 'agent_reviewer',
    } as unknown as Event);

    const tree = await svc.listAgents(created.id);

    expect(tree.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'main',
        kind: 'main',
        parent_agent_id: null,
        status: 'idle',
        usage: { input_other: 10, output: 4, input_cache_read: 2, input_cache_creation: 1 },
      }),
      expect.objectContaining({
        id: 'agent_reviewer',
        kind: 'team',
        parent_agent_id: 'main',
        name: 'Reviewer',
        role: 'reviewer',
        mandate: 'Review behavior',
        status: 'running',
        mounted_session_id: 'sess_mounted_reviewer',
      }),
    ]));
    const reviewer = tree.agents.find(agent => agent.id === 'agent_reviewer');
    expect(reviewer).not.toHaveProperty('title');
    expect(reviewer).not.toHaveProperty('intro');
    expect(tree.agents.find(agent => agent.id === 'agent_reviewer')?.last_active).toMatch(/Z$/);
  });

  it('reports a member idle when a turn.started event was never followed by a turn end', async () => {
    const created = await svc.create({ metadata: { cwd: '/tmp/stale-status' } });
    state.metas.set(created.id, {
      title: 'Stale status',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      isCustomTitle: true,
      agents: {
        main: { homedir: '/tmp/main', type: 'main', parentAgentId: null },
        agent_member: { homedir: '/tmp/member', type: 'sub', parentAgentId: 'main', kind: 'team' },
      },
      custom: {},
    });
    // The member's turn ended without the terminal event reaching this service —
    // a dropped event, a restart, or a turn started by another path. The live
    // agent is the authority, so the tree must not keep showing `running` and
    // make Discuss skip the member as busy.
    eventBus.eventService.publish({
      type: 'turn.started',
      sessionId: created.id,
      agentId: 'agent_member',
    } as unknown as Event);

    const tree = await svc.listAgents(created.id);

    expect(tree.agents.find(agent => agent.id === 'agent_member')?.status).toBe('idle');
  });
});

describe('SessionService department chat', () => {
  it('serves the leader chat log to a member and nothing to a non-member', async () => {
    const created = await svc.create({ metadata: { cwd: '/tmp/chat' } });
    state.metas.set(created.id, {
      title: 'Chat',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      isCustomTitle: true,
      agents: {
        main: {
          homedir: '/tmp/main',
          type: 'main',
          parentAgentId: null,
          chat: {
            nextMessageId: 2,
            messages: [
              { messageId: 1, agentId: 'agent_member', name: 'Member', message: 'cache key changed', mentions: ['all'], sentAt: '2026-08-20T00:00:00.000Z' },
            ],
          },
        },
        agent_member: {
          homedir: '/tmp/member',
          type: 'sub',
          parentAgentId: 'main',
          kind: 'team',
          teamLeaderAgentId: 'main',
          name: 'Member',
        },
      },
      custom: {},
    });

    const memberView = await svc.getDepartmentChat(created.id, 'agent_member');
    expect(memberView).toEqual({
      department_leader_agent_id: 'main',
      messages: [
        { message_id: 1, agent_id: 'agent_member', name: 'Member', message: 'cache key changed', mentions: ['all'], sent_at: '2026-08-20T00:00:00.000Z' },
      ],
    });

    // The parent never reads its department's chat; unknown ids are equally blind.
    const mainView = await svc.getDepartmentChat(created.id, 'main');
    expect(mainView).toEqual({ department_leader_agent_id: null, messages: [] });
    const unknownView = await svc.getDepartmentChat(created.id, 'agent_ghost');
    expect(unknownView).toEqual({ department_leader_agent_id: null, messages: [] });
  });
});

describe('SessionService.archive', () => {
  it('calls bridge.rpc.archiveSession and returns { archived: true }', async () => {
    const created = await svc.create({ metadata: { cwd: '/tmp/d' } });
    const result = await svc.archive(created.id);
    expect(result).toEqual({ archived: true });
    expect(state.archivedIds).toEqual([created.id]);
  });

  it('throws SessionNotFoundError on a missing id', async () => {
    await expect(svc.archive('does-not-exist')).rejects.toBeInstanceOf(SessionNotFoundError);
  });
});

describe('SessionService.delete', () => {
  it('calls bridge.rpc.deleteSession and permanently removes the session', async () => {
    const created = await svc.create({ metadata: { cwd: '/tmp/delete' } });
    const result = await svc.delete(created.id);
    expect(result).toEqual({ deleted: true });
    expect(state.deletedIds).toEqual([created.id]);
    await expect(svc.get(created.id)).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('throws SessionNotFoundError on a missing id', async () => {
    await expect(svc.delete('does-not-exist')).rejects.toBeInstanceOf(SessionNotFoundError);
  });
});

describe('SessionService.compact', () => {
  it('calls bridge.rpc.beginCompaction with the main agent and a trimmed instruction', async () => {
    const created = await svc.create({ metadata: { cwd: '/tmp/compact' } });
    const result = await svc.compact(created.id, { instruction: '  focus on decisions  ' });
    expect(result).toEqual({});
    expect(state.compactions).toEqual([
      { sessionId: created.id, agentId: 'main', instruction: 'focus on decisions' },
    ]);
  });

  it('omits instruction when it is blank after trimming', async () => {
    const created = await svc.create({ metadata: { cwd: '/tmp/compact-blank' } });
    await svc.compact(created.id, { instruction: '    ' });
    expect(state.compactions).toEqual([
      { sessionId: created.id, agentId: 'main', instruction: undefined },
    ]);
  });

  it('targets a named agent when supplied', async () => {
    const created = await svc.create({ metadata: { cwd: '/tmp/compact-agent' } });
    await svc.compact(created.id, { agent_id: 'agent_reviewer' });
    expect(state.compactions).toEqual([
      { sessionId: created.id, agentId: 'agent_reviewer', instruction: undefined },
    ]);
  });

  it('throws SessionNotFoundError on a missing id', async () => {
    await expect(svc.compact('does-not-exist', {})).rejects.toBeInstanceOf(SessionNotFoundError);
    expect(state.compactions).toEqual([]);
  });
});

describe('SessionService.undo', () => {
  it('undoes through core and returns refreshed messages plus status', async () => {
    const created = await svc.create({ metadata: { cwd: '/tmp/undo' } });
    state.contexts.set(created.id, {
      history: [
        textMessage('user', 'first prompt'),
        textMessage('assistant', 'first answer'),
        textMessage('user', 'second prompt'),
        textMessage('assistant', 'second answer'),
      ],
      tokenCount: 40,
    });
    state.postUndoContexts.set(created.id, {
      history: [
        textMessage('user', 'first prompt'),
        textMessage('assistant', 'first answer'),
      ],
      tokenCount: 20,
    });

    const result = await svc.undo(created.id, { count: 1, page_size: 10 });

    expect(state.resumedIds).toEqual([created.id]);
    expect(state.undoPayloads).toEqual([
      { sessionId: created.id, agentId: 'main', count: 1 },
    ]);
    expect(result.messages.has_more).toBe(false);
    expect(result.messages.items.map((message) => message.content[0])).toEqual([
      { type: 'text', text: 'first answer' },
      { type: 'text', text: 'first prompt' },
    ]);
    expect(result.status).toMatchObject({
      status: 'idle',
      model: 'kimi-k2',
      thinking_level: 'auto',
      permission: 'manual',
      discuss_mode: false,
      context_tokens: 20,
      max_context_tokens: 100,
      context_usage: 0.2,
    });
  });

  it('does not call core undo when the requested count crosses a compaction boundary', async () => {
    const created = await svc.create({ metadata: { cwd: '/tmp/undo-boundary' } });
    state.contexts.set(created.id, {
      history: [
        textMessage('assistant', 'summary', { kind: 'compaction_summary' }),
        textMessage('user', 'recent prompt'),
        textMessage('assistant', 'recent answer'),
      ],
      tokenCount: 20,
    });

    await expect(svc.undo(created.id, { count: 2 })).rejects.toBeInstanceOf(
      SessionUndoUnavailableError,
    );
    expect(state.undoPayloads).toEqual([]);
    expect(state.contexts.get(created.id)?.history.map((message) => message.content[0])).toEqual([
      { type: 'text', text: 'summary' },
      { type: 'text', text: 'recent prompt' },
      { type: 'text', text: 'recent answer' },
    ]);
  });

  it('targets a named agent', async () => {
    const created = await svc.create({ metadata: { cwd: '/tmp/undo-agent' } });
    state.contexts.set(created.id, {
      history: [textMessage('user', 'review this')],
      tokenCount: 8,
    });
    await svc.undo(created.id, { count: 1, agent_id: 'agent_reviewer' });
    expect(state.undoPayloads).toEqual([
      { sessionId: created.id, agentId: 'agent_reviewer', count: 1 },
    ]);
  });

  it('throws SessionNotFoundError on a missing id', async () => {
    await expect(svc.undo('does-not-exist', { count: 1 })).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
    expect(state.undoPayloads).toEqual([]);
  });
});

describe('SessionService per-domain event listeners (Phase C)', () => {
  it('onDidCreate fires after bridge.rpc.createSession resolves', async () => {
    const events: unknown[] = [];
    svc.onDidCreate((e) => { events.push(e); });
    const session = await svc.create({ metadata: { cwd: '/tmp/evt' } });
    expect(events).toHaveLength(1);
    expect((events[0] as { session: { id: string } }).session.id).toBe(session.id);
  });

  it('publishes session.created after creating a session', async () => {
    const session = await svc.create({ metadata: { cwd: '/tmp/evt-bus' } });
    expect(eventBus.events).toContainEqual({
      type: 'event.session.created',
      sessionId: session.id,
      agentId: 'main',
      session,
    });
  });

  it('onDidCreate detach stops future events', async () => {
    const events: unknown[] = [];
    const sub = svc.onDidCreate((e) => { events.push(e); });
    sub.dispose();
    await svc.create({ metadata: { cwd: '/tmp/evt2' } });
    expect(events).toHaveLength(0);
  });

  it('onDidClose fires after bridge.rpc.archiveSession resolves', async () => {
    const closedIds: string[] = [];
    svc.onDidClose((e) => { closedIds.push(e.sessionId); });
    const session = await svc.create({ metadata: { cwd: '/tmp/evt3' } });
    await svc.archive(session.id);
    expect(closedIds).toEqual([session.id]);
  });

  it('onDidClose detach stops future events', async () => {
    const closedIds: string[] = [];
    const sub = svc.onDidClose((e) => { closedIds.push(e.sessionId); });
    sub.dispose();
    const session = await svc.create({ metadata: { cwd: '/tmp/evt4' } });
    await svc.archive(session.id);
    expect(closedIds).toHaveLength(0);
  });
});

describe('SessionService status lifecycle', () => {
  it('getStatus returns live status', async () => {
    const session = await svc.create({ metadata: { cwd: '/tmp/status' } });
    const status = await svc.getStatus(session.id);
    expect(status.status).toBe('idle');
  });

  it('patches created session status to idle', async () => {
    const session = await svc.create({ metadata: { cwd: '/tmp/status2' } });
    expect(session.status).toBe('idle');
  });

  it('turn.started moves status to running and emits status_changed', async () => {
    const session = await svc.create({ metadata: { cwd: '/tmp/running' } });
    eventBus.eventService.publish({
      type: 'turn.started',
      sessionId: session.id,
    } as unknown as Event);
    expect((await svc.get(session.id)).status).toBe('running');
    expect(eventBus.events).toContainEqual(expect.objectContaining({
      type: 'event.session.status_changed',
      sessionId: session.id,
      previous_status: 'idle',
      status: 'running',
    }));
  });

  it('aggregates child-agent activity without loading or visiting that session', async () => {
    const session = await svc.create({ metadata: { cwd: '/tmp/global-activity' } });
    const resumedBefore = [...state.resumedIds];
    eventBus.eventService.publish({
      type: 'turn.started',
      sessionId: session.id,
      agentId: 'team-reviewer',
    } as unknown as Event);

    expect(svc.listActiveAgentActivity()).toContainEqual(expect.objectContaining({
      sessionId: session.id,
      agentId: 'team-reviewer',
      status: 'running',
    }));
    expect(state.resumedIds).toEqual(resumedBefore);

    eventBus.eventService.publish({
      type: 'turn.ended',
      sessionId: session.id,
      agentId: 'team-reviewer',
      reason: 'success',
    } as unknown as Event);
    expect(svc.listActiveAgentActivity()).toEqual([]);
  });

  it('aggregates active background tasks globally without resuming their parent session', async () => {
    const session = await svc.create({ metadata: { cwd: '/tmp/global-background-activity' } });
    const resumedBefore = [...state.resumedIds];
    eventBus.eventService.publish({
      type: 'background.task.started',
      sessionId: session.id,
      agentId: 'main',
      info: {
        taskId: 'bash-global-1',
        kind: 'process',
        description: 'pnpm test --filter agent-core',
        status: 'running',
        startedAt: Date.now(),
        endedAt: null,
        command: 'pnpm test --filter agent-core',
        pid: 42,
        exitCode: null,
      },
    } as unknown as Event);

    expect(svc.listActiveAgentActivity()).toContainEqual(expect.objectContaining({
      sessionId: session.id,
      agentId: 'background:bash-global-1',
      kind: 'background',
      taskId: 'bash-global-1',
      status: 'running',
    }));
    expect(state.resumedIds).toEqual(resumedBefore);

    eventBus.eventService.publish({
      type: 'background.task.terminated',
      sessionId: session.id,
      agentId: 'main',
      info: {
        taskId: 'bash-global-1',
        kind: 'process',
        description: 'pnpm test --filter agent-core',
        status: 'completed',
        startedAt: Date.now() - 100,
        endedAt: Date.now(),
        command: 'pnpm test --filter agent-core',
        pid: 42,
        exitCode: 0,
      },
    } as unknown as Event);
    expect(svc.listActiveAgentActivity()).toEqual([]);
  });

  it('turn.ended with success moves status back to idle', async () => {
    const session = await svc.create({ metadata: { cwd: '/tmp/ended' } });
    eventBus.eventService.publish({ type: 'turn.started', sessionId: session.id } as unknown as Event);
    eventBus.eventService.publish({ type: 'turn.ended', sessionId: session.id, reason: 'success' } as unknown as Event);
    expect((await svc.get(session.id)).status).toBe('idle');
  });

  it('turn.ended with failed moves status to aborted', async () => {
    const session = await svc.create({ metadata: { cwd: '/tmp/aborted' } });
    eventBus.eventService.publish({ type: 'turn.started', sessionId: session.id } as unknown as Event);
    eventBus.eventService.publish({ type: 'turn.ended', sessionId: session.id, reason: 'failed' } as unknown as Event);
    expect((await svc.get(session.id)).status).toBe('aborted');
  });

  it('prompt.submitted moves status to running when a current prompt exists', async () => {
    const session = await svc.create({ metadata: { cwd: '/tmp/prompt' } });
    promptStub.activePromptIds.set(session.id, 'p1');
    eventBus.eventService.publish({ type: 'prompt.submitted', sessionId: session.id } as unknown as Event);
    expect((await svc.get(session.id)).status).toBe('running');
  });

  it('pending approval yields awaiting_approval', async () => {
    const session = await svc.create({ metadata: { cwd: '/tmp/approval' } });
    approvalStub.pending.set(session.id, [{ id: 'a1' }]);
    eventBus.eventService.publish({ type: 'event.approval.requested', sessionId: session.id } as unknown as Event);
    expect((await svc.get(session.id)).status).toBe('awaiting_approval');
  });

  it('pending question yields awaiting_question', async () => {
    const session = await svc.create({ metadata: { cwd: '/tmp/question' } });
    questionStub.pending.set(session.id, [{ id: 'q1' }]);
    eventBus.eventService.publish({ type: 'event.question.requested', sessionId: session.id } as unknown as Event);
    expect((await svc.get(session.id)).status).toBe('awaiting_question');
  });

  it('approval takes precedence over active prompt', async () => {
    const session = await svc.create({ metadata: { cwd: '/tmp/priority' } });
    promptStub.activePromptIds.set(session.id, 'p1');
    approvalStub.pending.set(session.id, [{ id: 'a1' }]);
    eventBus.eventService.publish({ type: 'prompt.submitted', sessionId: session.id } as unknown as Event);
    expect((await svc.get(session.id)).status).toBe('awaiting_approval');
  });

  it('does not emit status_changed when status is unchanged', async () => {
    const session = await svc.create({ metadata: { cwd: '/tmp/nochange' } });
    const statusChangedCount = (e: unknown) =>
      (e as { type?: string }).type === 'event.session.status_changed';
    const before = eventBus.events.filter(statusChangedCount).length;
    eventBus.eventService.publish({ type: 'prompt.completed', sessionId: session.id } as unknown as Event);
    expect(eventBus.events.filter(statusChangedCount).length).toBe(before);
  });
});
