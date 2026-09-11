import type { Session, SessionAgent, SessionGraphEdge } from '../api/client';
import type { PendingTopologyOp, SessionMapDoc, SessionMapEdge } from '../components/sessionMapDoc';
import {
  addSessionMapEdge,
  edgesForLayout,
  incomingParentEdgeCount,
  seedEdgesFromServerGraph,
} from '../components/sessionMapDoc';
import { parentSessionIdOf, wouldCreateMountCycle } from './session-mount';

/** Permission-gated tool name for top-level self-bootstrap role (P1 stub). */
export const SELF_BOOTSTRAP_ROLE_TOOL = 'SessionSelfBootstrap';

/** Unified map node — one class for sessions, agents, roots, and mounted children. */
export interface MapNodeMember {
  session: Session;
  hostSessionId?: string;
  agent?: SessionAgent;
  kind: 'session' | 'agent';
}

export type MapNodeStatusTone = 'running' | 'working' | 'idle' | 'error' | 'other';

export interface MapNodeGraphContext {
  sessions: readonly Session[];
  mapEdges?: readonly SessionMapEdge[];
  /** Local top-level self-bootstrap roles (map doc) until server sync. */
  topLevelRoles?: Readonly<Record<string, string>>;
  hasOpenAgentHandler?: boolean;
}

export interface MapNodeCapabilities {
  wireSessionId: string | null;
  status: string;
  statusTone: MapNodeStatusTone;
  isTopLevel: boolean;
  isMember: boolean;
  isAgentGhost: boolean;
  isRealSession: boolean;
  canSelfBootstrapRole: boolean;
  canWireOut: boolean;
  canWireIn: boolean;
  canDelete: boolean;
  canDisconnect: boolean;
  canOpenAsSession: boolean;
  canOpenAsAgent: boolean;
  canMountOthers: boolean;
  displayTier: 'top' | 'mounted' | 'member';
}

export function sessionIsBusy(session: Session | undefined): boolean {
  return session?.status === 'running' || session?.status === 'working';
}

export function mapMemberStatus(member: MapNodeMember): string {
  const agentStatus = member.agent?.status?.trim();
  if (agentStatus) return agentStatus;
  return member.session.status?.trim() || 'idle';
}

export function mapStatusTone(status: string): MapNodeStatusTone {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'running') return 'running';
  if (normalized === 'working') return 'working';
  if (normalized === 'idle' || normalized === 'pending' || normalized === 'stopped' || normalized === 'paused') {
    return 'idle';
  }
  if (normalized === 'error' || normalized === 'failed') return 'error';
  return 'other';
}

/** CSS class for sidebar-style status dots on map cards and list rows. */
export function mapStatusDotClass(status: string): string {
  const tone = mapStatusTone(status);
  if (tone === 'running') return 'running';
  if (tone === 'working') return 'active';
  if (tone === 'error') return 'error';
  if (tone === 'idle') return 'idle';
  return 'stopped';
}

/**
 * Real session id that owns an OUT/IN wire.
 * Priority: real session card id → dual-write mounted_session_id.
 */
export function wireSourceParentSessionId(member: MapNodeMember): string | null {
  if (member.kind === 'agent') return null;
  if (member.kind === 'session') {
    const id = member.session.id.trim();
    if (id.length > 0 && !id.startsWith('agent:')) return id;
  }
  return null;
}

/** True when the session has no incoming parent edge and no server parent metadata. */
export function isTopLevelSessionNode(
  sessionId: string,
  edges: readonly SessionMapEdge[],
  sessions: readonly Session[],
): boolean {
  if (incomingParentEdgeCount(sessionId, edges) > 0) return false;
  const node = sessions.find((session) => session.id === sessionId);
  return parentSessionIdOf(node) === undefined;
}

/** Top-level nodes may self-bootstrap role; mounted members may not. */
export function allowsSelfBootstrapRole(
  sessionId: string,
  doc: { edges?: readonly SessionMapEdge[] },
  sessions: readonly Session[],
): boolean {
  return isTopLevelSessionNode(sessionId, doc.edges ?? [], sessions);
}

/** Whether `childId` may mount under `parentId` without creating a cycle. */
export function canMountMemberUnder(
  childId: string,
  parentId: string,
  sessions: readonly Session[],
  mapParentByChild?: ReadonlyMap<string, string>,
): boolean {
  if (childId === parentId) return false;
  return !wouldCreateMountCycle(childId, parentId, sessions, mapParentByChild);
}

/** Build child→parent map from SessionMapDoc parent edges. */
export function mapParentByChildFromEdges(
  mapEdges: readonly { type: string; source: string; target: string }[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const edge of mapEdges) {
    if (edge.type !== 'parent') continue;
    out.set(edge.target, edge.source);
  }
  return out;
}

/**
 * Permission matrix for a single map node.
 * UI reads these flags — avoid branching on `kind === 'agent'` across the page.
 */
