/**
 * Conversation map: mount forest + TeamCreate members (agent dual-write).
 * Full-bleed blueprint canvas with d3-force layout; members open through host agents.
 */

import {
  forceCollide,
  forceLink,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
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
import { completeMountIdentityFromPrompt } from './mountIdentityComplete';
import {
  annotationBounds,
  DEFAULT_ANNOTATION_COLORS,
  loadSessionMapDoc,
  newAnnotationId,
  saveSessionMapDoc,
  type MapAnnotationBox,
  type SessionMapDoc,
} from './sessionMapDoc';

const NODE_W = 220;
const NODE_H = 96;
const GAP_X = 36;
const GAP_Y = 64;
const CANVAS_PAD = 48;
const MIN_SCALE = 0.55;
const MAX_SCALE = 2.5;
/** Allow fit to slightly enlarge small forests so they fill the viewport. */
const FIT_MAX_SCALE = 1.35;
/** Soft collide settle after drag — NEVER continuous home-slot gravity. */
const SETTLE_ALPHA = 0.12;
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
const COLLIDE_RADIUS = Math.min(NODE_W, NODE_H) / 2 + 8;
const LINK_DISTANCE = NODE_H + GAP_Y;
/** Weak links — structure is mount topology, positions are user-owned. */
const LINK_STRENGTH = 0.015;
/**
 * Ambient home-slot gravity MUST stay off. Rearrange may apply a one-shot
 * pull toward layout seeds, then clear it and pin nodes where they settled.
 */
export const HOME_PULL_STRENGTH = 0;
/** Sentinel for tests — ambient simulation must never register continuous home forces. */
export const SESSION_MAP_AMBIENT_HOME_GRAVITY = false;
const REARRANGE_HOME_STRENGTH = 0.9;
const REARRANGE_LINK_STRENGTH = 0.01;
/** Generous UE-style port hit radius (world units). */
const PORT_HIT_RADIUS = 36;
/** Snap / near-miss feedback when the drop barely misses a valid port. */
const NEAR_MISS_RADIUS = 56;
const BODY_PORT_SLOP = 8;
/** Non-sticky errors auto-dismiss; mount failures stay until dismissed. */
const ERROR_AUTO_DISMISS_MS = 6_500;
const HINT_AUTO_DISMISS_MS = 2_800;
/** Left floating list — focus uses optical center of free canvas. */
const FOCUS_INSET_TOP = 72;
const FOCUS_INSET_BOTTOM = 36;

/** Floating chrome insets (side list removed — search lives in the top bar). */
function focusInsetForViewport(_width: number): { left: number; top: number; bottom: number } {
  return {
    left: 16,
    top: FOCUS_INSET_TOP,
    bottom: FOCUS_INSET_BOTTOM,
  };
}

export interface TreeView {
  x: number;
  y: number;
  scale: number;
}

export function fitTreeView(content: { width: number; height: number }, viewport: { width: number; height: number }): TreeView {
  if (viewport.width <= 0 || viewport.height <= 0 || content.width <= 0 || content.height <= 0) {
    return { x: 0, y: 0, scale: 1 };
  }
  const margin = 32;
  const scale = Math.max(
    MIN_SCALE,
    Math.min(
      FIT_MAX_SCALE,
      (viewport.width - margin * 2) / content.width,
      (viewport.height - margin * 2) / content.height,
    ),
  );
  const scaledWidth = content.width * scale;
  const scaledHeight = content.height * scale;
  return {
    x: (viewport.width - scaledWidth) / 2,
    y: scaledHeight + margin * 2 > viewport.height ? margin : (viewport.height - scaledHeight) / 2,
    scale,
  };
}

export function zoomTreeView(view: TreeView, nextScale: number, centerX: number, centerY: number): TreeView {
  const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, nextScale));
  return {
    scale,
    x: centerX - (centerX - view.x) * (scale / view.scale),
    y: centerY - (centerY - view.y) * (scale / view.scale),
  };
}

export { parentSessionIdOf };

/** Map node: a real session and/or a durable team agent in a parent session. */
export interface MapMemberRef {
  session: Session;
  /** Parent session that owns the team agent (when opening agent-only members). */
  hostSessionId?: string;
  agent?: SessionAgent;
  kind: 'session' | 'agent';
}

interface PlacedNode {
  member: MapMemberRef;
  x: number;
  y: number;
  cx: number;
}

interface ForceMapNode extends SimulationNodeDatum {
  id: string;
  member: MapMemberRef;
}

interface ForceMapLink extends SimulationLinkDatum<ForceMapNode> {
  source: string | ForceMapNode;
  target: string | ForceMapNode;
}

function sessionLabel(session: Session): string {
  const title = session.title?.trim();
  return title || session.id;
}

function memberLabel(member: MapMemberRef): string {
  if (member.agent !== undefined) return sessionAgentDisplayName(member.agent);
  return sessionLabel(member.session);
}

function memberRole(member: MapMemberRef): string | undefined {
  if (typeof member.agent?.role === 'string' && member.agent.role.trim()) return member.agent.role;
  const mountRole = member.session.metadata?.mount_role;
  return typeof mountRole === 'string' && mountRole.trim() ? mountRole : undefined;
}

function ensureGraphEdges(graph: SessionGraph): SessionGraph {
  if (graph.edges.length > 0) return graph;
  const idSet = new Set(graph.nodes.map((node) => node.id));
  const edges: SessionGraph['edges'] = [];
  for (const node of graph.nodes) {
    const parentId = parentSessionIdOf(node);
    if (parentId !== undefined && idSet.has(parentId)) {
      edges.push({ child_session_id: node.id, parent_session_id: parentId });
    }
  }
  return { nodes: graph.nodes, edges };
}

/**
 * Forest layout: top-level sessions are roots; mounted children hang under parents.
 * Extra agent-only members (no dual-write session yet) hang under their host root.
 */
