/**
 * Conversation map: session mount forest plus TeamCreate member cards.
 * Full-bleed blueprint canvas with d3-force layout; department members open through host agents.
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

import { api, type Session, type SessionAgent, type SessionGraph } from '../api/client';
import { useI18n } from '../i18n';
import { sessionAgentDisplayName } from '../utils/session-agent';
import { parentSessionIdOf, wouldCreateMountCycle } from '../utils/session-mount';
import { dedupeMapMembers, mapOpenTarget } from '../utils/session-map-open';
import { getAppErrors, reportAppError, subscribeAppErrors } from '../utils/error-center';
import {
  CANVAS_PAD,
  MAX_SCALE,
  MIN_SCALE,
  NODE_H,
  NODE_W,
  ensureGraphEdges,
  fitTreeView,
  layoutSessionMountForest,
  memberLabel,
  memberProjectCwd,
  memberRole,
  nodeKey,
  projectFolderName,
  sessionLabel,
  type MapMemberRef,
  type TreeView,
  zoomTreeView,
} from './session-map/layout';
import {
  COLLIDE_RADIUS,
  HOME_PULL_STRENGTH,
  LINK_DISTANCE,
  LINK_STRENGTH,
  REARRANGE_SETTLE_MS,
  SESSION_MAP_AMBIENT_HOME_GRAVITY,
  SETTLE_ALPHA,
  buildMapComponents,
  cachedAgentsFromMapMembers,
  forceIntraComponentCollide,
  isComponentRootPin,
  mapMembersFromAgentCache,
  resolveMapNodeSpawnPosition,
  resolveNodeDragGroupIds,
  snapComponentChildrenToLiveRoot,
  tidyComponentAroundRoot,
  type ForceMapLink,
  type ForceMapNode,
  type MapComponentInfo,
} from './session-map/motion';

export {
  ensureGraphEdges,
  fitTreeView,
  layoutSessionMountForest,
  memberLabel,
  memberProjectCwd,
  memberRole,
  nodeKey,
  projectFolderName,
  sessionLabel,
  zoomTreeView,
} from './session-map/layout';
export { NODE_H, NODE_W } from './session-map/layout';
export type { MapMemberRef, PlacedNode, TreeView } from './session-map/layout';
export {
  COLLIDE_RADIUS,
  HOME_PULL_STRENGTH,
  LINK_DISTANCE,
  LINK_STRENGTH,
  REARRANGE_SETTLE_MS,
  SESSION_MAP_AMBIENT_HOME_GRAVITY,
  SETTLE_ALPHA,
  buildMapComponents,
  cachedAgentsFromMapMembers,
  forceIntraComponentCollide,
  isComponentRootPin,
  mapMembersFromAgentCache,
  resolveMapNodeSpawnPosition,
  resolveNodeDragGroupIds,
  snapComponentChildrenToLiveRoot,
  tidyComponentAroundRoot,
} from './session-map/motion';
export type { ForceMapLink, ForceMapNode, MapComponentInfo } from './session-map/motion';
import {
  canMountMemberUnder,
  clearPendingTopology,
  describeMapCurrentAction,
  describeMapErrorSummary,
  disconnectParentEdges,
  formatMapStatusLabel,
  mapMemberStatus,
  mapNodeCapabilities,
  mapParentByChildFromEdges,
  mapStatusDotClass,
  matchesMapStatusFilter,
  mergeGraphWithMapEdges,
  mergeSessionTags,
  pendingTopologyOpsReady,
  queuePendingTopology,
  readSessionTags,
  reconcileParentEdgesWithServer,
  sessionIsBusy,
  upsertParentMapEdge,
  upsertTypedMapEdge,
  wireSourceParentSessionId,
  type MapLiveHints,
  type MapStatusFilter,
} from '../utils/session-graph';
import { completeMountIdentityFromPrompt } from './mountIdentityComplete';
import { SessionIdentityDrawer } from './SessionIdentityDrawer';
import {
  annotationBounds,
  DEFAULT_ANNOTATION_COLORS,
  loadCachedMapAgents,
  loadSessionMapDoc,
  newAnnotationId,
  newLabelId,
  removeEdgesForSession,
  removeSessionMapEdge,
  rectsIntersect,
  saveCachedMapAgents,
  saveSessionMapDoc,
  sessionMatchesLabelFilter,
  assignSessionLabel,
  toggleSessionLabel,
  type MapAnnotationBox,
  type SessionMapDoc,
  type SessionMapEdge,
  type SessionMapEdgeType,
} from './sessionMapDoc';

export { parentSessionIdOf };

const CLICK_MOVE_THRESHOLD = 5;
/**
 * After ANY port/wire gesture the browser dispatches a click near the pointer
 * (with pointer capture it is retargeted). For this window, clicks landing on
 * node cards / ports are swallowed so wiring can never open a session.
 */
const WIRE_CLICK_SUPPRESS_MS = 600;
/**
 * Collide radius for free placement (not forced into tree slots).
 */
const REARRANGE_HOME_STRENGTH = 0.9;
const REARRANGE_LINK_STRENGTH = 0.01;
/** UE-style port hit radius (world units) — slightly tighter than full card half-width. */
const PORT_HIT_RADIUS = 28;
/** Snap / near-miss feedback when the drop barely misses a valid port. */
const NEAR_MISS_RADIUS = 56;
const BODY_PORT_SLOP = 8;
/** Non-sticky errors auto-dismiss; mount failures stay until dismissed. */
const ERROR_AUTO_DISMISS_MS = 6_500;
const HINT_AUTO_DISMISS_MS = 2_800;
/** Left floating list — focus uses optical center of free canvas. */
const FOCUS_INSET_TOP = 72;
const FOCUS_INSET_BOTTOM = 36;
const FOCUS_INSET_LEFT_LIST = 200;
const AGENT_POLL_MS = 4_000;
const MIN_ANNOTATION_SIZE = 48;

/** Floating chrome insets — reserve left strip when the session list is open. */
function focusInsetForViewport(width: number, listOpen: boolean): { left: number; top: number; bottom: number } {
  return {
    left: listOpen && width > 640 ? FOCUS_INSET_LEFT_LIST : 16,
    top: FOCUS_INSET_TOP,
    bottom: FOCUS_INSET_BOTTOM,
  };
}

export { wireSourceParentSessionId };

/** Whether dropping a wire onto `target` is a legal mount/reconnect or collab link. */
export function isValidWireTarget(
  wire: Pick<WireDragState, 'side' | 'parentSessionId' | 'childSessionId' | 'fromId'> & {
    edgeType?: SessionMapEdgeType;
  },
  target: ForceMapNode,
  nodes: readonly Session[],
  mapEdges: readonly SessionMapEdge[] = [],
): boolean {
  const caps = mapNodeCapabilities(target.member, { sessions: nodes, mapEdges });
  if (!caps.canWireIn) return false;
  if (target.id === wire.fromId) return false;
  const targetId = target.member.session.id;
  const edgeType = wire.edgeType ?? 'parent';
  if (edgeType === 'peer' || edgeType === 'service') {
    const otherId = wire.side === 'out' ? wire.parentSessionId : wire.childSessionId;
    if (otherId.length === 0 || targetId === otherId) return false;
    if (otherId.startsWith('agent:') || targetId.startsWith('agent:')) return false;
    return true;
  }
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
  /** Captured parent session id — never activeSessionId. */
  parentId: string;
  title: string;
  role: string;
  mandate: string;
  prompt: string;
  /** World-space anchor for the on-canvas identity editor (drop point). */
  worldX: number;
  worldY: number;
}

interface WireDragState {
  fromId: string;
  /** Edge type chosen at wire start (Shift=peer, Alt=service, default=parent). */
  edgeType: SessionMapEdgeType;
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
  canSelfBootstrapRole: boolean;
  label: string;
}

interface SelectionContextMenu {
  x: number;
  y: number;
}

interface CanvasContextMenu {
  x: number;
  y: number;
  worldX: number;
  worldY: number;
}

function wireEdgeTypeFromModifiers(event: Pick<ReactPointerEvent, 'shiftKey' | 'altKey'>): SessionMapEdgeType {
  if (event.altKey) return 'service';
  if (event.shiftKey) return 'peer';
  return 'parent';
}

