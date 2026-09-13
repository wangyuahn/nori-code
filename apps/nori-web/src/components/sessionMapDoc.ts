/**
 * Conversation-map document: explicit session-node edges (source of truth for topology
 * chrome), note boxes, and pinned positions. Persisted in localStorage so
 * nori-web stays off agent-core until server graph storage lands.
 * Legacy label fields are parsed for forward compatibility but are not rendered
 * by the map. Identity labels belong to the session identity panel.
 */

import type { Session, SessionGraph, SessionGraphEdge } from '../api/client';
import { parentSessionIdOf } from '../utils/session-mount';

export const SESSION_MAP_DOC_KEY = 'nori-session-map-doc';
/** Stale-while-revalidate cache so map members paint before getAgents returns. */
export const SESSION_MAP_AGENTS_CACHE_KEY = 'nori-session-map-agents-cache';
export const SESSION_MAP_GRAPH_CACHE_KEY = 'nori-session-map-graph-cache';

/** Last successful graph response used for stale-while-revalidate first paint. */
export function loadCachedMapGraph(): SessionGraph | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(SESSION_MAP_GRAPH_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SessionGraph;
    if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveCachedMapGraph(graph: SessionGraph): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(SESSION_MAP_GRAPH_CACHE_KEY, JSON.stringify(graph));
  } catch {
    // Storage is best effort; the live graph remains authoritative.
  }
}

/** Lightweight agent ghost snapshot for first-paint map hydration. */
export interface CachedMapAgent {
  hostId: string;
  agentId: string;
  mounted_session_id?: string;
  title?: string;
  role?: string;
  status?: string;
  mandate?: string;
}

export interface MapAnnotationBox {
  readonly id: string;
  title: string;
  /** Hex/CSS color; missing/invalid values normalize on parse. */
  color: string;
  /** Legacy soft bindings are read but never maintained by the map. */
  nodeIds?: string[];
  rect?: { x: number; y: number; width: number; height: number };
}

export interface MapLabelDef {
  readonly id: string;
  name: string;
  color: string;
}

export type SessionMapEdgeType = 'parent';

/** Explicit map edge — persisted as topology truth (server sync for parent edges). */
export interface SessionMapEdge {
  readonly id: string;
  type: SessionMapEdgeType;
  /** Parent session id for this job. */
  source: string;
  /** Child session id receiving this job. */
  target: string;
  role?: string;
  mandate?: string;
  task?: string;
  returnTo?: string;
  status?: string;
}

/** Deferred mount/unmount until the affected agent turn finishes (P1 queue). */
export interface PendingTopologyOp {
  readonly id: string;
  kind: 'mount' | 'unmount' | 'remount';
  childSessionId: string;
  parentSessionId?: string;
  role?: string;
  mandate?: string;
  queuedAt: string;
}

export interface SessionMapDoc {
  version: 1 | 2;
  annotations: MapAnnotationBox[];
  labels: MapLabelDef[];
  /** sessionId → label ids */
  sessionLabels: Record<string, string[]>;
  /**
   * Force-node id (`session:…`, legacy `agent:…`, `draft:…`) → pinned world
   * **center**. Bare session ids are accepted on read and rewritten to
   * `session:id` on the next persist so refresh never treats them as new.
   */
  positions?: Record<string, { x: number; y: number }>;
  /** Explicit edges — source of truth for map topology (P1). */
  edges?: SessionMapEdge[];
  /** Mount mutations waiting for idle sessions (applied after agent turn). */
  pendingTopology?: PendingTopologyOp[];
}

export const DEFAULT_ANNOTATION_COLORS = [
  '#3b82f6',
  '#22c55e',
  '#eab308',
  '#ef4444',
  '#a855f7',
  '#06b6d4',
] as const;

export function emptySessionMapDoc(): SessionMapDoc {
  return { version: 2, annotations: [], labels: [], sessionLabels: {}, edges: [] };
}

