/**
 * Conversation map: Session cards and their work edges on a user-owned canvas.
 * Every card is a Session. Department members are child Sessions on the same forest.
 */

import {
  forceLink,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
} from 'd3-force';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { api, type Session, type SessionGraph } from '../api/client';
import { useI18n } from '../i18n';
import { parentSessionIdOf, wouldCreateMountCycle } from '../utils/session-mount';
import { getAppErrors, reportAppError, subscribeAppErrors } from '../utils/error-center';
import {
  CANVAS_PAD,
  MAX_SCALE,
  MIN_SCALE,
  NODE_H,
  NODE_W,
  offsetSpawnFromSiblings,
  ensureGraphEdges,
  fitTreeView,
  layoutSessionMountForest,
  memberLabel,
  memberProjectCwd,
  memberRole,
  nodeKey,
  projectFolderName,
  type MapMemberRef,
  type TreeView,
  zoomTreeView,
} from './session-map/layout';
import {
  COLLIDE_RADIUS,
  HOME_PULL_STRENGTH,
  LINK_DISTANCE,
  LINK_STRENGTH,
  SESSION_MAP_AMBIENT_HOME_GRAVITY,
  SETTLE_ALPHA,
  buildMapComponents,
  forceIntraComponentCollide,
  isComponentRootPin,
  resolveNodeDragGroupIds,
  buildForceMapNodes,
  tidyComponentAroundRoot,
  type ForceMapLink,
  type ForceMapNode,
  type MapComponentInfo,
} from './session-map/motion';

import {
  canMountMemberUnder,
  clearPendingTopology,
  describeMapCurrentAction,
  describeMapErrorSummary,
  disconnectParentEdges,
  mapMemberStatus,
  mapRuntimeStatus,
  mapNodeCapabilities,
  mapParentByChildFromEdges,
  mapStatusDotClass,
  formatElapsed,
  formatMapStatusWord,
  mergeGraphWithMapEdges,
  pendingTopologyOpsReady,
  queuePendingTopology,
  pruneDeadMapEdges,
  reconcileParentEdgesWithServer,
  sessionIsBusy,
  upsertParentMapEdge,
  wireSourceParentSessionId,
  type MapLiveHints,
} from '../utils/session-graph';
import { SessionIdentityDrawer, type SessionIdentityDraftValues, type SessionIdentityParentStatus } from './SessionIdentityDrawer';
import { Icon } from './Icon';
import {
  annotationBounds,
  DEFAULT_ANNOTATION_COLORS,
  canonicalMapPositionKey,
  bareMapSessionId,
  findParentMapEdge,
  isLiveLayoutParentEdge,
  lookupMapPosition,
  loadCachedMapGraph,
  loadSessionMapDoc,
  normalizeMapPositions,
  newAnnotationId,
  removeEdgesForSession,
  isUnappliedExtraJob,
  UNAPPLIED_EXTRA_JOB_STATUS,
  removeSessionMapEdgeByEndpoints,
  rectsIntersect,
  saveCachedMapGraph,
  saveSessionMapDoc,
  type MapAnnotationBox,
  type SessionMapDoc,
  type SessionMapEdge,
} from './sessionMapDoc';

export {
  ensureGraphEdges,
  fitTreeView,
  layoutSessionMountForest,
  memberLabel,
  memberProjectCwd,
  memberRole,
  nodeKey,
  projectFolderName,
  zoomTreeView,
} from './session-map/layout';
export { NODE_H, NODE_W } from './session-map/layout';
export type { MapMemberRef, PlacedNode, TreeView } from './session-map/layout';
export {
  COLLIDE_RADIUS,
  HOME_PULL_STRENGTH,
  LINK_DISTANCE,
  LINK_STRENGTH,
  SESSION_MAP_AMBIENT_HOME_GRAVITY,
  SETTLE_ALPHA,
  buildMapComponents,
  forceIntraComponentCollide,
  isComponentRootPin,
  resolveMapNodeSpawnPosition,
  resolveNodeDragGroupIds,
  buildForceMapNodes,
  snapComponentChildrenToLiveRoot,
  tidyComponentAroundRoot,
} from './session-map/motion';
export type { ForceMapLink, ForceMapNode, MapComponentInfo } from './session-map/motion';

export { parentSessionIdOf };

function hydrateMapPositions(
  positions: Record<string, { x: number; y: number }> | undefined,
): Map<string, { x: number; y: number }> {
  const map = new Map<string, { x: number; y: number }>();
  for (const [id, pos] of Object.entries(normalizeMapPositions(positions) ?? {})) {
    map.set(id, pos);
  }
  return map;
}

function forgetMapNodePosition(
  positions: Map<string, { x: number; y: number }>,
  sessionId: string,
): void {
  positions.delete(sessionId);
  positions.delete(canonicalMapPositionKey(sessionId));
  positions.delete(bareMapSessionId(sessionId));
}

