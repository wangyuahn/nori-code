import { Disposable, IInstantiationService, InstantiationType, registerSingleton } from '../../di';
import { Emitter } from '../../base/common/event';
import { ErrorCodes, KimiError } from '../../errors';
import { isRealUserInput } from '../../agent/compaction';
import type { AgentContextData, ContextMessage } from '../../agent/context';
import type { JsonObject, ListSessionsPayload, SessionSummary } from '../../rpc';
import type { AgentMeta, SessionMeta } from '../../session';
import {
  type CompactSessionRequest,
  type CompactSessionResponse,
  type Event,
  type Message,
  type PageResponse,
  type Session,
  type SessionAgentTreeNode,
  type SessionAgentTreeResponse,
  type SessionAgentChatResponse,
  type SessionChildCreate,
  type SessionCreate,
  type SessionFork,
  type SessionStatus,
  type SessionStatusResponse,
  type SessionUpdate,
  type SessionWarning,
  type TokenUsage,
  type UndoSessionRequest,
  type UndoSessionResponse,
  type UsageStatus,
  type BackgroundTaskInfo,
} from '@nori-code/protocol';

import { IApprovalService } from '../approval/approval';
import { ICoreProcessService } from '../coreProcess/coreProcess';
import { IEventService } from '../event/event';
import { toProtocolMessages } from '../message/message';
import { IPromptService, type AgentStatePatch } from '../prompt/prompt';
import { IQuestionService } from '../question/question';
import {
  ISessionService,
  SessionNotFoundError,
  SessionUndoUnavailableError,
  toProtocolSession,
  type SessionCreateOptions,
  type SessionListQuery,
} from './session';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const DEFAULT_UNDO_MESSAGE_PAGE_SIZE = 50;
const MAX_UNDO_MESSAGE_PAGE_SIZE = 100;
const CHILD_SESSION_KIND = 'child';
const MAIN_AGENT_ID = 'main';

function sessionAgentKey(sessionId: string, agentId: string): string {
  return `${sessionId}\u0000${agentId}`;
}

function asJsonObject(value: Record<string, unknown>): JsonObject {
  return value as unknown as JsonObject;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === '' ? undefined : trimmed;
}

function mapTokenUsage(usage: TokenUsage) {
  return {
    input_other: usage.inputOther,
    output: usage.output,
    input_cache_read: usage.inputCacheRead,
    input_cache_creation: usage.inputCacheCreation,
  };
}

function mapRealtimeUsage(usage: UsageStatus | undefined): SessionStatusResponse['usage'] {
  if (usage === undefined) return undefined;
  const byModel = usage.byModel === undefined
    ? undefined
    : Object.fromEntries(Object.entries(usage.byModel).map(([model, value]) => [model, mapTokenUsage(value)]));
  if (byModel === undefined && usage.currentTurn === undefined && usage.total === undefined) return undefined;
  return {
    ...(byModel === undefined ? {} : { by_model: byModel }),
    ...(usage.currentTurn === undefined ? {} : { current_turn: mapTokenUsage(usage.currentTurn) }),
    ...(usage.total === undefined ? {} : { total: mapTokenUsage(usage.total) }),
  };
}

function mapAgentUsage(usage: UsageStatus | undefined): SessionAgentTreeNode['usage'] {
  const total = usage?.total;
  if (total === undefined) return undefined;
  return mapTokenUsage(total);
}

function treeAgentKind(agentId: string, agent: AgentMeta): SessionAgentTreeNode['kind'] {
  if (agentId === MAIN_AGENT_ID || agent.type === 'main') return 'main';
  if (agent.discussion !== undefined) return 'discussion';
  if (agent.kind === 'team') return 'team';
  // Anything else is a standalone agent. `type: 'sub'` without a team kind or a
  // discussion belongs to a non-persisted helper agent, which never reaches the
  // tree, so there is no fourth case to map.
  return 'independent';
}

