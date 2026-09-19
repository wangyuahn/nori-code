import type { Agent } from '../agent';
import type { TeamChatMessageRecord, TeamDiscussionStatementRecord, TeamReportRecord } from './index';

/** Snapshot of a mounted child session that is a department member. */
export interface DepartmentMemberSnapshot {
  readonly sessionId: string;
  readonly name: string;
  readonly role: string;
  readonly mandate: string;
  readonly assignedTask?: string;
  readonly assignedAt?: string;
  readonly teamReport?: TeamReportRecord;
  readonly lastTurnSkip?: { readonly reason: string; readonly error: string };
}

export interface DepartmentMemberPatch {
  readonly assignedTask?: string | null;
  readonly assignedAt?: string | null;
  readonly teamReport?: TeamReportRecord | null;
  readonly lastTurnSkip?: { readonly reason: string; readonly error: string } | null;
}

/**
 * Cross-session department operations. Durable members are child Sessions;
 * the parent Session uses this bridge to prompt them, lock writes, and record
 * sibling chat / Discuss statements without a shadow Team Agent.
 */
export interface DepartmentRuntime {
  listDirectChildren(parentSessionId: string): Promise<readonly string[]>;
  memberSnapshot(sessionId: string): Promise<DepartmentMemberSnapshot | undefined>;
  patchMember(sessionId: string, patch: DepartmentMemberPatch): Promise<void>;
  ensureMain(sessionId: string): Promise<Agent>;
  isMainRunning(sessionId: string): Promise<boolean>;
  setWriteLocked(sessionId: string, locked: boolean): Promise<void>;
  publishDiscussionStatement(
    parentSessionId: string,
    speakerSessionId: string,
    message: string,
  ): Promise<{ readonly discussionAgentId: string; readonly entryId: number }>;
  postChat(
    parentSessionId: string,
    senderSessionId: string,
    senderName: string,
    message: string,
    mentions: readonly string[],
  ): Promise<TeamChatMessageRecord>;
  migrateShadowTranscript(hostSessionId: string, agentId: string, childSessionId: string): Promise<void>;
}

export interface SessionSearchHit {
  readonly sessionId: string;
  readonly title: string;
  readonly role?: string;
  readonly parentSessionId?: string;
  readonly cwd?: string;
}

export interface SessionTopologyRuntime {
  searchSessions(query: string): Promise<readonly SessionSearchHit[]>;
  mountSession(childSessionId: string, parentSessionId: string, role?: string, mandate?: string): Promise<void>;
  remountSession(childSessionId: string, parentSessionId: string, role?: string, mandate?: string): Promise<void>;
  unmountSession(sessionId: string): Promise<void>;
  sessionGraph(): Promise<{
    readonly nodes: ReadonlyArray<{ readonly id: string; readonly title: string; readonly parentSessionId?: string }>;
  }>;
  fillChildIdentity(parentSessionId: string, brief: string): Promise<{
    readonly title: string;
    readonly role: string;
    readonly mandate: string;
  }>;
}

export function syntheticTeamMeta(snapshot: DepartmentMemberSnapshot): {
  readonly homedir: string;
  readonly type: 'sub';
  readonly parentAgentId: string;
  readonly kind: 'team';
  readonly name: string;
  readonly role: string;
  readonly mandate: string;
  readonly teamLeaderAgentId: string;
  readonly mountedSessionId: string;
  readonly assignedTask?: string;
  readonly assignedAt?: string;
  readonly teamReport?: TeamReportRecord;
  readonly lastTurnSkip?: { readonly reason: string; readonly error: string };
} {
  return {
    homedir: '',
    type: 'sub',
    parentAgentId: 'main',
    kind: 'team',
    name: snapshot.name,
    role: snapshot.role,
    mandate: snapshot.mandate,
    teamLeaderAgentId: 'main',
    mountedSessionId: snapshot.sessionId,
    assignedTask: snapshot.assignedTask,
    assignedAt: snapshot.assignedAt,
    teamReport: snapshot.teamReport,
    lastTurnSkip: snapshot.lastTurnSkip,
  };
}

function remapShadowId(id: string, fromAgentId: string, childSessionId: string): string {
  return id === fromAgentId ? childSessionId : id;
}

/**
 * Rewrite leftover parent-session team agent ids to the durable child Session
 * id after a shadow transcript has been copied across.
 */
export function remapShadowTeamAgents<T extends {
  readonly chat?: {
    readonly messages?: ReadonlyArray<{
      readonly agentId: string;
      readonly mentions: readonly string[];
    }>;
  };
  readonly discussion?: {
    readonly participantAgentIds: readonly string[];
    readonly currentTurnAgentId?: string;
    readonly readCursors?: Readonly<Record<string, number>>;
    readonly statements?: ReadonlyArray<{ readonly agentId: string }>;
  };
}>(
  agents: Readonly<Record<string, T>>,
  fromAgentId: string,
  childSessionId: string,
): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [agentId, meta] of Object.entries(agents)) {
    let updated = meta;
    const chat = meta.chat;
    if (chat?.messages !== undefined) {
      updated = {
        ...updated,
        chat: {
          ...chat,
          messages: chat.messages.map((record) => ({
            ...record,
            agentId: remapShadowId(record.agentId, fromAgentId, childSessionId),
            mentions: record.mentions.map((mention) => (
              remapShadowId(mention, fromAgentId, childSessionId)
            )),
          })),
        },
      };
    }
    const discussion = meta.discussion;
    if (discussion !== undefined) {
      const readCursors = discussion.readCursors === undefined
        ? undefined
        : Object.fromEntries(
          Object.entries(discussion.readCursors).map(([id, cursor]) => [
            remapShadowId(id, fromAgentId, childSessionId),
            cursor,
          ]),
        );
      updated = {
        ...updated,
        discussion: {
          ...discussion,
          participantAgentIds: discussion.participantAgentIds.map((id) => (
            remapShadowId(id, fromAgentId, childSessionId)
          )),
          currentTurnAgentId: discussion.currentTurnAgentId === undefined
            ? undefined
            : remapShadowId(discussion.currentTurnAgentId, fromAgentId, childSessionId),
          readCursors,
          statements: discussion.statements?.map((record) => ({
            ...record,
            agentId: remapShadowId(record.agentId, fromAgentId, childSessionId),
          })),
        },
      };
    }
    next[agentId] = updated;
  }
  return next;
}

export type { TeamDiscussionStatementRecord };
