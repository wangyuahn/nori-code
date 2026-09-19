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

export type { TeamDiscussionStatementRecord };