export function newEdgeId(): string {
  return `edge_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function isSessionMapEdge(value: unknown): value is SessionMapEdge {
  if (value === null || typeof value !== 'object') return false;
  const edge = value as SessionMapEdge;
  if (typeof edge.id !== 'string' || typeof edge.source !== 'string' || typeof edge.target !== 'string') {
    return false;
  }
  return edge.type === 'parent';
}

export function normalizeSessionMapEdge(edge: SessionMapEdge): SessionMapEdge {
  const out: SessionMapEdge = {
    id: edge.id,
    type: edge.type,
    source: edge.source,
    target: edge.target,
  };
  if (typeof edge.mandate === 'string' && edge.mandate.trim()) out.mandate = edge.mandate.trim();
  if (typeof edge.role === 'string' && edge.role.trim()) out.role = edge.role.trim();
  if (typeof edge.task === 'string' && edge.task.trim()) out.task = edge.task.trim();
  if (typeof edge.returnTo === 'string' && edge.returnTo.trim()) out.returnTo = edge.returnTo.trim();
  if (typeof edge.status === 'string' && edge.status.trim()) out.status = edge.status.trim();
  return out;
}

/** Derive parent edges from server mount forest when local store is empty. */
export function seedEdgesFromServerGraph(serverEdges: readonly SessionGraphEdge[]): SessionMapEdge[] {
  return serverEdges.map((edge) => ({
    id: newEdgeId(),
    type: 'parent' as const,
    source: edge.parent_session_id,
    target: edge.child_session_id,
  }));
}

/** Local-only extra job while the server still stores a single parent. */
export const UNAPPLIED_EXTRA_JOB_STATUS = 'pending-multi-parent';

export function isUnappliedExtraJob(
  edge: Pick<SessionMapEdge, 'type' | 'status'>,
): boolean {
  return edge.type === 'parent' && edge.status === UNAPPLIED_EXTRA_JOB_STATUS;
}

/** Count all incoming work edges for a session, including unapplied extra jobs. */
export function incomingParentEdgeCount(
  sessionId: string,
  edges: readonly SessionMapEdge[],
): number {
  return edges.filter((edge) => edge.type === 'parent' && edge.target === sessionId).length;
}

/** Layout uses parent edges only; falls back to session metadata when store is empty. */
export function edgesForLayout(
  mapEdges: readonly SessionMapEdge[],
  sessions: readonly Session[],
): SessionGraphEdge[] {
  // Prefer mapDoc parent edges, then fill gaps from server metadata so a
  // createChild / mount that has not yet been dual-written into mapDoc still
  // appears under its parent instead of as a second forest root.
  const byChild = new Map<string, SessionGraphEdge>();
  for (const edge of mapEdges) {
    if (edge.type !== 'parent') continue;
    byChild.set(edge.target, {
      parent_session_id: edge.source,
      child_session_id: edge.target,
    });
  }
  for (const session of sessions) {
    if (byChild.has(session.id)) continue;
    const parentId = parentSessionIdOf(session);
    if (parentId !== undefined) {
      byChild.set(session.id, {
        parent_session_id: parentId,
        child_session_id: session.id,
      });
    }
  }
  return [...byChild.values()];
}

export function addSessionMapEdge(
  doc: SessionMapDoc,
  edge: Omit<SessionMapEdge, 'id'> & { id?: string },
): SessionMapDoc {
  const normalized = normalizeSessionMapEdge({
    id: edge.id ?? newEdgeId(),
    type: edge.type,
    source: edge.source,
    target: edge.target,
    role: edge.role,
    mandate: edge.mandate,
    task: edge.task,
    returnTo: edge.returnTo,
    status: edge.status,
  });
  const edges = [...(doc.edges ?? []), normalized];
  return { ...doc, version: 2, edges };
}

export function removeSessionMapEdge(doc: SessionMapDoc, edgeId: string): SessionMapDoc {
  const edges = (doc.edges ?? []).filter((edge) => edge.id !== edgeId);
  return { ...doc, edges: edges.length > 0 ? edges : [] };
}

export function removeSessionMapEdgeByEndpoints(
  doc: SessionMapDoc,
  type: SessionMapEdgeType,
  source: string,
  target: string,
): SessionMapDoc {
  const edges = (doc.edges ?? []).filter((edge) => !(
    edge.type === type && edge.source === source && edge.target === target
  ));
  return { ...doc, edges: edges.length > 0 ? edges : [] };
}

/** Remove all edges touching a deleted session node. */
export function removeEdgesForSession(doc: SessionMapDoc, sessionId: string): SessionMapDoc {
  const edges = (doc.edges ?? []).filter((edge) => edge.source !== sessionId && edge.target !== sessionId);
  return { ...doc, edges: edges.length > 0 ? edges : [] };
}

export function parseSessionMapDoc(raw: string | null | undefined): SessionMapDoc {
  if (raw === null || raw === undefined || raw.trim() === '') return emptySessionMapDoc();
  try {
    const parsed = JSON.parse(raw) as Partial<SessionMapDoc>;
    if (parsed.version !== 1 && parsed.version !== 2) return emptySessionMapDoc();
    const edges = parseEdges(parsed.edges);
    return {
      version: 2,
      annotations: Array.isArray(parsed.annotations)
        ? parsed.annotations.filter(isAnnotationBox).map(normalizeAnnotationBox)
        : [],
      labels: Array.isArray(parsed.labels) ? parsed.labels.filter(isLabelDef) : [],
      sessionLabels:
        parsed.sessionLabels !== undefined && typeof parsed.sessionLabels === 'object'
          ? Object.fromEntries(
            Object.entries(parsed.sessionLabels).filter(
              ([, ids]) => Array.isArray(ids) && ids.every((id) => typeof id === 'string'),
            ),
          )
          : {},
      positions: parsePositions(parsed.positions),
      edges,
      pendingTopology: parsePendingTopology(parsed.pendingTopology),
    };
  } catch {
    return emptySessionMapDoc();
  }
}

export function loadSessionMapDoc(
  storage: Pick<Storage, 'getItem'> = localStorage,
): SessionMapDoc {
  return parseSessionMapDoc(storage.getItem(SESSION_MAP_DOC_KEY));
}

export function saveSessionMapDoc(
  doc: SessionMapDoc,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  // Drop legacy canvas labels and soft bindings on the next write. Identity
  // labels are owned by the session identity API, while annotations are free
  // rectangles with no node membership database.
  const annotations = doc.annotations.map(({ nodeIds: _legacyNodeIds, ...annotation }) => annotation);
  const { labels: _legacyLabels, sessionLabels: _legacySessionLabels, ...rest } = doc;
  storage.setItem(SESSION_MAP_DOC_KEY, JSON.stringify({ ...rest, annotations }));
}

export function parseCachedMapAgents(raw: string | null | undefined): CachedMapAgent[] {
  if (raw === null || raw === undefined || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: CachedMapAgent[] = [];
    for (const entry of parsed) {
      if (entry === null || typeof entry !== 'object') continue;
      const row = entry as Partial<CachedMapAgent>;
      if (typeof row.hostId !== 'string' || row.hostId.trim() === '') continue;
      if (typeof row.agentId !== 'string' || row.agentId.trim() === '') continue;
      out.push({
        hostId: row.hostId,
        agentId: row.agentId,
        mounted_session_id: typeof row.mounted_session_id === 'string' ? row.mounted_session_id : undefined,
        title: typeof row.title === 'string' ? row.title : undefined,
        role: typeof row.role === 'string' ? row.role : undefined,
        status: typeof row.status === 'string' ? row.status : undefined,
        mandate: typeof row.mandate === 'string' ? row.mandate : undefined,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function loadCachedMapAgents(
  storage: Pick<Storage, 'getItem'> = localStorage,
): CachedMapAgent[] {
  return parseCachedMapAgents(storage.getItem(SESSION_MAP_AGENTS_CACHE_KEY));
}

export function saveCachedMapAgents(
  agents: readonly CachedMapAgent[],
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  storage.setItem(SESSION_MAP_AGENTS_CACHE_KEY, JSON.stringify(agents));
}

/** Finite positive-size world rect; rejects NaN / non-objects / zero/negative size. */
export function isValidAnnotationRect(
  value: unknown,
): value is { x: number; y: number; width: number; height: number } {
  if (value === null || typeof value !== 'object') return false;
  const rect = value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
  return typeof rect.x === 'number' && Number.isFinite(rect.x)
    && typeof rect.y === 'number' && Number.isFinite(rect.y)
    && typeof rect.width === 'number' && Number.isFinite(rect.width) && rect.width > 0
    && typeof rect.height === 'number' && Number.isFinite(rect.height) && rect.height > 0;
}

function isAnnotationBox(value: unknown): value is MapAnnotationBox {
  if (value === null || typeof value !== 'object') return false;
  const box = value as MapAnnotationBox & { color?: unknown; rect?: unknown };
  if (typeof box.id !== 'string' || typeof box.title !== 'string') return false;
  if (box.nodeIds !== undefined && (!Array.isArray(box.nodeIds) || !box.nodeIds.every((id) => typeof id === 'string'))) return false;
  // color optional on wire — normalize later; reject only if present and non-string
  if (box.color !== undefined && typeof box.color !== 'string') return false;
  // Invalid rect is stripped in normalize, not a hard reject.
  if (box.rect !== undefined && !isValidAnnotationRect(box.rect) && box.rect !== null) {
    // allow through — normalize drops bad rect
  }
  return true;
}

function normalizeAnnotationBox(box: MapAnnotationBox): MapAnnotationBox {
  const color = typeof box.color === 'string' && box.color.trim()
    ? box.color
    : DEFAULT_ANNOTATION_COLORS[0]!;
  const rect = isValidAnnotationRect(box.rect) ? box.rect : undefined;
  return {
    id: box.id,
    title: box.title,
    color,
    rect,
  };
}

function isLabelDef(value: unknown): value is MapLabelDef {
  if (value === null || typeof value !== 'object') return false;
  const label = value as MapLabelDef;
  return typeof label.id === 'string' && typeof label.name === 'string' && typeof label.color === 'string';
}

function parseEdges(value: unknown): SessionMapEdge[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isSessionMapEdge).map(normalizeSessionMapEdge);
}

function parsePendingTopology(value: unknown): PendingTopologyOp[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: PendingTopologyOp[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const row = entry as Partial<PendingTopologyOp>;
    if (typeof row.id !== 'string' || typeof row.childSessionId !== 'string') continue;
    if (row.kind !== 'mount' && row.kind !== 'unmount' && row.kind !== 'remount') continue;
    out.push({
      id: row.id,
      kind: row.kind,
      childSessionId: row.childSessionId,
      parentSessionId: typeof row.parentSessionId === 'string' ? row.parentSessionId : undefined,
      role: typeof row.role === 'string' ? row.role : undefined,
      mandate: typeof row.mandate === 'string' ? row.mandate : undefined,
      queuedAt: typeof row.queuedAt === 'string' ? row.queuedAt : new Date(0).toISOString(),
    });
  }
  return out.length > 0 ? out : undefined;
}

const SESSION_POSITION_PREFIX = 'session:';

/** Persist key for a force node. Bare session ids become `session:id`. */
export function canonicalMapPositionKey(id: string): string {
  if (
    id.startsWith(SESSION_POSITION_PREFIX)
    || id.startsWith('draft:')
    || id.startsWith('agent:')
  ) {
    return id;
  }
  return `${SESSION_POSITION_PREFIX}${id}`;
}

/** Keys to probe when reading a stored center (`session:id` then bare `id`). */
export function mapPositionLookupKeys(nodeId: string): string[] {
  const canonical = canonicalMapPositionKey(nodeId);
  const keys = [canonical];
  if (canonical.startsWith(SESSION_POSITION_PREFIX)) {
    const bare = canonical.slice(SESSION_POSITION_PREFIX.length);
    if (bare.length > 0) keys.push(bare);
  }
  if (nodeId !== canonical) keys.push(nodeId);
  return keys;
}

export function lookupMapPosition(
  positions: ReadonlyMap<string, { x: number; y: number }> | Record<string, { x: number; y: number }> | undefined,
  nodeId: string,
): { x: number; y: number } | undefined {
  if (positions === undefined) return undefined;
  const keys = mapPositionLookupKeys(nodeId);
  if (positions instanceof Map) {
    for (const key of keys) {
      const hit = positions.get(key);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  for (const key of keys) {
    const hit = positions[key];
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * Rewrite bare session ids to `session:id`. When both forms exist, keep the
 * canonical entry (what drag/settle persist) rather than the legacy key.
 */
export function normalizeMapPositions(
  positions: Record<string, { x: number; y: number }> | undefined,
): Record<string, { x: number; y: number }> | undefined {
  if (positions === undefined) return undefined;
  const out: Record<string, { x: number; y: number }> = {};
  for (const [id, pos] of Object.entries(positions)) {
    const key = canonicalMapPositionKey(id);
    if (id === key || out[key] === undefined) out[key] = pos;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parsePositions(
  value: unknown,
): Record<string, { x: number; y: number }> | undefined {
  if (value === null || value === undefined || typeof value !== 'object') return undefined;
  const out: Record<string, { x: number; y: number }> = {};
  for (const [id, pos] of Object.entries(value as Record<string, unknown>)) {
    if (pos === null || typeof pos !== 'object') continue;
    const point = pos as { x?: unknown; y?: unknown };
    if (typeof point.x === 'number' && typeof point.y === 'number' && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      out[id] = { x: point.x, y: point.y };
    }
  }
  return normalizeMapPositions(out);
}

export function newAnnotationId(): string {
  return `ann_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function newLabelId(): string {
  return `lbl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface PlacedBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Bounds for a note box.
 * Explicit `rect` is the source of truth. Legacy nodeIds are intentionally
 * ignored so a visual group never moves when a node is dragged.
 */
export function annotationBounds(
  box: MapAnnotationBox,
  placed: ReadonlyArray<{ session: { id: string }; x: number; y: number }>,
  nodeSize: { width: number; height: number },
): PlacedBounds {
  if (box.rect !== undefined && isValidAnnotationRect(box.rect)) {
    return box.rect;
  }
  return { x: 40, y: 40, width: nodeSize.width + 48, height: nodeSize.height + 48 };
}

/** Keep sessions that carry any of the active label filters (empty filter = all). */
export function sessionMatchesLabelFilter(
  sessionId: string,
  sessionLabels: Record<string, string[]>,
  activeLabelIds: readonly string[],
): boolean {
  if (activeLabelIds.length === 0) return true;
  const owned = sessionLabels[sessionId] ?? [];
  return activeLabelIds.some((id) => owned.includes(id));
}

export function toggleSessionLabel(
  doc: SessionMapDoc,
  sessionId: string,
  labelId: string,
): SessionMapDoc {
  const current = doc.sessionLabels[sessionId] ?? [];
  return assignSessionLabel(doc, sessionId, labelId, !current.includes(labelId));
}

export function assignSessionLabel(
  doc: SessionMapDoc,
  sessionId: string,
  labelId: string,
  assigned: boolean,
): SessionMapDoc {
  const current = doc.sessionLabels[sessionId] ?? [];
  const has = current.includes(labelId);
  if (assigned === has) return doc;
  const next = assigned ? [...current, labelId] : current.filter((id) => id !== labelId);
  return {
    ...doc,
    sessionLabels: {
      ...doc.sessionLabels,
      [sessionId]: next,
    },
  };
}

/** Axis-aligned rect intersection (inclusive edges). */
export function rectsIntersect(
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number },
): boolean {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}
