import type {
  ApprovalRequest,
  Session,
  SessionActivity,
  SessionAgent,
  SessionGraphEdge,
} from '../api/client';
import type { PendingTopologyOp, SessionMapDoc, SessionMapEdge } from '../components/sessionMapDoc';
import {
  addSessionMapEdge,
  edgesForLayout,
  incomingParentEdgeCount,
  isLiveLayoutParentEdge,
  isUnappliedExtraJob,
  newEdgeId,
  seedEdgesFromServerGraph,
} from '../components/sessionMapDoc';
import { parentSessionIdOf, wouldCreateMountCycle } from './session-mount';

/** Map metadata for a Session card; agent data may enrich the same card. */
export interface MapNodeMember {
  session: Session;
  hostSessionId?: string;
  agent?: SessionAgent;
  kind: 'session' | 'agent';
}

export type MapNodeStatusTone = 'running' | 'working' | 'idle' | 'error' | 'waiting' | 'stopped' | 'other';

export interface MapNodeGraphContext {
  sessions: readonly Session[];
  mapEdges?: readonly SessionMapEdge[];
}

export interface MapNodeCapabilities {
  wireSessionId: string | null;
  status: string;
  statusTone: MapNodeStatusTone;
  isTopLevel: boolean;
  isRealSession: boolean;
  canWireOut: boolean;
  canWireIn: boolean;
  canDelete: boolean;
  canDisconnect: boolean;
}

export function sessionIsBusy(session: Session | undefined): boolean {
  const status = session?.status?.trim().toLowerCase();
  return status === 'running'
    || status === 'working'
    || status === 'awaiting_approval'
    || status === 'awaiting_question'
    || status === 'waiting';
}

export function mapMemberStatus(member: MapNodeMember): string {
  if (isMapTimeoutFailure(member.agent?.summary)) return 'timeout';
  const agentStatus = member.agent?.status?.trim();
  if (agentStatus) return agentStatus;
  return member.session.status?.trim() || 'idle';
}

export function mapStatusTone(status: string): MapNodeStatusTone {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'running') return 'running';
  if (normalized === 'working') return 'working';
  if (normalized === 'awaiting_approval' || normalized === 'awaiting_question' || normalized === 'waiting') {
    return 'waiting';
  }
  if (normalized === 'aborted' || normalized === 'stopped' || normalized === 'paused') return 'stopped';
  if (normalized === 'idle' || normalized === 'pending') return 'idle';
  if (normalized === 'timeout' || normalized === 'error' || normalized === 'failed') return 'error';
  return 'other';
}

export type MapRuntimeStatus = 'idle' | 'running' | 'working' | 'error' | 'waiting' | 'stopped';

export function mapRuntimeStatus(status: string): MapRuntimeStatus {
  const tone = mapStatusTone(status);
  if (tone === 'other') return 'idle';
  return tone;
}

