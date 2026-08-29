/**
 * Department-tree rules for Team Engineering.
 *
 * A Team is a tree. `main` is the root; every durable Team Agent is a node that
 * may hire its own members, and a node plus its direct children form one
 * **department**. A discussion belongs to a department: the parent leads it and
 * its direct children participate.
 *
 * Everything here is a pure function over the session's agent metadata map so
 * the rules can be read and tested without a live Session. The module declares
 * the narrow shape it needs rather than importing `AgentMeta`, which keeps it
 * free of any dependency on the 2000-line session module that uses it.
 */

/** How many Team levels may exist below `main` when config sets no limit. */
export const DEFAULT_TEAM_MAX_DEPTH = 2;

/** The department-tree fields this module reads from a session's `AgentMeta`. */
export interface TeamTreeNode {
  readonly kind?: 'team' | 'sub';
  readonly teamLeaderAgentId?: string;
  readonly discussion?: {
    readonly status: 'active' | 'archived';
    readonly participantAgentIds: readonly string[];
  };
}

export type TeamTree = Readonly<Record<string, TeamTreeNode>>;

/**
 * Depth of `agentId` below the root. `main` is 0, a member of main's department
 * is 1, a member of that member's department is 2.
 *
 * A corrupt parent chain — a cycle, or a parent that no longer exists — is
 * treated as attaching to the root rather than looping forever, matching how the
 * agent tree reparents orphans to `main` for display.
 */
export function teamDepth(agents: TeamTree, agentId: string): number {
  let depth = 0;
  const visited = new Set<string>([agentId]);
  let current = agents[agentId]?.teamLeaderAgentId;
  while (current !== undefined && !visited.has(current)) {
    depth += 1;
    visited.add(current);
    if (current === 'main') break;
    current = agents[current]?.teamLeaderAgentId;
  }
  return depth;
}

/**
 * Whether `agentId` may hire members of its own. Depth counts Team levels below
 * `main`, so a node at depth `maxDepth` is the last level and hires nobody.
 */
export function canCreateDepartment(agents: TeamTree, agentId: string, maxDepth: number): boolean {
  return teamDepth(agents, agentId) < maxDepth;
}

/** A tree node paired with the id it is stored under. */
export interface TeamTreeAgent {
  readonly agentId: string;
  /** `undefined` when the id names no agent — dismissed, or never hired. */
  readonly node: TeamTreeNode | undefined;
}

/** How a direct-message target relates to the sender in the tree. */
export type TeamDirectMessageRelation = 'parent' | 'sibling' | 'member';

/**
 * Whether `sender` may direct-message `target`, and in what capacity. A node
 * reaches its parent (report up), its siblings (the department it participates
 * in), and its own members (the department it chairs) — the two departments it
 * belongs to, and nothing further away.
 *
 * Anyone else is unreachable on purpose: routing a message through the shared
 * parent is what keeps the node that owns a decision aware that it was made.
 * Returns `undefined` when the pair is unreachable, either end is not a tree
 * node, or the sender addressed itself.
 */
export function directMessageRelation(
  sender: TeamTreeAgent,
  target: TeamTreeAgent,
): TeamDirectMessageRelation | undefined {
  if (sender.agentId === target.agentId) return undefined;
  if (sender.node === undefined || target.node === undefined) return undefined;
  // A discussion transcript records a department's discussion; it is not a node
  // in the tree, so it neither sends nor receives.
  if (sender.agentId !== 'main' && sender.node.kind !== 'team') return undefined;
  if (target.agentId !== 'main' && target.node.kind !== 'team') return undefined;

  // `main` is the root: it has no parent to report to and no siblings.
  const senderParent = sender.agentId === 'main' ? undefined : sender.node.teamLeaderAgentId;
  if (senderParent !== undefined && target.agentId === senderParent) return 'parent';
  if (target.node.teamLeaderAgentId === sender.agentId) return 'member';
  if (senderParent !== undefined && target.node.teamLeaderAgentId === senderParent) return 'sibling';
  return undefined;
}

/**
 * The active discussion `agentId` is a participant in, if any — that is, the one
 * its parent department is running. Returns the discussion transcript's agent id.
 *
 * A node discusses in at most one department at a time. This is what lets the
 * caller refuse a node its own discussion while it still owes its parent a
 * statement: participating in two at once would have the same agent answering
 * two scheduled turns, and its own members would block on statements it cannot
 * write.
 */
export function activeDiscussionAsParticipant(agents: TeamTree, agentId: string): string | undefined {
  const entry = Object.entries(agents).find(([, node]) =>
    node.discussion?.status === 'active'
    && node.discussion.participantAgentIds.includes(agentId),
  );
  return entry?.[0];
}

/**
 * Session-mount department tree (P1): parent is `parent_session_id` on session
 * metadata. Discuss/Assign still address agents, but hiring depth and identity
 * resolve from this mount graph when available.
 */
export type SessionMountTree = Readonly<Record<string, string | undefined>>;

/** Depth of `sessionId` below a top-level root (no parent → 0). */
export function sessionMountDepth(parentById: SessionMountTree, sessionId: string): number {
  let depth = 0;
  const visited = new Set<string>([sessionId]);
  let current = parentById[sessionId];
  while (current !== undefined && !visited.has(current)) {
    depth += 1;
    visited.add(current);
    current = parentById[current];
  }
  return depth;
}

export function canCreateMountedDepartment(
  parentById: SessionMountTree,
  sessionId: string,
  maxDepth: number,
): boolean {
  return sessionMountDepth(parentById, sessionId) < maxDepth;
}

/** Direct mounted children of `parentSessionId`. */
export function mountedChildrenOf(
  parentById: SessionMountTree,
  parentSessionId: string,
): string[] {
  return Object.entries(parentById)
    .filter(([, parent]) => parent === parentSessionId)
    .map(([id]) => id)
    .toSorted();
}

/**
 * Resolve an agent's department depth. Mounted sessions are the authoritative
 * representation when the caller can map the agent to one; otherwise fall back
 * to the in-session agent tree. A TeamCreate member may be represented in both
 * trees, so adding the two depths would count the same department twice.
 */
export function departmentDepth(input: {
  readonly agents: TeamTree;
  readonly agentId: string;
  readonly parentById?: SessionMountTree;
  readonly sessionIdForAgent?: string;
}): number {
  const sessionId = input.sessionIdForAgent;
  if (
    sessionId !== undefined
    && input.parentById !== undefined
    && Object.hasOwn(input.parentById, sessionId)
  ) {
    return sessionMountDepth(input.parentById, sessionId);
  }
  return teamDepth(input.agents, input.agentId);
}

/** Whether `agentId` may hire, counting both the mount tree and the agent tree. */
export function canCreateDepartmentInTree(input: {
  readonly agents: TeamTree;
  readonly agentId: string;
  readonly maxDepth: number;
  readonly parentById?: SessionMountTree;
  readonly sessionIdForAgent?: string;
}): boolean {
  return departmentDepth(input) < input.maxDepth;
}