function createInitialForceGraph(
  sessions: readonly Session[],
  cachedGraph: SessionGraph | null,
): {
  nodes: ForceMapNode[];
  links: ForceMapLink[];
  positions: Map<string, { x: number; y: number }>;
} {
  const cachedDoc = loadSessionMapDoc();
  const positions = hydrateMapPositions(cachedDoc.positions);
  const cachedById = new Map((cachedGraph?.nodes ?? []).map((node) => [node.id, node]));
  for (const session of sessions) cachedById.set(session.id, session);
  const initialGraph = ensureGraphEdges({
    nodes: [...cachedById.values()],
    edges: [
      ...(cachedGraph?.edges ?? []),
      ...(cachedDoc.edges ?? [])
        .filter((edge) => edge.type === 'parent')
        .map((edge) => ({
          parent_session_id: edge.source,
          child_session_id: edge.target,
        })),
    ],
  });
  const initialLayout = layoutSessionMountForest(initialGraph);
  const { nodes } = buildForceMapNodes({
    placed: initialLayout.placed,
    previousById: new Map(),
    positions,
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  const links: ForceMapLink[] = [];
  const seen = new Set<string>();
  for (const edge of initialGraph.edges) {
    const source = `session:${edge.parent_session_id}`;
    const target = `session:${edge.child_session_id}`;
    const key = `${source}->${target}`;
    if (seen.has(key) || !nodeIds.has(source) || !nodeIds.has(target)) continue;
    seen.add(key);
    links.push({ source, target });
  }
  return { nodes, links, positions };
}

const CLICK_MOVE_THRESHOLD = 5;
/**
 * After ANY port/wire gesture the browser dispatches a click near the pointer
 * (with pointer capture it is retargeted). For this window, clicks landing on
 * node cards / ports are swallowed so wiring can never open a session.
 */
const WIRE_CLICK_SUPPRESS_MS = 600;
/** UE-style port hit radius (world units) — slightly tighter than full card half-width. */
const PORT_HIT_RADIUS = 28;
/** Snap / near-miss feedback when the drop barely misses a valid port. */
const NEAR_MISS_RADIUS = 56;
const BODY_PORT_SLOP = 8;
/** Non-sticky errors auto-dismiss; mount failures stay until dismissed. */
const ERROR_AUTO_DISMISS_MS = 6_500;
const HINT_AUTO_DISMISS_MS = 2_800;
/** Focus uses the optical center of the free canvas. */
const FOCUS_INSET_TOP = 72;
const FOCUS_INSET_BOTTOM = 36;
const MAP_POLL_MS = 4_000;
const MIN_ANNOTATION_SIZE = 48;
const MAP_FIRST_USE_HINT_KEY = 'nori-session-map-first-use-hint';

function localizedMapStatus(
  status: string,
  tr: (english: string, chinese: string) => string,
): string {
  const word = formatMapStatusWord(status);
  if (word === 'running') return tr('running', '运行中');
  if (word === 'working') return tr('working', '工作中');
  if (word === 'waiting-approval') return tr('waiting-approval', '等授权');
  if (word === 'waiting') return tr('waiting', '等待中');
  if (word === 'stopped') return tr('stopped', '已停止');
  if (word === 'idle') return tr('idle', '空闲');
  if (word === 'timeout') return tr('timeout', '超时');
  if (word === 'error') return tr('error', '错误');
  return word;
}

function localizedMapError(
  summary: string,
  tr: (english: string, chinese: string) => string,
): string {
  if (/[一-鿿]/u.test(summary)) return summary;
  if (/cycle|mount_cycle|40921/i.test(summary)) return tr('This job would create a cycle.', '这份工作会形成循环。');
  if (/busy|queued|in progress/i.test(summary)) return tr('This session is still working.', '这场会话还在工作。');
  if (/timeout|timed out|maximum duration/i.test(summary)) return tr('This run timed out.', '这次运行超时了。');
  if (/not available|not found|missing/i.test(summary)) return tr('This session is no longer available.', '这个会话已经不在了。');
  return tr('The session reported an error. Try again.', '这场会话出了问题，可以重试。');
}

function focusInsetForViewport(): { left: number; top: number; bottom: number } {
  return {
    left: 16,
    top: FOCUS_INSET_TOP,
    bottom: FOCUS_INSET_BOTTOM,
  };
}

export { wireSourceParentSessionId };

/** Whether dropping a wire onto `target` is a legal mount or reconnect. */
export function isValidWireTarget(
  wire: Pick<WireDragState, 'side' | 'parentSessionId' | 'childSessionId' | 'fromId'>,
  target: ForceMapNode,
  nodes: readonly Session[],
  mapEdges: readonly SessionMapEdge[] = [],
): boolean {
  const caps = mapNodeCapabilities(target.member, { sessions: nodes, mapEdges });
  if (!caps.canWireIn) return false;
  if (target.id === wire.fromId) return false;
  const targetId = target.member.session.id;
  const mapParents = mapParentByChildFromEdges(mapEdges);
  if (wire.side === 'out') {
    const parentId = wire.parentSessionId;
    if (targetId === parentId) return false;
    return canMountMemberUnder(targetId, parentId, nodes, mapParents);
  }
  const childId = wire.childSessionId;
  if (targetId === childId) return false;
  return canMountMemberUnder(childId, targetId, nodes, mapParents);
}

/** Snap pan/zoom translation to device pixels so canvas text stays sharp under CSS transform. */
export function snapMapView(view: TreeView): TreeView {
  const dpr = typeof window !== 'undefined' && window.devicePixelRatio > 0
    ? window.devicePixelRatio
    : 1;
  return {
    x: Math.round(view.x * dpr) / dpr,
    y: Math.round(view.y * dpr) / dpr,
    scale: view.scale,
  };
}

/** Center the viewport on a placed node while keeping the given scale. */
export function centerViewOnNode(
  view: TreeView,
  node: { x: number; y: number },
  viewport: { width: number; height: number },
  nodeSize: { width: number; height: number } = { width: NODE_W, height: NODE_H },
  inset: { left?: number; top?: number; right?: number; bottom?: number } = {},
): TreeView {
  if (viewport.width <= 0 || viewport.height <= 0) return view;
  const left = inset.left ?? 0;
  const top = inset.top ?? 0;
  const right = inset.right ?? 0;
  const bottom = inset.bottom ?? 0;
  const usableWidth = Math.max(1, viewport.width - left - right);
  const usableHeight = Math.max(1, viewport.height - top - bottom);
  const cx = node.x + nodeSize.width / 2;
  const cy = node.y + nodeSize.height / 2;
  return {
    scale: view.scale,
    x: left + usableWidth / 2 - cx * view.scale,
    y: top + usableHeight / 2 - cy * view.scale,
  };
}

function pointerMovedBeyondClickThreshold(
  drag: { startX: number; startY: number },
  event: { clientX: number; clientY: number },
): boolean {
  const deltaX = event.clientX - drag.startX;
  const deltaY = event.clientY - drag.startY;
  return deltaX * deltaX + deltaY * deltaY > CLICK_MOVE_THRESHOLD * CLICK_MOVE_THRESHOLD;
}

function linkEndpoint(node: ForceMapNode, side: 'bottom' | 'top'): { x: number; y: number } {
  const x = node.x ?? 0;
  const y = node.y ?? 0;
  return {
    x,
    y: side === 'bottom' ? y + NODE_H / 2 : y - NODE_H / 2,
  };
}

/** On-canvas identity editor — blank-canvas create-new ONLY (link-existing is silent). */
interface MountDraft {
  id: string;
  /** Captured parent session id — never activeSessionId. */
  parentId: string;
  title: string;
  role: string;
  mandate: string;
  prompt: string;
  status?: 'editing' | 'asking-parent' | 'error' | 'creating';
  error?: string;
  /** World-space anchor for the on-canvas identity editor (drop point). */
  worldX: number;
  worldY: number;
}

interface TopLevelCreatePlaceholder {
  id: string;
  worldX: number;
  worldY: number;
  status: 'editing' | 'creating' | 'error';
  title?: string;
}

interface WireDragState {
  fromId: string;
  /**
   * OUT: parenting wire from source OUT → drop on child IN/card or empty.
   * IN: reconnect wire from child IN → drop on new parent OUT/card.
   */
  side: 'out' | 'in';
  /**
   * OUT wire: parent session id captured at OUT pointerdown.
   * IN wire: empty — parent resolved from drop target.
   */
  parentSessionId: string;
  /**
   * IN wire: child session id being reconnected (source card).
   * OUT wire: empty until drop hits an existing child.
   */
  childSessionId: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  startClientX: number;
  startClientY: number;
  /** Owning pointer — foreign pointers must not move or finish this wire. */
  pointerId: number;
}

interface NodeContextMenu {
  sessionId: string;
  x: number;
  y: number;
  canUnmount: boolean;
  label: string;
}

interface CanvasContextMenu {
  x: number;
  y: number;
  worldX: number;
  worldY: number;
}

interface WorkEdgeContextMenu {
  parentId: string;
  childId: string;
  x: number;
  y: number;
}

interface WorkEdgeEditor {
  parentId: string;
  childId: string;
  role: string;
  mandate: string;
  prompt: string;
  saving: boolean;
  parentStatus?: SessionIdentityParentStatus;
  error?: string;
}

interface DraftContextMenu {
  x: number;
  y: number;
}

interface MarqueeState {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  additive?: boolean;
}

type RightClickHit =
  | { type: 'canvas' }
  | { type: 'node'; sessionId: string }
  | { type: 'edge'; parentId: string; childId: string }
  | { type: 'draft' };

type MapStageGesture =
  | { kind: 'idle' }
  | {
    kind: 'right-click-pending';
    pointerId: number;
    originX: number;
    originY: number;
    view: TreeView;
    hit: RightClickHit;
  }
  | {
    kind: 'panning';
    pointerId: number;
    originX: number;
    originY: number;
    view: TreeView;
    source: 'right' | 'middle' | 'space';
  }
  | { kind: 'pan-done' }
  | { kind: 'right-click' };

function isBlockingStageGesture(kind: MapStageGesture['kind']): boolean {
  return kind === 'panning' || kind === 'right-click-pending';
}

function resolveRightClickHit(target: EventTarget | null): RightClickHit {
  if (!(target instanceof Element)) return { type: 'canvas' };
  if (target.closest('.session-map-draft-node') !== null) return { type: 'draft' };
  const node = target.closest('.session-map-node');
  if (node instanceof HTMLElement) {
    const sessionId = node.dataset.sessionId;
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      return { type: 'node', sessionId };
    }
  }
  const edge = target.closest('[data-parent-id][data-child-id]');
  if (edge instanceof Element) {
    const parentId = edge.getAttribute('data-parent-id');
    const childId = edge.getAttribute('data-child-id');
    if (parentId !== null && childId !== null) {
      return { type: 'edge', parentId, childId };
    }
  }
  return { type: 'canvas' };
}

/**
 * UE-style hit test: prefer the requested port circle, then card body.
 * Among overlaps, pick the nearest target (port center or card center).
 * Exported for tests — IN port must be hittable with a generous radius.
 */
export function hitSessionMapNode(
  nodes: ReadonlyArray<{ id: string; x?: number; y?: number }>,
  worldX: number,
  worldY: number,
  options: {
    excludeId?: string;
    preferPort?: 'in' | 'out' | 'any';
    nodeW?: number;
    nodeH?: number;
    portRadius?: number;
  } = {},
): { id: string; x?: number; y?: number } | undefined {
  const nodeW = options.nodeW ?? NODE_W;
  const nodeH = options.nodeH ?? NODE_H;
  const portRadius = options.portRadius ?? PORT_HIT_RADIUS;
  const prefer = options.preferPort ?? 'any';
  const candidates = nodes.filter((node) => node.id !== options.excludeId);

  const portDistance = (node: { x?: number; y?: number }, side: 'in' | 'out'): number => {
    const cx = node.x ?? 0;
    const cy = node.y ?? 0;
    const py = side === 'in' ? cy - nodeH / 2 : cy + nodeH / 2;
    return Math.hypot(worldX - cx, worldY - py);
  };

  const pickNearest = <T extends { x?: number; y?: number }>(
    list: readonly T[],
    distanceOf: (node: T) => number,
  ): T | undefined => {
    let best: T | undefined;
    let bestDistance = Infinity;
    for (const node of list) {
      const distance = distanceOf(node);
      if (distance < bestDistance) {
        best = node;
        bestDistance = distance;
      }
    }
    return best;
  };

  if (prefer === 'in' || prefer === 'out') {
    const portMatches = candidates.filter((node) => portDistance(node, prefer) <= portRadius);
    const portHit = pickNearest(portMatches, (node) => portDistance(node, prefer));
    if (portHit) return portHit;
  } else {
    const inMatches = candidates.filter((node) => portDistance(node, 'in') <= portRadius);
    const inHit = pickNearest(inMatches, (node) => portDistance(node, 'in'));
    if (inHit) return inHit;
    const outMatches = candidates.filter((node) => portDistance(node, 'out') <= portRadius);
    const outHit = pickNearest(outMatches, (node) => portDistance(node, 'out'));
    if (outHit) return outHit;
  }

  const bodyMatches = candidates.filter((node) => {
    const cx = node.x ?? 0;
    const cy = node.y ?? 0;
    const left = cx - nodeW / 2 - BODY_PORT_SLOP;
    const top = cy - nodeH / 2 - BODY_PORT_SLOP;
    return worldX >= left
      && worldX <= left + nodeW + BODY_PORT_SLOP * 2
      && worldY >= top
      && worldY <= top + nodeH + BODY_PORT_SLOP * 2;
  });
  return pickNearest(bodyMatches, (node) => Math.hypot(worldX - (node.x ?? 0), worldY - (node.y ?? 0)));
}

function portWorldPosition(node: { x?: number; y?: number }, side: 'in' | 'out'): { x: number; y: number } {
  const x = node.x ?? 0;
  const y = node.y ?? 0;
  return { x, y: side === 'in' ? y - NODE_H / 2 : y + NODE_H / 2 };
}

/** Keep port/edge hits usable after zoom-out without changing the 1× radius. */
function scaledWorldRadius(base: number, scale: number): number {
  if (!(scale > 0) || !Number.isFinite(scale)) return base;
  return Math.max(base, 16 / scale);
}

/** Nearest legal port/body for rubber-band snap while dragging or near-miss on drop. */
export function findNearestValidWireTarget(
  forceNodes: ReadonlyArray<ForceMapNode>,
  worldX: number,
  worldY: number,
  wire: Pick<WireDragState, 'side' | 'parentSessionId' | 'childSessionId' | 'fromId'>,
  nodes: readonly Session[],
  mapEdges: readonly SessionMapEdge[] = [],
  maxDistance = NEAR_MISS_RADIUS,
): { node: ForceMapNode; portX: number; portY: number; distance: number } | undefined {
  const preferPort = wire.side === 'out' ? 'in' : 'out';
  let best: { node: ForceMapNode; portX: number; portY: number; distance: number } | undefined;
  for (const node of forceNodes) {
    if (!isValidWireTarget(wire, node, nodes, mapEdges)) continue;
    const port = portWorldPosition(node, preferPort);
    const portDist = Math.hypot(worldX - port.x, worldY - port.y);
    const cx = node.x ?? 0;
    const cy = node.y ?? 0;
    const left = cx - NODE_W / 2 - BODY_PORT_SLOP;
    const top = cy - NODE_H / 2 - BODY_PORT_SLOP;
    const clampedX = Math.max(left, Math.min(left + NODE_W + BODY_PORT_SLOP * 2, worldX));
    const clampedY = Math.max(top, Math.min(top + NODE_H + BODY_PORT_SLOP * 2, worldY));
    const bodyDist = Math.hypot(worldX - clampedX, worldY - clampedY);
    const distance = Math.min(portDist, bodyDist);
    if (distance <= maxDistance && (best === undefined || distance < best.distance)) {
      best = { node, portX: port.x, portY: port.y, distance };
    }
  }
  return best;
}

/** Closest card (any) — used for near-miss feedback when no valid target matched. */
export function nearestSessionMapNodeDistance(
  nodes: ReadonlyArray<{ id: string; x?: number; y?: number }>,
  worldX: number,
  worldY: number,
  excludeId?: string,
): number | undefined {
  let best: number | undefined;
  for (const node of nodes) {
    if (node.id === excludeId) continue;
    const cx = node.x ?? 0;
    const cy = node.y ?? 0;
    const left = cx - NODE_W / 2;
    const top = cy - NODE_H / 2;
    const clampedX = Math.max(left, Math.min(left + NODE_W, worldX));
    const clampedY = Math.max(top, Math.min(top + NODE_H, worldY));
    const d = Math.hypot(worldX - clampedX, worldY - clampedY);
    if (best === undefined || d < best) best = d;
  }
  return best;
}

export function SessionMapPage({
  sessions,
  activeSessionId,
  onOpenSession,
  onGraphChanged,
  onCreateTopLevelSession,
  onChooseProject,
  preferredCreateCwd,
  onAskParentIdentity,
}: {
  sessions: readonly Session[];
  activeSessionId?: string;
  onOpenSession: (sessionId: string) => void;
  onGraphChanged?: () => void;
  /** Same create path as the Projects sidebar — Map only supplies the canvas position. */
  onCreateTopLevelSession?: (cwd: string) => Promise<string | null>;
  onChooseProject?: (options?: {
    createSession?: boolean;
    parentSessionId?: string;
    stayOnMap?: boolean;
    worldX?: number;
    worldY?: number;
    onCreated?: (sessionId: string | null) => void;
    onSelected?: (cwd: string) => void;
  }) => void;
  /** Prefer the sidebar's current project folder when creating from the canvas. */
  preferredCreateCwd?: string;
  /** Optional constrained parent-side identity draft capability. */
  onAskParentIdentity?: (input: { parentSessionId: string; brief: string }) => Promise<{
    title: string;
    role: string;
    mandate: string;
  }>;
}) {
  const { tr } = useI18n();
  const cachedGraph = loadCachedMapGraph();
  const initialForceRef = useRef<ReturnType<typeof createInitialForceGraph>>(undefined);
  if (initialForceRef.current === undefined) {
    initialForceRef.current = createInitialForceGraph(sessions, cachedGraph);
  }
  const [graph, setGraph] = useState<SessionGraph | null>(() => cachedGraph);
  const [error, setError] = useState<string | null>(null);
  const [errorSticky, setErrorSticky] = useState(false);
  const errorStickyRef = useRef(false);
  const [hint, setHint] = useState<string | null>(null);
  const [firstUseHintVisible, setFirstUseHintVisible] = useState(() => {
    try {
      return localStorage.getItem(MAP_FIRST_USE_HINT_KEY) !== '1';
    } catch {
      return true;
    }
  });
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchOpenRef = useRef(false);
  searchOpenRef.current = searchOpen;
  const searchIndexRef = useRef(0);
  const [searchFocusId, setSearchFocusId] = useState<string | null>(null);
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery('');
    searchIndexRef.current = 0;
    setSearchFocusId(null);
  }, []);
  const openSearch = useCallback(() => {
    setSearchOpen(true);
    window.setTimeout(() => searchInputRef.current?.focus(), 0);
  }, []);
  const [view, setView] = useState<TreeView>({ x: 0, y: 0, scale: 1 });
  const [panning, setPanning] = useState(false);
  const [draft, setDraft] = useState<MountDraft | null>(null);
  const [topLevelPlaceholder, setTopLevelPlaceholder] = useState<TopLevelCreatePlaceholder | null>(null);
  const [stoppingIds, setStoppingIds] = useState<Set<string>>(() => new Set());
  const [stopErrors, setStopErrors] = useState<Set<string>>(() => new Set());
  const [nodeErrors, setNodeErrors] = useState<Record<string, string>>({});
  const [wireDrag, setWireDrag] = useState<WireDragState | null>(null);
  const [wireSnapTargetId, setWireSnapTargetId] = useState<string | null>(null);
  const wireDragRef = useRef<WireDragState | null>(null);
  const busyRef = useRef(false);
  const disposedRef = useRef(false);
  const [mapDoc, setMapDoc] = useState<SessionMapDoc>(() => loadSessionMapDoc());
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [forceNodes, setForceNodes] = useState<ForceMapNode[]>(() => initialForceRef.current!.nodes);
  const [forceLinks, setForceLinks] = useState<ForceMapLink[]>(() => initialForceRef.current!.links);
  const [nodeMenu, setNodeMenu] = useState<NodeContextMenu | null>(null);
  const [marquee, setMarquee] = useState<MarqueeState | null>(null);
  const [canvasMenu, setCanvasMenu] = useState<CanvasContextMenu | null>(null);
  const [workEdgeMenu, setWorkEdgeMenu] = useState<WorkEdgeContextMenu | null>(null);
  const [workEdgeEditor, setWorkEdgeEditor] = useState<WorkEdgeEditor | null>(null);
  const [draftMenu, setDraftMenu] = useState<DraftContextMenu | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedWorkEdge, setSelectedWorkEdge] = useState<{ parentId: string; childId: string } | null>(null);
  const [confirmWorkEdge, setConfirmWorkEdge] = useState<{ parentId: string; childId: string } | null>(null);
  const [deleteConfirmSessionId, setDeleteConfirmSessionId] = useState<string | null>(null);
  const [deleteSelectionConfirm, setDeleteSelectionConfirm] = useState(false);
  const [batchFailure, setBatchFailure] = useState<string | null>(null);
  const [identitySession, setIdentitySession] = useState<Session | null>(null);
  const [liveHints, setLiveHints] = useState<MapLiveHints>({
    approvals: [],
    activity: [],
    turns: {},
    errors: [],
  });
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const forceNodesRef = useRef(forceNodes);
  forceNodesRef.current = forceNodes;
  const [, redraw] = useState(0);
  /** Sync paint — coalescing via rAF/microtask proved flaky under jsdom settle tests. */
  const scheduleRedraw = useCallback((_force = false) => {
    redraw((value) => value + 1);
  }, []);
  const annotationDragRef = useRef<{
    id: string;
    mode: 'move' | 'resize';
    startClientX: number;
    startClientY: number;
    origin: { x: number; y: number; width: number; height: number };
    moved: boolean;
  } | null>(null);
  const draftDragRef = useRef<{
    startClientX: number;
    startClientY: number;
    originX: number;
    originY: number;
    grabWorldX: number;
    grabWorldY: number;
    moved: boolean;
  } | null>(null);

  const viewportRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<MapStageGesture>({ kind: 'idle' });
  const refreshRevision = useRef(0);
  /** Last activeSessionId we centered on (avoids re-stealing pan on graph poll). */
  const centeredSessionRef = useRef<string | undefined>(undefined);
  /** User pan/zoom/drag — do not autofocus-steal after this until session changes. */
  const userAdjustedViewRef = useRef(false);
  /** One-shot fit when there is no active session (avoid poll resetting pan). */
  const didFitEmptyRef = useRef(false);
  /** Follow active node while mount/agent topology finishes loading. */
  const followFocusUntilRef = useRef(0);
  const followRafRef = useRef<number | null>(null);
  const simulationRef = useRef<Simulation<ForceMapNode, ForceMapLink> | null>(null);
  /** Hydrate from map doc immediately so first paint never teleports from forest seeds. */
  const positionsRef = useRef<Map<string, { x: number; y: number }>>(
    initialForceRef.current!.positions,
  );
  const topologyKeyRef = useRef('');
  const seedByIdRef = useRef(new Map<string, { x: number; y: number }>());
  const componentIndexRef = useRef(new Map<string, MapComponentInfo>());
  const dragRef = useRef<{
    node: ForceMapNode;
    startX: number;
    startY: number;
    /** World-space pointer at pointerdown — translation is relative to this. */
    grabWorldX: number;
    grabWorldY: number;
    moved: boolean;
    pinned: boolean;
    /** Force-node ids dragged together (includes primary). */
    groupNodeIds: string[];
    groupStartPositions: Map<string, { x: number; y: number }>;
  } | null>(null);
  const releaseDragPinsRef = useRef<(groupNodeIds: readonly string[]) => void>(() => {});
  const marqueeRef = useRef<MarqueeState | null>(null);
  const suppressClickRef = useRef<string | null>(null);
  const spacePressedRef = useRef(false);
  /** Timestamp until which node/port clicks are swallowed after a wire gesture. */
  const suppressMapClickUntilRef = useRef(0);
  const viewRef = useRef(view);
  viewRef.current = view;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const mapDocRef = useRef(mapDoc);
  mapDocRef.current = mapDoc;
  const cancelDraftRef = useRef<() => void>(() => {});
  const dismissUnappliedExtraJobRef = useRef<(parentId: string, childId: string) => void>(() => {});
  const wireListenersRef = useRef<{
    move: (event: PointerEvent) => void;
    up: (event: PointerEvent) => void;
  } | null>(null);
  const nodeDragListenersRef = useRef<{
    move: (event: PointerEvent) => void;
    up: (event: PointerEvent) => void;
  } | null>(null);

  const persistPositions = useCallback((positions: Map<string, { x: number; y: number }>) => {
    const merged: Record<string, { x: number; y: number }> = {
      ...mapDocRef.current.positions,
    };
    for (const [id, pos] of positions) {
      merged[id] = { x: pos.x, y: pos.y };
    }
    const nextPositions = normalizeMapPositions(merged);
    const canonical = hydrateMapPositions(nextPositions);
    positionsRef.current = canonical;
    const next = { ...mapDocRef.current, positions: nextPositions };
    mapDocRef.current = next;
    setMapDoc(next);
    saveSessionMapDoc(next);
  }, []);

  const clientToWorld = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const el = viewportRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const current = viewRef.current;
    return {
      x: (clientX - rect.left - current.x) / current.scale,
      y: (clientY - rect.top - current.y) / current.scale,
    };
  }, []);

  const detachWireListeners = useCallback(() => {
    const listeners = wireListenersRef.current;
    if (listeners === null) return;
    window.removeEventListener('pointermove', listeners.move, true);
    window.removeEventListener('pointerup', listeners.up, true);
    window.removeEventListener('pointercancel', listeners.up, true);
    wireListenersRef.current = null;
  }, []);

  const detachNodeDragListeners = useCallback(() => {
    const listeners = nodeDragListenersRef.current;
    if (listeners === null) return;
    window.removeEventListener('pointermove', listeners.move, true);
    window.removeEventListener('pointerup', listeners.up, true);
    window.removeEventListener('pointercancel', listeners.up, true);
    nodeDragListenersRef.current = null;
  }, []);

  const markUserAdjustedView = useCallback(() => {
    userAdjustedViewRef.current = true;
  }, []);

  const armClickSuppression = useCallback(() => {
    suppressMapClickUntilRef.current = performance.now() + WIRE_CLICK_SUPPRESS_MS;
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      detachWireListeners();
      detachNodeDragListeners();
      // Invalidate in-flight refreshes so late responses never setState post-unmount.
      refreshRevision.current += 1;
    };
  }, [detachNodeDragListeners, detachWireListeners]);

  // Click suppression for port/wire gestures. The trailing click the browser
  // dispatches after pointerup bubbles through node cards (pointer capture
  // retargets it) — swallow node/port clicks for a short window so a wire can
  // never open a session. A fresh pointerdown ends the window: by then any
  // legitimate click from the previous gesture has already been dispatched.
  useEffect(() => {
    const swallow = (event: MouseEvent) => {
      if (performance.now() > suppressMapClickUntilRef.current) return;
      const target = event.target as HTMLElement | null;
      // Node cards, ports, and note boxes (a wire dropped onto a note must not
      // also open the note editor).
      if (target?.closest('.session-map-node, .session-map-port, .session-map-annotation, .session-map-edges') !== null) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const disarm = () => {
      suppressMapClickUntilRef.current = 0;
    };
    window.addEventListener('click', swallow, true);
    window.addEventListener('pointerdown', disarm, true);
    return () => {
      window.removeEventListener('click', swallow, true);
      window.removeEventListener('pointerdown', disarm, true);
    };
  }, []);

  const cancelWireDrag = useCallback(() => {
    detachWireListeners();
    wireDragRef.current = null;
    setWireDrag(null);
    setWireSnapTargetId(null);
  }, [detachWireListeners]);

  // Losing window focus mid-gesture (alt-tab) leaves no pointerup — tear
  // in-flight gestures down. Keep selection box/ids; only dismiss menus.
  useEffect(() => {
    const onBlur = () => {
      spacePressedRef.current = false;
      cancelWireDrag();
      const drag = dragRef.current;
      detachNodeDragListeners();
      if (drag !== null && drag.pinned) {
        releaseDragPinsRef.current(drag.groupNodeIds);
      }
      dragRef.current = null;
      annotationDragRef.current = null;
      gestureRef.current = { kind: 'idle' };
      setPanning(false);
      if (marqueeRef.current !== null) {
        marqueeRef.current = null;
        setMarquee(null);
      }
      setNodeMenu(null);
      setWorkEdgeMenu(null);
      setDraftMenu(null);
    };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [cancelWireDrag, detachNodeDragListeners]);

  // Escape: in-progress wire first (don't leave a rubber band), then overlay
  // menus/drawers, then search, then marquee/draft, then selection.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      const typing = target instanceof HTMLElement
        && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      const typingInSearch = target === searchInputRef.current;
      if (event.key === ' ' && !typing) {
        spacePressedRef.current = true;
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && (!typing || typingInSearch)) {
        event.preventDefault();
        openSearch();
        return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && !typing) {
        if (selectedWorkEdge !== null) {
          event.preventDefault();
          const edge = selectedWorkEdge;
          const stored = findParentMapEdge(mapDocRef.current.edges, edge.parentId, edge.childId);
          if (stored !== undefined && isUnappliedExtraJob(stored)) {
            dismissUnappliedExtraJobRef.current(edge.parentId, edge.childId);
            return;
          }
          setConfirmWorkEdge(edge);
          return;
        }
        if (selectedIdsRef.current.length > 0) {
          event.preventDefault();
          setDeleteSelectionConfirm(true);
          return;
        }
      }
      if (event.key !== 'Escape') return;
      if (wireDragRef.current !== null) {
        event.preventDefault();
        cancelWireDrag();
        return;
      }
      if (nodeMenu !== null || canvasMenu !== null || workEdgeMenu !== null || draftMenu !== null || confirmWorkEdge !== null || workEdgeEditor !== null || identitySession !== null) {
        event.preventDefault();
        setNodeMenu(null);
        setCanvasMenu(null);
        setWorkEdgeMenu(null);
        setDraftMenu(null);
        setConfirmWorkEdge(null);
        setWorkEdgeEditor(null);
        setIdentitySession(null);
        return;
      }
      if (searchOpenRef.current) {
        event.preventDefault();
        closeSearch();
        return;
      }
      if (topLevelPlaceholder !== null && topLevelPlaceholder.status === 'editing') {
        event.preventDefault();
        setTopLevelPlaceholder(null);
        return;
      }
      if (marqueeRef.current !== null) {
        event.preventDefault();
        marqueeRef.current = null;
        setMarquee(null);
        return;
      }
      if (draftRef.current !== null) {
        event.preventDefault();
        cancelDraftRef.current();
        return;
      }
      if (typing) return;
      setEditingAnnotationId(null);
      setSelectedIds((ids) => (ids.length > 0 ? [] : ids));
      setSelectedWorkEdge(null);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === ' ') spacePressedRef.current = false;
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [cancelWireDrag, canvasMenu, closeSearch, confirmWorkEdge, draftMenu, identitySession, nodeMenu, openSearch, selectedWorkEdge, topLevelPlaceholder, workEdgeEditor, workEdgeMenu]);

  const clearError = useCallback(() => {
    errorStickyRef.current = false;
    setErrorSticky(false);
    setError(null);
  }, []);

  const showError = useCallback((message: string, sticky = false) => {
    errorStickyRef.current = sticky;
    setErrorSticky(sticky);
    setError(message);
    reportAppError({ source: 'map', message, operation: 'map' });
  }, []);

  const showNodeError = useCallback((sessionId: string, message: string) => {
    setNodeErrors((current) => ({ ...current, [sessionId]: message }));
    window.setTimeout(() => {
      setNodeErrors((current) => {
        if (current[sessionId] !== message) return current;
        const next = { ...current };
        delete next[sessionId];
        return next;
      });
    }, ERROR_AUTO_DISMISS_MS);
  }, []);

  const setTopologyBusy = useCallback((next: boolean) => {
    busyRef.current = next;
    // Mutations are object-local. The canvas remains interactive while a
    // session, edge, or deletion request is in flight.
    if (draftRef.current !== null && next) {
      setDraft((current) => current === null ? current : { ...current, status: current.status === 'creating' ? 'creating' : current.status });
    }
  }, []);

  const showHint = useCallback((message: string) => {
    setHint(message);
  }, []);

  // Transient errors auto-dismiss; sticky mount failures stay until the user closes them.
  useEffect(() => {
    if (error === null || errorStickyRef.current) return;
    const timer = window.setTimeout(() => clearError(), ERROR_AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [clearError, error]);

  useEffect(() => {
    if (hint === null) return;
    const timer = window.setTimeout(() => setHint(null), HINT_AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [hint]);

  const dismissFirstUseHint = useCallback(() => {
    setFirstUseHintVisible(false);
    try { localStorage.setItem(MAP_FIRST_USE_HINT_KEY, '1'); } catch { /* best effort */ }
  }, []);

  // Settled positions are user-owned: persist when the simulation comes to
  // rest and on unload, otherwise simulation drift is lost on reload.
  useEffect(() => {
    const persist = () => persistPositions(positionsRef.current);
    window.addEventListener('beforeunload', persist);
    return () => window.removeEventListener('beforeunload', persist);
  }, [persistPositions]);

  const persistDoc = useCallback((next: SessionMapDoc) => {
    const canonical = {
      ...next,
      positions: normalizeMapPositions(next.positions),
    };
    mapDocRef.current = canonical;
    setMapDoc(canonical);
    saveSessionMapDoc(canonical);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds([]);
  }, []);

  const componentIndex = useMemo(
    () => buildMapComponents(forceNodes, forceLinks),
    [forceNodes, forceLinks],
  );
  componentIndexRef.current = componentIndex;

  const pruneStalePositions = useCallback((aliveKeys: ReadonlySet<string>) => {
    const live = new Map<string, { x: number; y: number }>();
    for (const [key, pos] of positionsRef.current) {
      const canonical = canonicalMapPositionKey(key);
      if (!aliveKeys.has(canonical)) continue;
      if (key === canonical || !live.has(canonical)) live.set(canonical, pos);
    }
    for (const [key, pos] of positionsRef.current) {
      const canonical = canonicalMapPositionKey(key);
      if (key === canonical && aliveKeys.has(canonical)) live.set(canonical, pos);
    }
    positionsRef.current = live;

    const persisted = mapDocRef.current.positions;
    const nextPositions = normalizeMapPositions({
      ...Object.fromEntries(
        Object.entries(persisted ?? {}).filter(([id]) => (
          aliveKeys.has(canonicalMapPositionKey(id)) || live.has(canonicalMapPositionKey(id))
        )),
      ),
      ...Object.fromEntries(live),
    });
    const persistedKeys = Object.keys(persisted ?? {});
    const nextKeys = Object.keys(nextPositions ?? {});
    const unchanged = persistedKeys.length === nextKeys.length
      && nextKeys.every((key) => persisted?.[key]?.x === nextPositions?.[key]?.x
        && persisted?.[key]?.y === nextPositions?.[key]?.y);
    if (unchanged) return;
    const next = {
      ...mapDocRef.current,
      positions: nextPositions,
    };
    mapDocRef.current = next;
    setMapDoc(next);
    saveSessionMapDoc(next);
  }, []);

  const refresh = useCallback(async () => {
    // Poll/mutation refreshes must never stomp an open identity draft or an
    // in-flight wire/node drag — graph data would shift nodes mid-gesture.
    if (wireDragRef.current !== null || dragRef.current !== null
      || annotationDragRef.current !== null
      || draftDragRef.current !== null
      || draftRef.current !== null
      || marqueeRef.current !== null) {
      return;
    }
    const revision = ++refreshRevision.current;
    try {
      const next = ensureGraphEdges(await api.sessions.getGraph({ exclude_empty: false }));
      const liveIds = new Set(next.nodes.map((node) => node.id));
      let reconciled = reconcileParentEdgesWithServer(mapDocRef.current, next.edges);
      reconciled = pruneDeadMapEdges(reconciled, liveIds);
      if (reconciled !== mapDocRef.current) {
        mapDocRef.current = reconciled;
        setMapDoc(reconciled);
        saveSessionMapDoc(reconciled);
      }
      // Graph nodes are the first revalidation layer; live activity enriches
      // cards later and must not gate the canvas.
      if (!disposedRef.current && revision === refreshRevision.current) {
        setGraph(next);
        saveCachedMapGraph(next);
      }
      const alive = new Set<string>();
      for (const node of next.nodes) alive.add(canonicalMapPositionKey(node.id));
      for (const key of positionsRef.current.keys()) {
        if (key.startsWith('draft:') || key.startsWith('creating:')) alive.add(key);
      }
      pruneStalePositions(alive);

      const busyNodes = next.nodes.filter((node) => {
        const status = node.status.trim().toLowerCase();
        return status === 'running'
          || status === 'working'
          || status === 'awaiting_approval'
          || status === 'awaiting_question';
      }).slice(0, 16);
      const [activityResult, approvalResult] = await Promise.allSettled([
        api.sessions.getActivity(),
        api.approvals.list(),
      ]);
      const activity = activityResult.status === 'fulfilled' ? activityResult.value.items : [];
      const approvals = approvalResult.status === 'fulfilled' ? approvalResult.value.items : [];
      const turns: Record<string, { thinkingText?: string; toolName?: string }> = {};
      if (busyNodes.length > 0) {
        const snapshots = await Promise.allSettled(
          busyNodes.map((node) => api.sessions.getSnapshot(node.id)),
        );
        snapshots.forEach((result, index) => {
          if (result.status !== 'fulfilled') return;
          const node = busyNodes[index];
          if (node === undefined) return;
          const turn = result.value.in_flight_turn;
          const pending = result.value.pending_approvals?.[0];
          turns[node.id] = {
            thinkingText: turn?.step_thinking_text || turn?.thinking_text,
            toolName: turn?.running_tools[0]?.name ?? pending?.tool_name,
          };
        });
      }
      if (!disposedRef.current && revision === refreshRevision.current) {
        setLiveHints({
          approvals,
          activity,
          turns,
          errors: getAppErrors().map((item) => ({
            sessionId: item.sessionId,
            agentId: item.agentId,
            message: item.message,
          })),
        });
      }

      const readyOps = pendingTopologyOpsReady(mapDocRef.current, next.nodes);
      if (readyOps.length > 0 && !busyRef.current) {
        let doc = mapDocRef.current;
        for (const op of readyOps) {
          try {
            if (op.kind === 'mount' && op.parentSessionId !== undefined) {
              await api.sessions.mount(op.childSessionId, op.parentSessionId, {
                role: op.role,
                mandate: op.mandate,
              });
              doc = clearPendingTopology(
                upsertParentMapEdge(doc, op.parentSessionId, op.childSessionId, {
                  role: op.role,
                  mandate: op.mandate,
                }),
                op.childSessionId,
              );
            } else if (op.kind === 'remount' && op.parentSessionId !== undefined) {
              await api.sessions.remount(op.childSessionId, op.parentSessionId, {
                role: op.role,
                mandate: op.mandate,
              });
              doc = clearPendingTopology(
                upsertParentMapEdge(doc, op.parentSessionId, op.childSessionId, {
                  role: op.role,
                  mandate: op.mandate,
                }),
                op.childSessionId,
              );
            } else if (op.kind === 'unmount') {
              await api.sessions.unmount(op.childSessionId);
              doc = clearPendingTopology(disconnectParentEdges(doc, op.childSessionId), op.childSessionId);
            }
          } catch {
            if (disposedRef.current || revision !== refreshRevision.current) return;
            const failedDoc = clearPendingTopology(doc, op.childSessionId);
            doc = op.parentSessionId !== undefined
              ? upsertParentMapEdge(failedDoc, op.parentSessionId, op.childSessionId, { status: 'error' })
              : failedDoc;
            showHint(tr('这份工作暂时没生效，可以重试。', '这份工作暂时没生效，可以重试。'));
            break;
          }
        }
        if (doc !== mapDocRef.current) {
          mapDocRef.current = doc;
          setMapDoc(doc);
          saveSessionMapDoc(doc);
          onGraphChanged?.();
          if (disposedRef.current || revision !== refreshRevision.current) return;
          const refreshed = ensureGraphEdges(await api.sessions.getGraph({ exclude_empty: false }));
          if (disposedRef.current || revision !== refreshRevision.current) return;
          setGraph(refreshed);
        }
      }
    } catch {
      if (disposedRef.current || revision !== refreshRevision.current) return;
      showError(
        (graph !== null || forceNodesRef.current.length > 0)
          ? tr('Cannot refresh the map. Showing the last saved map.', '连不上，下面是上次的地图。')
          : tr('The map could not be loaded.', '地图暂时打不开。'),
      );
      // Keep the last successful graph when the server is unavailable. Sidebar
      // data may still be loading (or may be a partial page), so replacing the
      // snapshot with `sessions` alone would make cached nodes disappear.
      const fallbackById = new Map((graph?.nodes ?? []).map((node) => [node.id, node]));
      for (const session of sessions) fallbackById.set(session.id, session);
      const fallback = ensureGraphEdges({
        nodes: [...fallbackById.values()],
        edges: graph?.edges ?? [],
      });
      if (disposedRef.current || revision !== refreshRevision.current) return;
      setGraph(fallback);
      saveCachedMapGraph(fallback);
    }
  }, [graph, onGraphChanged, pruneStalePositions, sessions, showError, tr]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // Stable session-id signature — avoid refresh storms when parent re-renders
  // with a new `sessions` array of the same ids.
  const sessionsSignature = useMemo(
    () => sessions.map((session) => `${session.id}:${session.updated_at}`).join('\0'),
    [sessions],
  );

  useEffect(() => {
    void refreshRef.current();
  }, [sessionsSignature]);

  // Fixed poll interval — do not reset when `refresh` identity changes.
  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshRef.current();
    }, MAP_POLL_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => subscribeAppErrors((errors) => {
    setLiveHints((previous) => ({
      ...previous,
      errors: errors.map((item) => ({
        sessionId: item.sessionId,
        agentId: item.agentId,
        message: item.message,
      })),
    }));
  }), []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const busy = forceNodesRef.current.some((node) => {
        const status = mapMemberStatus(node.member);
        return sessionIsBusy(node.member.session)
          || status === 'running'
          || status === 'working'
          || status === 'awaiting_approval'
          || status === 'awaiting_question';
      });
      if (busy) scheduleRedraw();
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [scheduleRedraw]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const applySize = (width: number, height: number) => {
      const next = {
        width: Math.max(0, Math.round(width)),
        height: Math.max(0, Math.round(height)),
      };
      setViewportSize((previous) => (
        previous.width === next.width && previous.height === next.height ? previous : next
      ));
    };
    const rect = el.getBoundingClientRect();
    applySize(rect.width, rect.height);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      applySize(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const allNodes = useMemo(() => {
    const merged = new Map((graph?.nodes ?? []).map((node) => [node.id, node]));
    for (const session of sessions) merged.set(session.id, session);
    return [...merged.values()];
  }, [graph, sessions]);
  const byId = useMemo(() => new Map(allNodes.map((session) => [session.id, session])), [allNodes]);

  const mapGraphContext = useMemo(() => ({
    sessions: allNodes,
    mapEdges: mapDoc.edges ?? [],
  }), [allNodes, mapDoc.edges]);

  const memberCaps = useCallback((member: MapMemberRef) => (
    mapNodeCapabilities(member, mapGraphContext)
  ), [mapGraphContext]);

  const openMember = useCallback((member: MapMemberRef) => {
    if (performance.now() <= suppressMapClickUntilRef.current) return;
    const sessionId = member.session.id.trim();
    if (sessionId.length === 0) {
      showError(tr('This team member is no longer available.', '这个团队成员已不可用。'));
      return;
    }
    clearError();
    setSelectedIds([]);
    setSelectedWorkEdge(null);
    onOpenSession(sessionId);
  }, [clearError, onOpenSession, showError, tr]);

  const listMembers = useMemo(() => {
    return allNodes.map((session) => ({
      session,
      kind: 'session' as const,
      hostSessionId: parentSessionIdOf(session),
    }));
  }, [allNodes]);

  const filteredList = useMemo(() => {
    const q = query.trim().toLowerCase();
    return listMembers.filter((member) => {
      const sessionId = member.session.id;
      if (!q) return true;
      const title = memberLabel(member).toLowerCase();
      const prompt = (member.session.last_prompt ?? '').toLowerCase();
      const role = (memberRole(member) ?? '').toLowerCase();
      const mandate = (
        typeof member.session.metadata?.mount_mandate === 'string'
          ? member.session.metadata.mount_mandate
          : ''
      ).toLowerCase();
      const cwd = (memberProjectCwd(member, byId) ?? '').toLowerCase();
      const folder = cwd ? projectFolderName(cwd).toLowerCase() : '';
      return title.includes(q)
        || prompt.includes(q)
        || sessionId.toLowerCase().includes(q)
        || role.includes(q)
        || mandate.includes(q)
        || cwd.includes(q)
        || folder.includes(q);
    });
  }, [byId, listMembers, query]);

  const visibleIds = useMemo(() => new Set(filteredList.map((member) => nodeKey(member))), [filteredList]);
  useEffect(() => {
    searchIndexRef.current = 0;
    setSearchFocusId(null);
  }, [query]);
  const treeLayout = useMemo(() => {
    const serverGraph = ensureGraphEdges({
      nodes: allNodes,
      edges: graph?.edges ?? [],
    });
    const { layoutEdges } = mergeGraphWithMapEdges(
      serverGraph.nodes,
      serverGraph.edges,
      mapDoc.edges ?? [],
    );
    const base = layoutSessionMountForest({
      nodes: serverGraph.nodes,
      edges: layoutEdges,
    });
    return base;
  }, [allNodes, graph?.edges, mapDoc.edges]);

  // Layout is still seeded as a forest for stable placement, but rendering
  // follows the persisted work edges. This keeps additional parent jobs
  // visible as honest pending intent instead of silently collapsing them.
  const visualWorkEdges = useMemo(() => {
    const serverFallback = treeLayout.edges.map(({ from, to }) => ({
      source: from.member.session.id,
      target: to.member.session.id,
      status: undefined as string | undefined,
      role: undefined as string | undefined,
      mandate: undefined as string | undefined,
    }));
    const persisted = (mapDoc.edges ?? [])
      .filter((edge) => edge.type === 'parent')
      .filter((edge) => edge.source !== edge.target)
      .filter((edge) => allNodes.some((node) => node.id === edge.source)
        && (allNodes.some((node) => node.id === edge.target) || edge.target === draftRef.current?.id))
      .map((edge) => ({
        source: edge.source,
        target: edge.target,
        status: edge.status,
        role: edge.role,
        mandate: edge.mandate,
      }));
    const seen = new Set(persisted.map((edge) => `${edge.source}->${edge.target}`));
    return [
      ...persisted,
      ...serverFallback.filter((edge) => !seen.has(`${edge.source}->${edge.target}`)),
    ];
  }, [allNodes, draft?.id, mapDoc.edges, treeLayout.edges]);

  const topologyKey = useMemo(() => {
    const nodePart = treeLayout.placed.map((node) => nodeKey(node.member)).sort().join('\0');
    const edgePart = visualWorkEdges
      .filter((edge) => isLiveLayoutParentEdge({ type: 'parent', status: edge.status }))
      .map((edge) => `${edge.source}->${edge.target}`)
      .sort()
      .join('\0');
    return `${nodePart}\u0001${edgePart}`;
  }, [treeLayout, visualWorkEdges]);

  // Rebuild force graph when mount topology / filter set changes.
  // Existing ids keep positionsRef / previous sim coords — never teleport on graph poll.
  useEffect(() => {
    if (topologyKeyRef.current === topologyKey) return;
    topologyKeyRef.current = topologyKey;
    // Slot targets may shift when agents/mounts arrive. Only re-allow autofocus if
    // the user has not already pan/zoomed away from the initial focus.
    if (!userAdjustedViewRef.current) {
      centeredSessionRef.current = undefined;
    }

    const persisted = normalizeMapPositions(mapDocRef.current.positions) ?? {};
    for (const [id, pos] of Object.entries(persisted)) {
      if (lookupMapPosition(positionsRef.current, id) === undefined) {
        positionsRef.current.set(id, pos);
      }
    }

    const previousById = new Map(forceNodesRef.current.map((node) => [node.id, node]));
    const { nodes, seeds } = buildForceMapNodes({
      placed: treeLayout.placed,
      previousById,
      positions: positionsRef.current,
    });
    seedByIdRef.current = seeds;
    for (const node of nodes) {
      if (node.fx == null || node.fy == null) continue;
      positionsRef.current.set(node.id, { x: node.fx, y: node.fy });
    }

    const nodeIds = new Set(treeLayout.placed.map((placed) => nodeKey(placed.member)));
    const links: ForceMapLink[] = visualWorkEdges
      .filter((edge) => isLiveLayoutParentEdge({ type: 'parent', status: edge.status }))
      .filter((edge) => nodeIds.has(`session:${edge.source}`) && nodeIds.has(`session:${edge.target}`))
      .map((edge) => ({
        source: `session:${edge.source}`,
        target: `session:${edge.target}`,
      }));
    setForceNodes(nodes);
    setForceLinks(links);
  }, [topologyKey, treeLayout, visualWorkEdges]);

  // Merge into an existing simulation when possible — full restart teleports the forest.
  useEffect(() => {
    if (forceNodes.length === 0) {
      simulationRef.current?.stop();
      simulationRef.current = null;
      return;
    }

    const componentOf = (node: ForceMapNode): string => (
      componentIndexRef.current.get(node.id)?.componentId ?? node.id
    );

    const childHome = (node: ForceMapNode): { x: number; y: number } => {
      const comp = componentIndexRef.current.get(node.id);
      if (comp === undefined || comp.rootNodeId === node.id) {
        return { x: node.x ?? 0, y: node.y ?? 0 };
      }
      const root = forceNodesRef.current.find((candidate) => candidate.id === comp.rootNodeId);
      const seeds = seedByIdRef.current;
      const targets = tidyComponentAroundRoot({
        rootNodeId: comp.rootNodeId,
        nodeIds: comp.nodeIds,
        rootPosition: { x: root?.x ?? 0, y: root?.y ?? 0 },
        seeds,
      });
      return targets.get(node.id) ?? { x: node.x ?? 0, y: node.y ?? 0 };
    };

    const homeStrength = (node: ForceMapNode): number => {
      if (!SESSION_MAP_AMBIENT_HOME_GRAVITY) return 0;
      if (isComponentRootPin(node.id, componentIndexRef.current)) return 0;
      if (dragRef.current?.groupNodeIds.includes(node.id)) return 0;
      return HOME_PULL_STRENGTH;
    };

    let simulation = simulationRef.current;
    if (simulation === null) {
      simulation = forceSimulation(forceNodes)
        .force(
          'link',
          forceLink<ForceMapNode, ForceMapLink>(forceLinks)
            .id((node) => node.id)
            .distance(LINK_DISTANCE)
            .strength(LINK_STRENGTH),
        )
        .force(
          'collision',
          forceIntraComponentCollide(componentOf, COLLIDE_RADIUS, 0.55),
        )
        .force(
          'homeX',
          forceX<ForceMapNode>((node) => childHome(node).x).strength(homeStrength),
        )
        .force(
          'homeY',
          forceY<ForceMapNode>((node) => childHome(node).y).strength(homeStrength),
        )
        .alphaTarget(0)
        .alphaDecay(0.022)
        .velocityDecay(0.52)
        .on('tick', () => {
          for (const node of forceNodesRef.current) {
            if (node.fx == null || node.fy == null) continue;
            positionsRef.current.set(node.id, { x: node.fx, y: node.fy });
          }
          scheduleRedraw();
        })
        .on('end', () => {
          for (const node of forceNodesRef.current) {
            const x = node.x ?? 0;
            const y = node.y ?? 0;
            node.x = x;
            node.y = y;
            node.fx = x;
            node.fy = y;
            node.vx = 0;
            node.vy = 0;
            positionsRef.current.set(node.id, { x, y });
          }
          persistPositions(positionsRef.current);
          scheduleRedraw();
        });
      simulationRef.current = simulation;
      const needsSettle = forceNodes.some((node) => node.fx == null || node.fy == null);
      if (needsSettle) simulation.alpha(SETTLE_ALPHA);
      else simulation.alpha(0).stop();
    } else {
      simulation.nodes(forceNodes);
      const linkForce = simulation.force('link') as ReturnType<typeof forceLink<ForceMapNode, ForceMapLink>> | undefined;
      linkForce?.links(forceLinks);
      linkForce?.strength(LINK_STRENGTH);
      const needsSettle = forceNodes.some((node) => node.fx == null || node.fy == null);
      if (needsSettle) {
        // Mild settle for newcomers only — pinned user coords stay put.
        simulation.alpha(Math.max(simulation.alpha(), SETTLE_ALPHA * 0.45)).restart();
      }
    }

    return () => {
      // Keep the live simulation across topology merges; only stop on unmount
      // (empty forceNodes branch above) or when React tears the effect down for real.
    };
  }, [forceNodes, forceLinks, persistPositions, scheduleRedraw]);

  // Stop simulation on unmount.
  useEffect(() => () => {
    simulationRef.current?.stop();
    simulationRef.current = null;
  }, []);

  const focusNode = useCallback((target: ForceMapNode | undefined, nextScale?: number) => {
    if (target === undefined || target.x === undefined || target.y === undefined) return false;
    const width = viewportSize.width;
    const height = viewportSize.height;
    if (width <= 0 || height <= 0) return false;
    const base = nextScale === undefined
      ? viewRef.current
      : { ...viewRef.current, scale: Math.max(MIN_SCALE, Math.min(MAX_SCALE, nextScale)) };
    setView(centerViewOnNode(
      base,
      { x: target.x - NODE_W / 2, y: target.y - NODE_H / 2 },
      { width, height },
      { width: NODE_W, height: NODE_H },
      focusInsetForViewport(),
    ));
    return true;
  }, [viewportSize.height, viewportSize.width]);

  const findActiveForceNode = useCallback((sessionId: string | undefined): ForceMapNode | undefined => {
    if (sessionId === undefined) return undefined;
    return forceNodesRef.current.find((node) => node.member.session.id === sessionId);
  }, []);

  const stopFollowFocus = useCallback(() => {
    followFocusUntilRef.current = 0;
    if (followRafRef.current !== null) {
      window.cancelAnimationFrame(followRafRef.current);
      followRafRef.current = null;
    }
  }, []);

  const startFollowFocus = useCallback((sessionId: string, durationMs = 1400) => {
    stopFollowFocus();
    followFocusUntilRef.current = performance.now() + durationMs;
    const tick = () => {
      if (performance.now() >= followFocusUntilRef.current) {
        followRafRef.current = null;
        return;
      }
      if (userAdjustedViewRef.current) {
        followRafRef.current = null;
        return;
      }
      if (centeredSessionRef.current !== sessionId) {
        // Topology rebuild / focus change invalidated this follow — stop
        // instead of spinning uselessly until the timeout.
        followRafRef.current = null;
        return;
      }
      focusNode(findActiveForceNode(sessionId));
      followRafRef.current = window.requestAnimationFrame(tick);
    };
    followRafRef.current = window.requestAnimationFrame(tick);
  }, [findActiveForceNode, focusNode, stopFollowFocus]);

  // Reset user-adjust lock when the open session changes (new autofocus target).
  useEffect(() => {
    userAdjustedViewRef.current = false;
    didFitEmptyRef.current = false;
    centeredSessionRef.current = undefined;
  }, [activeSessionId]);

  // Entering the map or switching the open session: center on that session node.
  // After success, skip later layout polls so user pan is not stolen.
  useEffect(() => {
    if (viewportSize.width <= 0 || viewportSize.height <= 0) return;

    if (activeSessionId !== undefined) {
      if (userAdjustedViewRef.current) return;
      if (centeredSessionRef.current === activeSessionId) return;
      const target = findActiveForceNode(activeSessionId);
      if (target !== undefined && focusNode(target)) {
        centeredSessionRef.current = activeSessionId;
        startFollowFocus(activeSessionId);
        return;
      }
      // Node not placed yet — fit once while waiting; do not refit on every poll.
      if (!didFitEmptyRef.current) {
        didFitEmptyRef.current = true;
        setView(fitTreeView(
          { width: treeLayout.width, height: treeLayout.height },
          viewportSize,
        ));
      }
      return;
    }

    centeredSessionRef.current = undefined;
    stopFollowFocus();
    if (!userAdjustedViewRef.current && !didFitEmptyRef.current) {
      didFitEmptyRef.current = true;
      setView(fitTreeView(
        { width: treeLayout.width, height: treeLayout.height },
        viewportSize,
      ));
    }
  }, [
    activeSessionId,
    findActiveForceNode,
    focusNode,
    forceNodes,
    startFollowFocus,
    stopFollowFocus,
    treeLayout.height,
    treeLayout.width,
    viewportSize,
  ]);

  useEffect(() => () => {
    stopFollowFocus();
  }, [stopFollowFocus]);

  // Wheel must be a native non-passive listener: React's synthetic onWheel is
  // passive on the root, so preventDefault there cannot stop page scroll/zoom.
  const wheelHandlerRef = useRef<(event: WheelEvent) => void>(() => {});
  wheelHandlerRef.current = (event: WheelEvent) => {
    event.preventDefault();
    const el = viewportRef.current;
    if (!el) return;
    markUserAdjustedView();
    stopFollowFocus();
    const current = viewRef.current;
    const rect = el.getBoundingClientRect();
    if (event.deltaY === 0 && event.deltaX !== 0) {
      setView(snapMapView({
        ...current,
        x: current.x - event.deltaX,
      }));
      return;
    }
    setView(zoomTreeView(
      current,
      current.scale * (event.deltaY < 0 ? 1.12 : 0.89),
      event.clientX - rect.left,
      event.clientY - rect.top,
    ));
  };

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const handler = (event: WheelEvent) => wheelHandlerRef.current(event);
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onContextMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.session-identity-drawer, input, textarea, [contenteditable="true"]') !== null) return;
      event.preventDefault();
    };
    const onSelectStart = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]') !== null) return;
      event.preventDefault();
    };
    el.addEventListener('contextmenu', onContextMenu, true);
    el.addEventListener('selectstart', onSelectStart, true);
    return () => {
      el.removeEventListener('contextmenu', onContextMenu, true);
      el.removeEventListener('selectstart', onSelectStart, true);
    };
  }, []);

  const onPointerDown = (event: ReactPointerEvent) => {
    const target = event.target as HTMLElement;
    const isDraft = target.closest('.session-map-draft-node') !== null;
    if (target.closest('.session-map-context-menu') !== null) return;
    if (target.closest('.session-identity-drawer') !== null) return;

    const gesture = gestureRef.current;
    if (gesture.kind === 'pan-done' || gesture.kind === 'right-click') {
      gestureRef.current = { kind: 'idle' };
    }

    const rightOrMiddle = event.button === 2 || event.button === 1;
    if (rightOrMiddle && marqueeRef.current !== null) {
      marqueeRef.current = null;
      setMarquee(null);
    }

    const otherGesture = wireDragRef.current !== null
      || dragRef.current !== null
      || annotationDragRef.current !== null
      || draftDragRef.current !== null
      || isBlockingStageGesture(gestureRef.current.kind);
    if (rightOrMiddle && wireDragRef.current !== null) {
      cancelWireDrag();
      gestureRef.current = { kind: 'pan-done' };
      return;
    }
    if (rightOrMiddle) {
      if (otherGesture) return;
    } else if (otherGesture || marqueeRef.current !== null) {
      return;
    }

    setNodeMenu(null);
    setCanvasMenu(null);
    setWorkEdgeMenu(null);
    setWorkEdgeEditor(null);
    setSelectedWorkEdge(null);
    setDraftMenu(null);
    if (event.button === 0 && spacePressedRef.current) {
      event.preventDefault();
      stopFollowFocus();
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      gestureRef.current = {
        kind: 'panning',
        pointerId: event.pointerId,
        originX: event.clientX,
        originY: event.clientY,
        view: viewRef.current,
        source: 'space',
      };
      setPanning(true);
      return;
    }
    if (event.button === 0 && isDraft) {
      return;
    }
    // Annotation body uses pointer-events:none — only chrome (title/resize) captures.
    // Do not treat the annotation shell as a blocker for marquee/pan.
    if (event.button === 0 && target.closest('.session-map-node, .session-map-annotation-chrome, .session-map-float') !== null) {
      return;
    }

    // Right-drag pans. Pure right-click stays pending until pointerup so a
    // menu can open without a pan or a leftover marquee.
    if (event.button === 2 || event.button === 1) {
      stopFollowFocus();
      event.preventDefault();
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      if (event.button === 1) {
        gestureRef.current = {
          kind: 'panning',
          pointerId: event.pointerId,
          originX: event.clientX,
          originY: event.clientY,
          view: viewRef.current,
          source: 'middle',
        };
        setPanning(true);
        return;
      }
      gestureRef.current = {
        kind: 'right-click-pending',
        pointerId: event.pointerId,
        originX: event.clientX,
        originY: event.clientY,
        view: viewRef.current,
        hit: resolveRightClickHit(event.target),
      };
      return;
    }

    if (event.button !== 0) return;
    // Alt is reserved for disconnecting a work edge / connected port.
    // Empty canvas must not start a marquee or pan from this modifier.
    if (event.altKey) return;

    stopFollowFocus();
    // Left drag on empty canvas → ephemeral marquee (node selection region).
    const world = clientToWorld(event.clientX, event.clientY);
    if (world === null) return;
    const next = {
      startX: world.x,
      startY: world.y,
      endX: world.x,
      endY: world.y,
      additive: event.shiftKey,
    };
    marqueeRef.current = next;
    setMarquee(next);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const openWorkEdgeEditor = (parentId: string, childId: string) => {
    const edge = findParentMapEdge(mapDocRef.current.edges, parentId, childId);
    const child = byId.get(childId);
    const childServerParent = parentSessionIdOf(child);
    // Mount metadata belongs to the currently mounted job. A new job for the
    // same child must start with an empty role/mandate so it cannot silently
    // inherit the old parent's identity.
    const isCurrentServerEdge = childServerParent === parentId;
    setWorkEdgeMenu(null);
    setWorkEdgeEditor({
      parentId,
      childId,
      role: edge?.role ?? (isCurrentServerEdge && typeof child?.metadata?.mount_role === 'string' ? child.metadata.mount_role : ''),
      mandate: edge?.mandate ?? (isCurrentServerEdge && typeof child?.metadata?.mount_mandate === 'string' ? child.metadata.mount_mandate : ''),
      prompt: '',
      saving: false,
    });
  };

  const selectWorkEdge = useCallback((parentId: string, childId: string) => {
    setSelectedIds([]);
    setSelectedWorkEdge({ parentId, childId });
    setWorkEdgeEditor(null);
    setWorkEdgeMenu(null);
    setConfirmWorkEdge(null);
  }, []);

  const dismissUnappliedExtraJob = useCallback((parentId: string, childId: string) => {
    persistDoc(removeSessionMapEdgeByEndpoints(mapDocRef.current, 'parent', parentId, childId));
    setSelectedWorkEdge((current) => (
      current !== null && current.parentId === parentId && current.childId === childId
        ? null
        : current
    ));
    setWorkEdgeMenu(null);
    setConfirmWorkEdge(null);
  }, [persistDoc]);
  dismissUnappliedExtraJobRef.current = dismissUnappliedExtraJob;

  const executeSilentLink = useCallback(async (
    childId: string,
    parentId: string,
    forceRemount = false,
  ): Promise<'added' | 'remounted' | 'pending' | 'unapplied' | 'already' | 'rejected'> => {
    const child = allNodes.find((session) => session.id === childId);
    const parent = allNodes.find((session) => session.id === parentId);
    const mapParents = mapParentByChildFromEdges(mapDocRef.current.edges ?? []);
    const serverParent = parentSessionIdOf(child);
    const existingEdge = findParentMapEdge(mapDocRef.current.edges, parentId, childId);
    const hasExistingParentEdge = serverParent === parentId || (
      existingEdge !== undefined && existingEdge.status !== 'error'
    );
    const currentParent = serverParent ?? mapParents.get(childId);
    if (hasExistingParentEdge && !forceRemount) {
      busyRef.current = false;
      if (existingEdge !== undefined && isUnappliedExtraJob(existingEdge)) {
        selectWorkEdge(parentId, childId);
        return 'unapplied';
      }
      showHint(tr('Already mounted under this parent.', '已挂载在该父节点下。'));
      return 'already';
    }
    if (wouldCreateMountCycle(childId, parentId, allNodes, mapParents)) {
      busyRef.current = false;
      showNodeError(childId, tr(
        'Cannot mount here — it would create a cycle.',
        '不能挂到自己的下级。',
      ));
      return 'rejected';
    }
    if (currentParent !== undefined && !forceRemount) {
      busyRef.current = false;
      // Down-port hire: never remount. The server still stores one parent, so
      // keep this second job as an honest unapplied line until the user
      // explicitly chooses to move the live mount.
      persistDoc(upsertParentMapEdge(mapDocRef.current, parentId, childId, {
        status: UNAPPLIED_EXTRA_JOB_STATUS,
      }));
      selectWorkEdge(parentId, childId);
      return 'unapplied';
    }
    if (sessionIsBusy(child) || sessionIsBusy(parent)) {
      busyRef.current = false;
      const pendingKind = forceRemount || serverParent !== undefined ? 'remount' : 'mount';
      let pendingDoc = queuePendingTopology(mapDocRef.current, {
        kind: pendingKind,
        childSessionId: childId,
        parentSessionId: parentId,
      });
      pendingDoc = upsertParentMapEdge(pendingDoc, parentId, childId, { status: 'pending' });
      persistDoc(pendingDoc);
      showHint(tr(
        'Waiting for it to finish.',
        '等它说完。',
      ));
      return 'pending';
    }
    busyRef.current = true;
    clearError();
    try {
      if (serverParent !== undefined) {
        await api.sessions.remount(childId, parentId, {});
      } else {
        await api.sessions.mount(childId, parentId, {});
      }
      if (disposedRef.current) return 'rejected';
      let nextDoc = upsertParentMapEdge(mapDocRef.current, parentId, childId);
      if (serverParent !== undefined) {
        nextDoc = {
          ...nextDoc,
          edges: (nextDoc.edges ?? []).filter((edge) => !(
            edge.type === 'parent' && edge.target === childId && edge.source !== parentId
          )),
        };
      }
      persistDoc(clearPendingTopology(nextDoc, childId));
      await refresh();
      if (disposedRef.current) return 'rejected';
      onGraphChanged?.();
      return serverParent === undefined ? 'added' : 'remounted';
    } catch (error) {
      if (disposedRef.current) return 'rejected';
      const message = error instanceof Error ? error.message : String(error);
      const cycleHint = /cycle|环|40921|mount_cycle/i.test(message);
      persistDoc(upsertParentMapEdge(mapDocRef.current, parentId, childId, { status: 'error' }));
      showNodeError(childId, cycleHint
        ? tr('Cannot mount here — it would create a cycle.', '不能挂到自己的下级。')
        : tr('This job could not be connected. Try again.', '这份工作没接上，可以再试一次。'));
      return 'rejected';
    } finally {
      if (!disposedRef.current) busyRef.current = false;
      else busyRef.current = false;
    }
  }, [allNodes, clearError, onGraphChanged, persistDoc, refresh, selectWorkEdge, showHint, showNodeError, tr]);

  const finishWireDrag = useCallback(async (event: PointerEvent) => {
    const active = wireDragRef.current;
    // A different pointer lifting mid-wire must not finish (or cancel) it.
    if (active !== null && event.pointerId !== active.pointerId) return;
    detachWireListeners();
    wireDragRef.current = null;
    setWireDrag(null);
    setWireSnapTargetId(null);
    if (active === null || event.type === 'pointercancel' || event.button !== 0) return;

    armClickSuppression();

    // Tiny screen drag = cancel (click on port). Client-space threshold on
    // purpose: it measures finger/mouse travel, independent of zoom.
    if (Math.hypot(event.clientX - active.startClientX, event.clientY - active.startClientY) < 12) {
      return;
    }

    const world = clientToWorld(event.clientX, event.clientY);
    if (world === null) {
      busyRef.current = false;
      return;
    }
    let { x: worldX, y: worldY } = world;

    const preferPort = active.side === 'out' ? 'in' : 'out';
    const hitRadius = scaledWorldRadius(PORT_HIT_RADIUS, viewRef.current.scale);
    const snapRadius = scaledWorldRadius(NEAR_MISS_RADIUS, viewRef.current.scale);
    const hitRaw = hitSessionMapNode(forceNodesRef.current, worldX, worldY, {
      excludeId: active.fromId,
      preferPort,
      portRadius: hitRadius,
    });
    let hit = hitRaw === undefined
      ? undefined
      : forceNodesRef.current.find((node) => node.id === hitRaw.id);

    if (hit === undefined || (hit !== undefined && !isValidWireTarget(active, hit, allNodes, mapDocRef.current.edges ?? []))) {
      const snap = findNearestValidWireTarget(
        forceNodesRef.current,
        worldX,
        worldY,
        active,
        allNodes,
        mapDocRef.current.edges ?? [],
        snapRadius,
      );
      if (snap !== undefined) {
        hit = snap.node;
        worldX = snap.portX;
        worldY = snap.portY;
      }
    }

    if (hit === undefined) {
      // The first hit test excludes the wire source so a card cannot be
      // mistaken for a valid target. Keep a second hit only for explaining
      // an invalid drop, especially a self-connection or a cycle.
      const invalidHit = hitSessionMapNode(forceNodesRef.current, worldX, worldY, {
        preferPort,
        portRadius: hitRadius,
      });
      if (invalidHit?.id === active.fromId) {
        busyRef.current = false;
        showNodeError(active.fromId, tr('Cannot connect a session to itself.', '不能把会话挂到自己身上。'));
        return;
      }
      if (invalidHit !== undefined) {
        const invalidNode = forceNodesRef.current.find((node) => node.id === invalidHit.id);
        const invalidSessionId = invalidNode?.member.session.id;
        const cycle = invalidSessionId !== undefined && (
          active.side === 'out'
            ? wouldCreateMountCycle(invalidSessionId, active.parentSessionId, allNodes, mapParentByChildFromEdges(mapDocRef.current.edges ?? []))
            : wouldCreateMountCycle(active.childSessionId, invalidSessionId, allNodes, mapParentByChildFromEdges(mapDocRef.current.edges ?? []))
        );
        if (cycle) {
          busyRef.current = false;
          showNodeError(active.fromId, tr('Cannot mount here — it would create a cycle.', '不能挂到自己的下级。'));
          return;
        }
      }
      const nearest = nearestSessionMapNodeDistance(forceNodesRef.current, worldX, worldY, active.fromId);
      if (nearest !== undefined && nearest <= snapRadius) {
        busyRef.current = false;
        showNodeError(active.fromId, tr(
          'Drop missed the node. Aim for the port or card.',
          '未命中节点，请对准端口或卡片。',
        ));
        return;
      }
    }

    if (active.side === 'in') {
      const childId = active.childSessionId;
      if (childId.length === 0 || childId.startsWith('agent:')) {
        busyRef.current = false;
        return;
      }
      if (hit === undefined) {
        busyRef.current = false;
        // Reconnecting from the input port is intentionally cancellable:
        // dropping on empty space does not create a parent or mutate state.
        return;
      }
      if (!isValidWireTarget(active, hit, allNodes, mapDocRef.current.edges ?? [])) {
        busyRef.current = false;
        if (wouldCreateMountCycle(
          childId,
          hit.member.session.id,
          allNodes,
          mapParentByChildFromEdges(mapDocRef.current.edges ?? []),
        )) {
          showNodeError(active.fromId, tr('Cannot mount here — it would create a cycle.', '不能挂到自己的下级。'));
        } else {
          showNodeError(active.fromId, tr('Move this job to another session card.', '请改挂到另一张会话卡片。'));
        }
        return;
      }
      const parentId = hit.member.session.id;
      if (parentId === childId) {
        busyRef.current = false;
        return;
      }
      await executeSilentLink(childId, parentId, true);
      return;
    }

    const parentSessionId = active.parentSessionId;
    if (parentSessionId.length === 0 || parentSessionId.startsWith('agent:')) {
      busyRef.current = false;
      return;
    }

    if (hit !== undefined) {
      if (!isValidWireTarget(active, hit, allNodes, mapDocRef.current.edges ?? [])) {
        busyRef.current = false;
        if (hit.member.session.id === parentSessionId) {
          showHint(tr('Already mounted under this parent.', '已挂载在该父节点下。'));
        } else if (wouldCreateMountCycle(
          hit.member.session.id,
          parentSessionId,
          allNodes,
          mapParentByChildFromEdges(mapDocRef.current.edges ?? []),
        )) {
          showNodeError(active.fromId, tr('Cannot mount here — it would create a cycle.', '不能挂到自己的下级。'));
        } else {
          showNodeError(active.fromId, tr('Wire to a real session card.', '请连接到真实的会话卡片。'));
        }
        return;
      }
      const childId = hit.member.session.id;
      if (childId === parentSessionId) {
        busyRef.current = false;
        return;
      }
      const result = await executeSilentLink(childId, parentSessionId);
      // A new job gets its own identity. The child title remains the session
      // name; role and responsibility belong to this parent edge.
      // An unapplied extra job is selected instead — it is not live yet.
      if (result === 'added' || result === 'pending') {
        openWorkEdgeEditor(parentSessionId, childId);
      }
      return;
    }

    // Dropping on empty space creates a draft node. The parent edge is
    // persisted as soon as the draft appears and remains until Esc/abandon.
    const siblings = forceNodesRef.current
      .filter((node) => parentSessionIdOf(node.member.session) === parentSessionId)
      .map((node) => ({ x: node.x ?? worldX, y: node.y ?? worldY }));
    const spawn = offsetSpawnFromSiblings(siblings, worldX, worldY + NODE_H / 2);
    const draftId = `draft:${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    setDraft({
      id: draftId,
      parentId: parentSessionId,
      title: '',
      role: '',
      mandate: '',
      prompt: '',
      status: 'editing',
      worldX: spawn.x,
      worldY: spawn.y,
    });
    persistDoc({
      ...upsertParentMapEdge(mapDocRef.current, parentSessionId, draftId, { status: 'draft' }),
      positions: {
        ...mapDocRef.current.positions,
        [draftId]: { x: spawn.x, y: spawn.y },
      },
    });
  }, [
    allNodes,
    armClickSuppression,
    clientToWorld,
    detachWireListeners,
    executeSilentLink,
    showHint,
    showNodeError,
    persistDoc,
    tr,
    openWorkEdgeEditor,
  ]);

  const startWireFromPort = (
    event: ReactPointerEvent,
    node: ForceMapNode,
    side: 'out' | 'in',
  ) => {
    // Right/middle clicks must keep their default behavior (context menu).
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    // A port gesture ALWAYS ends in a click near a card — arm suppression up
    // front so even a bare port click can never open the node.
    armClickSuppression();

    if (wireDragRef.current !== null || dragRef.current !== null || marqueeRef.current !== null
      || annotationDragRef.current !== null || draftDragRef.current !== null
      || isBlockingStageGesture(gestureRef.current.kind)) return;
    stopFollowFocus();
    dragRef.current = null;
    detachWireListeners();

    if (event.altKey) {
      disconnectWorkFromPort(node, side);
      return;
    }

    if (side === 'in') {
      // UE Blueprint: drag FROM input pin to reconnect under a different parent.
      const childSessionId = wireSourceParentSessionId(node.member);
      if (childSessionId === null) {
        showNodeError(node.member.session.id, tr(
          'Only real session cards can reconnect from the input port.',
          '只有真实会话卡片才能从输入口重连。',
        ));
        return;
      }
      const hasCurrentWork = parentSessionIdOf(node.member.session) !== undefined
        || (mapDocRef.current.edges ?? []).some((edge) => edge.type === 'parent' && edge.target === childSessionId);
      if (!hasCurrentWork) {
        showHint(tr('This session has no job to move.', '这场会话现在没有可改挂的工作。'));
        return;
      }
      const fromX = node.x ?? 0;
      const fromY = (node.y ?? 0) - NODE_H / 2;
      const next: WireDragState = {
        fromId: node.id,
        side: 'in',
        parentSessionId: '',
        childSessionId,
        fromX,
        fromY,
        toX: fromX,
        toY: fromY - 48,
        startClientX: event.clientX,
        startClientY: event.clientY,
        pointerId: event.pointerId,
      };
      wireDragRef.current = next;
      setWireDrag(next);
    } else {
      const parentSessionId = wireSourceParentSessionId(node.member);
      if (parentSessionId === null) {
        showNodeError(node.member.session.id, tr(
          'This member has no session card yet. Wire from a real session card, or create a member on the canvas.',
          '这个成员还没有自己的会话卡。请从真实会话卡片拉线，或在画布上生一个成员。',
        ));
        return;
      }
      const fromX = node.x ?? 0;
      const fromY = (node.y ?? 0) + NODE_H / 2;
      const next: WireDragState = {
        fromId: node.id,
        side: 'out',
        parentSessionId,
        childSessionId: '',
        fromX,
        fromY,
        toX: fromX,
        toY: fromY + 48,
        startClientX: event.clientX,
        startClientY: event.clientY,
        pointerId: event.pointerId,
      };
      wireDragRef.current = next;
      setWireDrag(next);
    }

    const onMove = (moveEvent: PointerEvent) => {
      const current = wireDragRef.current;
      if (current === null || moveEvent.pointerId !== current.pointerId) return;
      const world = clientToWorld(moveEvent.clientX, moveEvent.clientY);
      if (world === null) return;
      const snap = findNearestValidWireTarget(
        forceNodesRef.current,
        world.x,
        world.y,
        current,
        allNodes,
        mapDocRef.current.edges ?? [],
        scaledWorldRadius(NEAR_MISS_RADIUS, viewRef.current.scale),
      );
      const toX = snap?.portX ?? world.x;
      const toY = snap?.portY ?? world.y;
      setWireSnapTargetId(snap?.node.id ?? null);
      const updated = { ...current, toX, toY };
      wireDragRef.current = updated;
      setWireDrag(updated);
    };
    const onUp = (upEvent: PointerEvent) => {
      void finishWireDrag(upEvent);
    };
    wireListenersRef.current = { move: onMove, up: onUp };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);

    // Single capture owner: the stage — NEVER the port/node. Capturing the
    // port retargets the trailing click into the card and opens the session.
    try {
      viewportRef.current?.setPointerCapture(event.pointerId);
    } catch {
      // Window listeners above still track the rubber-band wire.
    }
  };

  // setDraft + ref mirror must move together: refresh() gates on draftRef.
  const clearDraft = () => {
    const current = draftRef.current;
    if (current !== null) {
      const next = {
        ...mapDocRef.current,
        edges: (mapDocRef.current.edges ?? []).filter((edge) => edge.target !== current.id),
        positions: Object.fromEntries(Object.entries(mapDocRef.current.positions ?? {}).filter(([id]) => id !== current.id)),
      };
      persistDoc(next);
    }
    draftRef.current = null;
    setDraft(null);
  };

  const startDraftDrag = (event: ReactPointerEvent) => {
    if (event.button !== 0 || draftRef.current === null) return;
    if (wireDragRef.current !== null || dragRef.current !== null || annotationDragRef.current !== null
      || marqueeRef.current !== null || isBlockingStageGesture(gestureRef.current.kind)) return;
    if ((event.target as HTMLElement).closest('input, textarea, button, .session-map-port') !== null) return;
    const current = draftRef.current;
    event.stopPropagation();
    event.preventDefault();
    const origin = { x: current.worldX, y: current.worldY };
    const grab = clientToWorld(event.clientX, event.clientY);
    draftDragRef.current = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      originX: origin.x,
      originY: origin.y,
      grabWorldX: grab?.x ?? origin.x,
      grabWorldY: grab?.y ?? origin.y,
      moved: false,
    };
    const onMove = (moveEvent: PointerEvent) => {
      const drag = draftDragRef.current;
      const activeDraft = draftRef.current;
      if (drag === null || activeDraft === null) return;
      if (!drag.moved && Math.hypot(moveEvent.clientX - drag.startClientX, moveEvent.clientY - drag.startClientY) <= CLICK_MOVE_THRESHOLD) return;
      drag.moved = true;
      const world = clientToWorld(moveEvent.clientX, moveEvent.clientY);
      if (world === null) return;
      const next = { ...activeDraft, worldX: drag.originX + (world.x - drag.grabWorldX), worldY: drag.originY + (world.y - drag.grabWorldY) };
      draftRef.current = next;
      setDraft(next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      draftDragRef.current = null;
      if (draftRef.current?.status === 'editing') {
        const activeDraft = draftRef.current;
        persistDoc({
          ...upsertParentMapEdge(mapDocRef.current, activeDraft.parentId, activeDraft.id, { status: 'draft' }),
          positions: {
            ...mapDocRef.current.positions,
            [activeDraft.id]: { x: activeDraft.worldX, y: activeDraft.worldY },
          },
        });
      }
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
  };

  const cancelDraft = () => {
    // Esc must dismiss the draft even while the user is mid-edit; only block
    // during an in-flight createChild (busy) so we do not orphan a half-created session.
    if (draft === null || busyRef.current || draft.status === 'creating') return;
    clearDraft();
  };
  cancelDraftRef.current = () => {
    cancelDraft();
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    // Wire drag is tracked via window capture listeners (see startWireFromPort).
    // Annotation drag likewise uses window listeners (see startAnnotationDrag).
    if (wireDragRef.current !== null || annotationDragRef.current !== null) return;
    const gesture = gestureRef.current;
    if (gesture.kind === 'right-click-pending' || (gesture.kind === 'panning' && gesture.source === 'right')) {
      event.preventDefault();
      if (marqueeRef.current !== null) {
        marqueeRef.current = null;
        setMarquee(null);
      }
      if (event.pointerId !== gesture.pointerId) return;
      if (gesture.kind === 'right-click-pending') {
        if (!pointerMovedBeyondClickThreshold(
          { startX: gesture.originX, startY: gesture.originY },
          event,
        )) {
          return;
        }
        const next = {
          kind: 'panning' as const,
          pointerId: gesture.pointerId,
          originX: gesture.originX,
          originY: gesture.originY,
          view: gesture.view,
          source: 'right' as const,
        };
        gestureRef.current = next;
        setPanning(true);
        markUserAdjustedView();
        setView({
          ...next.view,
          x: next.view.x + (event.clientX - next.originX),
          y: next.view.y + (event.clientY - next.originY),
        });
        return;
      }
    }
    if (gesture.kind === 'panning') {
      if (event.pointerId !== gesture.pointerId) return;
      event.preventDefault();
      const next = {
        ...gesture.view,
        x: gesture.view.x + (event.clientX - gesture.originX),
        y: gesture.view.y + (event.clientY - gesture.originY),
      };
      if (
        Math.abs(next.x - gesture.view.x) > CLICK_MOVE_THRESHOLD
        || Math.abs(next.y - gesture.view.y) > CLICK_MOVE_THRESHOLD
      ) {
        markUserAdjustedView();
      }
      setView(next);
      return;
    }
    if (marqueeRef.current !== null) {
      const world = clientToWorld(event.clientX, event.clientY);
      if (world === null) return;
      const next = { ...marqueeRef.current, endX: world.x, endY: world.y };
      marqueeRef.current = next;
      setMarquee(next);
      return;
    }
    if (dragRef.current) {
      applyNodeDragMove(event.clientX, event.clientY);
    }
  };

  const applyNodeDragMove = (clientX: number, clientY: number) => {
    const drag = dragRef.current;
    if (drag === null) return;
    drag.moved ||= pointerMovedBeyondClickThreshold(drag, { clientX, clientY });
    if (!drag.moved) return;
    const world = clientToWorld(clientX, clientY);
    if (world === null) return;
    // Pin only after real move — prevents click from yanking the card.
    if (!drag.pinned) {
      drag.pinned = true;
      drag.groupStartPositions = new Map();
      for (const nodeId of drag.groupNodeIds) {
        const groupNode = forceNodesRef.current.find((candidate) => candidate.id === nodeId);
        if (groupNode === undefined) continue;
        const x = groupNode.x ?? 0;
        const y = groupNode.y ?? 0;
        drag.groupStartPositions.set(nodeId, { x, y });
        groupNode.fx = x;
        groupNode.fy = y;
      }
      simulationRef.current?.alpha(SETTLE_ALPHA).restart();
    }
    const dx = world.x - drag.grabWorldX;
    const dy = world.y - drag.grabWorldY;
    for (const [nodeId, start] of drag.groupStartPositions) {
      const groupNode = forceNodesRef.current.find((candidate) => candidate.id === nodeId);
      if (groupNode === undefined) continue;
      const x = start.x + dx;
      const y = start.y + dy;
      groupNode.fx = x;
      groupNode.fy = y;
      groupNode.x = x;
      groupNode.y = y;
      positionsRef.current.set(nodeId, { x, y });
    }
    redraw((value) => value + 1);
  };

  /** After a drag, pin every moved node where the user dropped it. */
  const releaseDragPinsAndSettle = useCallback((groupNodeIds: readonly string[]) => {
    for (const nodeId of groupNodeIds) {
      const groupNode = forceNodesRef.current.find((candidate) => candidate.id === nodeId);
      if (groupNode === undefined) continue;
      const x = groupNode.x ?? 0;
      const y = groupNode.y ?? 0;
      groupNode.x = x;
      groupNode.y = y;
      groupNode.vx = 0;
      groupNode.vy = 0;
      groupNode.fx = x;
      groupNode.fy = y;
      positionsRef.current.set(groupNode.id, { x, y });
    }
    persistPositions(positionsRef.current);
    scheduleRedraw();
  }, [persistPositions, scheduleRedraw]);
  releaseDragPinsRef.current = releaseDragPinsAndSettle;

  const finishMarquee = useCallback((additive = false) => {
    const box = marqueeRef.current;
    marqueeRef.current = null;
    setMarquee(null);
    if (box === null) return;
    const left = Math.min(box.startX, box.endX);
    const right = Math.max(box.startX, box.endX);
    const top = Math.min(box.startY, box.endY);
    const bottom = Math.max(box.startY, box.endY);
    if (right - left < 12 || bottom - top < 12) {
      if (!additive) clearSelection();
      return;
    }

    const hitIds: string[] = [];
    const selection = { left, top, right, bottom };
    for (const node of forceNodesRef.current) {
      const sessionId = node.member.session.id;
      const nodeLeft = (node.x ?? 0) - NODE_W / 2;
      const nodeTop = (node.y ?? 0) - NODE_H / 2;
      if (rectsIntersect(selection, {
        left: nodeLeft,
        top: nodeTop,
        right: nodeLeft + NODE_W,
        bottom: nodeTop + NODE_H,
      })) {
        hitIds.push(sessionId);
      }
    }
    const mergeSelection = additive || box.additive === true;
    setSelectedIds((current) => (
      mergeSelection ? [...new Set([...current, ...hitIds])] : hitIds
    ));
    if (hitIds.length > 0) armClickSuppression();
  }, [armClickSuppression, clearSelection]);

  const cancelMarquee = useCallback(() => {
    if (marqueeRef.current === null) return;
    marqueeRef.current = null;
    setMarquee(null);
  }, []);

  const createGroupBoxAt = (worldX: number, worldY: number) => {
    const color = DEFAULT_ANNOTATION_COLORS[mapDocRef.current.annotations.length % DEFAULT_ANNOTATION_COLORS.length]!;
    const annotation: MapAnnotationBox = {
      id: newAnnotationId(),
      title: tr('Group box', '分组框'),
      color,
      rect: {
        x: worldX - 24,
        y: worldY - 24,
        width: NODE_W + 48,
        height: NODE_H + 48,
      },
    };
    persistDoc({
      ...mapDocRef.current,
      annotations: [...mapDocRef.current.annotations, annotation],
    });
    setEditingAnnotationId(annotation.id);
    setCanvasMenu(null);
    clearSelection();
  };

  const annotateSelection = useCallback(() => {
    const selected = forceNodesRef.current.filter((node) => selectedIds.includes(node.member.session.id));
    if (selected.length === 0) return;
    const left = Math.min(...selected.map((node) => (node.x ?? 0) - NODE_W / 2)) - 16;
    const right = Math.max(...selected.map((node) => (node.x ?? 0) + NODE_W / 2)) + 16;
    const top = Math.min(...selected.map((node) => (node.y ?? 0) - NODE_H / 2)) - 16;
    const bottom = Math.max(...selected.map((node) => (node.y ?? 0) + NODE_H / 2)) + 16;
    const color = DEFAULT_ANNOTATION_COLORS[mapDocRef.current.annotations.length % DEFAULT_ANNOTATION_COLORS.length]!;
      const annotation: MapAnnotationBox = {
      id: newAnnotationId(),
      title: tr('Group box', '分组框'),
      color,
      rect: {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      },
    };
    persistDoc({
      ...mapDocRef.current,
      annotations: [...mapDocRef.current.annotations, annotation],
    });
    setEditingAnnotationId(annotation.id);
    clearSelection();
  }, [clearSelection, persistDoc, selectedIds, tr]);

  const openCanvasContextMenu = (event: ReactMouseEvent) => {
    if ((event.target as HTMLElement).closest('.session-map-node') !== null) return;
    event.preventDefault();
    event.stopPropagation();
    setNodeMenu(null);
    const world = clientToWorld(event.clientX, event.clientY);
    setCanvasMenu({
      x: event.clientX,
      y: event.clientY,
      worldX: world?.x ?? CANVAS_PAD,
      worldY: world?.y ?? CANVAS_PAD,
    });
  };

  const blockContextMenuIfGesture = (event: { preventDefault: () => void; stopPropagation: () => void }): boolean => {
    event.preventDefault();
    const kind = gestureRef.current.kind;
    if (kind === 'idle') return false;
    event.stopPropagation();
    if (kind === 'pan-done' || kind === 'right-click') {
      gestureRef.current = { kind: 'idle' };
    }
    return true;
  };

  const openRightClickMenu = (hit: RightClickHit, clientX: number, clientY: number) => {
    if (hit.type === 'node') {
      const member = forceNodesRef.current.find((node) => node.member.session.id === hit.sessionId)?.member;
      if (member === undefined) return;
      const caps = memberCaps(member);
      if (!caps.isRealSession) return;
      setCanvasMenu(null);
      setWorkEdgeMenu(null);
      setDraftMenu(null);
      setNodeMenu({
        sessionId: member.session.id,
        x: clientX,
        y: clientY,
        canUnmount: caps.canDisconnect,
        label: memberLabel(member),
      });
      return;
    }
    if (hit.type === 'edge') {
      setSelectedIds([]);
      setSelectedWorkEdge({ parentId: hit.parentId, childId: hit.childId });
      setNodeMenu(null);
      setCanvasMenu(null);
      setDraftMenu(null);
      setWorkEdgeMenu({
        parentId: hit.parentId,
        childId: hit.childId,
        x: clientX,
        y: clientY,
      });
      return;
    }
    if (hit.type === 'draft') {
      if (draftRef.current === null) return;
      setNodeMenu(null);
      setCanvasMenu(null);
      setWorkEdgeMenu(null);
      setDraftMenu({ x: clientX, y: clientY });
      return;
    }
    setNodeMenu(null);
    setWorkEdgeMenu(null);
    setDraftMenu(null);
    const world = clientToWorld(clientX, clientY);
    setCanvasMenu({
      x: clientX,
      y: clientY,
      worldX: world?.x ?? CANVAS_PAD,
      worldY: world?.y ?? CANVAS_PAD,
    });
  };

  const resolveCreateSessionCwd = (): string | undefined => {
    const preferred = preferredCreateCwd?.trim();
    if (preferred) return preferred;
    const active = activeSessionId ? byId.get(activeSessionId) : undefined;
    const activeCwd = active?.metadata?.cwd;
    if (typeof activeCwd === 'string' && activeCwd.trim()) return activeCwd.trim();
    for (const node of allNodes) {
      const cwd = node.metadata?.cwd;
      if (typeof cwd === 'string' && cwd.trim()) return cwd.trim();
    }
    return undefined;
  };

  const createSessionNodeAt = async (worldX: number, worldY: number, parentId?: string) => {
    setCanvasMenu(null);
    setNodeMenu(null);
    if (parentId !== undefined) {
      if (parentId.startsWith('agent:') || !byId.has(parentId)) {
        showError(tr(
          'Create under a real session card.',
          '请在真实的会话卡片下创建。',
        ), true);
        return;
      }
      const siblings = forceNodesRef.current
        .filter((node) => parentSessionIdOf(node.member.session) === parentId)
        .map((node) => ({ x: node.x ?? worldX, y: node.y ?? worldY }));
      const spawn = offsetSpawnFromSiblings(siblings, worldX, worldY + NODE_H / 2);
      const draftId = `draft:${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      setDraft({
        id: draftId,
        parentId,
        title: '',
        role: '',
        mandate: '',
        prompt: '',
        status: 'editing',
        worldX: spawn.x,
        worldY: spawn.y,
      });
      persistDoc({
        ...upsertParentMapEdge(mapDocRef.current, parentId, draftId, { status: 'draft' }),
        positions: {
          ...mapDocRef.current.positions,
          [draftId]: { x: spawn.x, y: spawn.y },
        },
      });
      return;
    }
    if (onCreateTopLevelSession === undefined) {
      showError(tr(
        'Cannot create a session from the map.',
        '无法从地图创建会话。',
      ), true);
      return;
    }
    const placeholderId = `creating:${Date.now().toString(36)}`;
    setTopLevelPlaceholder({ id: placeholderId, worldX, worldY, status: 'editing' });
    clearError();
  };

  const submitTopLevelCreate = async (values: SessionIdentityDraftValues) => {
    const placeholder = topLevelPlaceholder;
    if (placeholder === null || onCreateTopLevelSession === undefined) return;
    const { id: placeholderId, worldX, worldY } = placeholder;
    setTopLevelPlaceholder({ ...placeholder, status: 'creating', title: values.name.trim() });
    const runCreate = async (cwd: string) => {
      try {
        const createdId = await onCreateTopLevelSession(cwd);
        if (disposedRef.current || !createdId) {
          setTopLevelPlaceholder((current) => current?.id === placeholderId ? { ...current, status: 'error' } : current);
          return;
        }
        if (values.name.trim().length > 0 || values.role.trim().length > 0 || values.mandate.trim().length > 0) {
          await api.sessions.updateIdentity(createdId, {
            name: values.name.trim() || undefined,
            role: values.role.trim() || undefined,
            mandate: values.mandate.trim() || undefined,
          }).catch(() => undefined);
        }
        await finalizeTopLevelCreate(placeholderId, createdId, worldX, worldY);
      } catch {
        if (disposedRef.current) return;
        setTopLevelPlaceholder((current) => current?.id === placeholderId ? { ...current, status: 'error' } : current);
      }
    };
    const cwd = resolveCreateSessionCwd();
    if (cwd === undefined) {
      if (onChooseProject === undefined) {
        setTopLevelPlaceholder((current) => current?.id === placeholderId ? { ...current, status: 'error' } : current);
        return;
      }
      onChooseProject({
        createSession: false,
        stayOnMap: true,
        onSelected: (folder) => { void runCreate(folder); },
      });
      return;
    }
    await runCreate(cwd);
  };

  const finishNodeDrag = (event: { clientX: number; clientY: number; type: string }) => {
    const drag = dragRef.current;
    if (drag === null) return;
    detachNodeDragListeners();
    drag.moved ||= pointerMovedBeyondClickThreshold(drag, event);
    if (drag.moved) markUserAdjustedView();
    if (drag.pinned) {
      releaseDragPinsAndSettle(drag.groupNodeIds);
    }
    suppressClickRef.current = drag.moved || event.type === 'pointercancel' ? drag.node.id : null;
    dragRef.current = null;
  };

  const onPointerUp = (event: ReactPointerEvent) => {
    const gesture = gestureRef.current;
    const rightPending = gesture.kind === 'right-click-pending';
    const rightPan = gesture.kind === 'panning' && gesture.source === 'right';
    const blockingPan = isBlockingStageGesture(gesture.kind);
    let openedRightClickMenu = false;
    // Unified cleanup: no matter which gesture path ran (wire early-returns
    // included), pan state must always be released.
    try {
      if (wireDragRef.current !== null) {
        // Window listener also handles finish; keep as safety if capture stayed on stage.
        void finishWireDrag(event.nativeEvent);
        return;
      }
      const annDrag = annotationDragRef.current;
      if (annDrag !== null) {
        annotationDragRef.current = null;
        if (annDrag.moved) {
          saveSessionMapDoc(mapDocRef.current);
          armClickSuppression();
        } else if (event.type !== 'pointercancel') {
          setEditingAnnotationId(annDrag.id);
        }
        return;
      }
      if (rightPending || rightPan || event.button === 2) {
        if (marqueeRef.current !== null) {
          cancelMarquee();
        }
        if (
          gesture.kind === 'right-click-pending'
          && event.button === 2
          && event.type !== 'pointercancel'
        ) {
          openRightClickMenu(gesture.hit, event.clientX, event.clientY);
          openedRightClickMenu = true;
        }
        return;
      }
      if (marqueeRef.current !== null) {
        // pointercancel must not persist a note — abort the marquee.
        if (event.type === 'pointercancel') {
          cancelMarquee();
          return;
        }
        finishMarquee(event.shiftKey);
        return;
      }
      if (dragRef.current) {
        finishNodeDrag(event);
        return;
      }
    } finally {
      if (openedRightClickMenu) {
        gestureRef.current = { kind: 'right-click' };
      } else if (rightPan) {
        gestureRef.current = { kind: 'pan-done' };
      } else if (blockingPan) {
        gestureRef.current = { kind: 'idle' };
      }
      setPanning(false);
      if (rightPending || rightPan || event.button === 2) {
        if (marqueeRef.current !== null) {
          marqueeRef.current = null;
          setMarquee(null);
        }
      }
    }
  };

  const placedForAnnotations = forceNodes.map((node) => ({
    session: node.member.session,
    x: (node.x ?? 0) - NODE_W / 2,
    y: (node.y ?? 0) - NODE_H / 2,
    cx: node.x ?? 0,
  }));

  const beginGroupDrag = (
    event: ReactPointerEvent,
    primary: ForceMapNode,
    groupNodeIds: string[],
  ) => {
    if (wireDragRef.current !== null || annotationDragRef.current !== null || draftDragRef.current !== null
      || marqueeRef.current !== null || isBlockingStageGesture(gestureRef.current.kind)) return;
    stopFollowFocus();
    const grab = clientToWorld(event.clientX, event.clientY);
    try {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    } catch {
      // Window listeners below still track the drag.
    }
    dragRef.current = {
      node: primary,
      startX: event.clientX,
      startY: event.clientY,
      grabWorldX: grab?.x ?? (primary.x ?? 0),
      grabWorldY: grab?.y ?? (primary.y ?? 0),
      moved: false,
      pinned: false,
      groupNodeIds,
      groupStartPositions: new Map(),
    };
    suppressClickRef.current = null;

    // Window capture — pointer capture on the card/selection box can otherwise
    // starve the stage of move events in some browsers.
    detachNodeDragListeners();
    const onMove = (pointerEvent: PointerEvent) => {
      applyNodeDragMove(pointerEvent.clientX, pointerEvent.clientY);
    };
    const onUp = (pointerEvent: PointerEvent) => {
      finishNodeDrag(pointerEvent);
      if (isBlockingStageGesture(gestureRef.current.kind)) {
        gestureRef.current = { kind: 'idle' };
      }
      setPanning(false);
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    nodeDragListenersRef.current = { move: onMove, up: onUp };
  };

  const startNodeDrag = (event: ReactPointerEvent, node: ForceMapNode) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('.session-map-port, .session-map-stop-button') !== null) return;
    event.stopPropagation();
    const sessionId = node.member.session.id;
    const selectedIdsNow = selectedIdsRef.current;
    const comp = componentIndexRef.current.get(node.id);
    // Multi-select MUST take priority over "drag root moves whole tree".
    const groupNodeIds = resolveNodeDragGroupIds({
      nodeId: node.id,
      sessionId,
      selectedIds: selectedIdsNow,
      component: comp,
      forceNodes: forceNodesRef.current,
    });
    beginGroupDrag(
      event,
      node,
      groupNodeIds,
    );
  };

  const handleNodeClick = (member: MapMemberRef, event?: ReactMouseEvent) => {
    const key = nodeKey(member);
    // Safety net below the capture-phase swallow: a click that belongs to a
    // just-finished wire gesture must never open a session, even if it was
    // synthesized in a way that bypasses the window listener.
    if (performance.now() <= suppressMapClickUntilRef.current) return;
    if (suppressClickRef.current === key) {
      suppressClickRef.current = null;
      return;
    }
    const sessionId = member.session.id;
    if (event?.shiftKey) {
      setSelectedWorkEdge(null);
      setSelectedIds((ids) => (
        ids.includes(sessionId) ? ids.filter((id) => id !== sessionId) : [...ids, sessionId]
      ));
      return;
    }
    // A normal click enters the session. Selection is an explicit Shift gesture
    // or marquee, so opening a chat never leaves a stale selected state behind.
    openMember(member);
  };

  const submitMount = async (cwdOverride?: string) => {
    const currentDraft = draftRef.current ?? draft;
    if (currentDraft === null) return;
    if (!currentDraft.title.trim() || !currentDraft.role.trim() || !currentDraft.mandate.trim()) {
      showHint(tr('Fill in title, role, and responsibility first.', '请先填好标题、角色和职责。'));
      return;
    }
    if (currentDraft.parentId.startsWith('agent:') || !byId.has(currentDraft.parentId)) {
      setDraft({
        ...currentDraft,
        status: 'error',
        error: tr('The parent session is gone. Abandon this draft and try again.', '父会话已不存在，请放弃这张草稿后重试。'),
      });
      return;
    }
    const draftId = currentDraft.id;
    setDraft({ ...currentDraft, status: 'creating', error: undefined });
    clearError();
    try {
      const parent = byId.get(currentDraft.parentId);
      const selectedCwd = cwdOverride?.trim() || preferredCreateCwd?.trim();
      if (!parent?.metadata?.cwd && !selectedCwd) {
        onChooseProject?.({
          createSession: false,
          parentSessionId: currentDraft.parentId,
          onSelected: (cwd) => { void submitMount(cwd); },
        });
        setDraft((active) => active?.id === draftId ? {
          ...active,
          status: 'error',
          error: tr('Choose a project folder for this member first.', '请先为这个成员选择项目文件夹。'),
        } : active);
        return;
      }
      if (!parent?.metadata?.cwd && selectedCwd) {
        if (parent === undefined) return;
        await api.sessions.updateProfile(parent.id, {
          metadata: { ...parent.metadata, cwd: selectedCwd },
        });
      }
      const options = {
        role: currentDraft.role.trim() || undefined,
        mandate: currentDraft.mandate.trim() || undefined,
      };
      const created = await api.sessions.createChild(currentDraft.parentId, {
        title: currentDraft.title.trim() || tr('New member', '新成员'),
        role: options.role,
        mandate: options.mandate,
      });
      if (disposedRef.current) return;
      const dropX = currentDraft.worldX;
      const dropY = currentDraft.worldY;
      positionsRef.current.set(`session:${created.id}`, { x: dropX, y: dropY });
      persistPositions(positionsRef.current);
      persistDoc(upsertParentMapEdge(mapDocRef.current, currentDraft.parentId, created.id, {
        mandate: options.mandate,
      }));
      clearDraft();
      await refresh();
      if (disposedRef.current) return;
      onGraphChanged?.();
    } catch (error) {
      if (disposedRef.current) return;
      const message = error instanceof Error ? error.message : String(error);
      const errorText = /cwd|project|directory/i.test(message)
        ? tr('Choose a project folder for this member first.', '请先为这个成员选择项目文件夹。')
        : tr('The member could not be created. You can edit the draft and try again.', '成员没建成功，可以修改草稿后再试。');
      setDraft((current) => current?.id === draftId ? { ...current, status: 'error', error: errorText } : current);
    } finally {
      busyRef.current = false;
    }
  };

  const askParentToWriteIdentity = async (brief?: string) => {
    const current = draftRef.current;
    if (current === null) return;
    const prompt = (brief ?? current.prompt).trim();
    if (prompt.length === 0) {
      setDraft({
        ...current,
        status: 'error',
        error: tr('Write a Prompt first, then ask the parent to fill the identity.', '先写 Prompt，再让父节点填写。'),
      });
      return;
    }
    const parent = byId.get(current.parentId);
    if (sessionIsBusy(parent)) {
      setDraft({
        ...current,
        prompt,
        status: 'error',
        error: tr('Wait for the parent to finish before asking for an identity.', '等父亲说完再写身份。'),
      });
      return;
    }
    if (parent?.agent_config?.discuss_mode === true) {
      setDraft({
        ...current,
        prompt,
        status: 'error',
        error: tr('Wait for the parent to finish its discussion.', '等父亲开完会再写身份。'),
      });
      return;
    }
    if (onAskParentIdentity === undefined) {
      setDraft({
        ...current,
        prompt,
        status: 'error',
        error: tr('父亲这次没写出来，你可以自己填。', '父亲这次没写出来，你可以自己填。'),
      });
      return;
    }
    setDraft({ ...current, prompt, status: 'asking-parent', error: undefined });
    try {
      const identity = await onAskParentIdentity({
        parentSessionId: current.parentId,
        brief: prompt,
      });
      if (draftRef.current?.id !== current.id) return;
      setDraft({
        ...current,
        prompt,
        title: identity.title.trim(),
        role: identity.role.trim(),
        mandate: identity.mandate.trim(),
        status: 'editing',
        error: undefined,
      });
    } catch {
      if (draftRef.current?.id !== current.id) return;
      setDraft({
        ...current,
        prompt,
        status: 'error',
        error: tr('父亲这次没写出来，你可以自己填。', '父亲这次没写出来，你可以自己填。'),
      });
    }
  };

  const unmountSession = async (sessionId: string) => {
    const child = allNodes.find((session) => session.id === sessionId);
    const serverParent = parentSessionIdOf(child);
    const pendingOnlyEdges = (mapDocRef.current.edges ?? []).filter((edge) => (
      edge.type === 'parent'
      && edge.target === sessionId
      && isUnappliedExtraJob(edge)
    ));
    if (serverParent === undefined && pendingOnlyEdges.length > 0) {
      let next = mapDocRef.current;
      for (const edge of pendingOnlyEdges) {
        next = removeSessionMapEdgeByEndpoints(next, 'parent', edge.source, edge.target);
      }
      persistDoc(next);
      setNodeMenu(null);
      showHint(tr('已结束这份工作', '已结束这份工作'));
      return;
    }
    if (sessionIsBusy(child)) {
      let pendingDoc = queuePendingTopology(mapDocRef.current, {
        kind: 'unmount',
        childSessionId: sessionId,
      });
      pendingDoc = {
        ...pendingDoc,
        edges: (pendingDoc.edges ?? []).map((edge) => (
          edge.type === 'parent' && edge.target === sessionId ? { ...edge, status: 'pending' } : edge
        )),
      };
      persistDoc(pendingDoc);
      setNodeMenu(null);
      showHint(tr(
        'Waiting for it to finish.',
        '等它说完。',
      ));
      return;
    }
    busyRef.current = true;
    clearError();
    setNodeMenu(null);
    try {
      await api.sessions.unmount(sessionId);
      if (disposedRef.current) return;
      persistDoc(disconnectParentEdges(mapDocRef.current, sessionId));
      await refresh();
      if (disposedRef.current) return;
      onGraphChanged?.();
    } catch {
      if (disposedRef.current) return;
      showNodeError(sessionId, tr('The session could not be ended. Try again.', '这份工作没结束，可以再试一次。'));
    } finally {
      if (!disposedRef.current) busyRef.current = false;
      else busyRef.current = false;
    }
  };

  const endWorkEdge = async (parentId: string, childId: string) => {
    setWorkEdgeMenu(null);
    setSelectedWorkEdge(null);
    setConfirmWorkEdge(null);
    const child = byId.get(childId);
    const serverParent = parentSessionIdOf(child);
    const stored = findParentMapEdge(mapDocRef.current.edges, parentId, childId);
    if (stored !== undefined && isUnappliedExtraJob(stored)) {
      dismissUnappliedExtraJob(parentId, childId);
      showHint(tr('Removed this extra job line.', '已去掉这条'));
      return;
    }
    const isServerEdge = serverParent === parentId;
    if (!isServerEdge || childId.startsWith('draft:')) {
      persistDoc(removeSessionMapEdgeByEndpoints(mapDocRef.current, 'parent', parentId, childId));
      showHint(tr('已结束这份工作', '已结束这份工作'));
      return;
    }
    if (sessionIsBusy(child)) {
      let pendingDoc = queuePendingTopology(mapDocRef.current, { kind: 'unmount', childSessionId: childId });
      pendingDoc = {
        ...pendingDoc,
        edges: (pendingDoc.edges ?? []).map((edge) => (
          edge.type === 'parent' && edge.source === parentId && edge.target === childId
            ? { ...edge, status: 'pending' }
            : edge
        )),
      };
      persistDoc(pendingDoc);
      showHint(tr('等它说完再结束这份工作', '等它说完再结束这份工作'));
      return;
    }
    try {
      await api.sessions.unmount(childId);
      persistDoc(removeSessionMapEdgeByEndpoints(mapDocRef.current, 'parent', parentId, childId));
      await refresh();
      onGraphChanged?.();
      showHint(tr('已结束这份工作', '已结束这份工作'));
    } catch {
      showNodeError(childId, tr('This job could not be ended. Try again.', '这份工作没结束，可以再试一次。'));
    }
  };

  function disconnectWorkFromPort(node: ForceMapNode, side: 'in' | 'out') {
    const sessionId = node.member.session.id;
    const incoming = visualWorkEdges.filter((edge) => edge.target === sessionId);
    const outgoing = visualWorkEdges.filter((edge) => edge.source === sessionId);
    const candidates = side === 'in' ? incoming : outgoing;
    if (candidates.length === 1) {
      void endWorkEdge(candidates[0]!.source, candidates[0]!.target);
      return;
    }
    if (side === 'in') {
      const serverParent = parentSessionIdOf(node.member.session);
      const live = incoming.find((edge) => edge.source === serverParent);
      if (live !== undefined) {
        void endWorkEdge(live.source, live.target);
        return;
      }
      if (serverParent !== undefined || incoming.length > 0) {
        void unmountSession(sessionId);
        return;
      }
      showHint(tr('This session has no job to disconnect.', '这场会话现在没有可拆的工作。'));
      return;
    }
    if (outgoing.length > 1) {
      showHint(tr(
        'Alt-click the work edge to end that job.',
        '按住 Alt 点那条工作边来结束这份工作。',
      ));
      return;
    }
    showHint(tr('This session has no job to disconnect.', '这场会话现在没有可拆的工作。'));
  }

  const retryWorkEdge = async (parentId: string, childId: string) => {
    setWorkEdgeMenu(null);
    const child = byId.get(childId);
    const currentParent = parentSessionIdOf(child)
      ?? mapParentByChildFromEdges(mapDocRef.current.edges ?? []).get(childId);
    const result = await executeSilentLink(childId, parentId, currentParent === parentId);
    if (result === 'added' || result === 'pending') {
      openWorkEdgeEditor(parentId, childId);
    }
  };

  const saveWorkEdgeIdentity = async (values?: SessionIdentityDraftValues) => {
    const current = workEdgeEditor;
    if (current === null || current.saving) return;
    const role = (values?.role ?? current.role).trim() || undefined;
    const mandate = (values?.mandate ?? current.mandate).trim() || undefined;
    const name = values?.name.trim();
    const existing = findParentMapEdge(mapDocRef.current.edges, current.parentId, current.childId);
    const child = byId.get(current.childId);
    const parent = byId.get(current.parentId);
    const serverParent = parentSessionIdOf(child);
    const isLiveEdge = (existing === undefined || !isUnappliedExtraJob(existing)) && serverParent === current.parentId;
    if (isLiveEdge && (sessionIsBusy(child) || sessionIsBusy(parent))) {
      setWorkEdgeEditor({
        ...current,
        error: tr('等它说完再改这份工作。', '等它说完再改这份工作。'),
      });
      return;
    }
    setWorkEdgeEditor({ ...current, saving: true, error: undefined });
    let nextDoc = upsertParentMapEdge(mapDocRef.current, current.parentId, current.childId, {
      role,
      mandate,
      status: existing?.status,
    });
    if (!isLiveEdge && existing?.status === 'pending') {
      nextDoc = {
        ...nextDoc,
        pendingTopology: (nextDoc.pendingTopology ?? []).map((op) => (
          op.childSessionId === current.childId
            && op.parentSessionId === current.parentId
            ? { ...op, role, mandate }
            : op
        )),
      };
    }
    persistDoc(nextDoc);
    if (!isLiveEdge) {
      setWorkEdgeEditor(null);
      showHint(tr('这份工作身份已更新。', '这份工作身份已更新。'));
      return;
    }
    try {
      await api.sessions.remount(current.childId, current.parentId, { role, mandate });
      if (name) {
        await api.sessions.updateIdentity(current.childId, { name, role, mandate }).catch(() => undefined);
      }
      if (disposedRef.current) return;
      await refresh();
      if (disposedRef.current) return;
      setWorkEdgeEditor(null);
      onGraphChanged?.();
      showHint(tr('这份工作身份已更新。', '这份工作身份已更新。'));
    } catch {
      if (disposedRef.current) return;
      persistDoc(upsertParentMapEdge(mapDocRef.current, current.parentId, current.childId, {
        role,
        mandate,
        status: 'error',
      }));
      setWorkEdgeEditor({
        ...current,
        saving: false,
        error: tr('这份工作身份没保存好，可以再试一次。', '这份工作身份没保存好，可以再试一次。'),
      });
    }
  };

  const warningsForSession = (sessionId: string): string[] => {
    const childCount = allNodes.filter((node) => parentSessionIdOf(node) === sessionId).length;
    return childCount > 0 ? [tr(`${String(childCount)} mounted sessions become independent.`, `${String(childCount)} 个成员会话会变成独立会话。`)] : [];
  };

  const deleteSession = async (sessionId: string, confirmed = false) => {
    // Cascade-aware: deleting a host strands mounted children — say so up front.
    const childCount = allNodes.filter((node) => parentSessionIdOf(node) === sessionId).length;
    const warnings: string[] = [];
    if (childCount > 0) {
      warnings.push(tr(
        `${String(childCount)} mounted sessions will become top-level conversations.`,
        `${String(childCount)} 个成员会话将升为顶层对话。`,
      ));
    }
    if (!confirmed) {
      setDeleteConfirmSessionId(sessionId);
      return;
    }
    busyRef.current = true;
    clearError();
    setDeleteConfirmSessionId(null);
    setNodeMenu(null);
    try {
      await api.sessions.delete(sessionId);
      if (disposedRef.current) return;
      forgetMapNodePosition(positionsRef.current, sessionId);
      persistDoc(removeEdgesForSession(mapDocRef.current, sessionId));
      persistPositions(positionsRef.current);
      await refresh();
      if (disposedRef.current) return;
      onGraphChanged?.();
    } catch {
      if (disposedRef.current) return;
      showNodeError(sessionId, tr('The session could not be deleted. Try again.', '会话没删掉，可以再试一次。'));
    } finally {
      if (!disposedRef.current) busyRef.current = false;
      else busyRef.current = false;
    }
  };

  const deleteSelectedSessions = async (confirmed = false) => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;

    const warnings: string[] = [];
    for (const sessionId of ids) {
      const childCount = allNodes.filter((node) => parentSessionIdOf(node) === sessionId).length;
      if (childCount > 0) {
        warnings.push(tr(
          `“${byId.get(sessionId)?.title?.trim() || sessionId.slice(0, 10)}”: ${String(childCount)} mounted session(s) become top-level conversations.`,
          `「${byId.get(sessionId)?.title?.trim() || sessionId.slice(0, 10)}」：${String(childCount)} 个成员会话将升为顶层对话。`,
        ));
      }
    }

    if (!confirmed) {
      setDeleteSelectionConfirm(true);
      return;
    }

    busyRef.current = true;
    setBatchFailure(null);
    clearError();
    setNodeMenu(null);
    setDeleteSelectionConfirm(false);
    const failures: string[] = [];
    let doc = mapDocRef.current;
    try {
      for (const sessionId of ids) {
        try {
          await api.sessions.delete(sessionId);
          if (disposedRef.current) return;
          doc = removeEdgesForSession(doc, sessionId);
          forgetMapNodePosition(positionsRef.current, sessionId);
        } catch {
          failures.push(tr(
            `Could not delete ${byId.get(sessionId)?.title?.trim() || sessionId.slice(0, 8)}.`,
            `「${byId.get(sessionId)?.title?.trim() || sessionId.slice(0, 8)}」没删掉。`,
          ));
        }
      }
      mapDocRef.current = doc;
      persistDoc(doc);
      persistPositions(positionsRef.current);
      clearSelection();
      await refresh();
      if (disposedRef.current) return;
      onGraphChanged?.();
      if (failures.length > 0) {
        setBatchFailure(tr(
          `${String(failures.length)} session(s) could not be deleted.`,
          `${String(failures.length)} 个会话没删掉。`,
        ));
      }
    } catch {
      if (disposedRef.current) return;
      showError(tr('批量删除没完成，可以再试一次', '批量删除没完成，可以再试一次'));
    } finally {
      if (!disposedRef.current) busyRef.current = false;
      else busyRef.current = false;
    }
  };

  const selectedMembers = (): MapMemberRef[] => {
    const wanted = new Set(selectedIds);
    return forceNodesRef.current
      .filter((node) => wanted.has(node.member.session.id))
      .map((node) => node.member);
  };

  const selectedHasBusySession = selectedMembers().some((member) => {
    const tone = memberCaps(member).statusTone;
    return sessionIsBusy(member.session) || tone === 'running' || tone === 'working' || tone === 'waiting';
  });
  const selectedHasWork = selectedIds.some((sessionId) => (
    parentSessionIdOf(byId.get(sessionId)) !== undefined
    || (mapDoc.edges ?? []).some((edge) => edge.type === 'parent' && edge.target === sessionId)
  ));

  const abortSessionMember = async (member: MapMemberRef): Promise<void> => {
    await api.sessions.abort(member.session.id);
  };

  const stopMember = async (member: MapMemberRef) => {
    const id = member.session.id;
    setStoppingIds((current) => new Set(current).add(id));
    setStopErrors((current) => { const next = new Set(current); next.delete(id); return next; });
    try {
      await abortSessionMember(member);
      await refresh();
    } catch {
      setStopErrors((current) => new Set(current).add(id));
    } finally {
      setStoppingIds((current) => { const next = new Set(current); next.delete(id); return next; });
    }
  };

  const abortSelectedSessions = async () => {
    const members = selectedMembers();
    if (members.length === 0) return;
    busyRef.current = true;
    setBatchFailure(null);
    clearError();
    const failures: string[] = [];
    try {
      for (const member of members) {
        try {
          await abortSessionMember(member);
        } catch {
          failures.push(memberLabel(member));
        }
      }
      await refresh();
      if (failures.length > 0) {
        setBatchFailure(tr(
          `${String(failures.length)} session(s) did not stop.`,
          `${String(failures.length)} 个会话没停住。`,
        ));
      } else {
        showHint(tr(
          `Stopped ${String(members.length)} session(s).`,
          `已停止 ${String(members.length)} 个会话。`,
        ));
      }
    } finally {
      if (!disposedRef.current) busyRef.current = false;
      else busyRef.current = false;
    }
  };

  const unmountSelectedSessions = async () => {
    const ids = selectedIds.filter((id) => (
      parentSessionIdOf(byId.get(id)) !== undefined
      || (mapDocRef.current.edges ?? []).some((edge) => (
        edge.type === 'parent' && edge.target === id && isUnappliedExtraJob(edge)
      ))
    ));
    if (ids.length === 0) {
      showHint(tr('No mounted sessions in the selection.', '选中项里没有已挂载会话。'));
      return;
    }
    setTopologyBusy(true);
    setBatchFailure(null);
    clearError();
    const failures: string[] = [];
    try {
      for (const sessionId of ids) {
        try {
          const child = byId.get(sessionId);
          const serverParent = parentSessionIdOf(child);
          const pendingOnlyEdges = (mapDocRef.current.edges ?? []).filter((edge) => (
            edge.type === 'parent'
            && edge.target === sessionId
            && isUnappliedExtraJob(edge)
          ));
          if (serverParent === undefined && pendingOnlyEdges.length > 0) {
            let next = mapDocRef.current;
            for (const edge of pendingOnlyEdges) {
              next = removeSessionMapEdgeByEndpoints(next, 'parent', edge.source, edge.target);
            }
            persistDoc(next);
            continue;
          }
          if (sessionIsBusy(child)) {
            let pendingDoc = queuePendingTopology(mapDocRef.current, {
              kind: 'unmount',
              childSessionId: sessionId,
            });
            pendingDoc = {
              ...pendingDoc,
              edges: (pendingDoc.edges ?? []).map((edge) => (
                edge.type === 'parent' && edge.target === sessionId ? { ...edge, status: 'pending' } : edge
              )),
            };
            persistDoc(pendingDoc);
            continue;
          }
          await api.sessions.unmount(sessionId);
          persistDoc(disconnectParentEdges(mapDocRef.current, sessionId));
        } catch {
          failures.push(byId.get(sessionId)?.title?.trim() || sessionId.slice(0, 8));
        }
      }
      await refresh();
      onGraphChanged?.();
      if (failures.length > 0) {
        setBatchFailure(tr(
          `${String(failures.length)} job(s) could not be ended.`,
          `${String(failures.length)} 份工作没结束。`,
        ));
      }
    } finally {
      if (!disposedRef.current) setTopologyBusy(false);
      else busyRef.current = false;
    }
  };

  const stopCardEvent = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
  };

  const openIdentityForSession = (sessionId: string) => {
    const session = byId.get(sessionId)
      ?? sessions.find((item) => item.id === sessionId)
      ?? forceNodesRef.current.find((node) => node.member.session.id === sessionId)?.member.session;
    if (session === undefined) return;
    setNodeMenu(null);
    setIdentitySession(session);
  };

  const openNodeContextMenu = (
    event: ReactMouseEvent,
    member: MapMemberRef,
  ) => {
    if (blockContextMenuIfGesture(event)) return;
    const caps = memberCaps(member);
    if (!caps.isRealSession) return;
    event.stopPropagation();
    setNodeMenu({
      sessionId: member.session.id,
      x: event.clientX,
      y: event.clientY,
      canUnmount: caps.canDisconnect,
      label: memberLabel(member),
    });
  };

  const updateAnnotation = (id: string, patch: Partial<MapAnnotationBox>) => {
    persistDoc({
      ...mapDoc,
      annotations: mapDoc.annotations.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    });
  };

  const finishAnnotationDrag = useCallback((persist: boolean) => {
    const annDrag = annotationDragRef.current;
    if (annDrag === null) return;
    annotationDragRef.current = null;
    if (persist && annDrag.moved) {
      saveSessionMapDoc(mapDocRef.current);
      armClickSuppression();
    } else if (!annDrag.moved && persist) {
      setEditingAnnotationId(annDrag.id);
    }
  }, [armClickSuppression]);

  const startAnnotationDrag = (
    event: ReactPointerEvent,
    boxId: string,
    mode: 'move' | 'resize',
    bounds: { x: number; y: number; width: number; height: number },
  ) => {
    if (event.button !== 0) return;
    if (wireDragRef.current !== null || dragRef.current !== null || draftDragRef.current !== null
      || marqueeRef.current !== null || isBlockingStageGesture(gestureRef.current.kind)) return;
    event.stopPropagation();
    event.preventDefault();
    annotationDragRef.current = {
      id: boxId,
      mode,
      startClientX: event.clientX,
      startClientY: event.clientY,
      origin: { ...bounds },
      moved: false,
    };
    const onMove = (pointerEvent: PointerEvent) => {
      const drag = annotationDragRef.current;
      if (drag === null) return;
      const scale = viewRef.current.scale || 1;
      const dx = (pointerEvent.clientX - drag.startClientX) / scale;
      const dy = (pointerEvent.clientY - drag.startClientY) / scale;
      if (!drag.moved && Math.hypot(pointerEvent.clientX - drag.startClientX, pointerEvent.clientY - drag.startClientY) < CLICK_MOVE_THRESHOLD) {
        return;
      }
      drag.moved = true;
      const origin = drag.origin;
      const rect = drag.mode === 'move'
        ? {
            x: origin.x + dx,
            y: origin.y + dy,
            width: origin.width,
            height: origin.height,
          }
        : {
            x: origin.x,
            y: origin.y,
            width: Math.max(MIN_ANNOTATION_SIZE, origin.width + dx),
            height: Math.max(MIN_ANNOTATION_SIZE, origin.height + dy),
          };
      const next = {
        ...mapDocRef.current,
        annotations: mapDocRef.current.annotations.map((item) => (
          item.id === drag.id ? { ...item, rect } : item
        )),
      };
      mapDocRef.current = next;
      setMapDoc(next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      finishAnnotationDrag(true);
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
  };

  const removeAnnotation = (id: string) => {
    persistDoc({ ...mapDoc, annotations: mapDoc.annotations.filter((item) => item.id !== id) });
    if (editingAnnotationId === id) setEditingAnnotationId(null);
  };

  const finalizeTopLevelCreate = useCallback(async (
    placeholderId: string,
    createdId: string,
    worldX: number,
    worldY: number,
  ) => {
    if (disposedRef.current) return;
    setTopLevelPlaceholder((current) => current?.id === placeholderId ? null : current);
    positionsRef.current.set(`session:${createdId}`, { x: worldX, y: worldY });
    persistDoc({
      ...mapDocRef.current,
      positions: {
        ...mapDocRef.current.positions,
        [`session:${createdId}`]: { x: worldX, y: worldY },
      },
    });
    await refresh();
    if (disposedRef.current) return;
    onGraphChanged?.();
    showHint(tr('Session node created.', '已创建会话节点。'));
  }, [onGraphChanged, persistDoc, refresh, showHint, tr]);

  let minX = 0;
  let minY = 0;
  let maxX = Math.max(treeLayout.width, 400);
  let maxY = Math.max(treeLayout.height, 300);
  for (const node of forceNodes) {
    const left = (node.x ?? 0) - NODE_W / 2;
    const top = (node.y ?? 0) - NODE_H / 2;
    minX = Math.min(minX, left - CANVAS_PAD);
    minY = Math.min(minY, top - CANVAS_PAD);
    maxX = Math.max(maxX, left + NODE_W + CANVAS_PAD);
    maxY = Math.max(maxY, top + NODE_H + CANVAS_PAD);
  }
  for (const box of mapDoc.annotations) {
    const b = annotationBounds(box, placedForAnnotations, { width: NODE_W, height: NODE_H });
    minX = Math.min(minX, b.x - CANVAS_PAD);
    minY = Math.min(minY, b.y - CANVAS_PAD);
    maxX = Math.max(maxX, b.x + b.width + CANVAS_PAD);
    maxY = Math.max(maxY, b.y + b.height + CANVAS_PAD);
  }

  const wireValidTargetIds = useMemo(() => {
    if (wireDrag === null) return new Set<string>();
    const ids = new Set<string>();
    const edges = mapDoc.edges ?? [];
    for (const node of forceNodes) {
      if (isValidWireTarget(wireDrag, node, allNodes, edges)) ids.add(node.id);
    }
    return ids;
  }, [allNodes, forceNodes, mapDoc.edges, wireDrag]);

  const snappedView = snapMapView(view);
  const stickyWire = wireDrag;

  // Expand content bounds so the on-canvas draft card stays inside the SVG/wire layer.
  if (draft !== null) {
    minX = Math.min(minX, draft.worldX - 140 - CANVAS_PAD);
    minY = Math.min(minY, draft.worldY - CANVAS_PAD);
    maxX = Math.max(maxX, draft.worldX + 140 + CANVAS_PAD);
    maxY = Math.max(maxY, draft.worldY + 320 + CANVAS_PAD);
  }
  if (topLevelPlaceholder !== null) {
    minX = Math.min(minX, topLevelPlaceholder.worldX - NODE_W / 2 - CANVAS_PAD);
    minY = Math.min(minY, topLevelPlaceholder.worldY - NODE_H / 2 - CANVAS_PAD);
    maxX = Math.max(maxX, topLevelPlaceholder.worldX + NODE_W / 2 + CANVAS_PAD);
    maxY = Math.max(maxY, topLevelPlaceholder.worldY + NODE_H / 2 + CANVAS_PAD);
  }
  const contentWidth = Math.max(1, maxX - minX);
  const contentHeight = Math.max(1, maxY - minY);
  const showFirstUseHint = firstUseHintVisible
    && forceNodes.length > 0
    && !sessions.some((session) => parentSessionIdOf(session) !== undefined)
    && (graph?.edges ?? []).length === 0
    && !(mapDoc.edges ?? []).some((edge) => edge.type === 'parent');
  const selectedUnappliedEdge = selectedWorkEdge === null
    ? undefined
    : findParentMapEdge(mapDoc.edges, selectedWorkEdge.parentId, selectedWorkEdge.childId);
  const showUnappliedJobBar = selectedUnappliedEdge !== undefined
    && isUnappliedExtraJob(selectedUnappliedEdge)
    && workEdgeMenu === null;

  return (
    <div className="view-page view-page-wide session-map-page">
      <div
        ref={viewportRef}
        className={
          'session-map-stage'
          + (panning ? ' panning' : '')
          + (wireDrag !== null ? ' wiring' : '')
          + (marquee !== null ? ' marqueeing' : '')
        }
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest('.session-identity-drawer, input, textarea') !== null) return;
          if (blockContextMenuIfGesture(event)) return;
          if (target.closest('.session-map-node') !== null) return;
          if (target.closest('.session-map-context-menu') !== null) return;
          openCanvasContextMenu(event);
        }}
      >
        {error && (
          <div
            className={'session-map-float session-map-error' + (errorSticky ? ' sticky' : '')}
            role="alert"
          >
            <span className="session-map-error-text">{error}</span>
            <button
              type="button"
              className="session-map-error-close"
              aria-label={tr('Dismiss', '关闭')}
              onClick={() => clearError()}
            >
              ×
            </button>
          </div>
        )}
        {hint && (
          <div className="session-map-float session-map-hint-toast" role="status">
            <span>{hint}</span>
            <button
              type="button"
              aria-label={tr('Dismiss', '关闭')}
              title={tr('Dismiss', '关闭')}
              onClick={() => setHint(null)}
            >×</button>
          </div>
        )}
        {showFirstUseHint && (
          <div className="session-map-float session-map-hint-toast session-map-first-use-hint" role="status">
            <span>{tr(
              'Drag from a card bottom edge to empty space to create a member. The parent writes the identity.',
              '从卡片下缘拉到空白，会生出一个新成员。身份由那个父亲来写。',
            )}</span>
            <button
              type="button"
              aria-label={tr('Dismiss', '关闭')}
              title={tr('Dismiss', '关闭')}
              onClick={dismissFirstUseHint}
            >×</button>
          </div>
        )}
        {forceNodes.length === 0 && mapDoc.annotations.length === 0 && draft === null && topLevelPlaceholder === null
          ? <div className="session-map-stage-empty">{tr('Start a conversation with + on the left, or right-click empty space to create one.', '从左边 + 开始一场对话，或在空白处右键新建。')}</div>
          : (
              <div
                className="session-map-canvas"
                style={{
                  transform: `translate3d(${String(snappedView.x)}px, ${String(snappedView.y)}px, 0) scale(${String(snappedView.scale)})`,
                }}
              >
                {mapDoc.annotations.map((box) => {
                  const bounds = annotationBounds(box, placedForAnnotations, { width: NODE_W, height: NODE_H });
                  return (
                    <div
                      key={box.id}
                      className={
                        'session-map-annotation'
                        + (editingAnnotationId === box.id ? ' editing' : '')
                      }
                      style={{
                        left: bounds.x,
                        top: bounds.y,
                        width: bounds.width,
                        height: bounds.height,
                        ['--map-ann-color' as string]: box.color,
                        borderColor: box.color,
                        background: `${box.color}33`,
                      }}
                    >
                      <div
                        className="session-map-annotation-chrome session-map-annotation-titlebar"
                        onPointerDown={(event) => startAnnotationDrag(event, box.id, 'move', bounds)}
                      >
                        <span className="session-map-annotation-title">{box.title || tr('Group box', '分组框')}</span>
                      </div>
                      {editingAnnotationId === box.id && (
                        <div
                          className="session-map-annotation-editor"
                          onPointerDown={(event) => event.stopPropagation()}
                        >
                          <input
                            autoFocus
                            value={box.title}
                            aria-label={tr('Group box title', '分组框标题')}
                            onChange={(event) => updateAnnotation(box.id, { title: event.target.value })}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === 'Escape') {
                                event.preventDefault();
                                setEditingAnnotationId(null);
                              }
                            }}
                          />
                          <div className="session-map-note-colors" role="group" aria-label={tr('Group box color', '分组框颜色')}>
                            {DEFAULT_ANNOTATION_COLORS.map((color) => (
                              <button
                                key={color}
                                type="button"
                                className={'session-map-note-color' + (box.color === color ? ' active' : '')}
                                style={{ background: color }}
                                aria-label={color}
                                onClick={() => updateAnnotation(box.id, { color })}
                              />
                            ))}
                          </div>
                          <button type="button" className="session-map-note-delete" onClick={() => removeAnnotation(box.id)}>{tr('Delete', '删除')}</button>
                          <button type="button" className="session-map-note-done" onClick={() => setEditingAnnotationId(null)}>{tr('Done', '完成')}</button>
                        </div>
                      )}
                      <span
                        className="session-map-annotation-chrome session-map-annotation-resize"
                        aria-hidden
                        onPointerDown={(event) => startAnnotationDrag(event, box.id, 'resize', bounds)}
                      />
                    </div>
                  );
                })}
                <svg
                  className="session-map-edges"
                  width={contentWidth}
                  height={contentHeight}
                  style={{ left: minX, top: minY }}
                >
                  {visualWorkEdges.map((edge) => {
                    const from = forceNodes.find((node) => node.member.session.id === edge.source);
                    const to = edge.target === draft?.id
                      ? { x: draft.worldX, y: draft.worldY } as ForceMapNode
                      : forceNodes.find((node) => node.member.session.id === edge.target);
                    if (!from || !to) return null;
                    const start = linkEndpoint(from, 'bottom');
                    const end = linkEndpoint(to, 'top');
                    const midY = (start.y + end.y) / 2;
                    const d = `M ${start.x - minX} ${start.y - minY} C ${start.x - minX} ${midY - minY}, ${end.x - minX} ${midY - minY}, ${end.x - minX} ${end.y - minY}`;
                    const isPending = edge.status === 'pending';
                    const isUnapplied = isUnappliedExtraJob({ type: 'parent', status: edge.status });
                    const isError = edge.status === 'error';
                    const edgeRole = edge.role?.trim();
                    const edgeMandate = edge.mandate?.replace(/\s+/g, ' ').trim();
                    const edgeIdentity = [edgeRole, edgeMandate]
                      .filter((value): value is string => value !== undefined && value.length > 0)
                      .join(' · ')
                      .slice(0, 120);
                    const selected = selectedWorkEdge !== null
                      && selectedWorkEdge.parentId === edge.source
                      && selectedWorkEdge.childId === edge.target;
                    const toneClass = isPending || isUnapplied
                      ? ' pending-multi-parent'
                      : isError ? ' error' : '';
                    const hitWidth = scaledWorldRadius(14, snappedView.scale);
                    const onEdgePointerDown = (event: ReactPointerEvent<SVGPathElement>) => {
                      if (event.button === 0) event.stopPropagation();
                      if (event.button !== 0 || !event.altKey) return;
                      event.preventDefault();
                      armClickSuppression();
                      if (wireDragRef.current !== null || dragRef.current !== null || marqueeRef.current !== null
                        || annotationDragRef.current !== null || draftDragRef.current !== null
                        || isBlockingStageGesture(gestureRef.current.kind)) return;
                      void endWorkEdge(edge.source, edge.target);
                    };
                    const onEdgeClick = (event: ReactMouseEvent<SVGPathElement>) => {
                      event.stopPropagation();
                      if (event.altKey) return;
                      setSelectedIds([]);
                      setSelectedWorkEdge({ parentId: edge.source, childId: edge.target });
                    };
                    const onEdgeContextMenu = (event: ReactMouseEvent<SVGPathElement>) => {
                      if (blockContextMenuIfGesture(event)) return;
                      event.stopPropagation();
                      setSelectedIds([]);
                      setSelectedWorkEdge({ parentId: edge.source, childId: edge.target });
                      setNodeMenu(null);
                      setCanvasMenu(null);
                      setWorkEdgeMenu({
                        parentId: edge.source,
                        childId: edge.target,
                        x: event.clientX,
                        y: event.clientY,
                      });
                    };
                    return (
                      <g key={`${edge.source}->${edge.target}`}>
                      <title>{tr(
                        `Work for “${byId.get(edge.source)?.title?.trim() || edge.source}”: ${edgeIdentity || 'job'}`,
                        `给「${byId.get(edge.source)?.title?.trim() || edge.source}」干：${edgeIdentity || '工作'}`,
                      )}</title>
                      <path
                        className={`session-map-edge-hit${selected ? ' selected' : ''}${toneClass}`}
                        d={d}
                        style={{ strokeWidth: hitWidth }}
                        data-parent-id={edge.source}
                        data-child-id={edge.target}
                        data-edge-status={edge.status}
                        aria-label={edge.mandate ?? tr('Work edge', '工作边')}
                        role="button"
                        onPointerDown={onEdgePointerDown}
                        onClick={onEdgeClick}
                        onContextMenu={onEdgeContextMenu}
                      />
                      <path
                        className={`session-map-edge-visible${selected ? ' selected' : ''}${toneClass}`}
                        d={d}
                        aria-hidden
                      />
                      {(isPending || isUnapplied || isError) && (
                        <text x={(start.x + end.x) / 2 - minX + 6} y={midY - minY - 4} className="session-map-edge-pending-label">
                          {isUnapplied
                            ? tr("Can't work for two people at once yet.", '现在还不能同时给两个人干活')
                            : isError
                              ? tr('Could not connect', '没接上')
                              : tr('Waiting', '等它说完')}
                        </text>
                      )}
                      </g>
                    );
                  })}
                </svg>
                {forceNodes.map((node) => {
                  const member = node.member;
                  const caps = memberCaps(member);
                  const isActive = activeSessionId !== undefined
                    && member.session.id === activeSessionId;
                  const workEdges = visualWorkEdges.filter((edge) => edge.target === member.session.id);
                  const role = workEdges.length > 1
                    ? tr(`${String(workEdges.length)} jobs`, `${String(workEdges.length)} 份工作`)
                    : workEdges[0]?.role
                      || workEdges[0]?.mandate?.split(/[\n.!?。！？]/, 1)[0]?.trim()
                      || memberRole(member);
                  const parentCwd = workEdges.length === 1
                    ? byId.get(workEdges[0]!.source)?.metadata?.cwd
                    : undefined;
                  const ownCwd = member.session.metadata?.cwd;
                  const exceptionalCwd = typeof ownCwd === 'string' && ownCwd.trim()
                    && typeof parentCwd === 'string' && parentCwd.trim()
                    && ownCwd.trim() !== parentCwd.trim()
                    ? ownCwd.trim()
                    : undefined;
                  const statusClass = mapStatusDotClass(caps.status);
                  const runtimeTone = mapRuntimeStatus(caps.status);
                  const runtimeSince = member.session.updated_at;
                  const runtimeElapsed = (runtimeTone === 'running' || runtimeTone === 'working' || runtimeTone === 'waiting')
                    ? formatElapsed(Date.now() - Date.parse(runtimeSince))
                    : undefined;
                  const currentAction = describeMapCurrentAction(member, liveHints);
                  const isRuntimeBusy = sessionIsBusy(member.session)
                    || caps.statusTone === 'waiting'
                    || caps.statusTone === 'running'
                    || caps.statusTone === 'working'
                    || currentAction !== undefined;
                  const statusLabel = localizedMapStatus(caps.status, tr);
                  const left = Math.round((node.x ?? 0) - NODE_W / 2);
                  const top = Math.round((node.y ?? 0) - NODE_H / 2);
                  const isWireTarget = wireValidTargetIds.has(node.id);
                  const isWireSnap = wireSnapTargetId === node.id;
                  const isSearchMatch = query.trim().length > 0 && visibleIds.has(node.id);
                  const rawErrorSummary = describeMapErrorSummary(member, liveHints);
                  const errorSummary = nodeErrors[member.session.id]
                    ?? (rawErrorSummary === undefined ? undefined : localizedMapError(rawErrorSummary, tr));
                  const actionLabel = currentAction === undefined
                    ? undefined
                    : currentAction.kind === 'thinking'
                      ? (currentAction.detail !== undefined
                        ? tr(`thinking · ${currentAction.detail}`, `思考中 · ${currentAction.detail}`)
                        : tr('thinking', '思考中'))
                      : currentAction.kind === 'tool'
                        ? currentAction.detail
                        : currentAction.kind === 'waiting-approval'
                          ? (currentAction.detail !== undefined
                            ? tr(
                              `waiting-approval · ${currentAction.detail}`,
                              `等授权 · ${currentAction.detail}`,
                            )
                            : tr('waiting-approval', '等授权'))
                          : tr('waiting', '等待中');
                  return (
                    <div
                      key={node.id}
                      className={
                        'team-node session-map-node'
                        + (isActive ? ' active' : '')
                        + ` status-${caps.statusTone}`
                        + (nodeErrors[member.session.id] !== undefined ? ' has-local-error' : '')
                        + (selectedIds.includes(member.session.id) ? ' selected' : '')
                        + (isWireTarget ? ' wire-target-valid' : '')
                        + (isWireSnap ? ' wire-target-snap' : '')
                        + (isSearchMatch ? ' search-match' : '')
                        + (searchFocusId === node.id ? ' search-match-current' : '')
                      }
                      style={{ left, top, width: NODE_W, height: NODE_H }}
                      onPointerDown={(event) => startNodeDrag(event, node)}
                      onClick={(event) => handleNodeClick(member, event)}
                      onContextMenu={(event) => openNodeContextMenu(event, member)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          if (selectedIdsRef.current.length > 1) return;
                          openMember(member);
                          return;
                        }
                      }}
                      role="button"
                      tabIndex={0}
                      data-session-id={caps.isRealSession ? member.session.id : undefined}
                    >
                      {caps.canWireIn && (
                        <span
                          className={
                            'session-map-port session-map-port-in'
                            + (caps.canDisconnect ? ' connected' : '')
                            + (isWireTarget && wireDrag?.side === 'out' ? ' wire-highlight' : '')
                            + (isWireSnap && wireDrag?.side === 'out' ? ' wire-snap' : '')
                          }
                          title={tr(
                            'Input · drag to move this job · Alt-click to disconnect',
                            '输入口 · 拖动改挂这份工作 · Alt+左键断连',
                          )}
                          onPointerDown={(event) => startWireFromPort(event, node, 'in')}
                        />
                      )}
                      <div className="session-map-node-body">
                        <span className="team-node-name" title={memberLabel(member)}>
                          <i className={`status-dot ${statusClass}`} aria-hidden />
                          {memberLabel(member)}
                        </span>
                        <span className="session-map-status-badge" data-status={runtimeTone}>
                          {statusLabel}
                          {runtimeElapsed !== undefined && <small className="session-map-runtime-elapsed">{runtimeElapsed}</small>}
                        </span>
                        {role && <span className="team-node-sub" title={role}>{role}</span>}
                        {exceptionalCwd && <span className="team-node-project" title={exceptionalCwd}>{projectFolderName(exceptionalCwd)}</span>}
                        {errorSummary === undefined && actionLabel !== undefined && (
                          <span
                            className="session-map-current-action"
                            data-action-kind={currentAction?.kind}
                            title={actionLabel}
                          >
                            {actionLabel}
                          </span>
                        )}
                        {errorSummary !== undefined && (
                          <span className="session-map-card-error" title={errorSummary}>
                            {errorSummary}
                          </span>
                        )}
                      </div>
                        {isRuntimeBusy && (
                          <button
                            type="button"
                            className="session-map-stop-button"
                            data-map-action="stop"
                            disabled={stoppingIds.has(member.session.id)}
                            aria-label={tr('Stop session', '停止会话')}
                            title={tr('Stop session', '停止会话')}
                            onPointerDown={stopCardEvent}
                            onClick={(event) => {
                              stopCardEvent(event);
                              void stopMember(member);
                            }}
                          >
                            <Icon name="stop" size={10} />
                          </button>
                        )}
                        {stopErrors.has(member.session.id) && <span className="session-map-stop-error">{tr('Could not stop', '没停住')}</span>}
                      {caps.canWireOut && (
                        <span
                          className={
                            'session-map-port session-map-port-out'
                            + (isWireTarget && wireDrag?.side === 'in' ? ' wire-highlight' : '')
                            + (isWireSnap && wireDrag?.side === 'in' ? ' wire-snap' : '')
                          }
                          title={tr(
                            'Output · drag to create a child or add a job',
                            '输出口 · 拖出创建孩子或增加一份工作',
                          )}
                          onPointerDown={(event) => startWireFromPort(event, node, 'out')}
                        />
                      )}
                    </div>
                  );
                })}
                {marquee !== null && (
                  <div
                    className="session-map-marquee"
                    style={{
                      left: Math.min(marquee.startX, marquee.endX),
                      top: Math.min(marquee.startY, marquee.endY),
                      width: Math.abs(marquee.endX - marquee.startX),
                      height: Math.abs(marquee.endY - marquee.startY),
                    }}
                  />
                )}
                {stickyWire !== null && (
                  <svg
                    className="session-map-wire-preview"
                    width={contentWidth}
                    height={contentHeight}
                    style={{ left: minX, top: minY }}
                  >
                    <path
                      d={`M ${stickyWire.fromX - minX} ${stickyWire.fromY - minY} L ${stickyWire.toX - minX} ${stickyWire.toY - minY}`}
                    />
                  </svg>
                )}
                {draft && (
                  <div
                    className="team-node session-map-node session-map-draft-node"
                    role="presentation"
                    style={{
                      left: Math.round(draft.worldX - NODE_W / 2),
                      top: Math.round(draft.worldY - NODE_H / 2),
                      width: NODE_W,
                      height: NODE_H,
                    }}
                    onPointerDown={startDraftDrag}
                    onClick={(event) => event.stopPropagation()}
                    onContextMenu={(event) => {
                      if (blockContextMenuIfGesture(event)) return;
                      event.stopPropagation();
                      setNodeMenu(null);
                      setCanvasMenu(null);
                      setWorkEdgeMenu(null);
                      setDraftMenu({ x: event.clientX, y: event.clientY });
                    }}
                  >
                    <span className="session-map-port session-map-port-in connected" aria-hidden />
                    <span className="session-map-draft-badge">{tr('Draft', '草稿')}</span>
                    <div className="session-map-node-body session-map-draft-body">
                      <span className="team-node-name">
                        <i className="status-dot idle" aria-hidden />
                        {draft.title.trim() || tr('New member', '新成员')}
                      </span>
                      <span className="session-map-status-badge" data-status="idle">
                        {draft.status === 'asking-parent'
                          ? tr('Parent is writing…', '父节点正在填写…')
                          : draft.status === 'creating'
                            ? tr('Being born…', '正在出生…')
                            : draft.status === 'error'
                              ? (draft.error ?? tr('Could not create', '没建成功'))
                              : tr('Draft', '草稿')}
                      </span>
                      {(draft.role.trim() || draft.mandate.trim()) && (
                        <span className="team-node-sub">{draft.role.trim() || draft.mandate.trim()}</span>
                      )}
                    </div>
                    <span className="session-map-port session-map-port-out" aria-hidden />
                  </div>
                )}
                {topLevelPlaceholder && (
                  <div
                    className={`team-node session-map-node session-map-create-placeholder status-${topLevelPlaceholder.status}`}
                    style={{
                      left: Math.round(topLevelPlaceholder.worldX - NODE_W / 2),
                      top: Math.round(topLevelPlaceholder.worldY - NODE_H / 2),
                      width: NODE_W,
                      height: NODE_H,
                    }}
                  >
                    <span className="session-map-node-body">
                      <span className="team-node-name"><i className="status-dot" aria-hidden />{
                        topLevelPlaceholder.status === 'creating'
                          ? tr('Starting…', '正在开始…')
                          : topLevelPlaceholder.status === 'editing'
                            ? (topLevelPlaceholder.title?.trim() || tr('New session', '新会话'))
                            : tr('Could not start', '没建起来')
                      }</span>
                      {topLevelPlaceholder.status === 'error' && (
                        <span className="session-map-draft-actions">
                          <button type="button" onClick={() => setTopLevelPlaceholder({ ...topLevelPlaceholder, status: 'editing' })}>{tr('Try again', '再试一次')}</button>
                          <button type="button" onClick={() => setTopLevelPlaceholder(null)}>{tr('Remove', '去掉')}</button>
                        </span>
                      )}
                    </span>
                  </div>
                )}
              </div>
            )}

        <header className="session-map-float session-map-float-top">
          <div className="session-map-float-title" aria-hidden="true">{tr('Map', '地图')}</div>
          <div className="session-map-search-cluster">
            <button
              type="button"
              className="session-map-search-toggle"
              aria-label={tr('Search', '搜索')}
              aria-expanded={searchOpen}
              title={tr('Search', '搜索')}
              onClick={() => {
                if (searchOpen) {
                  closeSearch();
                  return;
                }
                openSearch();
              }}
            >
              <Icon name="search" size={14} />
            </button>
            {searchOpen && (
              <div className="session-map-search-wrap session-map-search-inline">
                <input
                  ref={searchInputRef}
                  className="session-map-search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      event.stopPropagation();
                      closeSearch();
                      return;
                    }
                    if (event.key !== 'Enter') return;
                    const matches = forceNodesRef.current.filter((node) => visibleIds.has(node.id));
                    if (matches.length === 0) return;
                    event.preventDefault();
                    const index = searchIndexRef.current % matches.length;
                    searchIndexRef.current += 1;
                    const focused = matches[index];
                    setSearchFocusId(focused?.id ?? null);
                    markUserAdjustedView();
                    focusNode(focused);
                  }}
                  placeholder={tr('Search title / project / members…', '搜索标题 / 项目 / 成员…')}
                />
                <button
                  type="button"
                  className="session-map-search-clear"
                  aria-label={tr('Close search', '关闭搜索')}
                  onClick={() => closeSearch()}
                >
                  ×
                </button>
              </div>
            )}
          </div>
        </header>

        {selectedIds.length > 0 && (
          <div className="session-map-float session-map-selection-toolbar" role="toolbar">
            <span className="session-map-selection-count">
              {tr(
                `${String(selectedIds.length)} selected`,
                `已选 ${String(selectedIds.length)}`,
              )}
            </span>
            <button type="button" className="session-map-tool" onClick={() => annotateSelection()}>
              {tr('Create group box', '创建分组框')}
            </button>
            {selectedHasBusySession && <button type="button" className="session-map-tool" data-map-action="stop" onClick={() => void abortSelectedSessions()}>
              {tr('Stop all', '全部停止')}
            </button>}
            {selectedHasWork && <button type="button" className="session-map-tool" data-map-action="unmount" onClick={() => void unmountSelectedSessions()}>
              {tr('Let independent', '让他们独立')}
            </button>}
            <button type="button" className="session-map-tool danger" data-map-action="delete" onClick={() => void deleteSelectedSessions()}>
              {tr('Delete', '删除')}
            </button>
            {deleteSelectionConfirm && (
              <span className="session-map-inline-confirm" role="group">
                <span>{tr('This cannot be undone.', '此操作不可撤销。')}</span>
                <button type="button" className="danger" onClick={() => void deleteSelectedSessions(true)}>{tr('Delete', '删除')}</button>
                <button type="button" onClick={() => setDeleteSelectionConfirm(false)}>{tr('Keep', '保留')}</button>
              </span>
            )}
            {batchFailure !== null && <span className="session-map-card-error" role="status">{batchFailure}</span>}
          </div>
        )}

        {identitySession !== null && (
          <SessionIdentityDrawer
            session={identitySession}
            onClose={() => setIdentitySession(null)}
            onSaved={() => {
              void refresh();
              onGraphChanged?.();
            }}
          />
        )}
        {identitySession === null && draft !== null && (
          <SessionIdentityDrawer
            key={`${draft.id}:${draft.status === 'asking-parent' ? 'writing' : 'form'}`}
            mode="create"
            parentTitle={byId.get(draft.parentId)?.title?.trim() || draft.parentId}
            allowAskParent
            initialValues={{
              name: draft.title,
              role: draft.role,
              mandate: draft.mandate,
              prompt: draft.prompt,
            }}
            parentStatus={((): SessionIdentityParentStatus => {
              if (draft.status === 'asking-parent') return 'writing';
              if (draft.status === 'error') return 'failed';
              const parent = byId.get(draft.parentId);
              if (sessionIsBusy(parent) || parent?.agent_config?.discuss_mode === true) return 'waiting';
              return 'idle';
            })()}
            parentMessage={draft.error}
            submitting={draft.status === 'creating'}
            onAskParent={(prompt) => void askParentToWriteIdentity(prompt)}
            onChange={(values) => {
              setDraft((current) => current === null ? current : {
                ...current,
                title: values.name,
                role: values.role,
                mandate: values.mandate,
                prompt: values.prompt,
              });
            }}
            onSubmit={async (values) => {
              const current = draftRef.current;
              if (current === null) return;
              const next = {
                ...current,
                title: values.name,
                role: values.role,
                mandate: values.mandate,
                prompt: values.prompt,
              };
              draftRef.current = next;
              setDraft(next);
              await submitMount();
            }}
            onClose={() => cancelDraft()}
          />
        )}
        {identitySession === null && draft === null && topLevelPlaceholder !== null && topLevelPlaceholder.status !== 'error' && (
          <SessionIdentityDrawer
            mode="create"
            initialValues={{ name: topLevelPlaceholder.title ?? '', role: '', mandate: '', prompt: '' }}
            requireCompleteIdentity={false}
            submitting={topLevelPlaceholder.status === 'creating'}
            onSubmit={(values) => submitTopLevelCreate(values)}
            onClose={() => {
              if (topLevelPlaceholder.status === 'creating') return;
              setTopLevelPlaceholder(null);
            }}
          />
        )}

        {nodeMenu !== null && (
          <div
            className="session-map-context-menu session-map-float"
            style={{ left: nodeMenu.x, top: nodeMenu.y }}
            role="menu"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const node = forceNodesRef.current.find((candidate) => (
                  candidate.member.session.id === nodeMenu.sessionId
                ));
                void createSessionNodeAt(
                  node?.x ?? 0,
                  (node?.y ?? 0) + NODE_H / 2 + 28,
                  nodeMenu.sessionId,
                );
              }}
            >
                {tr('Create a new member', '生一个新成员')}
            </button>
            {(() => {
              const node = forceNodesRef.current.find((candidate) => candidate.member.session.id === nodeMenu.sessionId);
              const stoppable = node !== undefined && (sessionIsBusy(node.member.session) || ['waiting', 'running', 'working'].includes(memberCaps(node.member).statusTone));
              return stoppable ? <button
                type="button"
                role="menuitem"
                onClick={() => {
                  if (node !== undefined) void abortSessionMember(node.member).then(() => refresh());
                  setNodeMenu(null);
                }}
              >{tr('Stop', '停止')}</button> : null;
            })()}
            <button
              type="button"
              role="menuitem"
              onClick={() => openIdentityForSession(nodeMenu.sessionId)}
            >
              {tr('Identity…', '身份…')}
            </button>
            {nodeMenu.canUnmount && (() => {
              const jobs = visualWorkEdges.filter((edge) => edge.target === nodeMenu.sessionId);
              const parentTitle = (parentId: string) => byId.get(parentId)?.title?.trim() || parentId;
              if (jobs.length <= 1) {
                const only = jobs[0];
                if (only !== undefined && isUnappliedExtraJob({ type: 'parent', status: only.status })) {
                  return (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setNodeMenu(null);
                        dismissUnappliedExtraJob(only.source, only.target);
                      }}
                    >
                      {tr('Remove this line', '去掉这条')}
                    </button>
                  );
                }
                return (
                  <button type="button" role="menuitem" onClick={() => void unmountSession(nodeMenu.sessionId)}>
                    {tr('Disconnect', '断连')}
                  </button>
                );
              }
              return jobs.map((job) => {
                const unapplied = isUnappliedExtraJob({ type: 'parent', status: job.status });
                return (
                  <button
                    key={`${job.source}->${job.target}`}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setNodeMenu(null);
                      if (unapplied) {
                        dismissUnappliedExtraJob(job.source, job.target);
                        return;
                      }
                      setConfirmWorkEdge({ parentId: job.source, childId: job.target });
                    }}
                  >
                    {unapplied
                      ? tr(`Remove the extra job from “${parentTitle(job.source)}”`, `去掉给「${parentTitle(job.source)}」的这条`)
                      : tr(`Disconnect from “${parentTitle(job.source)}”`, `断开与「${parentTitle(job.source)}」的工作`)}
                  </button>
                );
              });
            })()}
            <button
              type="button"
              role="menuitem"
              className="danger"
              onClick={() => setDeleteConfirmSessionId(nodeMenu.sessionId)}
            >
              {tr('Delete session…', '删除会话…')}
            </button>
            {deleteConfirmSessionId === nodeMenu.sessionId && (
              <div className="session-map-inline-confirm" role="group">
                <span>{tr(`Delete “${nodeMenu.label}”?`, `删除「${nodeMenu.label}」？`)}</span>
                {warningsForSession(nodeMenu.sessionId).map((warning) => <small key={warning}>{warning}</small>)}
                <button type="button" className="danger" onClick={() => void deleteSession(nodeMenu.sessionId, true)}>{tr('Delete', '删除')}</button>
                <button type="button" onClick={() => setDeleteConfirmSessionId(null)}>{tr('Keep', '保留')}</button>
              </div>
            )}
          </div>
        )}

        {canvasMenu !== null && (
          <div
            className="session-map-context-menu session-map-float"
            style={{ left: canvasMenu.x, top: canvasMenu.y }}
            role="menu"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => void createSessionNodeAt(canvasMenu.worldX, canvasMenu.worldY)}
            >
              {tr('Create session here', '在此新建会话')}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setCanvasMenu(null);
                markUserAdjustedView();
                setView(fitTreeView({ width: treeLayout.width, height: treeLayout.height }, viewportSize));
              }}
            >
              {tr('Fit to view', '适应画面')}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => createGroupBoxAt(canvasMenu.worldX, canvasMenu.worldY)}
            >
              {tr('Create group box', '创建分组框')}
            </button>
          </div>
        )}

        {draftMenu !== null && draft !== null && (
          <div
            className="session-map-context-menu session-map-float"
            style={{ left: draftMenu.x, top: draftMenu.y }}
            role="menu"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button type="button" role="menuitem" disabled={draft.status === 'asking-parent' || draft.status === 'creating'} onClick={() => { setDraftMenu(null); void askParentToWriteIdentity(); }}>
              {draft.status === 'asking-parent' ? tr('Parent is writing…', '父节点正在填写…') : tr('Ask parent to fill', '让父节点填写')}
            </button>
            <button type="button" role="menuitem" disabled={draft.status === 'creating'} onClick={() => { setDraftMenu(null); cancelDraft(); }}>
              {tr('Abandon draft', '放弃草稿')}
            </button>
          </div>
        )}

        {workEdgeMenu !== null && (() => {
          const menuEdge = findParentMapEdge(mapDoc.edges, workEdgeMenu.parentId, workEdgeMenu.childId);
          const unapplied = menuEdge !== undefined && isUnappliedExtraJob(menuEdge);
          return (
          <div
            className="session-map-context-menu session-map-float"
            style={{ left: workEdgeMenu.x, top: workEdgeMenu.y }}
            role="menu"
            onPointerDown={(event) => event.stopPropagation()}
          >
            {unapplied ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  data-map-action="dismiss-unapplied"
                  onClick={() => dismissUnappliedExtraJob(workEdgeMenu.parentId, workEdgeMenu.childId)}
                >
                  {tr('Remove this line', '去掉这条')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-map-action="remount-unapplied"
                  onClick={() => {
                    const { parentId, childId } = workEdgeMenu;
                    setWorkEdgeMenu(null);
                    void executeSilentLink(childId, parentId, true);
                  }}
                >
                  {tr('Move the job here', '改挂过来')}
                </button>
              </>
            ) : (
              <>
            <button type="button" role="menuitem" onClick={() => setConfirmWorkEdge({ parentId: workEdgeMenu.parentId, childId: workEdgeMenu.childId })}>
              {tr('Disconnect', '断连')}
            </button>
            {menuEdge?.status === 'error' && (
              <button
                type="button"
                role="menuitem"
                onClick={() => void retryWorkEdge(workEdgeMenu.parentId, workEdgeMenu.childId)}
              >
                {tr('Retry connection', '重试连接')}
              </button>
            )}
            <button type="button" role="menuitem" onClick={() => openWorkEdgeEditor(workEdgeMenu.parentId, workEdgeMenu.childId)}>
              {tr('Edit job identity…', '改这份身份…')}
            </button>
              </>
            )}
          </div>
          );
        })()}
        {workEdgeEditor !== null && (
          <SessionIdentityDrawer
            session={byId.get(workEdgeEditor.childId)}
            mode="edit"
            parentTitle={byId.get(workEdgeEditor.parentId)?.title?.trim() || workEdgeEditor.parentId}
            allowAskParent={onAskParentIdentity !== undefined}
            initialValues={{
              name: byId.get(workEdgeEditor.childId)?.title ?? '',
              role: workEdgeEditor.role,
              mandate: workEdgeEditor.mandate,
              prompt: workEdgeEditor.prompt,
            }}
            parentStatus={workEdgeEditor.parentStatus ?? (workEdgeEditor.error ? 'failed' : 'idle')}
            parentMessage={workEdgeEditor.error}
            submitting={workEdgeEditor.saving}
            onAskParent={(brief) => {
              if (onAskParentIdentity === undefined) return;
              setWorkEdgeEditor({ ...workEdgeEditor, prompt: brief, parentStatus: 'writing', error: undefined });
              void onAskParentIdentity({ parentSessionId: workEdgeEditor.parentId, brief }).then((identity) => {
                setWorkEdgeEditor((current) => current === null ? current : {
                  ...current,
                  role: identity.role,
                  mandate: identity.mandate,
                  parentStatus: 'idle',
                });
              }).catch(() => {
                setWorkEdgeEditor((current) => current === null ? current : {
                  ...current,
                  parentStatus: 'failed',
                  error: tr('父亲这次没写出来，你可以自己填。', '父亲这次没写出来，你可以自己填。'),
                });
              });
            }}
            onChange={(values) => {
              setWorkEdgeEditor((current) => current === null ? current : {
                ...current,
                role: values.role,
                mandate: values.mandate,
                prompt: values.prompt,
              });
            }}
            onSubmit={(values) => void saveWorkEdgeIdentity(values)}
            onClose={() => setWorkEdgeEditor(null)}
          />
        )}
        {showUnappliedJobBar && selectedWorkEdge !== null && (
          <div
            className="session-map-float session-map-edge-confirm"
            data-map-unapplied-job
            role="status"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <span>{tr("Can't work for two people at once yet.", '现在还不能同时给两个人干活')}</span>
            <button
              type="button"
              data-map-action="dismiss-unapplied"
              onClick={() => dismissUnappliedExtraJob(selectedWorkEdge.parentId, selectedWorkEdge.childId)}
            >
              {tr('Remove this line', '去掉这条')}
            </button>
            <button
              type="button"
              className="primary"
              data-map-action="remount-unapplied"
              onClick={() => void executeSilentLink(selectedWorkEdge.childId, selectedWorkEdge.parentId, true)}
            >
              {tr('Move the job here', '改挂过来')}
            </button>
          </div>
        )}
        {confirmWorkEdge !== null && (
          <div className="session-map-float session-map-edge-confirm" role="alertdialog">
            <span>{tr(`Disconnect from “${byId.get(confirmWorkEdge.parentId)?.title?.trim() || confirmWorkEdge.parentId}”?`, `断开与「${byId.get(confirmWorkEdge.parentId)?.title?.trim() || confirmWorkEdge.parentId}」的工作？`)}</span>
            <button type="button" className="danger" onClick={() => void endWorkEdge(confirmWorkEdge.parentId, confirmWorkEdge.childId)}>{tr('End job', '结束工作')}</button>
            <button type="button" onClick={() => setConfirmWorkEdge(null)}>{tr('Keep', '保留')}</button>
          </div>
        )}
        <button
          type="button"
          className="session-map-zoom"
          aria-label={tr('Reset zoom to 100%', '重置缩放到 100%')}
          title={tr('Reset zoom to 100%', '重置缩放到 100%')}
          onClick={() => {
            const centerX = viewportSize.width / 2;
            const centerY = viewportSize.height / 2;
            setView(zoomTreeView(viewRef.current, 1, centerX, centerY));
            markUserAdjustedView();
            stopFollowFocus();
          }}
        >
          {Math.round(view.scale * 100)}%
        </button>
      </div>
    </div>
  );
}