export function formatElapsed(ms: number): string | undefined {
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${String(Math.max(1, seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)}h ${String(minutes % 60)}m`;
}

export type MapStatusFilter = 'all' | 'running' | 'error' | 'idle';

/** Readable status word shown on map cards — not the tiny status dot. */
export function formatMapStatusWord(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'running') return 'running';
  if (normalized === 'working' || normalized === 'active') return 'working';
  if (normalized === 'awaiting_approval') return 'waiting-approval';
  if (normalized === 'awaiting_question' || normalized === 'waiting') return 'waiting';
  if (normalized === 'aborted' || normalized === 'stopped' || normalized === 'paused') return 'stopped';
  if (normalized === 'idle' || normalized === 'pending') return 'idle';
  if (normalized === 'timeout') return 'timeout';
  if (normalized === 'error' || normalized === 'failed') return 'error';
  return normalized.length > 0 ? normalized : 'idle';
}

export function formatMapStatusLabel(
  status: string,
  lastActive?: string,
  now = Date.now(),
): string {
  const label = formatMapStatusWord(status);
  const runtime = mapRuntimeStatus(status);
  if (
    (runtime === 'running' || runtime === 'working' || runtime === 'waiting')
    && lastActive !== undefined
  ) {
    const elapsed = formatElapsed(now - Date.parse(lastActive));
    if (elapsed !== undefined) return `${label} · ${elapsed}`;
  }
  return label;
}

export function matchesMapStatusFilter(status: string, filter: MapStatusFilter): boolean {
  if (filter === 'all') return true;
  const runtime = mapRuntimeStatus(status);
  if (filter === 'running') {
    return runtime === 'running' || runtime === 'working' || runtime === 'waiting';
  }
  if (filter === 'error') return runtime === 'error';
  return runtime === 'idle' || runtime === 'stopped';
}

export type MapCurrentActionKind = 'thinking' | 'tool' | 'waiting-approval' | 'waiting';

export interface MapCurrentAction {
  kind: MapCurrentActionKind;
  detail?: string;
}

export interface MapLiveTurnHint {
  thinkingText?: string;
  toolName?: string;
}

export interface MapLiveHints {
  approvals: readonly Pick<ApprovalRequest, 'session_id' | 'agent_id' | 'tool_name'>[];
  activity: readonly Pick<SessionActivity, 'session_id' | 'agent_id' | 'kind' | 'status'>[];
  turns: Readonly<Record<string, MapLiveTurnHint>>;
  errors: readonly { sessionId?: string; agentId?: string; message: string }[];
}

function clipMapText(value: string, max = 80): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

function liveHintForMember(
  member: MapNodeMember,
  live: MapLiveHints | undefined,
): {
  approval?: Pick<ApprovalRequest, 'session_id' | 'agent_id' | 'tool_name'>;
  activity?: Pick<SessionActivity, 'session_id' | 'agent_id' | 'kind' | 'status'>;
  turn?: MapLiveTurnHint;
} {
  if (live === undefined) return {};
  const sessionId = member.session.id;
  const hostId = member.hostSessionId;
  const agentId = member.agent?.agent_id;
  const approval = live.approvals.find((item) => {
    if (item.session_id === sessionId) return true;
    if (hostId !== undefined && item.session_id === hostId) {
      return item.agent_id === undefined || agentId === undefined || item.agent_id === agentId;
    }
    return false;
  });
  const activity = live.activity.find((item) => {
    if (item.session_id === sessionId) return true;
    if (hostId !== undefined && item.session_id === hostId) {
      return agentId === undefined || item.agent_id === agentId;
    }
    return false;
  });
  const turn = live.turns[sessionId] ?? (hostId !== undefined ? live.turns[hostId] : undefined);
  return { approval, activity, turn };
}

/** Current action line: thinking / tool name / waiting for approval. */
export function describeMapCurrentAction(
  member: MapNodeMember,
  live?: MapLiveHints,
): MapCurrentAction | undefined {
  const status = mapMemberStatus(member);
  const { approval, activity, turn } = liveHintForMember(member, live);
  const approvalTool = approval?.tool_name?.trim() || turn?.toolName?.trim();
  if (approval !== undefined || status === 'awaiting_approval') {
    return approvalTool !== undefined && approvalTool.length > 0
      ? { kind: 'waiting-approval', detail: approvalTool }
      : { kind: 'waiting-approval' };
  }
  if (status === 'awaiting_question') return { kind: 'waiting' };
  const runningTool = turn?.toolName?.trim();
  if (runningTool !== undefined && runningTool.length > 0) {
    return { kind: 'tool', detail: runningTool };
  }
  const thinking = turn?.thinkingText?.trim();
  if (thinking !== undefined && thinking.length > 0) return { kind: 'thinking', detail: clipMapText(thinking, 48) };
  const runtime = mapRuntimeStatus(status);
  if (runtime === 'running' || runtime === 'working' || activity !== undefined) {
    const assigned = member.agent?.assigned_task?.trim();
    if (assigned !== undefined && assigned.length > 0) return { kind: 'tool', detail: clipMapText(assigned, 48) };
    return { kind: 'thinking' };
  }
  if (runtime === 'waiting') return { kind: 'waiting' };
  return undefined;
}

function isMapTimeoutFailure(text: string | undefined): boolean {
  if (text === undefined || text.trim().length === 0) return false;
  return /timed out|maximum duration|retry exhausted \(timeout/i.test(text);
}

/** Failure summary for error/blocked/timeout cards. */
export function describeMapErrorSummary(
  member: MapNodeMember,
  live?: MapLiveHints,
): string | undefined {
  const sessionId = member.session.id;
  const hostId = member.hostSessionId;
  const agentId = member.agent?.agent_id;
  const match = live?.errors.find((item) => {
    if (item.sessionId === sessionId) return true;
    if (hostId !== undefined && item.sessionId === hostId) {
      return item.agentId === undefined || agentId === undefined || item.agentId === agentId;
    }
    return false;
  });
  if (match !== undefined && match.message.trim().length > 0) return clipMapText(match.message);
  const report = member.agent?.team_report_summary?.trim();
  if (
    (member.agent?.team_report_status === 'blocked' || member.agent?.team_report_status === 'needs_decision')
    && report !== undefined
    && report.length > 0
  ) {
    return clipMapText(report);
  }
  const skip = member.agent?.summary?.trim();
  if (skip !== undefined && isMapTimeoutFailure(skip)) return clipMapText(skip);
  const runtime = mapRuntimeStatus(mapMemberStatus(member));
  if (runtime !== 'error' && runtime !== 'stopped') return undefined;
  if (skip !== undefined && skip.length > 0) return clipMapText(skip);
  const metadataError = member.session.metadata?.last_error;
  if (typeof metadataError === 'string' && metadataError.trim().length > 0) {
    return clipMapText(metadataError);
  }
  const summary = member.agent?.summary?.trim() || member.session.last_prompt?.trim();
  if (summary !== undefined && summary.length > 0) return clipMapText(summary);
  return undefined;
}

/** CSS class for sidebar-style status dots on map cards. */
export function mapStatusDotClass(status: string): string {
  const tone = mapStatusTone(status);
  if (tone === 'running') return 'running';
  if (tone === 'working') return 'active';
  if (tone === 'error') return 'error';
  if (tone === 'waiting') return 'paused';
  if (tone === 'stopped') return 'stopped';
  if (tone === 'idle') return 'idle';
  return 'stopped';
}

/**
 * Real session id that owns an OUT/IN wire.
 * Agent ghosts are not wireable; dual-write members appear as real session cards.
 */
export function wireSourceParentSessionId(member: MapNodeMember): string | null {
  if (member.kind === 'agent') return null;
  const id = member.session.id.trim();
  return id.length > 0 ? id : null;
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

/** Build child→parent map from live SessionMapDoc parent edges. */
export function mapParentByChildFromEdges(
  mapEdges: readonly Pick<SessionMapEdge, 'type' | 'source' | 'target' | 'status'>[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const edge of mapEdges) {
    if (edge.type !== 'parent') continue;
    if (isUnappliedExtraJob(edge) || edge.status === 'draft') continue;
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
  const { sessions, mapEdges = [] } = context;
  const wireSessionId = wireSourceParentSessionId(member);
  const isRealSession = member.kind === 'session';
  const parentId = parentSessionIdOf(member.session) ?? member.hostSessionId;
  const isTopLevel = parentId === undefined
    && isRealSession
    && isTopLevelSessionNode(member.session.id, mapEdges, sessions);
  const status = mapMemberStatus(member);
  const statusTone = mapStatusTone(status);
  const canWireOut = wireSessionId !== null;
  const canWireIn = isRealSession;
  const canDelete = isRealSession;
  const canDisconnect = isRealSession && (
    parentSessionIdOf(member.session) !== undefined
    || incomingParentEdgeCount(member.session.id, mapEdges) > 0
  );
  return {
    wireSessionId,
    status,
    statusTone,
    isTopLevel,
    isRealSession,
    canWireOut,
    canWireIn,
    canDelete,
    canDisconnect,
  };
}

/** Resolve the role for the work represented by a session card. */
export function mapMemberRoleLabel(
  member: MapNodeMember,
): string | undefined {
  if (typeof member.agent?.role === 'string' && member.agent.role.trim()) return member.agent.role;
  const mountRole = member.session.metadata?.mount_role;
  if (typeof mountRole === 'string' && mountRole.trim()) return mountRole;
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
  // An unapplied extra job is deliberately visual only while the server still
  // has single-parent mounts. It must not pull the child into a second force
  // component or make cycle checks/layout treat the intent as live topology.
  const effectiveForLayout = seeded.filter((edge) => isLiveLayoutParentEdge(edge));
  // Keep the server graph as a fallback when a local document contains only
  // a visual pending edge (or has not caught up with a newly mounted session).
  // Local effective edges come last so an intentional pending remount still
  // controls the temporary layout while reconciliation is in flight.
  const layoutEdges = edgesForLayout([
    ...seedEdgesFromServerGraph(serverEdges),
    ...effectiveForLayout,
  ], sessions);
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

/**
 * Persist a parent edge locally (source = parent, target = child).
 * Preserve existing parent edges so the map can represent multiple jobs.
 */
export function upsertParentMapEdge(
  doc: SessionMapDoc,
  parentSessionId: string,
  childSessionId: string,
  fields?: Pick<SessionMapEdge, 'role' | 'mandate' | 'task' | 'returnTo' | 'status'>,
): SessionMapDoc {
  const withoutSameJob = {
    ...doc,
    edges: (doc.edges ?? []).filter((edge) => !(
      edge.type === 'parent' && edge.source === parentSessionId && edge.target === childSessionId
    )),
  };
  return addSessionMapEdge(withoutSameJob, {
    type: 'parent',
    source: parentSessionId,
    target: childSessionId,
    ...fields,
  });
}

/** Legacy compatibility helper. Non-parent edge types are ignored by the map. */
export function upsertTypedMapEdge(
  doc: SessionMapDoc,
  edge: Omit<SessionMapEdge, 'id'> & { id?: string },
): SessionMapDoc {
  if (edge.type !== 'parent') return doc;
  return upsertParentMapEdge(doc, edge.source, edge.target, {
    role: edge.role,
    mandate: edge.mandate,
    task: edge.task,
    returnTo: edge.returnTo,
    status: edge.status,
  });
}

function parentEdgeSignature(edges: readonly SessionMapEdge[]): string {
  return edges
    .filter((edge) => edge.type === 'parent')
    .map((edge) => `${edge.source}->${edge.target}:${edge.status ?? ''}`)
    .sort()
    .join('|');
}

function nonParentEdgeSignature(edges: readonly SessionMapEdge[]): string {
  return edges
    .filter((edge) => edge.type !== 'parent')
    .map((edge) => `${edge.type}:${edge.source}->${edge.target}:${edge.id}`)
    .sort()
    .join('|');
}

/**
 * Align local parent edges with the server mount forest.
 * Pending topology children are left alone until flush.
 */
export function reconcileParentEdgesWithServer(
  doc: SessionMapDoc,
  serverEdges: readonly SessionGraphEdge[],
): SessionMapDoc {
  const pendingChildren = new Set(
    (doc.pendingTopology ?? []).map((op) => op.childSessionId),
  );
  const local = doc.edges ?? [];
  for (const edge of local) {
    if (edge.type === 'parent' && (
      edge.status === 'draft'
      || isUnappliedExtraJob(edge)
      || edge.status === 'error'
    )) {
      pendingChildren.add(edge.target);
    }
  }
  const nonParent = local.filter((edge) => edge.type !== 'parent');
  const localByChild = new Map<string, SessionMapEdge[]>();
  for (const edge of local) {
    if (edge.type !== 'parent') continue;
    const entries = localByChild.get(edge.target) ?? [];
    entries.push(edge);
    localByChild.set(edge.target, entries);
  }

  const nextParent: SessionMapEdge[] = [];
  const seenChildren = new Set<string>();
  for (const server of serverEdges) {
    const child = server.child_session_id;
    const parent = server.parent_session_id;
    seenChildren.add(child);
    const existing = localByChild.get(child) ?? [];
    const matching = existing.find((edge) => edge.source === parent);
    const pending = existing.filter((edge) => (
      edge.status === 'draft'
      || isUnappliedExtraJob(edge)
      || edge.status === 'error'
    ));
    // A server edge is authoritative and therefore always rendered as a live
    // work edge. Keep local identity fields when possible, but never carry a
    // pending/draft status onto an edge the server confirms as mounted.
    const metadata = matching ?? existing.find((edge) => (
      edge.status !== 'draft' && !isUnappliedExtraJob(edge)
    ));
    nextParent.push({
      id: metadata?.id ?? newEdgeId(),
      type: 'parent',
      source: parent,
      target: child,
      role: metadata?.role,
      mandate: metadata?.mandate,
      task: metadata?.task,
      returnTo: metadata?.returnTo,
    });
    for (const edge of pending) {
      if (edge.source !== parent && !nextParent.some((candidate) => candidate.id === edge.id)) {
        nextParent.push(edge);
      }
    }
  }
  for (const child of pendingChildren) {
    if (seenChildren.has(child)) continue;
    nextParent.push(...(localByChild.get(child) ?? []));
  }

  const nextEdges = [...nextParent, ...nonParent];
  if (
    parentEdgeSignature(local) === parentEdgeSignature(nextEdges)
    && nonParentEdgeSignature(local) === nonParentEdgeSignature(nextEdges)
  ) {
    return doc;
  }
  return { ...doc, version: 2, edges: nextEdges.length > 0 ? nextEdges : [] };
}

/** Disconnect: remove parent edges pointing at child; keep the session node. */
export function disconnectParentEdges(doc: SessionMapDoc, childSessionId: string): SessionMapDoc {
  const edges = (doc.edges ?? []).filter((edge) => !(edge.type === 'parent' && edge.target === childSessionId));
  return {
    ...doc,
    edges: edges.length > 0 ? edges : undefined,
  };
}