interface MarqueeState {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
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

/** Nearest legal port/body for rubber-band snap while dragging or near-miss on drop. */
export function findNearestValidWireTarget(
  forceNodes: ReadonlyArray<ForceMapNode>,
  worldX: number,
  worldY: number,
  wire: Pick<WireDragState, 'side' | 'parentSessionId' | 'childSessionId' | 'fromId'> & {
    edgeType?: SessionMapEdgeType;
  },
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
  activeAgentId,
  onOpenSession,
  onOpenAgent,
  onGraphChanged,
}: {
  sessions: readonly Session[];
  activeSessionId?: string;
  activeAgentId?: string;
  onOpenSession: (sessionId: string) => void;
  /** Open a durable team agent inside its host session (legacy / agent-only members). */
  onOpenAgent?: (hostSessionId: string, agent: SessionAgent) => void;
  onGraphChanged?: () => void;
}) {
  const { tr } = useI18n();
  const [graph, setGraph] = useState<SessionGraph | null>(null);
  const [agentExtras, setAgentExtras] = useState<MapMemberRef[]>(() => (
    mapMembersFromAgentCache(loadCachedMapAgents())
  ));
  const [error, setError] = useState<string | null>(null);
  const [errorSticky, setErrorSticky] = useState(false);
  const errorStickyRef = useRef(false);
  const [hint, setHint] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<TreeView>({ x: 0, y: 0, scale: 1 });
  const [panning, setPanning] = useState(false);
  const [draft, setDraft] = useState<MountDraft | null>(null);
  const [wireDrag, setWireDrag] = useState<WireDragState | null>(null);
  const [wireSnapTargetId, setWireSnapTargetId] = useState<string | null>(null);
  const wireDragRef = useRef<WireDragState | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const disposedRef = useRef(false);
  const [mapDoc, setMapDoc] = useState<SessionMapDoc>(() => loadSessionMapDoc());
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const [bindAnnotationId, setBindAnnotationId] = useState<string | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [forceNodes, setForceNodes] = useState<ForceMapNode[]>([]);
  const [forceLinks, setForceLinks] = useState<ForceMapLink[]>([]);
  const [nodeMenu, setNodeMenu] = useState<NodeContextMenu | null>(null);
  const [marquee, setMarquee] = useState<MarqueeState | null>(null);
  const [selectionBox, setSelectionBox] = useState<MarqueeState | null>(null);
  const [selectionMenu, setSelectionMenu] = useState<SelectionContextMenu | null>(null);
  const [canvasMenu, setCanvasMenu] = useState<CanvasContextMenu | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [identitySession, setIdentitySession] = useState<Session | null>(null);
  const [statusFilter, setStatusFilter] = useState<MapStatusFilter>('all');
  const [tagMenuOpen, setTagMenuOpen] = useState(false);
  const [liveHints, setLiveHints] = useState<MapLiveHints>({
    approvals: [],
    activity: [],
    turns: {},
    errors: [],
  });
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const selectAllVisibleRef = useRef<() => void>(() => {});
  const [activeLabelIds, setActiveLabelIds] = useState<string[]>([]);
  const [listOpen, setListOpen] = useState(false);
  const forceNodesRef = useRef(forceNodes);
  forceNodesRef.current = forceNodes;
  const [, redraw] = useState(0);
  /** Sync paint — coalescing via rAF/microtask proved flaky under jsdom settle tests. */
  const scheduleRedraw = useCallback((_force = false) => {
    redraw((value) => value + 1);
  }, []);
  const agentExtrasRef = useRef(agentExtras);
  agentExtrasRef.current = agentExtras;
  const annotationDragRef = useRef<{
    id: string;
    mode: 'move' | 'resize';
    startClientX: number;
    startClientY: number;
    origin: { x: number; y: number; width: number; height: number };
    moved: boolean;
  } | null>(null);

  const viewportRef = useRef<HTMLDivElement>(null);
  const panOrigin = useRef<{ x: number; y: number; view: TreeView } | null>(null);
  const rightPanMovedRef = useRef(false);
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
  const rearrangeTimerRef = useRef<number | null>(null);
  const rearrangeGenerationRef = useRef(0);
  /** While true, poll refresh must not rebuild the graph mid-rearrange/settle. */
  const rearrangeActiveRef = useRef(false);
  const simulationRef = useRef<Simulation<ForceMapNode, ForceMapLink> | null>(null);
  /** Hydrate from map doc immediately so first paint never teleports from forest seeds. */
  const positionsRef = useRef<Map<string, { x: number; y: number }>>((() => {
    const map = new Map<string, { x: number; y: number }>();
    for (const [id, pos] of Object.entries(loadSessionMapDoc().positions ?? {})) {
      map.set(id, pos);
    }
    return map;
  })());
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
    /** When true the ephemeral selection box follows until pointerup. */
    fromSelection: boolean;
    /** World-space selection rect at drag start (translated with the group). */
    selectionBoxOrigin: MarqueeState | null;
  } | null>(null);
  const releaseDragPinsRef = useRef<(groupNodeIds: readonly string[]) => void>(() => {});
  const marqueeRef = useRef<MarqueeState | null>(null);
  const suppressClickRef = useRef<string | null>(null);
  /** Timestamp until which node/port clicks are swallowed after a wire gesture. */
  const suppressMapClickUntilRef = useRef(0);
  const viewRef = useRef(view);
  viewRef.current = view;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const mapDocRef = useRef(mapDoc);
  mapDocRef.current = mapDoc;
  const cancelDraftRef = useRef<() => void>(() => {});
  const agentWarnShownRef = useRef(false);
  const wireListenersRef = useRef<{
    move: (event: PointerEvent) => void;
    up: (event: PointerEvent) => void;
  } | null>(null);
  const nodeDragListenersRef = useRef<{
    move: (event: PointerEvent) => void;
    up: (event: PointerEvent) => void;
  } | null>(null);

  const persistPositions = useCallback((positions: Map<string, { x: number; y: number }>) => {
    const nextPositions: Record<string, { x: number; y: number }> = {
      ...mapDocRef.current.positions,
    };
    for (const [id, pos] of positions) {
      nextPositions[id] = { x: pos.x, y: pos.y };
    }
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
      if (target?.closest('.session-map-node, .session-map-port, .session-map-annotation') !== null) {
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
      cancelWireDrag();
      const drag = dragRef.current;
      detachNodeDragListeners();
      if (drag !== null && drag.pinned) {
        releaseDragPinsRef.current(drag.groupNodeIds);
      }
      dragRef.current = null;
      annotationDragRef.current = null;
      panOrigin.current = null;
      setPanning(false);
      if (marqueeRef.current !== null) {
        marqueeRef.current = null;
        setMarquee(null);
      }
      setSelectionMenu(null);
      setNodeMenu(null);
    };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [cancelWireDrag, detachNodeDragListeners]);

  // Escape: wire → marquee → draft → menus/editors/selection.
  // Ctrl/Cmd+A selects every visible session card.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      const typing = target instanceof HTMLElement
        && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if ((event.key === 'a' || event.key === 'A') && (event.metaKey || event.ctrlKey) && !typing) {
        event.preventDefault();
        selectAllVisibleRef.current();
        return;
      }
      if (event.key !== 'Escape') return;
      if (wireDragRef.current !== null) {
        event.preventDefault();
        cancelWireDrag();
        return;
      }
      if (marqueeRef.current !== null) {
        event.preventDefault();
        marqueeRef.current = null;
        setMarquee(null);
        return;
      }
      // Draft cancel wins over INPUT focus — Esc always aborts an open identity draft.
      if (draftRef.current !== null) {
        event.preventDefault();
        cancelDraftRef.current();
        return;
      }
      if (typing) return;
      setSelectionMenu(null);
      setNodeMenu(null);
      setTagMenuOpen(false);
      setBindAnnotationId(null);
      setEditingAnnotationId(null);
      setSelectedIds((ids) => (ids.length > 0 ? [] : ids));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancelWireDrag]);

  const clearError = useCallback(() => {
    errorStickyRef.current = false;
    setErrorSticky(false);
    setError(null);
    // Allow agent-refresh warnings to surface again after the user dismisses.
    agentWarnShownRef.current = false;
  }, []);

  const showError = useCallback((message: string, sticky = false) => {
    errorStickyRef.current = sticky;
    setErrorSticky(sticky);
    setError(message);
    reportAppError({ source: 'map', message, operation: 'map' });
  }, []);

  const setBusyLocked = useCallback((next: boolean) => {
    busyRef.current = next;
    setBusy(next);
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

  // Settled positions are user-owned: persist when the simulation comes to
  // rest and on unload, otherwise simulation drift is lost on reload.
  useEffect(() => {
    const persist = () => persistPositions(positionsRef.current);
    window.addEventListener('beforeunload', persist);
    return () => window.removeEventListener('beforeunload', persist);
  }, [persistPositions]);

  const persistDoc = useCallback((next: SessionMapDoc) => {
    setMapDoc(next);
    saveSessionMapDoc(next);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds([]);
    setSelectionBox(null);
    setSelectionMenu(null);
  }, []);

  const componentIndex = useMemo(
    () => buildMapComponents(forceNodes, forceLinks),
    [forceNodes, forceLinks],
  );
  componentIndexRef.current = componentIndex;

  /**
   * Hosts that need agent overlay: graph roots (can host team agents without
   * dual-write children yet), parents of mounted children, the active session,
   * and hosts we already know from prior extras — never every mounted leaf.
   */
  const agentHostIdsFor = useCallback((nodes: readonly Session[]): string[] => {
    const focusIds = new Set<string>();
    if (activeSessionId) focusIds.add(activeSessionId);
    for (const node of nodes) {
      const parentId = parentSessionIdOf(node);
      if (parentId !== undefined) {
        focusIds.add(parentId);
      } else {
        focusIds.add(node.id);
      }
    }
    for (const extra of agentExtrasRef.current) {
      if (extra.hostSessionId !== undefined) focusIds.add(extra.hostSessionId);
    }
    const nodeIds = new Set(nodes.map((node) => node.id));
    return [...focusIds].filter((id) => nodeIds.has(id) || id === activeSessionId);
  }, [activeSessionId]);

  const refreshAgents = useCallback(async (nodes: readonly Session[]): Promise<MapMemberRef[]> => {
    const focusIds = agentHostIdsFor(nodes);
    const extras: MapMemberRef[] = [];
    const agentErrors: string[] = [];
    await Promise.all(focusIds.map(async (hostId) => {
      try {
        const result = await api.sessions.getAgents(hostId);
        for (const agent of result.items ?? []) {
          if (agent.kind !== 'team' || agent.archived) continue;
          const mountedId = agent.mounted_session_id;
          if (mountedId === undefined || mountedId.length === 0) continue;
          const mountedSession = nodes.find((node) => node.id === mountedId);
          extras.push({
            kind: 'session',
            session: mountedSession ?? {
              id: mountedId,
              title: sessionAgentDisplayName(agent),
              status: agent.status,
              created_at: agent.last_active ?? new Date().toISOString(),
              updated_at: agent.last_active ?? new Date().toISOString(),
              metadata: {
                parent_session_id: hostId,
                mount_role: agent.role,
                mount_mandate: agent.mandate,
              },
            },
            hostSessionId: hostId,
            agent,
          });
        }
      } catch (err) {
        agentErrors.push(err instanceof Error ? err.message : String(err));
      }
    }));
    if (agentErrors.length === 0) {
      agentWarnShownRef.current = false;
    } else if (!agentWarnShownRef.current && !errorStickyRef.current) {
      agentWarnShownRef.current = true;
      showError(tr(
        `Could not refresh team members (${agentErrors[0]}). Session mounts still shown.`,
        `无法刷新团队成员（${agentErrors[0]}）。会话挂载仍可用。`,
      ));
    }
    return extras;
  }, [agentHostIdsFor, showError, tr]);

  const pruneStalePositions = useCallback((aliveKeys: ReadonlySet<string>) => {
    let changed = false;
    const stale: string[] = [];
    for (const key of positionsRef.current.keys()) {
      if (!aliveKeys.has(key)) stale.push(key);
    }
    for (const key of stale) {
      positionsRef.current.delete(key);
      changed = true;
    }
    const persisted = mapDocRef.current.positions;
    if (persisted === undefined && !changed) return;
    const nextPositions: Record<string, { x: number; y: number }> = {};
    for (const [id, pos] of Object.entries(persisted ?? {})) {
      if (aliveKeys.has(id) || positionsRef.current.has(id)) {
        nextPositions[id] = pos;
      } else {
        changed = true;
      }
    }
    for (const [id, pos] of positionsRef.current) {
      nextPositions[id] = pos;
    }
    if (!changed && Object.keys(nextPositions).length === Object.keys(persisted ?? {}).length) return;
    const next = {
      ...mapDocRef.current,
      positions: Object.keys(nextPositions).length > 0 ? nextPositions : undefined,
    };
    mapDocRef.current = next;
    setMapDoc(next);
    saveSessionMapDoc(next);
  }, []);

  const refresh = useCallback(async () => {
    // Poll/mutation refreshes must never stomp an open identity draft or an
    // in-flight wire/node drag — graph data would shift nodes mid-gesture.
    if (draftRef.current !== null || wireDragRef.current !== null || dragRef.current !== null
      || annotationDragRef.current !== null || rearrangeActiveRef.current
      || marqueeRef.current !== null) {
      return;
    }
    const revision = ++refreshRevision.current;
    try {
      const next = ensureGraphEdges(await api.sessions.getGraph({ exclude_empty: false }));
      const reconciled = reconcileParentEdgesWithServer(mapDocRef.current, next.edges);
      if (reconciled !== mapDocRef.current) {
        mapDocRef.current = reconciled;
        setMapDoc(reconciled);
        saveSessionMapDoc(reconciled);
      }
      const extras = await refreshAgents(next.nodes);
      if (disposedRef.current || revision !== refreshRevision.current) return;
      setGraph(next);
      setAgentExtras(extras);
      saveCachedMapAgents(cachedAgentsFromMapMembers(extras));
      const alive = new Set<string>();
      for (const node of next.nodes) alive.add(`session:${node.id}`);
      for (const extra of extras) alive.add(nodeKey(extra));
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
                upsertParentMapEdge(doc, op.parentSessionId, op.childSessionId),
                op.childSessionId,
              );
            } else if (op.kind === 'remount' && op.parentSessionId !== undefined) {
              await api.sessions.remount(op.childSessionId, op.parentSessionId, {
                role: op.role,
                mandate: op.mandate,
              });
              doc = clearPendingTopology(
                upsertParentMapEdge(doc, op.parentSessionId, op.childSessionId),
                op.childSessionId,
              );
            } else if (op.kind === 'unmount') {
              await api.sessions.unmount(op.childSessionId);
              doc = clearPendingTopology(disconnectParentEdges(doc, op.childSessionId), op.childSessionId);
            }
          } catch (flushError) {
            if (disposedRef.current || revision !== refreshRevision.current) return;
            showError(flushError instanceof Error ? flushError.message : String(flushError));
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
    } catch (err) {
      if (disposedRef.current || revision !== refreshRevision.current) return;
      showError(err instanceof Error ? err.message : String(err));
      // Fall back to sidebar sessions + metadata edges so hierarchy still renders.
      const fallback = ensureGraphEdges({ nodes: [...sessions], edges: [] });
      const extras = await refreshAgents(fallback.nodes);
      if (disposedRef.current || revision !== refreshRevision.current) return;
      setGraph(fallback);
      setAgentExtras(extras);
      saveCachedMapAgents(cachedAgentsFromMapMembers(extras));
    }
  }, [onGraphChanged, pruneStalePositions, refreshAgents, sessions, showError]);

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
    }, AGENT_POLL_MS);
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

  const allNodes = useMemo(() => graph?.nodes ?? [...sessions], [graph, sessions]);
  const byId = useMemo(() => new Map(allNodes.map((session) => [session.id, session])), [allNodes]);

  const mapGraphContext = useMemo(() => ({
    sessions: allNodes,
    mapEdges: mapDoc.edges ?? [],
    topLevelRoles: mapDoc.topLevelRoles ?? {},
    hasOpenAgentHandler: onOpenAgent !== undefined,
  }), [allNodes, mapDoc.edges, mapDoc.topLevelRoles, onOpenAgent]);

  const memberCaps = useCallback((member: MapMemberRef) => (
    mapNodeCapabilities(member, mapGraphContext)
  ), [mapGraphContext]);

  const selectedParentSessionId = useMemo(() => {
    if (selectedIds.length !== 1) return undefined;
    const sessionId = selectedIds[0]!;
    const sessionNode = byId.get(sessionId);
    if (sessionNode === undefined) return undefined;
    const caps = mapNodeCapabilities({ kind: 'session', session: sessionNode }, mapGraphContext);
    return caps.canMountOthers ? sessionId : undefined;
  }, [byId, mapGraphContext, selectedIds]);

  const listClickTimerRef = useRef<number | null>(null);

  const openMember = useCallback((member: MapMemberRef) => {
    if (performance.now() <= suppressMapClickUntilRef.current || draft !== null) return;
    const target = mapOpenTarget(member);
    if (target === undefined) {
      showError(tr('This team member is no longer available.', '这个团队成员已不可用。'));
      return;
    }
    clearError();
    if (target.kind === 'session') {
      onOpenSession(target.sessionId);
    } else if (onOpenAgent !== undefined) {
      onOpenAgent(target.hostSessionId, target.agent);
    } else {
      onOpenSession(target.agent.mounted_session_id ?? target.hostSessionId);
    }
  }, [clearError, draft, onOpenAgent, onOpenSession, showError, tr]);

  const agentOnlyExtras = useMemo(() => (
    dedupeMapMembers(agentExtras.filter((extra) => {
      if (extra.kind === 'session') return false;
      const mounted = extra.agent?.mounted_session_id;
      if (mounted !== undefined && byId.has(mounted)) return false;
      return true;
    }), allNodes)
  ), [agentExtras, byId]);

  const listMembers = useMemo(() => {
    const sessionMembers: MapMemberRef[] = allNodes.map((session) => {
      const parentId = parentSessionIdOf(session);
      const linked = parentId === undefined
        ? undefined
        : agentExtras.find((extra) => (
          extra.agent?.mounted_session_id === session.id
          && extra.hostSessionId === parentId
        ));
      return {
        session,
        kind: 'session' as const,
        hostSessionId: linked?.hostSessionId ?? parentId,
        agent: linked?.agent,
      };
    });
    return [...sessionMembers, ...agentOnlyExtras];
  }, [agentExtras, agentOnlyExtras, allNodes]);

  const filteredList = useMemo(() => {
    const q = query.trim().toLowerCase();
    return listMembers.filter((member) => {
      if (!matchesMapStatusFilter(mapMemberStatus(member), statusFilter)) return false;
      const sessionId = member.session.id;
      if (activeLabelIds.length > 0
        && !sessionMatchesLabelFilter(sessionId, mapDoc.sessionLabels, activeLabelIds)
        && !(member.kind === 'agent' && sessionMatchesLabelFilter(
          member.hostSessionId ?? sessionId,
          mapDoc.sessionLabels,
          activeLabelIds,
        ))) {
        return false;
      }
      if (!q) return true;
      const title = memberLabel(member).toLowerCase();
      const prompt = (member.session.last_prompt ?? '').toLowerCase();
      const role = (memberRole(member, mapDoc.topLevelRoles) ?? '').toLowerCase();
      const mandate = (
        typeof member.session.metadata?.mount_mandate === 'string'
          ? member.session.metadata.mount_mandate
          : member.agent?.mandate ?? ''
      ).toLowerCase();
      const cwd = (memberProjectCwd(member, byId) ?? '').toLowerCase();
      const folder = cwd ? projectFolderName(cwd).toLowerCase() : '';
      const tags = readSessionTags(member.session).join(' ').toLowerCase();
      return title.includes(q)
        || prompt.includes(q)
        || sessionId.toLowerCase().includes(q)
        || role.includes(q)
        || mandate.includes(q)
        || tags.includes(q)
        || (member.agent?.agent_id ?? '').toLowerCase().includes(q)
        || cwd.includes(q)
        || folder.includes(q);
    });
  }, [activeLabelIds, byId, listMembers, mapDoc.sessionLabels, mapDoc.topLevelRoles, query, statusFilter]);

  const visibleIds = useMemo(() => new Set(filteredList.map((member) => nodeKey(member))), [filteredList]);
  const busyVisibleCount = useMemo(() => (
    filteredList.filter((member) => {
      const status = mapMemberStatus(member);
      return sessionIsBusy(member.session)
        || status === 'running'
        || status === 'working'
        || status === 'awaiting_approval'
        || status === 'awaiting_question';
    }).length
  ), [filteredList]);

  // Drop selection entries that filters hide — batch delete/annotate must not
  // act on invisible nodes the user can no longer see.
  useEffect(() => {
    const visibleSessionIds = new Set(
      filteredList
        .filter((member) => member.kind === 'session')
        .map((member) => member.session.id),
    );
    setSelectedIds((ids) => {
      const next = ids.filter((id) => visibleSessionIds.has(id));
      return next.length === ids.length ? ids : next;
    });
  }, [filteredList]);

  const treeLayout = useMemo(() => {
    const serverGraph = ensureGraphEdges(graph ?? { nodes: [...sessions], edges: [] });
    const { layoutEdges } = mergeGraphWithMapEdges(
      serverGraph.nodes,
      serverGraph.edges,
      mapDoc.edges ?? [],
    );
    const base = layoutSessionMountForest(
      { nodes: serverGraph.nodes, edges: layoutEdges },
      agentExtras,
    );
    if (query.trim() === '' && activeLabelIds.length === 0 && statusFilter === 'all') return base;
    const wanted = new Set(visibleIds);
    const parentOf = new Map<string, string>();
    for (const { from, to } of base.edges) {
      parentOf.set(nodeKey(to.member), nodeKey(from.member));
    }
    for (const id of wanted) {
      const parent = parentOf.get(id);
      if (parent !== undefined) wanted.add(parent);
    }
    const placed = base.placed.filter((node) => wanted.has(nodeKey(node.member)));
    const edges = base.edges.filter(({ from, to }) => (
      wanted.has(nodeKey(from.member)) && wanted.has(nodeKey(to.member))
    ));
    return { ...base, placed, edges };
  }, [graph, sessions, agentExtras, query, visibleIds, mapDoc.edges, activeLabelIds, statusFilter]);

  const topologyKey = useMemo(() => {
    const nodePart = treeLayout.placed.map((node) => {
      const agent = node.member.agent;
      return `${nodeKey(node.member)}:${agent?.agent_id ?? ''}:${agent?.mounted_session_id ?? ''}`;
    }).sort().join('\0');
    const edgePart = treeLayout.edges
      .map(({ from, to }) => `${nodeKey(from.member)}->${nodeKey(to.member)}`)
      .sort()
      .join('\0');
    return `${nodePart}\u0001${edgePart}`;
  }, [treeLayout]);

  // Rebuild force graph when mount topology / filter set changes.
  // Existing ids keep positionsRef / previous sim coords — never teleport on agent poll.
  useEffect(() => {
    if (topologyKeyRef.current === topologyKey) return;
    const hadTopology = topologyKeyRef.current !== '';
    topologyKeyRef.current = topologyKey;
    // Slot targets may shift when agents/mounts arrive. Only re-allow autofocus if
    // the user has not already pan/zoomed away from the initial focus.
    if (!userAdjustedViewRef.current) {
      centeredSessionRef.current = undefined;
    }

    const seeds = new Map<string, { x: number; y: number }>();
    for (const placed of treeLayout.placed) {
      seeds.set(nodeKey(placed.member), {
        x: placed.x + NODE_W / 2,
        y: placed.y + NODE_H / 2,
      });
    }
    seedByIdRef.current = seeds;

    // Prefer in-memory drag pins; fall back to persisted doc positions once.
    const persisted = mapDocRef.current.positions ?? {};
    for (const [id, pos] of Object.entries(persisted)) {
      if (!positionsRef.current.has(id)) {
        positionsRef.current.set(id, pos);
      }
    }

    const previousById = new Map(forceNodesRef.current.map((node) => [node.id, node]));
    const childKeys = new Set(
      treeLayout.edges.map(({ to }) => nodeKey(to.member)),
    );

    // First pass: resolve positions for known ids (preserve) and hosts.
    const provisional = new Map<string, { x: number; y: number }>();
    for (const placed of treeLayout.placed) {
      const id = nodeKey(placed.member);
      const prev = previousById.get(id);
      const spawn = resolveMapNodeSpawnPosition({
        id,
        previous: prev,
        cached: positionsRef.current.get(id),
        seed: seeds.get(id),
      });
      provisional.set(id, spawn);
    }
    // Second pass: brand-new nodes without cache sit near their host (no (0,0) pop).
    for (const placed of treeLayout.placed) {
      const id = nodeKey(placed.member);
      if (previousById.has(id) || positionsRef.current.has(id)) continue;
      const hostId = placed.member.hostSessionId
        ?? parentSessionIdOf(placed.member.session);
      if (hostId === undefined) continue;
      const hostPos = provisional.get(`session:${hostId}`);
      if (hostPos === undefined) continue;
      const nearHost = resolveMapNodeSpawnPosition({
        id,
        hostPosition: hostPos,
        seed: seeds.get(id),
      });
      provisional.set(id, nearHost);
    }

    const nodes: ForceMapNode[] = treeLayout.placed.map((placed) => {
      const id = nodeKey(placed.member);
      const prev = previousById.get(id);
      const pos = provisional.get(id) ?? seeds.get(id)!;
      const isRoot = !childKeys.has(id);
      // Preserve root pins; children stay unpinned so tidy home can run.
      const fx = isRoot ? (prev?.fx ?? pos.x) : null;
      const fy = isRoot ? (prev?.fy ?? pos.y) : null;
      positionsRef.current.set(id, { x: pos.x, y: pos.y });
      return {
        id,
        member: placed.member,
        x: pos.x,
        y: pos.y,
        fx,
        fy,
        vx: prev?.vx ?? 0,
        vy: prev?.vy ?? 0,
      };
    });

    // After createChild/mount/unmount (topology change), snap children to tidy
    // slots under each root — does not move user-placed roots.
    if (hadTopology) {
      const index = buildMapComponents(nodes, treeLayout.edges.map(({ from, to }) => ({
        source: nodeKey(from.member),
        target: nodeKey(to.member),
      })));
      const seen = new Set<string>();
      for (const node of nodes) {
        const comp = index.get(node.id);
        if (comp === undefined || seen.has(comp.componentId)) continue;
        seen.add(comp.componentId);
        const root = nodes.find((candidate) => candidate.id === comp.rootNodeId);
        if (root === undefined) continue;
        const targets = tidyComponentAroundRoot({
          rootNodeId: comp.rootNodeId,
          nodeIds: comp.nodeIds,
          rootPosition: { x: root.x ?? 0, y: root.y ?? 0 },
          seeds,
        });
        for (const child of nodes) {
          if (child.id === comp.rootNodeId) continue;
          if (!comp.nodeIds.includes(child.id)) continue;
          // Only auto-tidy nodes that just appeared (no prior sim state).
          if (previousById.has(child.id)) continue;
          const target = targets.get(child.id);
          if (target === undefined) continue;
          child.x = target.x;
          child.y = target.y;
          positionsRef.current.set(child.id, target);
        }
      }
    }

    const links: ForceMapLink[] = treeLayout.edges.map(({ from, to }) => ({
      source: nodeKey(from.member),
      target: nodeKey(to.member),
    }));
    setForceNodes(nodes);
    setForceLinks(links);
  }, [topologyKey, treeLayout]);

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
      if (rearrangeActiveRef.current) return 0;
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
            positionsRef.current.set(node.id, {
              x: node.x ?? 0,
              y: node.y ?? 0,
            });
          }
          scheduleRedraw();
        })
        .on('end', () => {
          persistPositions(positionsRef.current);
          scheduleRedraw();
        });
      simulationRef.current = simulation;
    } else {
      simulation.nodes(forceNodes);
      const linkForce = simulation.force('link') as ReturnType<typeof forceLink<ForceMapNode, ForceMapLink>> | undefined;
      linkForce?.links(forceLinks);
      linkForce?.strength(LINK_STRENGTH);
      // Mild settle for newcomers only — do not hard-restart alpha to 1.
      if (!rearrangeActiveRef.current) {
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
      focusInsetForViewport(width, listOpen),
    ));
    return true;
  }, [listOpen, viewportSize.height, viewportSize.width]);

  const findActiveForceNode = useCallback((sessionId: string | undefined): ForceMapNode | undefined => {
    if (sessionId === undefined) return undefined;
    if (activeAgentId !== undefined && activeAgentId !== 'main') {
      const agentNode = forceNodesRef.current.find((node) => (
        node.member.hostSessionId === sessionId
        && node.member.agent?.agent_id === activeAgentId
      ));
      if (agentNode !== undefined) return agentNode;
    }
    return forceNodesRef.current.find((node) => (
      node.member.session.id === sessionId
      || node.member.agent?.mounted_session_id === sessionId
    ));
  }, [activeAgentId]);

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
    if (rearrangeTimerRef.current !== null) {
      window.clearTimeout(rearrangeTimerRef.current);
      rearrangeTimerRef.current = null;
    }
    rearrangeGenerationRef.current += 1;
  }, [stopFollowFocus]);

  const rearrange = useCallback(() => {
    // One-shot intra-component tidy — targets are relative to each root's current
    // position (no global forest-slot gravity).
    const nodes = forceNodesRef.current;
    if (nodes.length === 0) return;
    rearrangeActiveRef.current = true;

    const seeds = new Map<string, { x: number; y: number }>();
    for (const placed of treeLayout.placed) {
      seeds.set(nodeKey(placed.member), {
        x: placed.x + NODE_W / 2,
        y: placed.y + NODE_H / 2,
      });
    }
    seedByIdRef.current = seeds;

    const targets = new Map<string, { x: number; y: number }>();
    const seen = new Set<string>();
    for (const node of nodes) {
      const meta = componentIndexRef.current.get(node.id);
      if (meta === undefined || seen.has(meta.componentId)) continue;
      seen.add(meta.componentId);
      const root = nodes.find((candidate) => candidate.id === meta.rootNodeId) ?? node;
      const tidied = tidyComponentAroundRoot({
        rootNodeId: meta.rootNodeId,
        nodeIds: meta.nodeIds,
        rootPosition: { x: root.x ?? 0, y: root.y ?? 0 },
        seeds,
      });
      for (const [id, pos] of tidied) targets.set(id, pos);
    }

    for (const node of nodes) {
      node.fx = null;
      node.fy = null;
      node.vx = (node.vx ?? 0) * 0.15;
      node.vy = (node.vy ?? 0) * 0.15;
    }

    const simulation = simulationRef.current;
    if (simulation === null) {
      rearrangeActiveRef.current = false;
      return;
    }

    const homeX = (node: ForceMapNode): number => targets.get(node.id)?.x ?? node.x ?? 0;
    const homeY = (node: ForceMapNode): number => targets.get(node.id)?.y ?? node.y ?? 0;
    simulation.force('homeX', forceX<ForceMapNode>(homeX).strength(REARRANGE_HOME_STRENGTH));
    simulation.force('homeY', forceY<ForceMapNode>(homeY).strength(REARRANGE_HOME_STRENGTH));
    const linkForce = simulation.force('link') as ReturnType<typeof forceLink<ForceMapNode, ForceMapLink>> | undefined;
    linkForce?.strength(REARRANGE_LINK_STRENGTH);
    simulation.alphaTarget(0.18).alpha(1).restart();
    redraw((value) => value + 1);

    if (rearrangeTimerRef.current !== null) {
      window.clearTimeout(rearrangeTimerRef.current);
      rearrangeTimerRef.current = null;
    }
    simulation.on('end', null);
    const generation = ++rearrangeGenerationRef.current;

    const finishRearrange = () => {
      if (generation !== rearrangeGenerationRef.current) return;
      if (simulationRef.current !== simulation) return;
      try {
        // Restore ambient child tidy homes (roots stay pinned).
        const ambientHome = (node: ForceMapNode): { x: number; y: number } => {
          const comp = componentIndexRef.current.get(node.id);
          if (comp === undefined || comp.rootNodeId === node.id) {
            return { x: node.x ?? 0, y: node.y ?? 0 };
          }
          const root = forceNodesRef.current.find((candidate) => candidate.id === comp.rootNodeId);
          return tidyComponentAroundRoot({
            rootNodeId: comp.rootNodeId,
            nodeIds: comp.nodeIds,
            rootPosition: { x: root?.x ?? 0, y: root?.y ?? 0 },
            seeds: seedByIdRef.current,
          }).get(node.id) ?? { x: node.x ?? 0, y: node.y ?? 0 };
        };
        simulation.force(
          'homeX',
          forceX<ForceMapNode>((node) => ambientHome(node).x).strength((node) => (
            isComponentRootPin(node.id, componentIndexRef.current) ? 0 : HOME_PULL_STRENGTH
          )),
        );
        simulation.force(
          'homeY',
          forceY<ForceMapNode>((node) => ambientHome(node).y).strength((node) => (
            isComponentRootPin(node.id, componentIndexRef.current) ? 0 : HOME_PULL_STRENGTH
          )),
        );
        linkForce?.strength(LINK_STRENGTH);
        simulation.alphaTarget(0).alpha(0);
        for (const node of forceNodesRef.current) {
          // Hard-snap to tidy homes — do not keep mid-sim coords (d3 ticks can
          // stall after fake timers / background throttling).
          const x = homeX(node);
          const y = homeY(node);
          node.x = x;
          node.y = y;
          node.vx = 0;
          node.vy = 0;
          // Keep only roots pinned so ambient tidy can settle children.
          if (isComponentRootPin(node.id, componentIndexRef.current)) {
            node.fx = x;
            node.fy = y;
          } else {
            node.fx = null;
            node.fy = null;
          }
          positionsRef.current.set(node.id, { x, y });
        }
        persistPositions(positionsRef.current);
        // Brief settle so unpinned children finish under their root.
        simulation.alpha(SETTLE_ALPHA).restart();
        simulation.on('end', () => {
          persistPositions(positionsRef.current);
          scheduleRedraw();
        });
        scheduleRedraw();
      } finally {
        rearrangeActiveRef.current = false;
      }
    };

    simulation.on('end', () => {
      simulation.on('end', null);
      if (rearrangeTimerRef.current !== null) {
        window.clearTimeout(rearrangeTimerRef.current);
        rearrangeTimerRef.current = null;
      }
      finishRearrange();
    });
    rearrangeTimerRef.current = window.setTimeout(() => {
      rearrangeTimerRef.current = null;
      simulation.on('end', null);
      finishRearrange();
    }, REARRANGE_SETTLE_MS);

    if (activeSessionId !== undefined) {
      const target = findActiveForceNode(activeSessionId);
      if (target !== undefined) {
        userAdjustedViewRef.current = false;
        centeredSessionRef.current = activeSessionId;
        startFollowFocus(activeSessionId, 900);
        return;
      }
    }
    if (!userAdjustedViewRef.current) {
      setView(fitTreeView(
        { width: treeLayout.width, height: treeLayout.height },
        viewportSize,
      ));
    }
  }, [
    activeSessionId,
    findActiveForceNode,
    persistPositions,
    scheduleRedraw,
    startFollowFocus,
    treeLayout.height,
    treeLayout.placed,
    treeLayout.width,
    viewportSize,
  ]);

  const focusActive = useCallback(() => {
    userAdjustedViewRef.current = false;
    const target = findActiveForceNode(activeSessionId);
    if (target !== undefined) {
      if (activeSessionId !== undefined) {
        centeredSessionRef.current = activeSessionId;
        focusNode(target);
        startFollowFocus(activeSessionId, 600);
        return;
      }
      focusNode(target);
      return;
    }
    setView(fitTreeView(
      { width: treeLayout.width, height: treeLayout.height },
      viewportSize,
    ));
  }, [
    activeSessionId,
    findActiveForceNode,
    focusNode,
    startFollowFocus,
    treeLayout.height,
    treeLayout.width,
    viewportSize,
  ]);

  // Wheel must be a native non-passive listener: React's synthetic onWheel is
  // passive on the root, so preventDefault there cannot stop page scroll/zoom.
  const wheelHandlerRef = useRef<(event: WheelEvent) => void>(() => {});
  wheelHandlerRef.current = (event: WheelEvent) => {
    event.preventDefault();
    const el = viewportRef.current;
    if (!el) return;
    if (event.deltaY === 0) return;
    markUserAdjustedView();
    stopFollowFocus();
    const current = viewRef.current;
    const rect = el.getBoundingClientRect();
    // Wheel / trackpad vertical scroll → zoom only (UE-style). Ctrl+wheel is redundant.
    setView(zoomTreeView(
      current,
      current.scale * (event.deltaY < 0 ? 1.1 : 0.9),
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

  const onPointerDown = (event: ReactPointerEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest('.session-map-draft-node') !== null) return;
    if (target.closest('.session-map-context-menu') !== null) return;
    if (target.closest('.session-map-selection-box') !== null) return;
    if (target.closest('.session-map-list-panel') !== null) return;
    setNodeMenu(null);
    setSelectionMenu(null);
    setCanvasMenu(null);
    if (draftRef.current !== null) {
      if (target.closest('.session-map-node, .session-map-annotation-chrome, .session-map-float') === null) {
        cancelDraftRef.current();
      }
      return;
    }
    // Annotation body uses pointer-events:none — only chrome (title/resize) captures.
    // Do not treat the annotation shell as a blocker for marquee/pan.
    if (target.closest('.session-map-node, .session-map-annotation-chrome, .session-map-float') !== null) {
      return;
    }

    // Right-click pan. Do not preventDefault: Chromium then drops contextmenu.
    if (event.button === 2) {
      rightPanMovedRef.current = false;
      stopFollowFocus();
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      panOrigin.current = { x: event.clientX, y: event.clientY, view: viewRef.current };
      setPanning(true);
      return;
    }

    if (event.button !== 0) return;

    stopFollowFocus();
    // Left drag on empty canvas → ephemeral marquee (node selection region).
    const world = clientToWorld(event.clientX, event.clientY);
    if (world === null) return;
    const next = { startX: world.x, startY: world.y, endX: world.x, endY: world.y };
    marqueeRef.current = next;
    setMarquee(next);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const executeSilentLink = useCallback(async (
    childId: string,
    parentId: string,
    edgeType: SessionMapEdgeType = 'parent',
  ) => {
    if (edgeType !== 'parent') {
      busyRef.current = false;
      if (childId.startsWith('agent:') || parentId.startsWith('agent:')) {
        showError(tr('Wire target must be a real session card.', '连线目标必须是真实会话卡片。'));
        return;
      }
      persistDoc(upsertTypedMapEdge(mapDocRef.current, { type: edgeType, source: parentId, target: childId }));
      showHint(edgeType === 'peer'
        ? tr('Peer link saved on the map (local; not a mount).', '已在地图上保存对等连线（仅本地，不是挂载）。')
        : tr('Service link saved on the map (local; not a mount).', '已在地图上保存服务连线（仅本地，不是挂载）。'));
      return;
    }
    const child = allNodes.find((session) => session.id === childId);
    const parent = allNodes.find((session) => session.id === parentId);
    const mapParents = mapParentByChildFromEdges(mapDocRef.current.edges ?? []);
    const serverParent = parentSessionIdOf(child);
    const currentParent = serverParent ?? mapParents.get(childId);
    if (currentParent === parentId) {
      busyRef.current = false;
      showHint(tr('Already mounted under this parent.', '已挂载在该父节点下。'));
      return;
    }
    if (wouldCreateMountCycle(childId, parentId, allNodes, mapParents)) {
      busyRef.current = false;
      showError(tr(
        'Cannot mount here — would create a cycle in the session tree.',
        '无法挂载 — 会在会话树中形成环。',
      ), true);
      return;
    }
    if (currentParent !== undefined) {
      const childLabel = child?.title?.trim() || childId.slice(0, 10);
      const currentParentLabel = allNodes.find((session) => session.id === currentParent)?.title?.trim()
        || currentParent.slice(0, 10);
      const confirmed = window.confirm(tr(
        `“${childLabel}” already has a parent (“${currentParentLabel}”). A session can have only one parent — this remounts it, it does not add a second job. Continue?`,
        `「${childLabel}」已挂在「${currentParentLabel}」下。会话只能有一个父节点（暂不支持兼职），继续会改挂而不是增加第二份工作。继续吗？`,
      ));
      if (!confirmed) {
        busyRef.current = false;
        return;
      }
    }
    if (sessionIsBusy(child) || sessionIsBusy(parent)) {
      busyRef.current = false;
      persistDoc(queuePendingTopology(mapDocRef.current, {
        kind: serverParent !== undefined ? 'remount' : 'mount',
        childSessionId: childId,
        parentSessionId: parentId,
      }));
      showHint(tr(
        'Session busy — mount queued until the current turn finishes.',
        '会话忙碌 — 挂载已排队，将在当前轮次结束后应用。',
      ));
      return;
    }
    setBusyLocked(true);
    clearError();
    try {
      if (serverParent !== undefined) {
        await api.sessions.remount(childId, parentId, {});
      } else {
        await api.sessions.mount(childId, parentId, {});
      }
      if (disposedRef.current) return;
      persistDoc(clearPendingTopology(
        upsertParentMapEdge(mapDocRef.current, parentId, childId),
        childId,
      ));
      await refresh();
      if (disposedRef.current) return;
      onGraphChanged?.();
    } catch (err) {
      if (disposedRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      const cycleHint = /cycle|环|40921|mount_cycle/i.test(message);
      showError(cycleHint
        ? tr(
          'Cannot mount here — would create a cycle in the session tree.',
          '无法挂载 — 会在会话树中形成环。',
        )
        : tr(
          `Mount failed: ${message}`,
          `挂载失败：${message}`,
        ), true);
    } finally {
      if (!disposedRef.current) setBusyLocked(false);
      else busyRef.current = false;
    }
  }, [allNodes, clearError, onGraphChanged, persistDoc, refresh, setBusyLocked, showError, showHint, tr]);

  const focusMemberOnCanvas = useCallback((member: MapMemberRef) => {
    const key = nodeKey(member);
    const target = forceNodesRef.current.find((node) => node.id === key);
    if (target === undefined) {
      showHint(tr('Node not on canvas — clear filters or open list.', '节点不在画布上 — 请清除筛选或打开列表。'));
      return false;
    }
    markUserAdjustedView();
    stopFollowFocus();
    return focusNode(target);
  }, [focusNode, markUserAdjustedView, showHint, stopFollowFocus, tr]);

  const mountMemberUnderParent = useCallback(async (member: MapMemberRef, parentSessionId: string) => {
    const caps = memberCaps(member);
    if (!caps.isRealSession) return;
    const childId = member.session.id;
    const mapParents = mapParentByChildFromEdges(mapDocRef.current.edges ?? []);
    if (!canMountMemberUnder(childId, parentSessionId, allNodes, mapParents)) {
      showError(tr(
        'Cannot mount here — would create a cycle in the session tree.',
        '无法挂载 — 会在会话树中形成环。',
      ), true);
      return;
    }
    await executeSilentLink(childId, parentSessionId, 'parent');
  }, [allNodes, executeSilentLink, memberCaps, showError, tr]);

  const handleListItemClick = useCallback((member: MapMemberRef) => {
    if (listClickTimerRef.current !== null) {
      window.clearTimeout(listClickTimerRef.current);
    }
    listClickTimerRef.current = window.setTimeout(() => {
      listClickTimerRef.current = null;
      focusMemberOnCanvas(member);
    }, 220);
  }, [focusMemberOnCanvas]);

  const handleListItemDoubleClick = useCallback((member: MapMemberRef) => {
    if (listClickTimerRef.current !== null) {
      window.clearTimeout(listClickTimerRef.current);
      listClickTimerRef.current = null;
    }
    openMember(member);
  }, [openMember]);

  const finishWireDrag = useCallback(async (event: PointerEvent) => {
    const active = wireDragRef.current;
    // A different pointer lifting mid-wire must not finish (or cancel) it.
    if (active !== null && event.pointerId !== active.pointerId) return;
    detachWireListeners();
    wireDragRef.current = null;
    setWireDrag(null);
    setWireSnapTargetId(null);
    if (active === null || event.type === 'pointercancel') return;

    armClickSuppression();

    // Tiny screen drag = cancel (click on port). Client-space threshold on
    // purpose: it measures finger/mouse travel, independent of zoom.
    if (Math.hypot(event.clientX - active.startClientX, event.clientY - active.startClientY) < 12) {
      return;
    }

    // Sync lock immediately so another port gesture cannot start while we
    // resolve the drop (React `busy` state still lags one render).
    busyRef.current = true;

    const world = clientToWorld(event.clientX, event.clientY);
    if (world === null) {
      busyRef.current = false;
      return;
    }
    let { x: worldX, y: worldY } = world;

    const preferPort = active.side === 'out' ? 'in' : 'out';
    const hitRaw = hitSessionMapNode(forceNodesRef.current, worldX, worldY, {
      excludeId: active.fromId,
      preferPort,
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
      );
      if (snap !== undefined) {
        hit = snap.node;
        worldX = snap.portX;
        worldY = snap.portY;
      }
    }

    if (hit === undefined) {
      const self = hitSessionMapNode(forceNodesRef.current, worldX, worldY, { preferPort });
      if (self !== undefined) {
        busyRef.current = false;
        return;
      }
      const nearest = nearestSessionMapNodeDistance(forceNodesRef.current, worldX, worldY, active.fromId);
      if (nearest !== undefined && nearest <= NEAR_MISS_RADIUS) {
        busyRef.current = false;
        showError(tr(
          'Drop missed the node — aim for the port or card.',
          '未命中节点 — 请对准端口或卡片。',
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
        showError(tr(
          'Drop on another session card (or its output port) to reconnect.',
          '请拖到另一个会话卡片（或其输出口）上以重新挂载。',
        ));
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
          showError(tr(
            'Cannot mount here — would create a cycle in the session tree.',
            '无法挂载 — 会在会话树中形成环。',
          ), true);
        } else {
          showError(tr('Reconnect target must be a real session card.', '重连目标必须是真实会话卡片。'));
        }
        return;
      }
      const parentId = hit.member.session.id;
      if (parentId === childId) {
        busyRef.current = false;
        return;
      }
      await executeSilentLink(childId, parentId, active.edgeType);
      return;
    }

    const parentSessionId = active.parentSessionId;
    if (parentSessionId.length === 0 || parentSessionId.startsWith('agent:')) {
      busyRef.current = false;
      return;
    }

    if (hit !== undefined) {
      if (active.edgeType !== 'parent') {
        if (!isValidWireTarget(active, hit, allNodes, mapDocRef.current.edges ?? [])) {
          busyRef.current = false;
          showError(tr('Wire target must be a real session card.', '连线目标必须是真实会话卡片。'));
          return;
        }
        const childId = hit.member.session.id;
        if (childId === parentSessionId) {
          busyRef.current = false;
          return;
        }
        await executeSilentLink(childId, parentSessionId, active.edgeType);
        return;
      }
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
          showError(tr(
            'Cannot mount here — would create a cycle in the session tree.',
            '无法挂载 — 会在会话树中形成环。',
          ), true);
        } else {
          showError(tr('Wire target must be a real session card.', '连线目标必须是真实会话卡片。'));
        }
        return;
      }
      const childId = hit.member.session.id;
      if (childId === parentSessionId) {
        busyRef.current = false;
        return;
      }
      await executeSilentLink(childId, parentSessionId, active.edgeType);
      return;
    }

    // Local identity draft — not a mount mutation (parent edges only).
    if (active.edgeType !== 'parent') {
      busyRef.current = false;
      showHint(tr('Drop on a session card to create a peer/service edge.', '请拖到会话卡片上以创建对等/服务连线。'));
      return;
    }
    busyRef.current = false;
    setDraft({
      parentId: parentSessionId,
      title: tr('New member', '新成员'),
      role: '',
      mandate: '',
      prompt: '',
      worldX,
      worldY,
    });
  }, [
    allNodes,
    armClickSuppression,
    clientToWorld,
    detachWireListeners,
    executeSilentLink,
    showError,
    showHint,
    tr,
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

    // Alt+click input port of a mounted child → disconnect (unmount).
    // Do this before the busy gate so refresh/in-flight mutations cannot swallow the feedback.
    if (side === 'in' && event.altKey) {
      const caps = memberCaps(node.member);
      if (!caps.canDisconnect) {
        showError(tr(
          'Only mounted session cards can disconnect from the input port.',
          '只有已挂载的会话卡片才能从输入口断连。',
        ));
        return;
      }
      const label = memberLabel(node.member);
      const confirmed = window.confirm(tr(
        `Disconnect “${label}” from its parent? It becomes a top-level session.`,
        `将「${label}」从父节点拆挂？它会升为顶层会话。`,
      ));
      if (!confirmed) return;
      void unmountSession(node.member.session.id);
      return;
    }

    if (busy || busyRef.current || draft !== null || wireDragRef.current !== null) return;
    // Binding notes and wiring are mutually exclusive — leave bind mode.
    if (bindAnnotationId !== null) setBindAnnotationId(null);

    stopFollowFocus();
    dragRef.current = null;
    detachWireListeners();

    if (side === 'in') {
      // UE Blueprint: drag FROM input pin to reconnect under a different parent.
      const childSessionId = wireSourceParentSessionId(node.member);
      if (childSessionId === null) {
        showError(tr(
          'Only real session cards can reconnect from the input port.',
          '只有真实会话卡片才能从输入口重连。',
        ));
        return;
      }
      const fromX = node.x ?? 0;
      const fromY = (node.y ?? 0) - NODE_H / 2;
      const next: WireDragState = {
        fromId: node.id,
        edgeType: 'parent',
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
        showError(tr(
          'Department members hired with TeamCreate are not session nodes. Wire from a real session card, or create a child on the canvas.',
          'TeamCreate 雇佣的部门成员不是会话节点。请从真实会话卡片拉线，或在画布上新建子会话。',
        ));
        return;
      }
      const fromX = node.x ?? 0;
      const fromY = (node.y ?? 0) + NODE_H / 2;
      const next: WireDragState = {
        fromId: node.id,
        edgeType: wireEdgeTypeFromModifiers(event),
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
        NEAR_MISS_RADIUS,
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
    draftRef.current = null;
    setDraft(null);
  };

  const cancelDraft = () => {
    // Esc must dismiss the draft even while the user is mid-edit; only block
    // during an in-flight createChild (busy) so we do not orphan a half-created session.
    if (draft === null || busy || busyRef.current) return;
    clearDraft();
  };
  cancelDraftRef.current = () => {
    cancelDraft();
  };

  /**
   * Local-only identity fill from the brief — never sendPrompt to the parent
   * (avoids transcript pollution, cost, and tool runs).
   */
  const fillIdentityFromPrompt = () => {
    if (draft === null || draft.prompt.trim().length === 0 || busy || busyRef.current) return;
    const local = completeMountIdentityFromPrompt(draft.prompt.trim());
    setDraft({
      ...draft,
      title: local.title || draft.title,
      role: local.role || draft.role,
      mandate: local.mandate || draft.mandate,
    });
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    // Wire drag is tracked via window capture listeners (see startWireFromPort).
    // Annotation drag likewise uses window listeners (see startAnnotationDrag).
    if (wireDragRef.current !== null || annotationDragRef.current !== null) return;
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
      return;
    }
    if (!panOrigin.current) return;
    const next = {
      ...panOrigin.current.view,
      x: panOrigin.current.view.x + (event.clientX - panOrigin.current.x),
      y: panOrigin.current.view.y + (event.clientY - panOrigin.current.y),
    };
    if (
      Math.abs(next.x - panOrigin.current.view.x) > CLICK_MOVE_THRESHOLD
      || Math.abs(next.y - panOrigin.current.view.y) > CLICK_MOVE_THRESHOLD
    ) {
      rightPanMovedRef.current = true;
      markUserAdjustedView();
    }
    setView(next);
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
    if (drag.fromSelection && drag.selectionBoxOrigin !== null) {
      const origin = drag.selectionBoxOrigin;
      setSelectionBox({
        startX: origin.startX + dx,
        startY: origin.startY + dy,
        endX: origin.endX + dx,
        endY: origin.endY + dy,
      });
    }
    redraw((value) => value + 1);
  };

  /** After a drag, keep only component roots pinned so tidy-under-root can run. */
  const releaseDragPinsAndSettle = useCallback((groupNodeIds: readonly string[]) => {
    const touchedComponents = new Set<string>();
    for (const nodeId of groupNodeIds) {
      const groupNode = forceNodesRef.current.find((candidate) => candidate.id === nodeId);
      if (groupNode === undefined) continue;
      const x = groupNode.x ?? 0;
      const y = groupNode.y ?? 0;
      groupNode.x = x;
      groupNode.y = y;
      positionsRef.current.set(groupNode.id, { x, y });
      if (isComponentRootPin(groupNode.id, componentIndexRef.current)) {
        groupNode.fx = x;
        groupNode.fy = y;
      } else {
        groupNode.fx = null;
        groupNode.fy = null;
      }
      const comp = componentIndexRef.current.get(groupNode.id);
      if (comp !== undefined) touchedComponents.add(comp.componentId);
    }
    // Unpin non-dragged siblings and seed them toward tidy slots under the
    // (possibly moved) root — 组内整理 follows the top node.
    for (const node of forceNodesRef.current) {
      const comp = componentIndexRef.current.get(node.id);
      if (comp === undefined || !touchedComponents.has(comp.componentId)) continue;
      if (isComponentRootPin(node.id, componentIndexRef.current)) {
        const x = node.x ?? 0;
        const y = node.y ?? 0;
        node.fx = x;
        node.fy = y;
        continue;
      }
      node.fx = null;
      node.fy = null;
    }
    for (const componentId of touchedComponents) {
      const sample = forceNodesRef.current.find((node) => (
        componentIndexRef.current.get(node.id)?.componentId === componentId
      ));
      const meta = sample !== undefined ? componentIndexRef.current.get(sample.id) : undefined;
      if (meta === undefined) continue;
      const root = forceNodesRef.current.find((node) => node.id === meta.rootNodeId);
      if (root === undefined) continue;
      const rootWasDragged = groupNodeIds.includes(meta.rootNodeId);
      if (rootWasDragged) {
        // Root moved (whole-tree drag OR selection of only the root): hard-snap
        // children to tidy slots under the LIVE root, then short settle.
        const snapped = snapComponentChildrenToLiveRoot({
          rootNodeId: meta.rootNodeId,
          nodeIds: meta.nodeIds,
          rootPosition: { x: root.x ?? 0, y: root.y ?? 0 },
          seeds: seedByIdRef.current,
          nodes: forceNodesRef.current,
        });
        for (const [id, pos] of snapped) {
          positionsRef.current.set(id, pos);
        }
        continue;
      }
      const targets = tidyComponentAroundRoot({
        rootNodeId: meta.rootNodeId,
        nodeIds: meta.nodeIds,
        rootPosition: { x: root.x ?? 0, y: root.y ?? 0 },
        seeds: seedByIdRef.current,
      });
      for (const node of forceNodesRef.current) {
        if (!meta.nodeIds.includes(node.id) || node.id === meta.rootNodeId) continue;
        if (groupNodeIds.includes(node.id)) continue;
        const target = targets.get(node.id);
        if (target === undefined) continue;
        // Soft nudge when a non-root leaf moved — ambient home finishes settle.
        node.vx = ((target.x - (node.x ?? 0)) * 0.35);
        node.vy = ((target.y - (node.y ?? 0)) * 0.35);
      }
    }
    persistPositions(positionsRef.current);
    simulationRef.current?.alpha(SETTLE_ALPHA).alphaTarget(0).restart();
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
    setSelectedIds((current) => (
      additive ? [...new Set([...current, ...hitIds])] : hitIds
    ));
    setSelectionBox({ startX: left, startY: top, endX: right, endY: bottom });
    setSelectionMenu(null);
  }, [clearSelection]);

  const cancelMarquee = useCallback(() => {
    if (marqueeRef.current === null) return;
    marqueeRef.current = null;
    setMarquee(null);
  }, []);

  const annotateSelection = useCallback(() => {
    if (selectionBox === null) return;
    const left = Math.min(selectionBox.startX, selectionBox.endX);
    const right = Math.max(selectionBox.startX, selectionBox.endX);
    const top = Math.min(selectionBox.startY, selectionBox.endY);
    const bottom = Math.max(selectionBox.startY, selectionBox.endY);
    const color = DEFAULT_ANNOTATION_COLORS[mapDocRef.current.annotations.length % DEFAULT_ANNOTATION_COLORS.length]!;
    const annotation: MapAnnotationBox = {
      id: newAnnotationId(),
      title: tr('Note', '注释'),
      color,
      // Soft bind only — rect from the marquee is the persistent visual source of truth.
      nodeIds: [...selectedIds],
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
    setBindAnnotationId(null);
    setSelectionMenu(null);
    clearSelection();
  }, [clearSelection, persistDoc, selectedIds, selectionBox, tr]);

  const openSelectionContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setNodeMenu(null);
    setCanvasMenu(null);
    setSelectionMenu({ x: event.clientX, y: event.clientY });
  };

  const openCanvasContextMenu = (event: ReactMouseEvent) => {
    if ((event.target as HTMLElement).closest('.session-map-node') !== null) return;
    event.preventDefault();
    event.stopPropagation();
    setNodeMenu(null);
    setSelectionMenu(null);
    const world = clientToWorld(event.clientX, event.clientY);
    setCanvasMenu({
      x: event.clientX,
      y: event.clientY,
      worldX: world?.x ?? CANVAS_PAD,
      worldY: world?.y ?? CANVAS_PAD,
    });
  };

  const resolveCreateSessionCwd = (): string | undefined => {
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
          'Create under a real session card, not an agent ghost.',
          '请在真实会话卡片下创建，而不是代理幽灵节点。',
        ), true);
        return;
      }
      setDraft({
        parentId,
        title: tr('New member', '新成员'),
        role: '',
        mandate: '',
        prompt: '',
        worldX,
        worldY,
      });
      return;
    }
    const cwd = resolveCreateSessionCwd();
    if (cwd === undefined) {
      showError(tr(
        'No project folder — open a session with a cwd first.',
        '没有项目目录 — 请先打开带有 cwd 的会话。',
      ), true);
      return;
    }
    setBusyLocked(true);
    clearError();
    try {
      const created = await api.sessions.create({ cwd, smart_title: true });
      if (disposedRef.current || !created?.id) return;
      positionsRef.current.set(`session:${created.id}`, { x: worldX, y: worldY });
      persistDoc({
        ...mapDocRef.current,
        positions: {
          ...mapDocRef.current.positions,
          [`session:${created.id}`]: { x: worldX, y: worldY },
        },
      });
      await refresh();
      if (disposedRef.current) return;
      onGraphChanged?.();
      showHint(tr('Session node created.', '已创建会话节点。'));
    } catch (err) {
      if (disposedRef.current) return;
      showError(err instanceof Error ? err.message : String(err), true);
    } finally {
      if (!disposedRef.current) setBusyLocked(false);
      else busyRef.current = false;
    }
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
    // Ephemeral selection rect follows during drag, then disappears on mouseup.
    if (drag.fromSelection) {
      setSelectionBox(null);
    }
    suppressClickRef.current = drag.moved || event.type === 'pointercancel' ? drag.node.id : null;
    dragRef.current = null;
  };

  const onPointerUp = (event: ReactPointerEvent) => {
    const rightPan = panOrigin.current !== null && event.button === 2;
    const rightClickCreate = rightPan && event.type !== 'pointercancel' && !rightPanMovedRef.current;
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
      panOrigin.current = null;
      setPanning(false);
      if (rightClickCreate) {
        const target = event.target as HTMLElement;
        if (
          target.closest('.session-map-node') === null
          && target.closest('.session-map-context-menu') === null
          && target.closest('.session-map-draft-node') === null
          && target.closest('.session-map-list-panel') === null
          && target.closest('.session-map-selection-box') === null
        ) {
          setNodeMenu(null);
          setSelectionMenu(null);
          const world = clientToWorld(event.clientX, event.clientY);
          setCanvasMenu({
            x: event.clientX,
            y: event.clientY,
            worldX: world?.x ?? CANVAS_PAD,
            worldY: world?.y ?? CANVAS_PAD,
          });
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
    fromSelection: boolean,
  ) => {
    stopFollowFocus();
    setSelectionMenu(null);
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
      fromSelection,
      selectionBoxOrigin: fromSelection && selectionBox !== null
        ? { ...selectionBox }
        : null,
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
      panOrigin.current = null;
      setPanning(false);
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    nodeDragListenersRef.current = { move: onMove, up: onUp };
  };

  const startNodeDrag = (event: ReactPointerEvent, node: ForceMapNode) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('.session-map-port') !== null) return;
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
      selectionBox !== null && selectedIdsNow.includes(sessionId),
    );
  };

  const startSelectionBoxDrag = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    const selectedNodes = forceNodesRef.current.filter((candidate) => (
      selectedIds.includes(candidate.member.session.id)
    ));
    if (selectedNodes.length === 0) return;
    const primary = selectedNodes[0]!;
    beginGroupDrag(
      event,
      primary,
      selectedNodes.map((candidate) => candidate.id),
      true,
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
    // While the identity draft is open it owns the canvas: node clicks must
    // not navigate away and silently discard the draft.
    if (draft !== null) return;
    const sessionId = member.session.id;
    if (bindAnnotationId !== null) {
      const box = mapDoc.annotations.find((item) => item.id === bindAnnotationId);
      if (box === undefined) {
        setBindAnnotationId(null);
        return;
      }
      const nodeIds = box.nodeIds.includes(sessionId)
        ? box.nodeIds.filter((id) => id !== sessionId)
        : [...box.nodeIds, sessionId];
      persistDoc({
        ...mapDoc,
        annotations: mapDoc.annotations.map((item) => {
          if (item.id !== bindAnnotationId) return item;
          // Unbinding the last node: freeze the current visual bounds into the
          // rect so the box does not snap back to a stale position.
          if (nodeIds.length === 0 && item.nodeIds.length > 0) {
            return {
              ...item,
              nodeIds,
              // Prefer the existing free rect; only freeze a hull when none exists.
              rect: item.rect ?? annotationBounds(item, placedForAnnotations, { width: NODE_W, height: NODE_H }),
            };
          }
          return { ...item, nodeIds };
        }),
      });
      return;
    }
    if (event?.shiftKey) {
      setSelectedIds((ids) => (
        ids.includes(sessionId) ? ids.filter((id) => id !== sessionId) : [...ids, sessionId]
      ));
      return;
    }
    setSelectedIds([sessionId]);
  };

  const submitMount = async () => {
    if (draft === null) return;
    if (draft.parentId.startsWith('agent:') || !byId.has(draft.parentId)) {
      showError(tr(
        'The parent session no longer exists. Close this draft and retry.',
        '父会话已不存在。请关闭此草稿后重试。',
      ), true);
      return;
    }
    setBusyLocked(true);
    clearError();
    try {
      const options = {
        role: draft.role.trim() || undefined,
        mandate: draft.mandate.trim() || undefined,
      };
      const created = await api.sessions.createChild(draft.parentId, {
        title: draft.title.trim() || tr('New member', '新成员'),
        role: options.role,
        mandate: options.mandate,
      });
      if (disposedRef.current) return;
      const dropX = draft.worldX;
      const dropY = draft.worldY + NODE_H / 2;
      positionsRef.current.set(`session:${created.id}`, { x: dropX, y: dropY });
      persistPositions(positionsRef.current);
      persistDoc(upsertParentMapEdge(mapDocRef.current, draft.parentId, created.id, {
        mandate: options.mandate,
      }));
      clearDraft();
      await refresh();
      if (disposedRef.current) return;
      onGraphChanged?.();
    } catch (err) {
      if (disposedRef.current) return;
      showError(err instanceof Error ? err.message : String(err), true);
    } finally {
      if (!disposedRef.current) setBusyLocked(false);
      else busyRef.current = false;
    }
  };

  const confirmUnmountSession = (sessionId: string, label: string) => {
    const confirmed = window.confirm(tr(
      `Disconnect “${label}” from its parent? It becomes a top-level session.`,
      `将「${label}」从父节点拆挂？它会升为顶层会话。`,
    ));
    if (!confirmed) return;
    void unmountSession(sessionId);
  };

  const unmountSession = async (sessionId: string) => {
    const child = allNodes.find((session) => session.id === sessionId);
    if (sessionIsBusy(child)) {
      persistDoc(queuePendingTopology(mapDocRef.current, {
        kind: 'unmount',
        childSessionId: sessionId,
      }));
      setNodeMenu(null);
      showHint(tr(
        'Session busy — unmount queued until the current turn finishes.',
        '会话忙碌 — 拆挂已排队，将在当前轮次结束后应用。',
      ));
      return;
    }
    setBusyLocked(true);
    clearError();
    setNodeMenu(null);
    try {
      await api.sessions.unmount(sessionId);
      if (disposedRef.current) return;
      persistDoc(disconnectParentEdges(mapDocRef.current, sessionId));
      await refresh();
      if (disposedRef.current) return;
      onGraphChanged?.();
    } catch (err) {
      if (disposedRef.current) return;
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!disposedRef.current) setBusyLocked(false);
      else busyRef.current = false;
    }
  };

  const deleteSession = async (sessionId: string) => {
    const label = byId.get(sessionId)?.title?.trim() || sessionId.slice(0, 10);
    // Cascade-aware: deleting a host strands children/agents — say so up front.
    const childCount = allNodes.filter((node) => parentSessionIdOf(node) === sessionId).length;
    const memberCount = agentExtras.filter((extra) => extra.hostSessionId === sessionId).length;
    const warnings: string[] = [];
    if (childCount > 0) {
      warnings.push(tr(
        `${String(childCount)} mounted child session(s) will promote to top level.`,
        `${String(childCount)} 个已挂载子会话将升为顶层。`,
      ));
    }
    if (memberCount > 0) {
      warnings.push(tr(
        `${String(memberCount)} team member(s) hosted here will lose their entry point.`,
        `${String(memberCount)} 个托管团队成员将随之移除。`,
      ));
    }
    const ok = window.confirm(
      tr(
        `Delete session “${label}”? This cannot be undone.`,
        `删除会话「${label}」？此操作不可撤销。`,
      ) + (warnings.length > 0 ? `\n${warnings.join('\n')}` : ''),
    );
    if (!ok) {
      setNodeMenu(null);
      return;
    }
    setBusyLocked(true);
    clearError();
    setNodeMenu(null);
    try {
      await api.sessions.delete(sessionId);
      if (disposedRef.current) return;
      positionsRef.current.delete(`session:${sessionId}`);
      persistDoc(removeEdgesForSession(mapDocRef.current, sessionId));
      persistPositions(positionsRef.current);
      await refresh();
      if (disposedRef.current) return;
      onGraphChanged?.();
    } catch (err) {
      if (disposedRef.current) return;
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!disposedRef.current) setBusyLocked(false);
      else busyRef.current = false;
    }
  };

  const deleteSelectedSessions = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;

    const warnings: string[] = [];
    for (const sessionId of ids) {
      const childCount = allNodes.filter((node) => parentSessionIdOf(node) === sessionId).length;
      const memberCount = agentExtras.filter((extra) => extra.hostSessionId === sessionId).length;
      if (childCount > 0) {
        warnings.push(tr(
          `“${byId.get(sessionId)?.title?.trim() || sessionId.slice(0, 10)}”: ${String(childCount)} child(ren) promote to top level.`,
          `「${byId.get(sessionId)?.title?.trim() || sessionId.slice(0, 10)}」：${String(childCount)} 个子会话将升为顶层。`,
        ));
      }
      if (memberCount > 0) {
        warnings.push(tr(
          `“${byId.get(sessionId)?.title?.trim() || sessionId.slice(0, 10)}”: ${String(memberCount)} team member(s) lose their entry point.`,
          `「${byId.get(sessionId)?.title?.trim() || sessionId.slice(0, 10)}」：${String(memberCount)} 名托管成员将随之移除。`,
        ));
      }
    }

    const ok = window.confirm(
      tr(
        `Delete ${String(ids.length)} selected session(s)? This cannot be undone.`,
        `删除已选中的 ${String(ids.length)} 个会话？此操作不可撤销。`,
      ) + (warnings.length > 0 ? `\n${warnings.join('\n')}` : ''),
    );
    if (!ok) return;

    setBusyLocked(true);
    clearError();
    setNodeMenu(null);
    const failures: string[] = [];
    let doc = mapDocRef.current;
    try {
      for (const sessionId of ids) {
        try {
          await api.sessions.delete(sessionId);
          if (disposedRef.current) return;
          doc = removeEdgesForSession(doc, sessionId);
          positionsRef.current.delete(`session:${sessionId}`);
        } catch (err) {
          failures.push(tr(
            `Delete ${sessionId.slice(0, 8)}…: ${err instanceof Error ? err.message : String(err)}`,
            `删除 ${sessionId.slice(0, 8)}…：${err instanceof Error ? err.message : String(err)}`,
          ));
        }
      }
      mapDocRef.current = doc;
      persistDoc(doc);
      persistPositions(positionsRef.current);
      setSelectionMenu(null);
      clearSelection();
      await refresh();
      if (disposedRef.current) return;
      onGraphChanged?.();
      if (failures.length > 0) {
        showError(tr(
          `Batch delete finished with ${String(failures.length)} failure(s): ${failures.slice(0, 3).join(' · ')}`,
          `批量删除完成，${String(failures.length)} 项失败：${failures.slice(0, 3).join(' · ')}`,
        ));
      }
    } catch (err) {
      if (disposedRef.current) return;
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!disposedRef.current) setBusyLocked(false);
      else busyRef.current = false;
    }
  };

  const selectedMembers = (): MapMemberRef[] => {
    const wanted = new Set(selectedIds);
    return forceNodesRef.current
      .filter((node) => wanted.has(node.member.session.id))
      .map((node) => node.member);
  };

  const abortSessionMember = async (member: MapMemberRef): Promise<void> => {
    const tasks = [api.sessions.abort(member.session.id)];
    if (member.agent !== undefined && member.hostSessionId !== undefined) {
      tasks.push(api.sessions.abort(member.hostSessionId, member.agent.agent_id));
    }
    const results = await Promise.allSettled(tasks);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed !== undefined && failed.status === 'rejected') {
      throw failed.reason;
    }
  };

  const abortSelectedSessions = async () => {
    const members = selectedMembers();
    if (members.length === 0) return;
    setBusyLocked(true);
    clearError();
    setSelectionMenu(null);
    const failures: string[] = [];
    try {
      for (const member of members) {
        try {
          await abortSessionMember(member);
        } catch (err) {
          failures.push(memberLabel(member) + ': ' + (err instanceof Error ? err.message : String(err)));
        }
      }
      await refresh();
      if (failures.length > 0) {
        showError(tr(
          `Stop finished with ${String(failures.length)} failure(s): ${failures.slice(0, 3).join(' · ')}`,
          `停止完成，${String(failures.length)} 项失败：${failures.slice(0, 3).join(' · ')}`,
        ));
      } else {
        showHint(tr(
          `Stopped ${String(members.length)} session(s).`,
          `已停止 ${String(members.length)} 个会话。`,
        ));
      }
    } finally {
      if (!disposedRef.current) setBusyLocked(false);
      else busyRef.current = false;
    }
  };

  const unmountSelectedSessions = async () => {
    const ids = selectedIds.filter((id) => parentSessionIdOf(byId.get(id)) !== undefined);
    if (ids.length === 0) {
      showHint(tr('No mounted sessions in the selection.', '选中项里没有已挂载会话。'));
      return;
    }
    const confirmed = window.confirm(tr(
      `Unmount ${String(ids.length)} selected session(s) to top-level?`,
      `将已选中的 ${String(ids.length)} 个会话拆挂为顶层？`,
    ));
    if (!confirmed) return;
    setBusyLocked(true);
    clearError();
    setSelectionMenu(null);
    const failures: string[] = [];
    try {
      for (const sessionId of ids) {
        try {
          const child = byId.get(sessionId);
          if (sessionIsBusy(child)) {
            persistDoc(queuePendingTopology(mapDocRef.current, {
              kind: 'unmount',
              childSessionId: sessionId,
            }));
            continue;
          }
          await api.sessions.unmount(sessionId);
          persistDoc(disconnectParentEdges(mapDocRef.current, sessionId));
        } catch (err) {
          failures.push(sessionId.slice(0, 8) + ': ' + (err instanceof Error ? err.message : String(err)));
        }
      }
      await refresh();
      onGraphChanged?.();
      if (failures.length > 0) {
        showError(tr(
          `Unmount finished with ${String(failures.length)} failure(s).`,
          `拆挂完成，${String(failures.length)} 项失败。`,
        ));
      }
    } finally {
      if (!disposedRef.current) setBusyLocked(false);
      else busyRef.current = false;
    }
  };

  const openSelectedSession = () => {
    const members = selectedMembers();
    const member = members[0];
    if (member === undefined) return;
    if (selectedIds.length > 1) {
      showHint(tr(
        `Opening 1 of ${String(selectedIds.length)} selected sessions.`,
        `已选 ${String(selectedIds.length)} 个，只打开 1 个。`,
      ));
    }
    setSelectionMenu(null);
    openMember(member);
  };

  const selectAllVisible = useCallback(() => {
    const ids = filteredList
      .filter((member) => member.kind === 'session')
      .map((member) => member.session.id);
    setSelectedIds(ids);
    setSelectionMenu(null);
    setTagMenuOpen(false);
  }, [filteredList]);
  selectAllVisibleRef.current = selectAllVisible;

  const applyMapLabelToSelected = (labelId: string, assigned: boolean) => {
    let doc = mapDocRef.current;
    for (const sessionId of selectedIdsRef.current) {
      doc = assignSessionLabel(doc, sessionId, labelId, assigned);
    }
    persistDoc(doc);
    setTagMenuOpen(false);
    setSelectionMenu(null);
  };

  const applyIdentityTagToSelected = async (mode: 'add' | 'remove') => {
    const tag = window.prompt(
      mode === 'add'
        ? tr('Identity tag to add', '要添加的身份标签')
        : tr('Identity tag to remove', '要移除的身份标签'),
    );
    if (tag === null || !tag.trim()) return;
    const ids = [...selectedIdsRef.current];
    setBusyLocked(true);
    setTagMenuOpen(false);
    setSelectionMenu(null);
    const failures: string[] = [];
    try {
      for (const sessionId of ids) {
        const session = byId.get(sessionId);
        if (session === undefined) continue;
        try {
          await api.sessions.updateIdentity(sessionId, {
            tags: mergeSessionTags(readSessionTags(session), tag, mode),
          });
        } catch (err) {
          failures.push(`${sessionId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      await refresh();
      onGraphChanged?.();
      if (failures.length > 0) {
        showError(tr(
          `Tag update finished with ${String(failures.length)} failure(s).`,
          `标签更新完成，${String(failures.length)} 项失败。`,
        ));
      }
    } finally {
      if (!disposedRef.current) setBusyLocked(false);
      else busyRef.current = false;
    }
  };

  const createChildForSession = (sessionId: string) => {
    const node = forceNodesRef.current.find((candidate) => (
      candidate.member.session.id === sessionId
    ));
    void createSessionNodeAt(
      node?.x ?? 0,
      (node?.y ?? 0) + NODE_H / 2 + 28,
      sessionId,
    );
  };

  const stopCardEvent = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
  };

  const openIdentityForSession = (sessionId: string) => {
    const session = byId.get(sessionId);
    if (session === undefined) return;
    setNodeMenu(null);
    setSelectionMenu(null);
    setIdentitySession(session);
  };

  const openNodeContextMenu = (
    event: ReactMouseEvent,
    member: MapMemberRef,
  ) => {
    const caps = memberCaps(member);
    if (!caps.isRealSession) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectionMenu(null);
    setTagMenuOpen(false);
    if (!selectedIdsRef.current.includes(member.session.id)) {
      setSelectedIds([member.session.id]);
    }
    setNodeMenu({
      sessionId: member.session.id,
      x: event.clientX,
      y: event.clientY,
      canUnmount: caps.canDisconnect,
      canSelfBootstrapRole: caps.canSelfBootstrapRole,
      label: memberLabel(member),
    });
  };

  const promptSelfBootstrapRole = (sessionId: string) => {
    const current = mapDoc.topLevelRoles?.[sessionId]
      ?? (typeof byId.get(sessionId)?.metadata?.mount_role === 'string'
        ? byId.get(sessionId)!.metadata!.mount_role as string
        : '');
    const next = window.prompt(
      tr('Self-bootstrap role for this top-level session (local until server sync)', '顶层会话自举角色（本地保存，待服务端同步）'),
      current,
    );
    if (next === null) return;
    const role = next.trim();
    const topLevelRoles = { ...mapDoc.topLevelRoles };
    if (role.length === 0) {
      delete topLevelRoles[sessionId];
    } else {
      topLevelRoles[sessionId] = role;
    }
    persistDoc({
      ...mapDoc,
      topLevelRoles: Object.keys(topLevelRoles).length > 0 ? topLevelRoles : undefined,
    });
    setNodeMenu(null);
    showHint(tr(
      'Role saved locally. Mounting disables self-bootstrap until unmounted.',
      '角色已本地保存。挂载后将禁用自举，拆挂回顶层后恢复。',
    ));
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
    if (bindAnnotationId === id) setBindAnnotationId(null);
  };

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

  const editingAnnotation = mapDoc.annotations.find((item) => item.id === editingAnnotationId);

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
  const contentWidth = Math.max(1, maxX - minX);
  const contentHeight = Math.max(1, maxY - minY);

  return (
    <div className="view-page view-page-wide session-map-page">
      <div
        ref={viewportRef}
        className={
          'session-map-stage'
          + (panning ? ' panning' : '')
          + (bindAnnotationId !== null ? ' binding-note' : '')
          + (wireDrag !== null ? ' wiring' : '')
          + (marquee !== null ? ' marqueeing' : '')
          + (selectionBox !== null ? ' selecting' : '')
          + (busy ? ' busy' : '')
        }
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(event) => {
          if ((event.target as HTMLElement).closest('.session-map-node') !== null) return;
          if ((event.target as HTMLElement).closest('.session-map-context-menu') !== null) return;
          event.preventDefault();
          if (rightPanMovedRef.current) return;
          openCanvasContextMenu(event);
        }}
        onDoubleClick={(event) => {
          // Require Alt or Shift to avoid accidental rearrange on empty canvas.
          if (!event.altKey && !event.shiftKey) return;
          if ((event.target as HTMLElement).closest(
            '.session-map-node, .session-map-annotation-chrome, .session-map-float, .session-map-draft-node',
          ) !== null) {
            return;
          }
          rearrange();
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
            {hint}
          </div>
        )}
        {busy && <div className="session-map-busy-overlay" aria-busy="true" aria-live="polite" />}
        {forceNodes.length === 0 && mapDoc.annotations.length === 0
          ? <div className="session-map-stage-empty">{tr('No sessions yet.', '还没有会话。')}</div>
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
                        + (bindAnnotationId === box.id ? ' binding' : '')
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
                        <span className="session-map-annotation-title">{box.title || tr('Note', '注释')}</span>
                      </div>
                      {box.nodeIds.length === 0 && (
                        <span className="session-map-annotation-empty">{tr('Empty box', '空框')}</span>
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
                  {forceLinks.map((link) => {
                    const from = typeof link.source === 'string'
                      ? forceNodes.find((node) => node.id === link.source)
                      : link.source;
                    const to = typeof link.target === 'string'
                      ? forceNodes.find((node) => node.id === link.target)
                      : link.target;
                    if (!from || !to) return null;
                    const start = linkEndpoint(from, 'bottom');
                    const end = linkEndpoint(to, 'top');
                    const midY = (start.y + end.y) / 2;
                    const d = `M ${start.x - minX} ${start.y - minY} C ${start.x - minX} ${midY - minY}, ${end.x - minX} ${midY - minY}, ${end.x - minX} ${end.y - minY}`;
                    return (
                      <path
                        key={`${typeof link.source === 'string' ? link.source : link.source.id}->${typeof link.target === 'string' ? link.target : link.target.id}`}
                        d={d}
                      />
                    );
                  })}
                  {(mapDoc.edges ?? []).filter((edge) => edge.type === 'peer' || edge.type === 'service').map((edge) => {
                    const from = forceNodes.find((node) => node.member.session.id === edge.source);
                    const to = forceNodes.find((node) => node.member.session.id === edge.target);
                    if (from === undefined || to === undefined) return null;
                    const start = linkEndpoint(from, 'bottom');
                    const end = linkEndpoint(to, 'top');
                    const midY = (start.y + end.y) / 2;
                    const d = `M ${start.x - minX} ${start.y - minY} C ${start.x - minX} ${midY - minY}, ${end.x - minX} ${midY - minY}, ${end.x - minX} ${end.y - minY}`;
                    return (
                      <path
                        key={edge.id}
                        className={`session-map-edge-collab session-map-edge-${edge.type}`}
                        d={d}
                        data-edge-type={edge.type}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          persistDoc(removeSessionMapEdge(mapDocRef.current, edge.id));
                          showHint(tr('Removed the local map link.', '已移除本地地图连线。'));
                        }}
                      >
                        <title>
                          {edge.type === 'peer'
                            ? tr('Peer link · click to remove', '对等连线 · 点击删除')
                            : tr('Service link · click to remove', '服务连线 · 点击删除')}
                        </title>
                      </path>
                    );
                  })}
                </svg>
                {forceNodes.map((node) => {
                  const member = node.member;
                  const caps = memberCaps(member);
                  const parentId = parentSessionIdOf(member.session) ?? member.hostSessionId;
                  const parentSession = parentId !== undefined ? byId.get(parentId) : undefined;
                  const parentName = parentSession !== undefined
                    ? sessionLabel(parentSession)
                    : parentId !== undefined
                      ? parentId.slice(0, 8)
                      : undefined;
                  const isActive = activeSessionId !== undefined && (
                    member.session.id === activeSessionId
                    || member.agent?.mounted_session_id === activeSessionId
                  );
                  const role = memberRole(member, mapDoc.topLevelRoles);
                  const projectCwd = memberProjectCwd(member, byId);
                  const statusClass = mapStatusDotClass(caps.status);
                  const tierLabel = caps.displayTier === 'member'
                    ? tr('member', '成员')
                    : caps.displayTier === 'mounted'
                      ? (parentName !== undefined
                        ? tr(`under ${parentName}`, `挂在「${parentName.length > 14 ? `${parentName.slice(0, 14)}…` : parentName}」`)
                        : tr('mounted', '已挂载'))
                      : tr('top-level', '顶层');
                  const left = Math.round((node.x ?? 0) - NODE_W / 2);
                  const top = Math.round((node.y ?? 0) - NODE_H / 2);
                  const isWireTarget = wireValidTargetIds.has(node.id);
                  const isWireSnap = wireSnapTargetId === node.id;
                  const pendingOp = (mapDoc.pendingTopology ?? []).find(
                    (op) => op.childSessionId === member.session.id,
                  );
                  const currentAction = describeMapCurrentAction(member, liveHints);
                  const errorSummary = describeMapErrorSummary(member, liveHints);
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
                        + (caps.displayTier === 'top' ? ' top-level' : caps.displayTier === 'mounted' ? ' mounted' : ' member')
                        + ` status-${caps.statusTone}`
                        + (selectedIds.includes(member.session.id) ? ' selected' : '')
                        + (isWireTarget ? ' wire-target-valid' : '')
                        + (isWireSnap ? ' wire-target-snap' : '')
                        + (pendingOp !== undefined ? ' pending-topology' : '')
                      }
                      style={{ left, top, width: NODE_W, height: NODE_H }}
                      onPointerDown={(event) => startNodeDrag(event, node)}
                      onClick={(event) => handleNodeClick(member, event)}
                      onDoubleClick={() => openMember(member)}
                      onContextMenu={(event) => openNodeContextMenu(event, member)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          if (draft !== null) return;
                          event.preventDefault();
                          openMember(member);
                          return;
                        }
                        if (event.key !== ' ') return;
                        if (draft !== null) return;
                        event.preventDefault();
                        handleNodeClick(member, event as unknown as ReactMouseEvent);
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
                            'Input · drag to reconnect · Alt+click to disconnect',
                            '输入口 · 拖动重连 · Alt+点击断连',
                          )}
                          onPointerDown={(event) => startWireFromPort(event, node, 'in')}
                        />
                      )}
                      <div className="session-map-node-body">
                        <span className="team-node-name" title={memberLabel(member)}>
                          <i className={`status-dot ${statusClass}`} aria-hidden />
                          {memberLabel(member)}
                          <em
                            className={`session-map-status-badge tone-${caps.statusTone}`}
                            title={formatMapStatusLabel(
                              caps.status,
                              member.agent?.last_active ?? member.session.updated_at,
                            )}
                          >
                            {formatMapStatusLabel(
                              caps.status,
                              member.agent?.last_active ?? member.session.updated_at,
                            )}
                          </em>
                        </span>
                        <span className="team-node-sub" title={tierLabel}>
                          {tierLabel}
                          {role ? ` · ${role}` : ''}
                        </span>
                        {projectCwd !== undefined ? (
                          <span className="team-node-project" title={projectCwd}>
                            {tr('Project', '项目')}
                            {': '}
                            {projectFolderName(projectCwd)}
                          </span>
                        ) : null}
                        {member.agent?.mandate || (typeof member.session.metadata?.mount_mandate === 'string'
                          ? member.session.metadata.mount_mandate
                          : undefined)
                          ? (
                            <span
                              className="team-node-task"
                              title={member.agent?.mandate
                                ?? (member.session.metadata?.mount_mandate as string)}
                            >
                              {member.agent?.mandate
                                ?? (member.session.metadata?.mount_mandate as string)}
                            </span>
                          )
                          : null}
                        {actionLabel !== undefined && (
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
                        <span className="session-map-card-actions">
                          <button
                            type="button"
                            data-map-action="open"
                            title={tr('Open chat', '打开对话')}
                            onPointerDown={stopCardEvent}
                            onClick={(event) => {
                              stopCardEvent(event);
                              openMember(member);
                            }}
                          >
                            {tr('Open', '打开')}
                          </button>
                          <button
                            type="button"
                            data-map-action="stop"
                            title={tr('Stop', '停止')}
                            onPointerDown={stopCardEvent}
                            onClick={(event) => {
                              stopCardEvent(event);
                              void abortSessionMember(member).then(() => refresh());
                            }}
                          >
                            {tr('Stop', '停止')}
                          </button>
                          <button
                            type="button"
                            data-map-action="child"
                            title={tr('New child session', '新建子会话')}
                            onPointerDown={stopCardEvent}
                            onClick={(event) => {
                              stopCardEvent(event);
                              createChildForSession(member.session.id);
                            }}
                          >
                            {tr('Child', '子会话')}
                          </button>
                          <button
                            type="button"
                            data-map-action="settings"
                            title={tr('Session settings', '会话设置')}
                            onPointerDown={stopCardEvent}
                            onClick={(event) => {
                              stopCardEvent(event);
                              openIdentityForSession(member.session.id);
                            }}
                          >
                            {tr('Settings', '设置')}
                          </button>
                          {caps.canDisconnect && (
                            <button
                              type="button"
                              data-map-action="unmount"
                              title={tr('Unmount to top-level', '拆挂升顶层')}
                              onPointerDown={stopCardEvent}
                              onClick={(event) => {
                                stopCardEvent(event);
                                confirmUnmountSession(member.session.id, memberLabel(member));
                              }}
                            >
                              {tr('Unmount', '拆挂')}
                            </button>
                          )}
                          <button
                            type="button"
                            data-map-action="delete"
                            className="danger"
                            title={tr('Delete session', '删除会话')}
                            onPointerDown={stopCardEvent}
                            onClick={(event) => {
                              stopCardEvent(event);
                              void deleteSession(member.session.id);
                            }}
                          >
                            {tr('Delete', '删除')}
                          </button>
                        </span>
                      </div>
                      {caps.canWireOut && (
                        <span
                          className={
                            'session-map-port session-map-port-out'
                            + (isWireTarget && wireDrag?.side === 'in' ? ' wire-highlight' : '')
                            + (isWireSnap && wireDrag?.side === 'in' ? ' wire-snap' : '')
                          }
                          title={tr(
                            'Output · drag to create / remount child · Shift+drag peer · Alt+drag service',
                            '输出口 · 拖出创建或改挂子节点 · Shift 对等 · Alt 服务',
                          )}
                          onPointerDown={(event) => startWireFromPort(event, node, 'out')}
                        />
                      )}
                      {pendingOp !== undefined && (
                        <span
                          className="session-map-pending"
                          title={tr(
                            `Queued ${pendingOp.kind} until idle (${pendingOp.queuedAt})`,
                            `已排队 ${pendingOp.kind === 'unmount' ? '拆挂' : pendingOp.kind === 'remount' ? '改挂' : '挂载'}，等待空闲（${pendingOp.queuedAt}）`,
                          )}
                        >
                          {tr(
                            pendingOp.kind === 'unmount'
                              ? 'queued unmount'
                              : pendingOp.kind === 'remount'
                                ? 'queued remount'
                                : 'queued mount',
                            pendingOp.kind === 'unmount'
                              ? '排队拆挂'
                              : pendingOp.kind === 'remount'
                                ? '排队改挂'
                                : '排队挂载',
                          )}
                        </span>
                      )}
                      {caps.canDisconnect && bindAnnotationId === null && (
                        <span
                          className="session-map-unmount"
                          role="presentation"
                          title={tr('Unmount to top-level', '拆挂升顶层')}
                          onClick={(event) => {
                            event.stopPropagation();
                            confirmUnmountSession(member.session.id, memberLabel(member));
                          }}
                        >
                          ×
                        </span>
                      )}
                    </div>
                  );
                })}
                {selectionBox !== null && (
                  <div
                    className="session-map-selection-box"
                    style={{
                      left: Math.min(selectionBox.startX, selectionBox.endX),
                      top: Math.min(selectionBox.startY, selectionBox.endY),
                      width: Math.abs(selectionBox.endX - selectionBox.startX),
                      height: Math.abs(selectionBox.endY - selectionBox.startY),
                    }}
                    onPointerDown={startSelectionBoxDrag}
                    onClick={(event) => {
                      event.stopPropagation();
                      // Drag-end synthesizes a click — ignore so we do not wipe the gesture.
                      if (suppressClickRef.current !== null) {
                        suppressClickRef.current = null;
                        return;
                      }
                      clearSelection();
                    }}
                    onContextMenu={openSelectionContextMenu}
                  />
                )}
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
                      className={stickyWire.edgeType !== 'parent' ? `session-map-wire-${stickyWire.edgeType}` : undefined}
                      d={`M ${stickyWire.fromX - minX} ${stickyWire.fromY - minY} L ${stickyWire.toX - minX} ${stickyWire.toY - minY}`}
                    />
                  </svg>
                )}
                {draft && (
                  <div
                    className="session-map-draft-node"
                    role="dialog"
                    aria-modal="false"
                    style={{
                      left: Math.round(draft.worldX - 130),
                      top: Math.round(draft.worldY),
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <h3>{tr('New member identity', '新成员身份')}</h3>
                    <p className="session-map-draft-meta">
                      {tr(
                        `Under ${draft.parentId.slice(0, 10)}… · confirm to create`,
                        `挂到 ${draft.parentId.slice(0, 10)}… · 确认后创建`,
                      )}
                    </p>
                    <label>
                      {tr('Title', '标题')}
                      <input
                        value={draft.title}
                        onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                      />
                    </label>
                    <label>
                      {tr('Role', '角色')}
                      <input
                        value={draft.role}
                        onChange={(event) => setDraft({ ...draft, role: event.target.value })}
                      />
                    </label>
                    <label>
                      {tr('Mandate', '职责')}
                      <textarea
                        value={draft.mandate}
                        onChange={(event) => setDraft({ ...draft, mandate: event.target.value })}
                        rows={3}
                      />
                    </label>
                    <label>
                      {tr('Brief for local parse', '提示词（本地解析，不启动父会话）')}
                      <textarea
                        value={draft.prompt}
                        onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
                        rows={2}
                      />
                    </label>
                    <button
                      type="button"
                      className="session-map-tool"
                      disabled={busy || draft.prompt.trim().length === 0}
                      onClick={() => fillIdentityFromPrompt()}
                    >
                      {tr('Parse locally (no parent turn)', '本地解析（不启动父会话）')}
                    </button>
                    <div className="session-map-draft-actions">
                      <button type="button" disabled={busy} onClick={() => cancelDraft()}>
                        {tr('Cancel', '取消')}
                      </button>
                      <button
                        type="button"
                        className="primary"
                        disabled={busy}
                        onClick={() => void submitMount()}
                      >
                        {busy
                          ? tr('Working…', '处理中…')
                          : tr('Confirm', '确认')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

        <header className="session-map-float session-map-float-top">
          <div className="session-map-float-title">
            <div className="view-eyebrow">{tr('Map', '地图')}</div>
            <h2>{tr('Conversation Map', '对话地图')}</h2>
            <div className="session-map-count">
              {tr(
                `${String(allNodes.length)} sessions · ${String(filteredList.length)} shown`,
                `${String(allNodes.length)} 个会话 · 显示 ${String(filteredList.length)}`,
              )}
              {selectedIds.length > 0
                ? tr(
                  ` · ${String(selectedIds.length)} selected`,
                  ` · 已选 ${String(selectedIds.length)}`,
                )
                : ''}
              {busyVisibleCount > 0
                ? tr(` · ${String(busyVisibleCount)} busy`, ` · ${String(busyVisibleCount)} 个忙碌`)
                : ''}
              {(mapDoc.pendingTopology ?? []).length > 0
                ? tr(
                  ` · ${String((mapDoc.pendingTopology ?? []).length)} queued`,
                  ` · ${String((mapDoc.pendingTopology ?? []).length)} 项排队`,
                )
                : ''}
            </div>
          </div>
          <div className="session-map-search-wrap session-map-search-inline">
            <input
              className="session-map-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={tr('Search title / project / members…', '搜索标题 / 项目 / 成员…')}
            />
            {query.trim() !== '' && (
              <button
                type="button"
                className="session-map-search-clear"
                aria-label={tr('Clear search', '清除搜索')}
                onClick={() => setQuery('')}
              >
                ×
              </button>
            )}
          </div>
          {query.trim() !== '' && selectedParentSessionId !== undefined && (
            <div className="session-map-mount-hint">
              {tr(
                'Select a search result → Mount to attach under the selected parent.',
                '在搜索结果上点击「挂载」以挂到当前选中的父节点。',
              )}
            </div>
          )}
          <div className="session-map-toolbar">
            <button
              type="button"
              className={'session-map-tool' + (listOpen ? ' active' : '')}
              onClick={() => setListOpen((open) => !open)}
              title={tr('Toggle session list', '切换会话列表')}
            >
              {tr('List', '列表')}
            </button>
            <button
              type="button"
              className="session-map-tool"
              data-map-action="select-all"
              onClick={() => selectAllVisible()}
            >
              {tr('Select all visible', '全选可见')}
            </button>
            <button
              type="button"
              className="session-map-tool"
              data-map-action="clear-selection"
              disabled={selectedIds.length === 0}
              onClick={() => clearSelection()}
            >
              {tr('Clear selection', '清除选择')}
            </button>
            <div className="session-map-status-filters" role="group" aria-label={tr('Filter by status', '按状态筛选')}>
              {([
                ['running', tr('Running', '运行中')],
                ['error', tr('Error', '出错')],
                ['idle', tr('Idle', '空闲')],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={'session-map-tool' + (statusFilter === value ? ' active' : '')}
                  data-status-filter={value}
                  aria-pressed={statusFilter === value}
                  onClick={() => setStatusFilter((current) => (current === value ? 'all' : value))}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="team-tree-legend">
              <span><i className="tone-running" />{tr('Running', '运行中')}</span>
              <span><i className="tone-attention" />{tr('Working', '工作中')}</span>
              <span><i className="tone-idle" />{tr('Idle', '空闲')}</span>
              <span><i className="tone-waiting" />{tr('Waiting', '等待中')}</span>
              <span><i className="tone-muted" />{tr('Stopped', '已停止')}</span>
              <span><i className="tone-error" />{tr('Error', '错误')}</span>
            </div>
          </div>
          <div className="session-map-float-zoom">
            <button type="button" className="session-map-tool" onClick={rearrange} title={tr('Rearrange (or Alt+double-click empty)', '规整（或 Alt+双击空白）')}>
              {tr('Rearrange', '规整')}
            </button>
            <button type="button" className="session-map-tool" onClick={focusActive} title={tr('Focus', '聚焦')}>
              {tr('Focus', '聚焦')}
            </button>
            <button
              type="button"
              className="session-map-tool session-map-zoom-btn"
              aria-label={tr('Zoom in', '放大')}
              onClick={() => {
                markUserAdjustedView();
                stopFollowFocus();
                const cx = viewportSize.width / 2;
                const cy = viewportSize.height / 2;
                setView(zoomTreeView(view, view.scale * 1.15, cx, cy));
              }}
            >
              +
            </button>
            <button
              type="button"
              className="session-map-tool session-map-zoom-btn"
              aria-label={tr('Zoom out', '缩小')}
              onClick={() => {
                markUserAdjustedView();
                stopFollowFocus();
                const cx = viewportSize.width / 2;
                const cy = viewportSize.height / 2;
                setView(zoomTreeView(view, view.scale / 1.15, cx, cy));
              }}
            >
              −
            </button>
          </div>
        </header>

        <div className="session-map-float session-map-label-bar">
            {mapDoc.labels.map((label) => (
              <button
                key={label.id}
                type="button"
                className={'session-map-label-chip' + (activeLabelIds.includes(label.id) ? ' active' : '')}
                style={{ ['--map-label-color' as string]: label.color }}
                onClick={() => setActiveLabelIds((ids) => (
                  ids.includes(label.id) ? ids.filter((id) => id !== label.id) : [...ids, label.id]
                ))}
              >
                {label.name}
              </button>
            ))}
            <button
              type="button"
              className="session-map-tool session-map-label-add"
              onClick={() => {
                const name = window.prompt(tr('New label name', '新标签名称'));
                if (name === null || !name.trim()) return;
                const color = DEFAULT_ANNOTATION_COLORS[mapDoc.labels.length % DEFAULT_ANNOTATION_COLORS.length]!;
                persistDoc({
                  ...mapDoc,
                  labels: [...mapDoc.labels, { id: newLabelId(), name: name.trim(), color }],
                });
              }}
            >
              {tr('+ Label', '+ 标签')}
            </button>
            {activeLabelIds.length > 0 && (
              <button
                type="button"
                className="session-map-tool"
                onClick={() => setActiveLabelIds([])}
              >
                {tr('Clear filter', '清除筛选')}
              </button>
            )}
        </div>

        {listOpen && (
          <aside className="session-map-float session-map-list-panel" aria-label={tr('Session list', '会话列表')}>
            <div className="session-map-list-scroll">
              {filteredList.length === 0 ? (
                <div className="session-map-list-empty">{tr('No matches', '无匹配')}</div>
              ) : filteredList.map((member) => {
                const id = member.session.id;
                const caps = memberCaps(member);
                const isActive = activeSessionId !== undefined && (
                  id === activeSessionId || member.agent?.mounted_session_id === activeSessionId
                );
                const canMountHere = selectedParentSessionId !== undefined
                  && caps.isRealSession
                  && canMountMemberUnder(
                    id,
                    selectedParentSessionId,
                    allNodes,
                    mapParentByChildFromEdges(mapDoc.edges ?? []),
                  )
                  && parentSessionIdOf(member.session) !== selectedParentSessionId;
                const tierLabel = caps.displayTier === 'member'
                  ? tr('member', '成员')
                  : caps.displayTier === 'mounted'
                    ? tr('mounted', '已挂载')
                    : tr('top-level', '顶层');
                return (
                  <div
                    key={nodeKey(member)}
                    className={'session-map-list-item' + (isActive ? ' active' : '')}
                  >
                    <button
                      type="button"
                      className="session-map-list-main"
                      onClick={() => handleListItemClick(member)}
                      onDoubleClick={() => handleListItemDoubleClick(member)}
                    >
                      <span className="session-map-list-title">
                        <i className={`status-dot ${mapStatusDotClass(caps.status)}`} aria-hidden />
                        {memberLabel(member)}
                      </span>
                      <span className="session-map-list-meta">
                        {tierLabel}
                        {(() => {
                          const cwd = memberProjectCwd(member, byId);
                          return cwd ? ` · ${projectFolderName(cwd)}` : '';
                        })()}
                      </span>
                    </button>
                    <div className="session-map-list-actions">
                      <button
                        type="button"
                        className="session-map-list-action"
                        title={tr('Open chat', '打开对话')}
                        onClick={() => openMember(member)}
                      >
                        {tr('Open', '打开')}
                      </button>
                      {canMountHere && (
                        <button
                          type="button"
                          className="session-map-list-action primary"
                          title={tr('Mount under selected parent', '挂载到选中父节点')}
                          disabled={busy}
                          onClick={() => void mountMemberUnderParent(member, selectedParentSessionId!)}
                        >
                          {tr('Mount', '挂载')}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </aside>
        )}

        {editingAnnotation && (
          <div className="session-map-float session-map-note-editor">
            <label>
              {tr('Note title', '注释标题')}
              <input
                autoFocus
                value={editingAnnotation.title}
                onChange={(event) => updateAnnotation(editingAnnotation.id, { title: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    setEditingAnnotationId(null);
                  }
                }}
              />
            </label>
            <div className="session-map-note-colors" role="group" aria-label={tr('Note color', '注释颜色')}>
              {DEFAULT_ANNOTATION_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={'session-map-note-color' + (editingAnnotation.color === color ? ' active' : '')}
                  style={{ background: color }}
                  aria-label={color}
                  onClick={() => updateAnnotation(editingAnnotation.id, { color })}
                />
              ))}
            </div>
            <button
              type="button"
              className={'session-map-tool' + (bindAnnotationId === editingAnnotation.id ? ' active' : '')}
              onClick={() => setBindAnnotationId((id) => (id === editingAnnotation.id ? null : editingAnnotation.id))}
            >
              {tr('Bind nodes', '绑定节点')}
            </button>
            <button type="button" className="session-map-tool" onClick={() => removeAnnotation(editingAnnotation.id)}>
              {tr('Delete note', '删除注释')}
            </button>
            <button type="button" className="session-map-tool" onClick={() => setEditingAnnotationId(null)}>
              {tr('Done', '完成')}
            </button>
          </div>
        )}

        <span className="session-map-float session-map-hint">
          {bindAnnotationId
            ? tr('Click nodes to soft-bind / unbind this note', '点击节点软绑定/解绑此注释框')
            : wireDrag !== null
              ? wireDrag.edgeType === 'peer'
                ? tr('Drop on a session card to create a peer link (local, not a mount)', '放到会话卡片上创建对等连线（仅本地，不是挂载）')
                : wireDrag.edgeType === 'service'
                  ? tr('Drop on a session card to create a service link (local, not a mount)', '放到会话卡片上创建服务连线（仅本地，不是挂载）')
                  : wireDrag.side === 'in'
                    ? tr('Drop on a parent card / output port to reconnect', '放到父卡片或输出口上重连')
                    : tr('Drop on a card / input port to link, or empty canvas for a new child', '放到卡片/输入口直接挂载，或空白处新建子节点')
              : draft !== null
                ? tr('Edit identity on the canvas · Esc cancels', '在画布上编辑身份 · Esc 取消')
                : tr('Right-click new session · right-drag pan · Shift+drag peer · Alt+drag service · Alt+click IN to disconnect', '右键新建会话 · 右键拖动画布 · Shift 对等连线 · Alt 服务连线 · Alt+点击输入口断连')}
        </span>

        {(mapDoc.pendingTopology ?? []).length > 0 && (
          <div className="session-map-float session-map-queued-banner" role="status">
            {tr(
              `${String((mapDoc.pendingTopology ?? []).length)} topology change(s) waiting for idle sessions.`,
              `${String((mapDoc.pendingTopology ?? []).length)} 项拓扑变更正在等待会话空闲。`,
            )}
          </div>
        )}

        {selectedIds.length > 0 && (
          <div className="session-map-float session-map-selection-toolbar" role="toolbar">
            <span className="session-map-selection-count">
              {tr(
                `${String(selectedIds.length)} selected`,
                `已选 ${String(selectedIds.length)}`,
              )}
            </span>
            <button type="button" className="session-map-tool" data-map-action="open" disabled={busy} onClick={() => openSelectedSession()}>
              {tr('Open', '打开')}
            </button>
            <button type="button" className="session-map-tool" data-map-action="stop" disabled={busy} onClick={() => void abortSelectedSessions()}>
              {tr('Stop', '停止')}
            </button>
            <button
              type="button"
              className="session-map-tool"
              data-map-action="child"
              disabled={busy || selectedIds.length !== 1}
              onClick={() => {
                const id = selectedIds[0];
                if (id !== undefined) createChildForSession(id);
              }}
            >
              {tr('Child', '子会话')}
            </button>
            <button
              type="button"
              className="session-map-tool"
              data-map-action="settings"
              disabled={busy || selectedIds.length !== 1}
              onClick={() => {
                const id = selectedIds[0];
                if (id !== undefined) openIdentityForSession(id);
              }}
            >
              {tr('Settings', '设置')}
            </button>
            <div className="session-map-tag-menu">
              <button
                type="button"
                className="session-map-tool"
                data-map-action="tags"
                disabled={busy}
                onClick={() => setTagMenuOpen((open) => !open)}
              >
                {tr('Tags', '标签')}
              </button>
              {tagMenuOpen && (
                <div className="session-map-tag-menu-list" role="menu">
                  {mapDoc.labels.map((label) => (
                    <div key={label.id}>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => applyMapLabelToSelected(label.id, true)}
                      >
                        {tr(`Add “${label.name}”`, `打上「${label.name}」`)}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => applyMapLabelToSelected(label.id, false)}
                      >
                        {tr(`Remove “${label.name}”`, `去掉「${label.name}」`)}
                      </button>
                    </div>
                  ))}
                  <button type="button" role="menuitem" onClick={() => void applyIdentityTagToSelected('add')}>
                    {tr('Add identity tag…', '添加身份标签…')}
                  </button>
                  <button type="button" role="menuitem" onClick={() => void applyIdentityTagToSelected('remove')}>
                    {tr('Remove identity tag…', '移除身份标签…')}
                  </button>
                </div>
              )}
            </div>
            <button type="button" className="session-map-tool" data-map-action="unmount" disabled={busy} onClick={() => void unmountSelectedSessions()}>
              {tr('Unmount', '拆挂')}
            </button>
            <button type="button" className="session-map-tool danger" data-map-action="delete" disabled={busy} onClick={() => void deleteSelectedSessions()}>
              {tr('Delete', '删除')}
            </button>
            <button type="button" className="session-map-tool" onClick={() => clearSelection()}>
              {tr('Clear', '清除')}
            </button>
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

        {selectionMenu !== null && (
          <div
            className="session-map-context-menu session-map-float"
            style={{ left: selectionMenu.x, top: selectionMenu.y }}
            role="menu"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => annotateSelection()}
            >
              {tr('Annotate', '注释')}
            </button>
            {selectedIds.length > 0 && (
              <>
                <button type="button" role="menuitem" disabled={busy} onClick={() => openSelectedSession()}>
                  {tr('Open', '打开')}
                </button>
                <button type="button" role="menuitem" disabled={busy} onClick={() => void abortSelectedSessions()}>
                  {tr('Stop', '停止')}
                </button>
                {selectedIds.length === 1 && (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={busy}
                      onClick={() => {
                        const id = selectedIds[0];
                        if (id !== undefined) createChildForSession(id);
                      }}
                    >
                      {tr('New child session', '新建子会话')}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        const id = selectedIds[0];
                        if (id !== undefined) openIdentityForSession(id);
                      }}
                    >
                      {tr('Session settings…', '会话设置…')}
                    </button>
                  </>
                )}
                {mapDoc.labels.map((label) => (
                  <div key={label.id}>
                    <button type="button" role="menuitem" onClick={() => applyMapLabelToSelected(label.id, true)}>
                      {tr(`Add label “${label.name}”`, `打上标签「${label.name}」`)}
                    </button>
                    <button type="button" role="menuitem" onClick={() => applyMapLabelToSelected(label.id, false)}>
                      {tr(`Remove label “${label.name}”`, `去掉标签「${label.name}」`)}
                    </button>
                  </div>
                ))}
                <button type="button" role="menuitem" onClick={() => void applyIdentityTagToSelected('add')}>
                  {tr('Add identity tag…', '添加身份标签…')}
                </button>
                <button type="button" role="menuitem" onClick={() => void applyIdentityTagToSelected('remove')}>
                  {tr('Remove identity tag…', '移除身份标签…')}
                </button>
                <button type="button" role="menuitem" disabled={busy} onClick={() => void unmountSelectedSessions()}>
                  {tr('Unmount', '拆挂')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="danger"
                  disabled={busy}
                  onClick={() => void deleteSelectedSessions()}
                >
                  {tr(`Delete (${String(selectedIds.length)})`, `删除 (${String(selectedIds.length)})`)}
                </button>
                <button type="button" role="menuitem" onClick={() => clearSelection()}>
                  {tr('Clear selection', '清除选择')}
                </button>
              </>
            )}
          </div>
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
              disabled={busy}
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
              {tr('New child session', '新建子会话')}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => {
                const node = forceNodesRef.current.find((candidate) => (
                  candidate.member.session.id === nodeMenu.sessionId
                ));
                if (node !== undefined) openMember(node.member);
                setNodeMenu(null);
              }}
            >
              {tr('Open chat', '打开对话')}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => {
                const node = forceNodesRef.current.find((candidate) => (
                  candidate.member.session.id === nodeMenu.sessionId
                ));
                if (node !== undefined) void abortSessionMember(node.member).then(() => refresh());
                setNodeMenu(null);
              }}
            >
              {tr('Stop', '停止')}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => openIdentityForSession(nodeMenu.sessionId)}
            >
              {tr('Session settings…', '会话设置…')}
            </button>
            {nodeMenu.canSelfBootstrapRole && (
              <button
                type="button"
                role="menuitem"
                onClick={() => promptSelfBootstrapRole(nodeMenu.sessionId)}
              >
                {tr('Set self-bootstrap role…', '设置自举角色…')}
              </button>
            )}
            {nodeMenu.canUnmount && (
              <button
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={() => confirmUnmountSession(nodeMenu.sessionId, nodeMenu.label)}
              >
                {tr('Unmount to top-level', '拆挂升顶层')}
              </button>
            )}
            {mapDoc.labels.map((label) => {
              const assigned = (mapDoc.sessionLabels[nodeMenu.sessionId] ?? []).includes(label.id);
              return (
                <button
                  key={label.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    persistDoc(toggleSessionLabel(mapDoc, nodeMenu.sessionId, label.id));
                    setNodeMenu(null);
                  }}
                >
                  {assigned
                    ? tr(`Remove label “${label.name}”`, `移除标签「${label.name}」`)
                    : tr(`Add label “${label.name}”`, `添加标签「${label.name}」`)}
                </button>
              );
            })}
            <button type="button" role="menuitem" onClick={() => void applyIdentityTagToSelected('add')}>
              {tr('Add identity tag…', '添加身份标签…')}
            </button>
            <button type="button" role="menuitem" onClick={() => void applyIdentityTagToSelected('remove')}>
              {tr('Remove identity tag…', '移除身份标签…')}
            </button>
            <button
              type="button"
              role="menuitem"
              className="danger"
              disabled={busy}
              onClick={() => void deleteSession(nodeMenu.sessionId)}
            >
              {tr('Delete session…', '删除会话…')}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => setNodeMenu(null)}
            >
              {tr('Cancel', '取消')}
            </button>
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
              disabled={busy}
              onClick={() => void createSessionNodeAt(canvasMenu.worldX, canvasMenu.worldY)}
            >
              {tr('New session here', '在此新建会话')}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => setCanvasMenu(null)}
            >
              {tr('Cancel', '取消')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