export function layoutSessionMountForest(
  graph: SessionGraph,
  agentExtras: readonly MapMemberRef[] = [],
): {
  placed: PlacedNode[];
  edges: Array<{ from: PlacedNode; to: PlacedNode }>;
  width: number;
  height: number;
} {
  const normalized = ensureGraphEdges(graph);
  const byId = new Map(normalized.nodes.map((node) => [node.id, node]));
  const children = new Map<string, string[]>();

  for (const edge of normalized.edges) {
    if (!byId.has(edge.child_session_id) || !byId.has(edge.parent_session_id)) continue;
    const list = children.get(edge.parent_session_id) ?? [];
    list.push(edge.child_session_id);
    children.set(edge.parent_session_id, list);
  }

  const agentByHost = new Map<string, MapMemberRef[]>();
  const agentsByMountedSession = new Map<string, MapMemberRef[]>();
  for (const extra of agentExtras) {
    const mounted = extra.agent?.mounted_session_id;
    if (mounted !== undefined) {
      const linked = agentsByMountedSession.get(mounted) ?? [];
      linked.push(extra);
      agentsByMountedSession.set(mounted, linked);
    }
    const hostId = extra.hostSessionId;
    if (hostId === undefined || !byId.has(hostId)) continue;
    const mountedNode = mounted === undefined ? undefined : byId.get(mounted);
    const correctlyLinked = mountedNode !== undefined && parentSessionIdOf(mountedNode) === hostId;
    if (mounted !== undefined && correctlyLinked) continue;
    const list = agentByHost.get(hostId) ?? [];
    list.push(extra);
    agentByHost.set(hostId, list);
  }

  const sessionMember = (session: Session): MapMemberRef => {
    const parentId = parentSessionIdOf(session);
    const linkedAgent = parentId === undefined
      ? undefined
      : agentsByMountedSession.get(session.id)?.find((extra) => extra.hostSessionId === parentId);
    return {
      session,
      kind: 'session',
      hostSessionId: linkedAgent?.hostSessionId ?? parentId,
      agent: linkedAgent?.agent,
    };
  };

  for (const list of children.values()) {
    list.sort((a, b) => {
      const left = byId.get(a)!;
      const right = byId.get(b)!;
      return left.updated_at.localeCompare(right.updated_at);
    });
  }

  const roots = [...normalized.nodes]
    .filter((node) => {
      const parentId = parentSessionIdOf(node);
      return parentId === undefined || !byId.has(parentId);
    })
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));

  const placed: PlacedNode[] = [];
  let nextCol = 0;

  const placeSession = (session: Session, depth: number): { left: number; right: number; node: PlacedNode } => {
    const childIds = children.get(session.id) ?? [];
    const extras = agentByHost.get(session.id) ?? [];
    if (childIds.length === 0 && extras.length === 0) {
      const col = nextCol++;
      const x = CANVAS_PAD + col * (NODE_W + GAP_X);
      const y = CANVAS_PAD + depth * (NODE_H + GAP_Y);
      const node: PlacedNode = {
        member: sessionMember(session),
        x,
        y,
        cx: x + NODE_W / 2,
      };
      placed.push(node);
      return { left: col, right: col, node };
    }

    const childLayouts = [
      ...childIds.map((id) => placeSession(byId.get(id)!, depth + 1)),
      ...extras.map((extra) => {
        const col = nextCol++;
        const x = CANVAS_PAD + col * (NODE_W + GAP_X);
        const y = CANVAS_PAD + (depth + 1) * (NODE_H + GAP_Y);
        const node: PlacedNode = { member: extra, x, y, cx: x + NODE_W / 2 };
        placed.push(node);
        return { left: col, right: col, node };
      }),
    ];
    const left = childLayouts[0]!.left;
    const right = childLayouts.at(-1)!.right;
    const cx = ((left + right) / 2) * (NODE_W + GAP_X) + CANVAS_PAD + NODE_W / 2;
    const x = cx - NODE_W / 2;
    const y = CANVAS_PAD + depth * (NODE_H + GAP_Y);
    const node: PlacedNode = {
      member: sessionMember(session),
      x,
      y,
      cx,
    };
    placed.push(node);
    return { left, right, node };
  };

  let forestOffset = 0;
  for (const root of roots) {
    nextCol = forestOffset;
    placeSession(root, 0);
    forestOffset = nextCol + 1;
  }

  const byKey = new Map(placed.map((node) => [nodeKey(node.member), node]));
  const edges: Array<{ from: PlacedNode; to: PlacedNode }> = [];
  for (const edge of normalized.edges) {
    const from = byKey.get(`session:${edge.parent_session_id}`);
    const to = byKey.get(`session:${edge.child_session_id}`);
    if (from && to) edges.push({ from, to });
  }
  for (const [hostId, extras] of agentByHost) {
    const from = byKey.get(`session:${hostId}`);
    if (!from) continue;
    for (const extra of extras) {
      const to = byKey.get(nodeKey(extra));
      if (to) edges.push({ from, to });
    }
  }

  const width = Math.max(NODE_W + CANVAS_PAD * 2, ...placed.map((n) => n.x + NODE_W + CANVAS_PAD), 1);
  const height = Math.max(NODE_H + CANVAS_PAD * 2, ...placed.map((n) => n.y + NODE_H + CANVAS_PAD), 1);
  return { placed, edges, width, height };
}

function nodeKey(member: MapMemberRef): string {
  if (member.kind === 'agent' && member.agent !== undefined && member.hostSessionId !== undefined) {
    return `agent:${member.hostSessionId}:${member.agent.agent_id}`;
  }
  return `session:${member.session.id}`;
}

/**
 * Real session id that owns an OUT/IN wire.
 * Must be captured at pointerdown — never re-derive from activeSessionId.
 * Agent ghosts (kind==='agent' or synthetic `agent:…` ids) are never wireable,
 * even when metadata still carries a stale mounted_session_id UUID.
 */
