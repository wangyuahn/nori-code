import { createDecorator } from '../../di';
import { encodeWorkDirKey } from '../../session/store';
import type { Event } from '../../base/common/event';
import type { SessionSummary } from '../../rpc';
import type { SessionMeta } from '../../session';
import {
  emptySessionUsage,
  type CompactSessionRequest,
  type CompactSessionResponse,
  type CursorQuery,
  type PageResponse,
  type Session,
  type SessionAgentTreeResponse,
  type SessionAgentChatResponse,
  type SessionAgentSystemPromptResponse,
  type SessionChildCreate,
  type SessionCreate,
  type SessionFork,
  type SessionGraphResponse,
  type SessionMount,
  type SessionRemount,
  type SessionStatusResponse,
  type SessionWarning,
  type SessionUpdate,
  type UndoSessionRequest,
  type UndoSessionResponse,
} from '@nori-code/protocol';

export interface SessionListQuery extends CursorQuery {
  status?: import('@nori-code/protocol').SessionStatus;
  workDir?: string;
  includeArchive?: boolean;
  /** When true, hide sessions the user has never interacted with (no prompt yet). */
  excludeEmpty?: boolean;
}

export interface SessionClientTelemetry {
  id?: string;
  name?: string;
  version?: string;
  uiMode?: string;
}

export interface SessionCreateOptions {
  client?: SessionClientTelemetry;
}

export interface ISessionService {
  readonly _serviceBrand: undefined;

  create(input: SessionCreate, options?: SessionCreateOptions): Promise<Session>;

  list(query: SessionListQuery): Promise<PageResponse<Session>>;

  get(id: string): Promise<Session>;

  update(id: string, input: SessionUpdate, agentId?: string): Promise<Session>;

  fork(id: string, input: SessionFork): Promise<Session>;

  listChildren(id: string, query: SessionListQuery): Promise<PageResponse<Session>>;

  createChild(id: string, input: SessionChildCreate): Promise<Session>;

  /** Mount `id` under `parent_session_id` (single parent; rejects cycles). */
  mount(id: string, input: SessionMount): Promise<Session>;

  /** Clear mount so `id` becomes a top-level session. */
  unmount(id: string): Promise<Session>;

  /** Remount `id` under a new parent (same as mount with a different parent). */
  remount(id: string, input: SessionRemount): Promise<Session>;

  /** All visible sessions plus mount edges derived from `parent_session_id`. */
  getGraph(query?: SessionListQuery): Promise<SessionGraphResponse>;

  getStatus(id: string, agentId?: string, ensureResumed?: boolean): Promise<SessionStatusResponse>;

  listAgents(id: string): Promise<SessionAgentTreeResponse>;

  /**
   * The department Chat log visible from `agentId`. Only a team member sees
   * its department's log; any other node (main, a lead, unknown id) gets an
   * empty log with a null leader — the parent never reads its members' chat.
   */
  getDepartmentChat(id: string, agentId: string): Promise<SessionAgentChatResponse>;

  /** The effective system prompt of one agent transcript; empty when unknown. */
  getAgentSystemPrompt(id: string, agentId: string): Promise<SessionAgentSystemPromptResponse>;

  /** Returns active agent work without resuming or loading session transcripts. */
  listActiveAgentActivity?(): readonly SessionAgentActivity[];

  getSessionWarnings(id: string): Promise<readonly SessionWarning[]>;

  compact(id: string, input: CompactSessionRequest): Promise<CompactSessionResponse>;

  undo(id: string, input: UndoSessionRequest): Promise<UndoSessionResponse>;

  archive(id: string): Promise<{ archived: true }>;

  delete?(id: string): Promise<{ deleted: true }>;

  readonly onDidCreate: Event<{ session: Session }>;

  readonly onDidClose: Event<{ sessionId: string }>;
}

export interface SessionAgentActivity {
  readonly sessionId: string;
  readonly agentId: string;
  readonly kind: 'agent' | 'background';
  readonly taskId?: string;
  readonly status: import('@nori-code/protocol').SessionStatus;
  readonly lastActive: string | undefined;
}

export const ISessionService = createDecorator<ISessionService>('sessionService');

export class SessionUndoUnavailableError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string, message = 'Nothing to undo in the active context.') {
    super(message);
    this.name = 'SessionUndoUnavailableError';
    this.sessionId = sessionId;
  }
}

export class SessionNotFoundError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`session ${sessionId} does not exist`);
    this.name = 'SessionNotFoundError';
    this.sessionId = sessionId;
  }
}

export class SessionMountCycleError extends Error {
  readonly sessionId: string;
  readonly parentSessionId: string;
  constructor(sessionId: string, parentSessionId: string) {
    super(`mounting session ${sessionId} under ${parentSessionId} would create a cycle`);
    this.name = 'SessionMountCycleError';
    this.sessionId = sessionId;
    this.parentSessionId = parentSessionId;
  }
}

export function toProtocolSession(
  summary: SessionSummary,
  meta?: SessionMeta | undefined,
): Session {
  const summaryMetadata = (summary.metadata ?? {}) as Record<string, unknown>;
  const customMetadata = (meta?.custom ?? {}) as Record<string, unknown>;
  const cwd =
    (typeof customMetadata['cwd'] === 'string' && customMetadata['cwd']) ||
    (typeof summaryMetadata['cwd'] === 'string' && summaryMetadata['cwd']) ||
    summary.workDir;

  const { goal: _dropSummaryGoal, ...summaryWithoutGoal } = summaryMetadata;
  const { goal: _dropCustomGoal, ...customWithoutGoal } = customMetadata;

  const mergedMetadata: Session['metadata'] = {
    ...summaryWithoutGoal,
    ...customWithoutGoal,
    cwd,
  };

  const title = visibleSessionTitle(meta?.title ?? summary.title);
  const workspaceId = encodeWorkDirKey(summary.workDir);
  const totalUsage = summary.usage?.total;
  const messageCount = summary.messageCount ?? 0;
  const usage = totalUsage === undefined
    ? emptySessionUsage()
    : {
        input_tokens: totalUsage.inputOther,
        output_tokens: totalUsage.output,
        cache_read_tokens: totalUsage.inputCacheRead,
        cache_creation_tokens: totalUsage.inputCacheCreation,
        total_cost_usd: 0,
        context_tokens: 0,
        context_limit: 0,
        turn_count: messageCount,
      };

  return {
    id: summary.id,
    workspace_id: workspaceId,
    title,
    created_at: new Date(summary.createdAt).toISOString(),
    updated_at: new Date(summary.updatedAt).toISOString(),
    status: 'idle',
    archived: summary.archived === true,
    last_prompt: summary.lastPrompt,
    metadata: mergedMetadata,
    agent_config: {
      model: summary.model ?? '',
    },
    usage,
    permission_rules: [],
    message_count: messageCount,
    last_seq: 0,
  };
}

function visibleSessionTitle(title: string | undefined): string {
  if (title === undefined) return '';
  return /^\s*<(?:system-reminder|nori-session-title)>/i.test(title) ? '' : title;
}