function mapSessionUsage(usage: UsageStatus | undefined): Session['usage'] | undefined {
  const total = usage?.total;
  if (total === undefined) return undefined;
  return {
    input_tokens: total.inputOther,
    output_tokens: total.output,
    cache_read_tokens: total.inputCacheRead,
    cache_creation_tokens: total.inputCacheCreation,
    total_cost_usd: 0,
    context_tokens: 0,
    context_limit: 0,
    turn_count: 0,
  };
}

function canUndoHistory(history: readonly ContextMessage[], count: number): boolean {
  let found = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message === undefined) continue;
    if (message.origin?.kind === 'injection') continue;
    if (message.origin?.kind === 'compaction_summary') return false;
    if (isRealUserInput(message)) {
      found++;
      if (found >= count) return true;
    }
  }
  return false;
}

function pageContextMessages(
  sessionId: string,
  sessionCreatedAtMs: number,
  context: AgentContextData,
  requestedPageSize: number | undefined,
): PageResponse<Message> {
  const pageSize = Math.min(
    Math.max(requestedPageSize ?? DEFAULT_UNDO_MESSAGE_PAGE_SIZE, 1),
    MAX_UNDO_MESSAGE_PAGE_SIZE,
  );
  const all = context.history.flatMap((message, index) =>
    toProtocolMessages(sessionId, index, message, sessionCreatedAtMs),
  );
  const desc = all.toReversed();
  return {
    items: desc.slice(0, pageSize),
    has_more: desc.length > pageSize,
  };
}

export class SessionService extends Disposable implements ISessionService {
  readonly _serviceBrand: undefined;

  private readonly _onDidCreate = this._register(new Emitter<{ session: Session }>());
  readonly onDidCreate = this._onDidCreate.event;
  private readonly _onDidClose = this._register(new Emitter<{ sessionId: string }>());
  readonly onDidClose = this._onDidClose.event;

  private readonly _statusByAgent = new Map<string, SessionStatus>();
  private readonly _activeTurns = new Set<string>();
  private readonly _abortedTurns = new Set<string>();
  private readonly _lastActivityByAgent = new Map<string, string>();
  private readonly _activeBackgroundTasks = new Map<string, import('./session').SessionAgentActivity>();
  private _promptService: IPromptService | undefined;

  constructor(
    @ICoreProcessService private readonly core: ICoreProcessService,
    @IEventService private readonly eventService: IEventService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IApprovalService private readonly approvalService: IApprovalService,
    @IQuestionService private readonly questionService: IQuestionService,
  ) {
    super();
    this._register(
      this.eventService.onDidPublish((event) => {
        this._handleBusEvent(event);
      }),
    );
  }

  private get promptService(): IPromptService {
    return (this._promptService ??= this.instantiation.invokeFunction((a) => a.get(IPromptService)));
  }

  /**
   * The single status ladder. Both the cheap event-derived read and the
   * authoritative live read go through here, so the two can never disagree about
   * priority — they differ only in what they know about the turn.
   *
   * Priority:
   *   1. awaiting_approval — pending approvals exist
   *   2. awaiting_question — pending questions exist
   *   3. running           — a turn is executing, or a submitted prompt is in flight
   *   4. aborted           — last turn ended as cancelled/failed and no new work started
   *   5. idle              — everything else
   *
   * `turnRunning` is the caller's answer to "is a turn executing right now": the
   * live agent phase where we have it, the event cache where we do not.
   */
  private _statusFrom(
    sessionId: string,
    agentId: string,
    turnRunning: boolean,
  ): SessionStatus {
    if (this.approvalService.listPending(sessionId, agentId).length > 0) {
      return 'awaiting_approval';
    }
    if (this.questionService.listPending(sessionId, agentId).length > 0) {
      return 'awaiting_question';
    }
    if (turnRunning) return 'running';
    // A prompt that was accepted but whose turn has not begun yet: the agent is
    // idle for an instant, and reporting idle here would flicker the UI between
    // submit and `turn.started`.
    if (this.promptService.getCurrentPromptId(sessionId, agentId) !== undefined) {
      return 'running';
    }
    if (this._abortedTurns.has(sessionAgentKey(sessionId, agentId))) {
      return 'aborted';
    }
    return 'idle';
  }