export function mapNodeCapabilities(
  member: MapNodeMember,
  context: MapNodeGraphContext,
): MapNodeCapabilities {
  const { sessions, mapEdges = [], hasOpenAgentHandler = false } = context;
  const wireSessionId = wireSourceParentSessionId(member);
  const isAgentGhost = member.kind === 'agent' || member.session.id.startsWith('agent:');
  const isRealSession = member.kind === 'session' && !member.session.id.startsWith('agent:');
  const parentId = parentSessionIdOf(member.session) ?? member.hostSessionId;
  const sessionIdForTop = wireSessionId ?? (isRealSession ? member.session.id : undefined);
  const isTopLevel = parentId === undefined
    && !isAgentGhost
    && (sessionIdForTop === undefined || isTopLevelSessionNode(sessionIdForTop, mapEdges, sessions));
  const isMember = parentId !== undefined || isAgentGhost || member.agent !== undefined;
  const status = mapMemberStatus(member);
  const statusTone = mapStatusTone(status);
  const canSelfBootstrapRole = sessionIdForTop !== undefined
    && allowsSelfBootstrapRole(sessionIdForTop, { edges: mapEdges }, sessions);
  const canWireOut = wireSessionId !== null;
  const canWireIn = isRealSession;
  const canDelete = isRealSession;
  const canDisconnect = isRealSession && parentSessionIdOf(member.session) !== undefined;
  const canOpenAsSession = isRealSession;
  const canOpenAsAgent = parentId !== undefined
    && member.agent !== undefined
    && hasOpenAgentHandler;
  const canMountOthers = canWireOut;
  const displayTier: MapNodeCapabilities['displayTier'] = isAgentGhost || member.agent
    ? 'member'
    : parentId !== undefined
      ? 'mounted'
      : 'top';

  return {
    wireSessionId,
    status,
    statusTone,
    isTopLevel,
    isMember,
    isAgentGhost,
    isRealSession,
    canSelfBootstrapRole,
    canWireOut,
    canWireIn,
    canDelete,
    canDisconnect,
    canOpenAsSession,
    canOpenAsAgent,
    displayTier,
    canMountOthers,
  };
}

/** Resolve role label: agent → mount metadata → local top-level bootstrap. */
export function mapMemberRoleLabel(
  member: MapNodeMember,
  topLevelRoles: Readonly<Record<string, string>> = {},
): string | undefined {
  if (typeof member.agent?.role === 'string' && member.agent.role.trim()) return member.agent.role;
  const mountRole = member.session.metadata?.mount_role;
  if (typeof mountRole === 'string' && mountRole.trim()) return mountRole;
  const wireId = wireSourceParentSessionId(member);
  if (wireId !== null) {
    const local = topLevelRoles[wireId];
    if (typeof local === 'string' && local.trim()) return local.trim();
  }
  return undefined;
}

/** Pending mount ops whose sessions are idle and safe to apply. */
export function pendingTopologyOpsReady(
  doc: SessionMapDoc,
  sessions: readonly Session[],
): PendingTopologyOp[] {
  const pending = doc.pendingTopology ?? [];
  return pending.filter((op) => {
    const child = sessions.find((session) => session.id === op.childSessionId);
    if (child === undefined) return false;
    if (sessionIsBusy(child)) return false;
    if (op.kind === 'unmount') return true;
    const parentId = op.parentSessionId;
    if (parentId === undefined) return false;
    const parent = sessions.find((session) => session.id === parentId);
    if (parent === undefined) return false;
    if (sessionIsBusy(parent)) return false;
    return true;
  });
}

/** Merge persisted map edges with server mount forest for layout + rendering. */
export function mergeGraphWithMapEdges(
  sessions: readonly Session[],
  serverEdges: readonly SessionGraphEdge[],
  mapEdges: readonly SessionMapEdge[],
): { layoutEdges: SessionGraphEdge[]; visualEdges: SessionMapEdge[] } {
  const seeded = mapEdges.length > 0
    ? mapEdges
    : seedEdgesFromServerGraph(serverEdges);
  const layoutEdges = edgesForLayout(seeded, sessions);
  return { layoutEdges, visualEdges: [...seeded] };
}

export function queuePendingTopology(
  doc: SessionMapDoc,
  op: Omit<PendingTopologyOp, 'id' | 'queuedAt'>,
): SessionMapDoc {
  const pending = doc.pendingTopology ?? [];
  const filtered = pending.filter((item) => item.childSessionId !== op.childSessionId);
  return {
    ...doc,
    pendingTopology: [
      ...filtered,
      {
        ...op,
        id: `pt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        queuedAt: new Date().toISOString(),
      },
    ],
  };
}

export function clearPendingTopology(doc: SessionMapDoc, childSessionId: string): SessionMapDoc {
  const pending = doc.pendingTopology ?? [];
  const next = pending.filter((item) => item.childSessionId !== childSessionId);
  return {
    ...doc,
    pendingTopology: next.length > 0 ? next : undefined,
  };
}

/** Persist a parent edge locally (source = parent, target = child). */
export function upsertParentMapEdge(
  doc: SessionMapDoc,
  parentSessionId: string,
  childSessionId: string,
  fields?: Pick<SessionMapEdge, 'mandate' | 'task' | 'returnTo' | 'status'>,
): SessionMapDoc {
  return addSessionMapEdge(disconnectParentEdges(doc, childSessionId), {
    type: 'parent',
    source: parentSessionId,
    target: childSessionId,
    ...fields,
  });
}

/** Disconnect: remove parent edges pointing at child; keep the session node. */
export function disconnectParentEdges(doc: SessionMapDoc, childSessionId: string): SessionMapDoc {
  const edges = (doc.edges ?? []).filter((edge) => !(edge.type === 'parent' && edge.target === childSessionId));
  return {
    ...doc,
    edges: edges.length > 0 ? edges : undefined,
  };
}