export function wireSourceParentSessionId(member: MapMemberRef): string | null {
  if (member.kind === 'agent') return null;
  const id = member.session.id.trim();
  if (id.length === 0 || id.startsWith('agent:')) return null;
  return id;
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

/** Whether dropping a wire onto `target` is a legal mount/reconnect. */
export function isValidWireTarget(
  wire: Pick<WireDragState, 'side' | 'parentSessionId' | 'childSessionId' | 'fromId'>,
  target: ForceMapNode,
  nodes: readonly Session[],
): boolean {
  if (target.id === wire.fromId) return false;
  if (target.member.kind !== 'session' || target.member.session.id.startsWith('agent:')) return false;
  const targetId = target.member.session.id;
  if (wire.side === 'out') {
    const parentId = wire.parentSessionId;
    if (targetId === parentId) return false;
    return !wouldCreateMountCycle(targetId, parentId, nodes);
  }
  const childId = wire.childSessionId;
  if (targetId === childId) return false;
  return !wouldCreateMountCycle(childId, targetId, nodes);
}

/** Nearest legal port/body for rubber-band snap while dragging or near-miss on drop. */
export function findNearestValidWireTarget(
  forceNodes: ReadonlyArray<ForceMapNode>,
  worldX: number,
  worldY: number,
  wire: Pick<WireDragState, 'side' | 'parentSessionId' | 'childSessionId' | 'fromId'>,
  nodes: readonly Session[],
  maxDistance = NEAR_MISS_RADIUS,
): { node: ForceMapNode; portX: number; portY: number; distance: number } | undefined {
  const preferPort = wire.side === 'out' ? 'in' : 'out';
  let best: { node: ForceMapNode; portX: number; portY: number; distance: number } | undefined;
  for (const node of forceNodes) {
    if (!isValidWireTarget(wire, node, nodes)) continue;
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
  onOpenAgent,
  onGraphChanged,
}: {
  sessions: readonly Session[];
  activeSessionId?: string;
  onOpenSession: (sessionId: string) => void;
  /** Open a durable team agent inside its host session (legacy / agent-only members). */
  onOpenAgent?: (hostSessionId: string, agent: SessionAgent) => void;
  onGraphChanged?: () => void;
}) {
  const { tr } = useI18n();
  const [graph, setGraph] = useState<SessionGraph | null>(null);
  const [agentExtras, setAgentExtras] = useState<MapMemberRef[]>([]);
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
  const [noteMode, setNoteMode] = useState(false);
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const [bindAnnotationId, setBindAnnotationId] = useState<string | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [forceNodes, setForceNodes] = useState<ForceMapNode[]>([]);
  const [forceLinks, setForceLinks] = useState<ForceMapLink[]>([]);
  const [nodeMenu, setNodeMenu] = useState<NodeContextMenu | null>(null);
  const [marquee, setMarquee] = useState<MarqueeState | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const forceNodesRef = useRef(forceNodes);
  forceNodesRef.current = forceNodes;
  const [, redraw] = useState(0);

  const viewportRef = useRef<HTMLDivElement>(null);
  const panOrigin = useRef<{ x: number; y: number; view: TreeView } | null>(null);
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
  const simulationRef = useRef<Simulation<ForceMapNode, ForceMapLink> | null>(null);
  const positionsRef = useRef(new Map<string, { x: number; y: number }>());
  const topologyKeyRef = useRef('');
  const seedByIdRef = useRef(new Map<string, { x: number; y: number }>());
  const dragRef = useRef<{
    node: ForceMapNode;
    startX: number;
    startY: number;
    moved: boolean;
    pinned: boolean;
  } | null>(null);
  const marqueeRef = useRef<MarqueeState | null>(null);
  /** When true, finishing the marquee persists a note; Shift-only select leaves this false. */
  const marqueeCreatesNoteRef = useRef(false);
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
      // Invalidate in-flight refreshes so late responses never setState post-unmount.
      refreshRevision.current += 1;
    };
  }, [detachWireListeners]);

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

  // Losing window focus mid-gesture (alt-tab, release outside the window)
  // leaves no pointerup — tear every gesture down so no state gets stuck.
  useEffect(() => {
    const onBlur = () => {
      cancelWireDrag();
      dragRef.current = null;
      panOrigin.current = null;
      setPanning(false);
      if (marqueeRef.current !== null) {
        marqueeRef.current = null;
        marqueeCreatesNoteRef.current = false;
        setMarquee(null);
      }
    };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [cancelWireDrag]);

  // Escape: cancel wire → cancel in-progress marquee → cancel draft → dismiss menus/editors/selection.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target;
      if (target instanceof HTMLElement
        && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      if (wireDragRef.current !== null) {
        cancelWireDrag();
        return;
      }
      if (marqueeRef.current !== null) {
        marqueeRef.current = null;
        marqueeCreatesNoteRef.current = false;
        setMarquee(null);
        return;
      }
      if (draftRef.current !== null) {
        cancelDraftRef.current();
        return;
      }
      setNodeMenu(null);
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

  const refreshAgents = useCallback(async (nodes: readonly Session[]): Promise<MapMemberRef[]> => {
    const focusIds = new Set(nodes.map((node) => node.id));
    if (activeSessionId) focusIds.add(activeSessionId);
    const extras: MapMemberRef[] = [];
    const agentErrors: string[] = [];
    await Promise.all([...focusIds].map(async (hostId) => {
      try {
        const result = await api.sessions.getAgents(hostId);
        for (const agent of result.items ?? []) {
          if (agent.kind !== 'team' || agent.archived) continue;
          const mountedId = agent.mounted_session_id;
          const mountedSession = mountedId
            ? nodes.find((node) => node.id === mountedId && parentSessionIdOf(node) === hostId)
            : undefined;
          // Ghosts must NEVER reuse a real mounted_session_id UUID as session.id —
          // that would make wireSourceParentSessionId treat them as wireable parents.
          const ghostId = `agent:${hostId}:${agent.agent_id}`;
          extras.push({
            kind: mountedSession !== undefined ? 'session' : 'agent',
            session: mountedSession ?? {
              id: ghostId,
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
  }, [activeSessionId, showError, tr]);

  const refresh = useCallback(async () => {
    // Poll/mutation refreshes must never stomp an open identity draft or an
    // in-flight wire/node drag — graph data would shift nodes mid-gesture.
    if (draftRef.current !== null || wireDragRef.current !== null || dragRef.current !== null) {
      return;
    }
    const revision = ++refreshRevision.current;
    try {
      const next = ensureGraphEdges(await api.sessions.getGraph({ exclude_empty: false }));
      const extras = await refreshAgents(next.nodes);
      if (disposedRef.current || revision !== refreshRevision.current) return;
      setGraph(next);
      setAgentExtras(extras);
    } catch (err) {
      if (disposedRef.current || revision !== refreshRevision.current) return;
      showError(err instanceof Error ? err.message : String(err));
      // Fall back to sidebar sessions + metadata edges so hierarchy still renders.
      const fallback = ensureGraphEdges({ nodes: [...sessions], edges: [] });
      const extras = await refreshAgents(fallback.nodes);
      if (disposedRef.current || revision !== refreshRevision.current) return;
      setGraph(fallback);
      setAgentExtras(extras);
    }
  }, [refreshAgents, sessions, showError]);

  useEffect(() => {
    void refresh();
  }, [refresh, sessions]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refresh();
    }, 4_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

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

  const refreshAgentOverlay = useCallback(async (): Promise<MapMemberRef[]> => {
    const extras = await refreshAgents(allNodes);
    setAgentExtras(extras);
    return extras;
  }, [allNodes, refreshAgents]);

  const openMember = useCallback((member: MapMemberRef) => {
    const parentId = parentSessionIdOf(member.session) ?? member.hostSessionId;
    if (parentId !== undefined) {
      void (async () => {
        try {
          const extras = await refreshAgentOverlay();
          const linked = extras.find((extra) => (
            extra.hostSessionId === parentId
            && extra.agent?.agent_id === member.agent?.agent_id
            && (
              member.agent?.mounted_session_id === undefined
              || extra.agent?.mounted_session_id === member.agent.mounted_session_id
            )
          )) ?? extras.find((extra) => (
            extra.hostSessionId === parentId
            && extra.agent?.mounted_session_id === member.session.id
          ));
          if (linked?.agent === undefined) {
            showError(tr(
              'This mounted team member is no longer available.',
              '这个已挂载团队成员已不可用。',
            ));
            return;
          }
          if (onOpenAgent === undefined) {
            showError(tr(
              'This team member can only be opened from its owning session.',
              '团队成员只能从所属会话中打开。',
            ));
            return;
          }
          if (disposedRef.current) return;
          clearError();
          onOpenAgent(parentId, linked.agent);
        } catch (openError) {
          if (disposedRef.current) return;
          showError(openError instanceof Error ? openError.message : String(openError));
        }
      })();
      return;
    }
    onOpenSession(member.session.id);
  }, [clearError, onOpenAgent, onOpenSession, refreshAgentOverlay, showError, tr]);

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
    const agentOnly = agentExtras.filter((extra) => {
      const mounted = extra.agent?.mounted_session_id;
      if (mounted === undefined) return true;
      const mountedSession = byId.get(mounted);
      return mountedSession === undefined || parentSessionIdOf(mountedSession) !== extra.hostSessionId;
    });
    return [...sessionMembers, ...agentOnly];
  }, [agentExtras, allNodes, byId]);

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
          : member.agent?.mandate ?? ''
      ).toLowerCase();
      return title.includes(q)
        || prompt.includes(q)
        || sessionId.toLowerCase().includes(q)
        || role.includes(q)
        || mandate.includes(q)
        || (member.agent?.agent_id ?? '').toLowerCase().includes(q);
    });
  }, [listMembers, query]);

  const visibleIds = useMemo(() => new Set(filteredList.map((member) => nodeKey(member))), [filteredList]);

  const treeLayout = useMemo(() => {
    const base = layoutSessionMountForest(
      graph ?? { nodes: [...sessions], edges: [] },
      agentExtras,
    );
    if (query.trim() === '') return base;
    const placed = base.placed.filter((node) => visibleIds.has(nodeKey(node.member)));
    const edges = base.edges.filter(({ from, to }) => (
      visibleIds.has(nodeKey(from.member)) && visibleIds.has(nodeKey(to.member))
    ));
    return { ...base, placed, edges };
  }, [graph, sessions, agentExtras, query, visibleIds]);

  const topologyKey = useMemo(() => {
    const nodePart = treeLayout.placed.map((node) => nodeKey(node.member)).sort().join('\0');
    const edgePart = treeLayout.edges
      .map(({ from, to }) => `${nodeKey(from.member)}->${nodeKey(to.member)}`)
      .sort()
      .join('\0');
    return `${nodePart}\u0001${edgePart}`;
  }, [treeLayout]);

  // Rebuild force graph when mount topology / filter set changes; seed from tree layout.
  useEffect(() => {
    if (topologyKeyRef.current === topologyKey) return;
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

    const nodes: ForceMapNode[] = treeLayout.placed.map((placed) => {
      const id = nodeKey(placed.member);
      const remembered = positionsRef.current.get(id);
      const seed = seeds.get(id)!;
      const x = remembered?.x ?? seed.x;
      const y = remembered?.y ?? seed.y;
      return {
        id,
        member: placed.member,
        x,
        y,
        // Keep user-placed cards pinned so collide/link cannot yank them home.
        fx: remembered !== undefined ? remembered.x : null,
        fy: remembered !== undefined ? remembered.y : null,
      };
    });
    const links: ForceMapLink[] = treeLayout.edges.map(({ from, to }) => ({
      source: nodeKey(from.member),
      target: nodeKey(to.member),
    }));
    setForceNodes(nodes);
    setForceLinks(links);
  }, [topologyKey, treeLayout]);

  // Soft collide + weak links only. NO continuous forceX/forceY toward tree slots.
  useEffect(() => {
    simulationRef.current?.stop();
    if (forceNodes.length === 0) {
      simulationRef.current = null;
      return;
    }

    const simulation = forceSimulation(forceNodes)
      .force(
        'link',
        forceLink<ForceMapNode, ForceMapLink>(forceLinks)
          .id((node) => node.id)
          .distance(LINK_DISTANCE)
          .strength(LINK_STRENGTH),
      )
      .force('collision', forceCollide<ForceMapNode>().radius(COLLIDE_RADIUS).strength(0.55))
      .alphaTarget(0)
      .alphaDecay(0.05)
      .velocityDecay(0.65)
      .on('tick', () => {
        for (const node of forceNodes) {
          positionsRef.current.set(node.id, {
            x: node.x ?? 0,
            y: node.y ?? 0,
          });
        }
        redraw((value) => value + 1);
      })
      .on('end', () => {
        // Simulation came to rest — settle positions are user-owned state and
        // must survive reload, not just explicit drags.
        persistPositions(positionsRef.current);
      });
    simulationRef.current = simulation;
    return () => {
      simulation.stop();
    };
  }, [forceNodes, forceLinks, persistPositions]);

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
      focusInsetForViewport(width),
    ));
    return true;
  }, [viewportSize.height, viewportSize.width]);

  const findActiveForceNode = useCallback((sessionId: string | undefined): ForceMapNode | undefined => {
    if (sessionId === undefined) return undefined;
    return forceNodesRef.current.find((node) => (
      node.member.session.id === sessionId
      || node.member.agent?.mounted_session_id === sessionId
    ));
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
    if (rearrangeTimerRef.current !== null) {
      window.clearTimeout(rearrangeTimerRef.current);
      rearrangeTimerRef.current = null;
    }
    rearrangeGenerationRef.current += 1;
  }, [stopFollowFocus]);

  const rearrange = useCallback(() => {
    // One-shot tidy toward tree seeds — then CLEAR home forces and pin where settled.
    // Continuous ambient home-pull is forbidden (users must be able to change structure).
    const seeds = new Map<string, { x: number; y: number }>();
    for (const placed of treeLayout.placed) {
      seeds.set(nodeKey(placed.member), {
        x: placed.x + NODE_W / 2,
        y: placed.y + NODE_H / 2,
      });
    }
    seedByIdRef.current = seeds;

    for (const node of forceNodes) {
      node.fx = null;
      node.fy = null;
      node.vx = (node.vx ?? 0) * 0.15;
      node.vy = (node.vy ?? 0) * 0.15;
    }

    const simulation = simulationRef.current;
    const homeX = (node: ForceMapNode): number => seedByIdRef.current.get(node.id)?.x ?? node.x ?? 0;
    const homeY = (node: ForceMapNode): number => seedByIdRef.current.get(node.id)?.y ?? node.y ?? 0;
    simulation?.force('homeX', forceX<ForceMapNode>(homeX).strength(REARRANGE_HOME_STRENGTH));
    simulation?.force('homeY', forceY<ForceMapNode>(homeY).strength(REARRANGE_HOME_STRENGTH));
    const linkForce = simulation?.force('link') as ReturnType<typeof forceLink<ForceMapNode, ForceMapLink>> | undefined;
    linkForce?.strength(REARRANGE_LINK_STRENGTH);
    simulation?.alphaTarget(0).alpha(1).restart();

    if (rearrangeTimerRef.current !== null) {
      window.clearTimeout(rearrangeTimerRef.current);
      rearrangeTimerRef.current = null;
    }
    const generation = ++rearrangeGenerationRef.current;
    rearrangeTimerRef.current = window.setTimeout(() => {
      rearrangeTimerRef.current = null;
      if (generation !== rearrangeGenerationRef.current) return;
      if (simulationRef.current !== simulation) return; // topology rebuilt — dead sim
      // Kill one-shot home gravity completely — pin cards at settled slots.
      simulation?.force('homeX', null);
      simulation?.force('homeY', null);
      linkForce?.strength(LINK_STRENGTH);
      for (const node of forceNodes) {
        const x = node.x ?? homeX(node);
        const y = node.y ?? homeY(node);
        node.x = x;
        node.y = y;
        node.fx = x;
        node.fy = y;
        positionsRef.current.set(node.id, { x, y });
      }
      persistPositions(positionsRef.current);
      simulation?.alpha(0).alphaTarget(0);
      redraw((value) => value + 1);
    }, 850);

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
    forceNodes,
    persistPositions,
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
    markUserAdjustedView();
    stopFollowFocus();
    const current = viewRef.current;
    if (event.ctrlKey || event.metaKey) {
      // Pinch gesture / Ctrl+wheel → zoom around the pointer.
      const rect = el.getBoundingClientRect();
      setView(zoomTreeView(
        current,
        current.scale * (event.deltaY < 0 ? 1.1 : 0.9),
        event.clientX - rect.left,
        event.clientY - rect.top,
      ));
      return;
    }
    // Plain wheel / two-finger trackpad scroll → pan (deltaX included).
    const factor = event.deltaMode === 1 ? 32 : 1;
    setView({
      ...current,
      x: current.x - event.deltaX * factor,
      y: current.y - event.deltaY * factor,
    });
  };

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const handler = (event: WheelEvent) => wheelHandlerRef.current(event);
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('.session-map-draft-node') !== null) return;
    if (target.closest('.session-map-context-menu') !== null) return;
    setNodeMenu(null);
    if (draftRef.current !== null) {
      if (target.closest('.session-map-node, .session-map-annotation, .session-map-float') === null) {
        cancelDraftRef.current();
      }
      return;
    }
    if (target.closest('.session-map-node, .session-map-annotation, .session-map-float') !== null) {
      return;
    }
    stopFollowFocus();
    // Notes mode → drag creates a note box. Shift alone → multi-select only (no persist).
    if (noteMode || event.shiftKey) {
      const world = clientToWorld(event.clientX, event.clientY);
      if (world === null) return;
      const next = { startX: world.x, startY: world.y, endX: world.x, endY: world.y };
      marqueeRef.current = next;
      marqueeCreatesNoteRef.current = noteMode;
      setMarquee(next);
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      return;
    }
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    panOrigin.current = { x: event.clientX, y: event.clientY, view: viewRef.current };
    setPanning(true);
    // Clicking empty canvas clears the marquee selection.
    setSelectedIds((ids) => (ids.length > 0 ? [] : ids));
  };

  const executeSilentLink = useCallback(async (childId: string, parentId: string) => {
    const child = allNodes.find((session) => session.id === childId);
    const currentParent = parentSessionIdOf(child);
    if (currentParent === parentId) {
      busyRef.current = false;
      showHint(tr('Already mounted under this parent.', '已挂载在该父节点下。'));
      return;
    }
    if (wouldCreateMountCycle(childId, parentId, allNodes)) {
      busyRef.current = false;
      showError(tr(
        'Cannot mount here — would create a cycle in the session tree.',
        '无法挂载 — 会在会话树中形成环。',
      ), true);
      return;
    }
    setBusyLocked(true);
    clearError();
    try {
      if (currentParent !== undefined) {
        await api.sessions.remount(childId, parentId, {});
      } else {
        await api.sessions.mount(childId, parentId, {});
      }
      if (disposedRef.current) return;
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
  }, [allNodes, clearError, onGraphChanged, refresh, setBusyLocked, showError, showHint, tr]);

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

    if (hit === undefined || (hit !== undefined && !isValidWireTarget(active, hit, allNodes))) {
      const snap = findNearestValidWireTarget(
        forceNodesRef.current,
        worldX,
        worldY,
        active,
        allNodes,
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
      if (!isValidWireTarget(active, hit, allNodes)) {
        busyRef.current = false;
        if (wouldCreateMountCycle(childId, hit.member.session.id, allNodes)) {
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
      await executeSilentLink(childId, parentId);
      return;
    }

    const parentSessionId = active.parentSessionId;
    if (parentSessionId.length === 0 || parentSessionId.startsWith('agent:')) {
      busyRef.current = false;
      return;
    }

    if (hit !== undefined) {
      if (!isValidWireTarget(active, hit, allNodes)) {
        busyRef.current = false;
        if (hit.member.session.id === parentSessionId) {
          showHint(tr('Already mounted under this parent.', '已挂载在该父节点下。'));
        } else if (wouldCreateMountCycle(hit.member.session.id, parentSessionId, allNodes)) {
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
      await executeSilentLink(childId, parentSessionId);
      return;
    }

    // Local identity draft — not a mount mutation.
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
    if (busy || busyRef.current || draft !== null || wireDragRef.current !== null) return;
    // Binding notes and wiring are mutually exclusive — leave bind mode.
    if (bindAnnotationId !== null) setBindAnnotationId(null);

    // Alt+click input port of a mounted child → disconnect (unmount).
    if (side === 'in' && event.altKey) {
      const member = node.member;
      const canUnmount = member.kind === 'session'
        && !member.session.id.startsWith('agent:')
        && parentSessionIdOf(member.session) !== undefined;
      if (!canUnmount) {
        showError(tr(
          'Only mounted session cards can disconnect from the input port.',
          '只有已挂载的会话卡片才能从输入口断连。',
        ));
        return;
      }
      const label = memberLabel(member);
      const confirmed = window.confirm(tr(
        `Disconnect “${label}” from its parent? It becomes a top-level session.`,
        `将「${label}」从父节点拆挂？它会升为顶层会话。`,
      ));
      if (!confirmed) return;
      void unmountSession(member.session.id);
      return;
    }

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
        showError(tr('Open this member as a real session before wiring children.', '请先打开该成员会话再拉线创建子节点。'));
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
    if (wireDragRef.current !== null) return;
    if (marqueeRef.current !== null) {
      const world = clientToWorld(event.clientX, event.clientY);
      if (world === null) return;
      const next = { ...marqueeRef.current, endX: world.x, endY: world.y };
      marqueeRef.current = next;
      setMarquee(next);
      return;
    }
    if (dragRef.current) {
      const drag = dragRef.current;
      drag.moved ||= pointerMovedBeyondClickThreshold(drag, event);
      if (!drag.moved) return;
      // Pin only after real move — prevents click from yanking the card.
      if (!drag.pinned) {
        drag.pinned = true;
        drag.node.fx = drag.node.x;
        drag.node.fy = drag.node.y;
        simulationRef.current?.alpha(SETTLE_ALPHA).restart();
      }
      const world = clientToWorld(event.clientX, event.clientY);
      if (world === null) return;
      drag.node.fx = world.x;
      drag.node.fy = world.y;
      drag.node.x = world.x;
      drag.node.y = world.y;
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
      markUserAdjustedView();
    }
    setView(next);
  };

  const finishMarquee = useCallback(() => {
    const box = marqueeRef.current;
    const createNote = marqueeCreatesNoteRef.current;
    marqueeRef.current = null;
    marqueeCreatesNoteRef.current = false;
    setMarquee(null);
    if (box === null) return;
    const left = Math.min(box.startX, box.endX);
    const right = Math.max(box.startX, box.endX);
    const top = Math.min(box.startY, box.endY);
    const bottom = Math.max(box.startY, box.endY);
    if (right - left < 12 || bottom - top < 12) return;

    const hitIds: string[] = [];
    for (const node of forceNodesRef.current) {
      const cx = node.x ?? 0;
      const cy = node.y ?? 0;
      const sessionId = node.member.session.id;
      if (sessionId.startsWith('agent:') || node.member.kind === 'agent') continue;
      if (cx >= left && cx <= right && cy >= top && cy <= bottom) {
        hitIds.push(sessionId);
      }
    }
    setSelectedIds(hitIds);

    // Shift-only marquee: multi-select without persisting a note.
    // Notes mode marquee: materialize a free annotation rect and open the editor.
    if (!createNote) return;

    const color = DEFAULT_ANNOTATION_COLORS[mapDocRef.current.annotations.length % DEFAULT_ANNOTATION_COLORS.length]!;
    const annotation: MapAnnotationBox = {
      id: newAnnotationId(),
      title: tr('Note', '注释'),
      color,
      nodeIds: [],
      rect: {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      },
    };
    const next = {
      ...mapDocRef.current,
      annotations: [...mapDocRef.current.annotations, annotation],
    };
    persistDoc(next);
    setEditingAnnotationId(annotation.id);
    setNoteMode(true);
    setBindAnnotationId(null);
  }, [persistDoc, tr]);

  const cancelMarquee = useCallback(() => {
    if (marqueeRef.current === null) return;
    marqueeRef.current = null;
    marqueeCreatesNoteRef.current = false;
    setMarquee(null);
  }, []);

  const onPointerUp = (event: ReactPointerEvent) => {
    // Unified cleanup: no matter which gesture path ran (wire early-returns
    // included), pan state must always be released.
    try {
      if (wireDragRef.current !== null) {
        // Window listener also handles finish; keep as safety if capture stayed on stage.
        void finishWireDrag(event.nativeEvent);
        return;
      }
      if (marqueeRef.current !== null) {
        // pointercancel must not persist a note — abort the marquee.
        if (event.type === 'pointercancel') {
          cancelMarquee();
          return;
        }
        finishMarquee();
        return;
      }
      if (dragRef.current) {
        const drag = dragRef.current;
        drag.moved ||= pointerMovedBeyondClickThreshold(drag, event);
        if (drag.moved) markUserAdjustedView();
        if (drag.pinned) {
          // KEEP pin — do not release into home-slot gravity.
          const x = drag.node.fx ?? drag.node.x ?? 0;
          const y = drag.node.fy ?? drag.node.y ?? 0;
          drag.node.fx = x;
          drag.node.fy = y;
          positionsRef.current.set(drag.node.id, { x, y });
          persistPositions(positionsRef.current);
          simulationRef.current?.alpha(SETTLE_ALPHA).alphaTarget(0).restart();
        }
        suppressClickRef.current = drag.moved || event.type === 'pointercancel' ? drag.node.id : null;
        dragRef.current = null;
        return;
      }
    } finally {
      panOrigin.current = null;
      setPanning(false);
    }
  };

  const placedForAnnotations = forceNodes.map((node) => ({
    session: node.member.session,
    x: (node.x ?? 0) - NODE_W / 2,
    y: (node.y ?? 0) - NODE_H / 2,
    cx: node.x ?? 0,
  }));

  const startNodeDrag = (event: ReactPointerEvent, node: ForceMapNode) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('.session-map-port') !== null) return;
    event.stopPropagation();
    stopFollowFocus();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    // Do not pin fx until the pointer actually moves (avoids click teleport).
    dragRef.current = {
      node,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      pinned: false,
    };
    suppressClickRef.current = null;
  };

  const handleNodeClick = (member: MapMemberRef) => {
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
              rect: annotationBounds(item, placedForAnnotations, { width: NODE_W, height: NODE_H }),
            };
          }
          return { ...item, nodeIds };
        }),
      });
      return;
    }
    openMember(member);
  };

  const submitMount = async () => {
    if (draft === null) return;
    if (!byId.has(draft.parentId)) {
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
    setBusyLocked(true);
    clearError();
    setNodeMenu(null);
    try {
      await api.sessions.unmount(sessionId);
      if (disposedRef.current) return;
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
      // Prune pinned positions of agent ghosts hosted by the deleted session.
      // Map iterators stay valid while deleting the current key.
      for (const key of positionsRef.current.keys()) {
        if (key.startsWith(`agent:${sessionId}:`)) {
          positionsRef.current.delete(key);
        }
      }
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

  const openNodeContextMenu = (
    event: ReactMouseEvent,
    member: MapMemberRef,
  ) => {
    if (member.kind !== 'session' || member.session.id.startsWith('agent:')) return;
    event.preventDefault();
    event.stopPropagation();
    const parentId = parentSessionIdOf(member.session);
    setNodeMenu({
      sessionId: member.session.id,
      x: event.clientX,
      y: event.clientY,
      canUnmount: parentId !== undefined,
      label: memberLabel(member),
    });
  };

  const addEmptyAnnotation = () => {
    const color = DEFAULT_ANNOTATION_COLORS[mapDoc.annotations.length % DEFAULT_ANNOTATION_COLORS.length]!;
    const originX = viewportSize.width > 0
      ? (-view.x / view.scale) + 40
      : CANVAS_PAD + 20;
    const originY = viewportSize.height > 0
      ? (-view.y / view.scale) + 40
      : CANVAS_PAD + 20;
    const box: MapAnnotationBox = {
      id: newAnnotationId(),
      title: tr('Note', '注释'),
      color,
      nodeIds: [],
      rect: { x: originX, y: originY, width: NODE_W + 80, height: NODE_H + 60 },
    };
    persistDoc({ ...mapDoc, annotations: [...mapDoc.annotations, box] });
    setEditingAnnotationId(box.id);
    setNoteMode(true);
    setBindAnnotationId(null);
  };

  const updateAnnotation = (id: string, patch: Partial<MapAnnotationBox>) => {
    persistDoc({
      ...mapDoc,
      annotations: mapDoc.annotations.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    });
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
    for (const node of forceNodes) {
      if (isValidWireTarget(wireDrag, node, allNodes)) ids.add(node.id);
    }
    return ids;
  }, [allNodes, forceNodes, wireDrag]);

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
          + (noteMode ? ' note-mode' : '')
          + (marquee !== null ? ' marqueeing' : '')
          + (busy ? ' busy' : '')
        }
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={(event) => {
          if ((event.target as HTMLElement).closest(
            '.session-map-node, .session-map-annotation, .session-map-float, .session-map-draft-node',
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
                        borderColor: box.color,
                        background: `${box.color}22`,
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        setEditingAnnotationId(box.id);
                        setNoteMode(true);
                      }}
                    >
                      <span className="session-map-annotation-title">{box.title || tr('Note', '注释')}</span>
                      {box.nodeIds.length === 0 && (
                        <span className="session-map-annotation-empty">{tr('Empty box', '空框')}</span>
                      )}
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
                </svg>
                {forceNodes.map((node) => {
                  const member = node.member;
                  const parentId = parentSessionIdOf(member.session) ?? member.hostSessionId;
                  const parentSession = parentId !== undefined ? byId.get(parentId) : undefined;
                  const parentName = parentSession !== undefined
                    ? sessionLabel(parentSession)
                    : parentId !== undefined
                      ? parentId.slice(0, 8)
                      : undefined;
                  // Guard undefined: `agent?.mounted_session_id === undefined` is true for
                  // every node without a mount, which wrongly painted every card active.
                  const isActive = activeSessionId !== undefined && (
                    member.session.id === activeSessionId
                    || member.agent?.mounted_session_id === activeSessionId
                  );
                  const role = memberRole(member);
                  const left = Math.round((node.x ?? 0) - NODE_W / 2);
                  const top = Math.round((node.y ?? 0) - NODE_H / 2);
                  const isWireTarget = wireValidTargetIds.has(node.id);
                  const isWireSnap = wireSnapTargetId === node.id;
                  return (
                    <div
                      key={node.id}
                      className={
                        'team-node session-map-node'
                        + (isActive ? ' active' : '')
                        + (parentId ? ' mounted' : ' top-level')
                        + (member.kind === 'agent' || member.agent ? ' member' : '')
                        + (selectedIds.includes(member.session.id) ? ' selected' : '')
                        + (isWireTarget ? ' wire-target-valid' : '')
                        + (isWireSnap ? ' wire-target-snap' : '')
                      }
                      style={{ left, top, width: NODE_W, height: NODE_H }}
                      onPointerDown={(event) => startNodeDrag(event, node)}
                      onClick={() => handleNodeClick(member)}
                      onContextMenu={(event) => openNodeContextMenu(event, member)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        if (draft !== null) return;
                        event.preventDefault();
                        handleNodeClick(member);
                      }}
                      role="button"
                      tabIndex={0}
                      data-session-id={member.session.id.startsWith('agent:') || member.kind === 'agent'
                        ? undefined
                        : member.session.id}
                    >
                      <span
                        className={
                          'session-map-port session-map-port-in'
                          + (parentId ? ' connected' : '')
                          + (isWireTarget && wireDrag?.side === 'out' ? ' wire-highlight' : '')
                          + (isWireSnap && wireDrag?.side === 'out' ? ' wire-snap' : '')
                        }
                        title={tr(
                          'Input · drag to reconnect · Alt+click to disconnect',
                          '输入口 · 拖动重连 · Alt+点击断连',
                        )}
                        onPointerDown={(event) => startWireFromPort(event, node, 'in')}
                      />
                      <div className="session-map-node-body">
                        <span className="team-node-name" title={memberLabel(member)}>{memberLabel(member)}</span>
                        <span className="team-node-sub" title={
                          member.kind === 'agent' || member.agent
                            ? tr('member', '成员')
                            : parentName !== undefined
                              ? tr(`under ${parentName}`, `挂在「${parentName}」`)
                              : tr('top-level', '顶层')
                        }>
                          {member.kind === 'agent' || member.agent
                            ? tr('member', '成员')
                            : parentName !== undefined
                              ? tr(`under ${parentName}`, `挂在「${parentName.length > 14 ? `${parentName.slice(0, 14)}…` : parentName}」`)
                              : tr('top-level', '顶层')}
                          {role ? ` · ${role}` : ''}
                        </span>
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
                      </div>
                      <span
                        className={
                          'session-map-port session-map-port-out'
                          + (isWireTarget && wireDrag?.side === 'in' ? ' wire-highlight' : '')
                          + (isWireSnap && wireDrag?.side === 'in' ? ' wire-snap' : '')
                        }
                        title={tr('Output · drag to create / remount child', '输出口 · 拖出创建或改挂子节点')}
                        onPointerDown={(event) => startWireFromPort(event, node, 'out')}
                      />
                      {parentId
                        && member.kind === 'session'
                        && !member.session.id.startsWith('agent:')
                        && bindAnnotationId === null && (
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
                `${String(allNodes.length)} sessions · ${String(agentExtras.length)} members · ${String(filteredList.length)} shown`,
                `${String(allNodes.length)} 个会话 · ${String(agentExtras.length)} 名成员 · 显示 ${String(filteredList.length)}`,
              )}
            </div>
          </div>
          <div className="session-map-search-wrap session-map-search-inline">
            <input
              className="session-map-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={tr('Search sessions / members…', '搜索会话 / 成员…')}
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
          <div className="session-map-toolbar">
            <button
              type="button"
              className={'session-map-tool' + (noteMode ? ' active' : '')}
              onClick={() => {
                setNoteMode((value) => !value);
                setBindAnnotationId(null);
              }}
            >
              {tr('Notes', '注释框')}
            </button>
            {noteMode && (
              <>
                <button type="button" className="session-map-tool" onClick={addEmptyAnnotation}>
                  {tr('Add note', '加空框')}
                </button>
                <span className="session-map-tool-hint">
                  {tr(
                    'Drag empty canvas for a note box; Shift+drag only selects',
                    '空白处拖动建注释框；Shift+拖动仅框选',
                  )}
                </span>
              </>
            )}
            <div className="team-tree-legend">
              <span><i className="tone-idle" />{tr('Session', '会话')}</span>
              <span><i className="tone-running" />{tr('Member', '成员')}</span>
            </div>
          </div>
          <div className="session-map-float-zoom">
            <button type="button" className="session-map-tool" onClick={rearrange} title={tr('Rearrange', '规整')}>
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

        {editingAnnotation && (
          <div className="session-map-float session-map-note-editor">
            <label>
              {tr('Note title', '注释标题')}
              <input
                value={editingAnnotation.title}
                onChange={(event) => updateAnnotation(editingAnnotation.id, { title: event.target.value })}
              />
            </label>
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
              ? wireDrag.side === 'in'
                ? tr('Drop on a parent card / output port to reconnect', '放到父卡片或输出口上重连')
                : tr('Drop on a card / input port to link, or empty canvas for a new child', '放到卡片/输入口直接挂载，或空白处新建子节点')
              : draft !== null
                ? tr('Edit identity on the canvas · click empty area to cancel', '在画布上编辑身份 · 点空白处取消')
                  : noteMode
                  ? tr('Drag empty canvas for a note box; Shift+drag only selects', '空白处拖动建注释框；Shift+拖动仅框选')
                  : tr('Drag canvas · wheel pans · Ctrl+wheel zooms · drag nodes · pull IN/OUT ports to wire · right-click to unmount/delete', '拖动画布 · 滚轮/双指平移 · Ctrl+滚轮缩放 · 拖节点 · 从输入/输出口拉线 · 右键拆挂/删除')}
        </span>

        {nodeMenu !== null && (
          <div
            className="session-map-context-menu session-map-float"
            style={{ left: nodeMenu.x, top: nodeMenu.y }}
            role="menu"
            onPointerDown={(event) => event.stopPropagation()}
          >
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
      </div>
    </div>
  );
}