  /** Event-derived status. Cheap: it never resumes an agent, so it is what the
   *  session list uses. `_readAuthoritativeStatus` corrects it wherever a live
   *  agent is already at hand. */
  private _computeStatus(sessionId: string, agentId = MAIN_AGENT_ID): SessionStatus {
    return this._statusFrom(
      sessionId,
      agentId,
      this._activeTurns.has(sessionAgentKey(sessionId, agentId)),
    );
  }

  /**
   * Reconcile event-derived caches with the target Agent's live state. Events
   * remain useful for immediate notifications, but they are not authoritative:
   * a missed terminal event must not leave an idle agent permanently running.
   */
  private async _readAuthoritativeStatus(
    sessionId: string,
    agentId = MAIN_AGENT_ID,
  ): Promise<SessionStatus> {
    const key = sessionAgentKey(sessionId, agentId);
    const runtime = await this.core.rpc.getRuntimeState({ sessionId, agentId });
    if (runtime.phase === 'running') {
      this._activeTurns.add(key);
    } else {
      this._activeTurns.delete(key);
    }
    const status = this._statusFrom(sessionId, agentId, runtime.phase !== 'idle');
    this._statusByAgent.set(key, status);
    return status;
  }

  /**
   * Overwrite the placeholder status on a protocol Session with the live value,
   * and remember the last status we returned so status-change events can be
   * emitted only when the live state actually moves.
   */
  private _patchSessionStatus(session: Session): Session {
    const agentState = this._promptService?.getAgentStateSnapshot(session.id);
    if (agentState !== undefined) {
      session.agent_config = {
        ...session.agent_config,
        ...(agentState.model !== undefined ? { model: agentState.model } : {}),
        ...(agentState.thinking !== undefined ? { thinking: agentState.thinking } : {}),
        ...(agentState.permissionMode !== undefined
          ? { permission_mode: agentState.permissionMode as Session['agent_config']['permission_mode'] }
          : {}),
        ...(agentState.discussMode !== undefined ? { discuss_mode: agentState.discussMode } : {}),
      };
    }
    const runtime = session.metadata['noriRuntime'];
    if (runtime !== null && typeof runtime === 'object') {
      const toolsReadonly = (runtime as Record<string, unknown>)['toolsReadonly'];
      if (typeof toolsReadonly === 'boolean') {
        session.agent_config.main_write_enabled = !toolsReadonly;
      }
    }
    const status = this._computeStatus(session.id);
    session.status = status;
    this._statusByAgent.set(sessionAgentKey(session.id, MAIN_AGENT_ID), status);
    return session;
  }

  /**
   * Publish `event.session.status_changed` when the computed status for a
   * session differs from the last one we announced. Called after every relevant
   * lifecycle event so the session list stays in sync.
   */
  private _emitStatusChanged(sessionId: string, agentId = MAIN_AGENT_ID): void {
    const key = sessionAgentKey(sessionId, agentId);
    const previous = this._statusByAgent.get(key) ?? 'idle';
    const next = this._computeStatus(sessionId, agentId);
    if (previous === next) return;

    this._statusByAgent.set(key, next);
    this.eventService.publish({
      type: 'event.session.status_changed',
      agentId,
      sessionId,
      status: next,
      previous_status: previous,
      current_prompt_id: this.promptService.getCurrentPromptId(sessionId, agentId),
    } as unknown as Event);
  }

  private _handleBusEvent(event: Event): void {
    const type = (event as { type?: string }).type;
    const sessionId = (event as { sessionId?: string }).sessionId;
    if (sessionId === undefined || sessionId === '' || type === undefined) return;
    const agentId = (event as { agentId?: string }).agentId ?? MAIN_AGENT_ID;
    const key = sessionAgentKey(sessionId, agentId);
    this._lastActivityByAgent.set(key, new Date().toISOString());

    switch (type) {
      case 'turn.started': {
        this._activeTurns.add(key);
        this._abortedTurns.delete(key);
        this._emitStatusChanged(sessionId, agentId);
        break;
      }
      case 'turn.ended': {
        this._activeTurns.delete(key);
        const reason = (event as { reason?: string }).reason;
        if (reason === 'cancelled' || reason === 'failed' || reason === 'filtered') {
          this._abortedTurns.add(key);
        } else {
          this._abortedTurns.delete(key);
        }
        this._emitStatusChanged(sessionId, agentId);
        break;
      }
      case 'prompt.submitted': {
        this._abortedTurns.delete(key);
        this._emitStatusChanged(sessionId, agentId);
        break;
      }
      case 'prompt.completed':
      case 'prompt.aborted':
      case 'event.approval.requested':
      case 'event.approval.resolved':
      case 'event.approval.expired':
      case 'event.question.requested':
      case 'event.question.answered':
      case 'event.question.dismissed': {
        this._emitStatusChanged(sessionId, agentId);
        break;
      }
      case 'background.task.started':
      case 'background.task.updated':
      case 'background.task.terminated': {
        const info = (event as { info?: BackgroundTaskInfo }).info;
        if (info === undefined) break;
        const taskKey = `${sessionId}\u0000${info.taskId}`;
        const terminal = type === 'background.task.terminated'
          || ['completed', 'failed', 'timed_out', 'killed', 'lost', 'cancelled', 'stopped'].includes(String(info.status));
        if (terminal) {
          this._activeBackgroundTasks.delete(taskKey);
          break;
        }
        this._activeBackgroundTasks.set(taskKey, {
          sessionId,
          agentId: `background:${info.taskId}`,
          kind: 'background',
          taskId: info.taskId,
          status: 'running',
          lastActive: new Date(info.startedAt).toISOString(),
        });
        break;
      }
    }
  }

  async create(input: SessionCreate, options?: SessionCreateOptions): Promise<Session> {
    if (input.metadata === undefined || typeof input.metadata.cwd !== 'string') {
      throw new Error('SessionService.create: metadata.cwd is required');
    }
    const metadataForCore = asJsonObject(input.metadata as Record<string, unknown>);
    const summary = await this.core.rpc.createSession({
      workDir: input.metadata.cwd,
      metadata: metadataForCore,
      model: input.agent_config?.model,
      client: options?.client,
    });
    if (input.title !== undefined) {
      try {
        await this.core.rpc.renameSession({ sessionId: summary.id, title: input.title });
      } catch {
      }
    }
    const meta = await this.tryGetMeta(summary.id);
    const session = this._patchSessionStatus(toProtocolSession(summary, meta));
    this.emitCreated(session);
    return session;
  }

  async list(query: SessionListQuery): Promise<PageResponse<Session>> {
    const corePayload: ListSessionsPayload = {
      workDir: query.workDir,
      includeArchive: query.includeArchive,
    };
    const all = await this.core.rpc.listSessions(corePayload);
    const sorted = all.toSorted((a, b) => b.updatedAt - a.updatedAt);
    // Hide sessions the user has never interacted with: a session is "empty" when
    // it has no lastPrompt (the first prompt has not been sent yet). Filtered
    // before cursor pagination so each returned page is filled with non-empty
    // sessions and has_more reflects the filtered set.
    const visible = query.excludeEmpty ? sorted.filter((s) => s.lastPrompt) : sorted;

    let pivotIndex = -1;
    if (query.before_id !== undefined) {
      pivotIndex = visible.findIndex((s) => s.id === query.before_id);
    } else if (query.after_id !== undefined) {
      pivotIndex = visible.findIndex((s) => s.id === query.after_id);
    }

    let slice: typeof visible;
    if (query.before_id !== undefined && pivotIndex >= 0) {
      slice = visible.slice(pivotIndex + 1);
    } else if (query.after_id !== undefined && pivotIndex >= 0) {
      slice = visible.slice(0, pivotIndex);
    } else {
      slice = visible;
    }

    const requestedSize = query.page_size ?? DEFAULT_PAGE_SIZE;
    const pageSize = Math.min(Math.max(requestedSize, 1), MAX_PAGE_SIZE);
    const pageSummaries = slice.slice(0, pageSize);
    const hasMore = slice.length > pageSize;

    const items = await Promise.all(
      pageSummaries.map(async (s) => {
        const session = this._patchSessionStatus(toProtocolSession(s, await this.tryGetMeta(s.id)));
        await this._attachUsage(session);
        return session;
      }),
    );

    const filtered =
      query.status !== undefined ? items.filter((s) => s.status === query.status) : items;

    return { items: filtered, has_more: hasMore };
  }

  async get(id: string): Promise<Session> {
    const all = await this.core.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }
    const meta = await this.tryGetMeta(id);
    const session = this._patchSessionStatus(toProtocolSession(summary, meta));
    await this._attachUsage(session);
    return session;
  }

  async update(id: string, input: SessionUpdate, agentId = MAIN_AGENT_ID): Promise<Session> {
    const all = await this.core.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }

    if (input.title !== undefined) {
      await this.core.rpc.renameSession({ sessionId: id, title: input.title });
    }

    const metadataPatch = input.metadata;
    if (metadataPatch !== undefined && Object.keys(metadataPatch).length > 0) {
      await this.core.rpc.updateSessionMetadata({
        sessionId: id,
        metadata: { custom: metadataPatch as Record<string, unknown> },
      });
    }

    const ac = input.agent_config;
    if (ac !== undefined) {
      const patch: AgentStatePatch = {};
      if (ac.model !== undefined && ac.model !== '') patch.model = ac.model;
      if (ac.thinking !== undefined) patch.thinking = ac.thinking;
      if (ac.permission_mode !== undefined) patch.permission_mode = ac.permission_mode;
      if (ac.discuss_mode !== undefined) patch.discuss_mode = ac.discuss_mode;
      if (ac.goal_objective !== undefined) patch.goal_objective = ac.goal_objective;
      if (ac.goal_control !== undefined) patch.goal_control = ac.goal_control;
      if (
        patch.model !== undefined ||
        patch.thinking !== undefined ||
        patch.permission_mode !== undefined ||
        patch.discuss_mode !== undefined ||
        patch.goal_objective !== undefined ||
        patch.goal_control !== undefined
      ) {
        await this.promptService.applyAgentState(id, patch, 'meta', undefined, agentId);
      }
      if (ac.main_write_enabled !== undefined) {
        await this.core.rpc.setNoriRuntimeSettings({
          sessionId: id,
          agentId,
          toolsReadonly: !ac.main_write_enabled,
        });
      }
    }

    const allAfter = await this.core.rpc.listSessions({});
    const summaryAfter = allAfter.find((s) => s.id === id) ?? summary;
    const meta = await this.tryGetMeta(id);
    const session = this._patchSessionStatus(toProtocolSession(summaryAfter, meta));
    await this._attachUsage(session);
    return session;
  }

  async fork(id: string, input: SessionFork): Promise<Session> {
    const source = await this.get(id);
    const title = input.title ?? `Fork: ${source.title || source.id}`;
    const metadata = input.metadata === undefined ? undefined : asJsonObject(input.metadata);
    const summary = await this.core.rpc.forkSession({
      sessionId: id,
      title,
      metadata,
    });
    const meta = await this.tryGetMeta(summary.id);
    const session = this._patchSessionStatus(toProtocolSession(summary, meta));
    this.emitCreated(session);
    return session;
  }

  async listChildren(id: string, query: SessionListQuery): Promise<PageResponse<Session>> {
    await this.get(id);
    const all = await this.core.rpc.listSessions({});
    const sorted = all.toSorted((a, b) => b.updatedAt - a.updatedAt);
    const children = sorted.filter(
      (summary) =>
        summary.metadata?.['parent_session_id'] === id &&
        summary.metadata?.['child_session_kind'] === CHILD_SESSION_KIND,
    );

    let pivotIndex = -1;
    if (query.before_id !== undefined) {
      pivotIndex = children.findIndex((s) => s.id === query.before_id);
    } else if (query.after_id !== undefined) {
      pivotIndex = children.findIndex((s) => s.id === query.after_id);
    }

    let slice: typeof children;
    if (query.before_id !== undefined && pivotIndex >= 0) {
      slice = children.slice(pivotIndex + 1);
    } else if (query.after_id !== undefined && pivotIndex >= 0) {
      slice = children.slice(0, pivotIndex);
    } else {
      slice = children;
    }

    const requestedSize = query.page_size ?? DEFAULT_PAGE_SIZE;
    const pageSize = Math.min(Math.max(requestedSize, 1), MAX_PAGE_SIZE);
    const pageSummaries = slice.slice(0, pageSize);
    const items = await Promise.all(
      pageSummaries.map(async (s) => {
        const session = this._patchSessionStatus(toProtocolSession(s, await this.tryGetMeta(s.id)));
        await this._attachUsage(session);
        return session;
      }),
    );
    const filtered =
      query.status !== undefined
        ? items.filter((session) => session.status === query.status)
        : items;

    return {
      items: filtered,
      has_more: slice.length > pageSize,
    };
  }

  async createChild(id: string, input: SessionChildCreate): Promise<Session> {
    const parent = await this.get(id);
    const title = input.title ?? `Child: ${parent.title || parent.id}`;
    const metadata = asJsonObject({
      ...input.metadata,
      parent_session_id: id,
      child_session_kind: CHILD_SESSION_KIND,
    });
    const summary = await this.core.rpc.forkSession({
      sessionId: id,
      title,
      metadata,
    });
    const meta = await this.tryGetMeta(summary.id);
    const session = this._patchSessionStatus(toProtocolSession(summary, meta));
    this.emitCreated(session);
    return session;
  }

  private emitCreated(session: Session): void {
    this._onDidCreate.fire({ session });
    this.eventService.publish({
      type: 'event.session.created',
      agentId: 'main',
      sessionId: session.id,
      session,
    });
  }

  async listAgents(id: string): Promise<SessionAgentTreeResponse> {
    const summary = await this.requireSummary(id);
    // Metadata for dormant sessions is reconstructed by resume; without it a
    // freshly opened parent conversation would incorrectly expose only main.
    await this.core.rpc.resumeSession({ sessionId: id });
    const meta = await this.tryGetMeta(id);
    const agents = new Map(Object.entries(meta?.agents ?? {}));
    if (!agents.has(MAIN_AGENT_ID)) {
      agents.set(MAIN_AGENT_ID, {
        homedir: '',
        type: MAIN_AGENT_ID,
        parentAgentId: null,
      });
    }

    const nodes = await Promise.all(
      [...agents.entries()]
        .toSorted(([leftId, left], [rightId, right]) => {
          if (left.type === 'main') return -1;
          if (right.type === 'main') return 1;
          return leftId.localeCompare(rightId);
        })
        .map(async ([agentId, agent]): Promise<SessionAgentTreeNode> => {
          const key = sessionAgentKey(id, agentId);
          let usage: SessionAgentTreeNode['usage'];
          try {
            usage = mapAgentUsage(await this.core.rpc.getUsage({ sessionId: id, agentId }));
          } catch {
            usage = undefined;
          }
          const status = await this._readAuthoritativeStatus(id, agentId);
          return {
            id: agentId,
            kind: treeAgentKind(agentId, agent),
            parent_agent_id: agent.parentAgentId,
            name: agent.name ?? agentId,
            role: agent.role,
            mandate: agent.mandate,
            assigned_task: agent.assignedTask ?? agent.teamReport?.task,
            team_report_status: agent.teamReport?.status,
            team_report_summary: agent.teamReport?.summary,
            team_report_received: agent.teamReport?.receivedAt !== undefined,
            summary: agent.discussion?.topic ?? agent.assignedTask,
            status,
            usage,
            last_active: this._lastActivityByAgent.get(key) ?? new Date(summary.updatedAt).toISOString(),
            archived: agent.discussion?.status === 'archived',
            ...(agent.discussion?.currentTurnAgentId === undefined
              ? {}
              : { discussion_turn_agent_id: agent.discussion.currentTurnAgentId }),
          };
        }),
    );
    return { agents: nodes };
  }

  async getDepartmentChat(id: string, agentId: string): Promise<SessionAgentChatResponse> {
    await this.requireSummary(id);
    await this.core.rpc.resumeSession({ sessionId: id });
    const meta = await this.tryGetMeta(id);
    const member = meta?.agents[agentId];
    const leaderAgentId = member?.kind === 'team' ? member.teamLeaderAgentId : undefined;
    if (leaderAgentId === undefined) {
      return { department_leader_agent_id: null, messages: [] };
    }
    const messages = (meta?.agents[leaderAgentId]?.chat?.messages ?? []).map((record) => ({
      message_id: record.messageId,
      agent_id: record.agentId,
      name: record.name,
      message: record.message,
      mentions: [...record.mentions],
      sent_at: record.sentAt,
    }));
    return { department_leader_agent_id: leaderAgentId, messages };
  }

  listActiveAgentActivity(): readonly import('./session').SessionAgentActivity[] {
    const activeStatuses = new Set<SessionStatus>(['running', 'awaiting_approval', 'awaiting_question']);
    const active = new Map<string, import('./session').SessionAgentActivity>();
    for (const [key, status] of this._statusByAgent) {
      if (!activeStatuses.has(status)) continue;
      const separator = key.indexOf('\u0000');
      if (separator < 1) continue;
      const sessionId = key.slice(0, separator);
      const agentId = key.slice(separator + 1);
      active.set(key, {
        sessionId,
        agentId,
        kind: 'agent',
        status,
        lastActive: this._lastActivityByAgent.get(key),
      });
    }
    for (const key of this._activeTurns) {
      if (active.has(key)) continue;
      const separator = key.indexOf('\u0000');
      if (separator < 1) continue;
      const sessionId = key.slice(0, separator);
      const agentId = key.slice(separator + 1);
      active.set(key, {
        sessionId,
        agentId,
        kind: 'agent',
        status: 'running',
        lastActive: this._lastActivityByAgent.get(key),
      });
    }
    for (const [key, item] of this._activeBackgroundTasks) {
      if (!active.has(key)) active.set(key, item);
    }
    return [...active.values()];
  }

  async getStatus(
    id: string,
    agentId = MAIN_AGENT_ID,
    ensureResumed = true,
  ): Promise<SessionStatusResponse> {
    const all = await this.core.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }

    if (ensureResumed) await this.core.rpc.resumeSession({ sessionId: id });

    const [config, context, permission, discussMode, usage, runtime, goalResult] = await Promise.all([
      this.core.rpc.getConfig({ sessionId: id, agentId }),
      this.core.rpc.getContext({ sessionId: id, agentId }),
      this.core.rpc.getPermission({ sessionId: id, agentId }),
      this.core.rpc.getDiscussMode({ sessionId: id, agentId }),
      this.core.rpc.getUsage?.({ sessionId: id, agentId }),
      this.core.rpc.getNoriRuntimeSettings({ sessionId: id, agentId }),
      this.core.rpc.getGoal({ sessionId: id, agentId }),
    ]);

    const maxContextTokens = config.modelCapabilities?.max_context_tokens ?? 0;
    const contextTokens = context.tokenCount;
    const contextUsage = maxContextTokens > 0 ? contextTokens / maxContextTokens : 0;

    const agentState = this.promptService.getAgentStateSnapshot(id, agentId);

    const realtimeUsage = mapRealtimeUsage(usage);
    const status = await this._readAuthoritativeStatus(id, agentId);
    return {
      status,
      model: config.modelAlias ?? config.provider?.model,
      thinking_level: config.thinkingEffort,
      permission: permission.mode,
      discuss_mode: agentState?.discussMode ?? discussMode,
      main_write_enabled: !runtime.toolsReadonly,
      goal: goalResult.goal,
      context_tokens: contextTokens,
      max_context_tokens: maxContextTokens,
      context_usage: contextUsage,
      ...(realtimeUsage === undefined ? {} : { usage: realtimeUsage }),
    };
  }

  async getSessionWarnings(id: string): Promise<readonly SessionWarning[]> {
    const all = await this.core.rpc.listSessions({});
    if (!all.some((s) => s.id === id)) {
      throw new SessionNotFoundError(id);
    }
    try {
      await this.core.rpc.resumeSession({ sessionId: id });
    } catch {
      // best-effort: the session may already be loaded in core memory.
    }
    try {
      return await this.core.rpc.getSessionWarnings({ sessionId: id });
    } catch {
      return [];
    }
  }

  async compact(id: string, input: CompactSessionRequest): Promise<CompactSessionResponse> {
    const all = await this.core.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }

    // beginCompaction only sees sessions loaded in core memory — resume first
    // (mirrors undo) so compacting a freshly-opened session doesn't throw
    // SESSION_NOT_FOUND.
    await this.core.rpc.resumeSession({ sessionId: id });

    const instruction = normalizeOptionalString(input.instruction);
    const agentId = input.agent_id ?? MAIN_AGENT_ID;
    await this.core.rpc.beginCompaction({
      sessionId: id,
      agentId,
      instruction,
    });
    return {};
  }

  async undo(id: string, input: UndoSessionRequest): Promise<UndoSessionResponse> {
    const summary = await this.requireSummary(id);
    await this.core.rpc.resumeSession({ sessionId: id });
    const agentId = input.agent_id ?? MAIN_AGENT_ID;
    const before = await this.core.rpc.getContext({ sessionId: id, agentId });
    if (!canUndoHistory(before.history, input.count)) {
      throw new SessionUndoUnavailableError(id);
    }

    try {
      await this.core.rpc.undoHistory({
        sessionId: id,
        agentId,
        count: input.count,
      });
    } catch (error) {
      if (error instanceof KimiError && error.code === ErrorCodes.REQUEST_INVALID) {
        throw new SessionUndoUnavailableError(id, error.message);
      }
      throw error;
    }

    const after = await this.core.rpc.getContext({ sessionId: id, agentId });
    return {
      messages: pageContextMessages(id, summary.createdAt, after, input.page_size),
      status: await this.getStatus(id, agentId, false),
    };
  }

  async archive(id: string): Promise<{ archived: true }> {
    const all = await this.core.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }
    await this.core.rpc.archiveSession({ sessionId: id });
    this._onDidClose.fire({ sessionId: id });
    this._clearAgentRuntimeState(id);
    return { archived: true };
  }

  async delete(id: string): Promise<{ deleted: true }> {
    const all = await this.core.rpc.listSessions({ includeArchive: true });
    const summary = all.find((session) => session.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }
    await this.core.rpc.deleteSession({ sessionId: id });
    this._onDidClose.fire({ sessionId: id });
    this._clearAgentRuntimeState(id);
    return { deleted: true };
  }

  private async requireSummary(id: string): Promise<SessionSummary> {
    const all = await this.core.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }
    return summary;
  }

  private _clearAgentRuntimeState(sessionId: string): void {
    const prefix = `${sessionId}\u0000`;
    for (const map of [this._statusByAgent, this._lastActivityByAgent, this._activeBackgroundTasks]) {
      for (const key of map.keys()) {
        if (key.startsWith(prefix)) map.delete(key);
      }
    }
    for (const set of [this._activeTurns, this._abortedTurns]) {
      for (const key of set) {
        if (key.startsWith(prefix)) set.delete(key);
      }
    }
  }

  private async tryGetMeta(id: string): Promise<SessionMeta | undefined> {
    try {
      const meta = await this.core.rpc.getSessionMetadata({ sessionId: id });
      return meta;
    } catch {
      return undefined;
    }
  }

  private async _attachUsage(session: Session): Promise<void> {
    try {
      const usage = await this.core.rpc.getUsage({ sessionId: session.id, agentId: 'main' });
      session.usage = mapSessionUsage(usage) ?? session.usage;
    } catch {
      // Unloaded historical sessions keep their persisted protocol fallback.
    }
  }

  override dispose(): void {
    if (this._store.isDisposed) return;
    super.dispose();
  }
}

registerSingleton(ISessionService, SessionService, InstantiationType.Delayed);
