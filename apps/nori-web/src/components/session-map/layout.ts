import type { Session, SessionGraph } from '../../api/client';
import { parentSessionIdOf } from '../../utils/session-mount';
import { mapMemberRoleLabel, type MapNodeMember } from '../../utils/session-graph';
import { canonicalMapPositionKey } from '../sessionMapDoc';

export const NODE_W = 220;
export const NODE_H = 120;
export const GAP_X = 36;
export const GAP_Y = 64;
export const CANVAS_PAD = 48;
export const MIN_SCALE = 0.2;
export const MAX_SCALE = 4;
export const FIT_MAX_SCALE = 1.35;
/** Diagonal stagger for a coincident pile — a deck, not a full-card jump. */
export const STACK_NUDGE = 18;
/** Visual fan on a pile; kept close so the stack still reads as one group. */
export const OVERLAP_STACK_STEP = 16;
/** Centers this close are the same pile (edge-grazing neighbors stay put). */
export const PILE_CENTER_SLACK = 56;
/** Exact cached duplicates: only these get a world-space stagger. */
export const COINCIDENT_SLACK = 10;

/** True when two card rectangles would draw on top of each other. */
export function cardsOverlap(
  a: { x: number; y: number },
  b: { x: number; y: number },
  nodeW = NODE_W,
  nodeH = NODE_H,
): boolean {
  return Math.abs(a.x - b.x) < nodeW && Math.abs(a.y - b.y) < nodeH;
}

/** True when two centers sit in the same pile, not a near-miss at the edge. */
export function cardsPiled(
  a: { x: number; y: number },
  b: { x: number; y: number },
  slack = PILE_CENTER_SLACK,
): boolean {
  return Math.abs(a.x - b.x) < slack && Math.abs(a.y - b.y) < slack;
}

/** Shift a new child so it does not land on the exact same center. */
export function offsetSpawnFromSiblings(
  occupied: ReadonlyArray<{ x: number; y: number }>,
  worldX: number,
  worldY: number,
  _nodeW = NODE_W,
  gap = STACK_NUDGE,
): { x: number; y: number } {
  let x = worldX;
  let y = worldY;
  let guard = 0;
  while (occupied.some((point) => cardsPiled(point, { x, y }, COINCIDENT_SLACK)) && guard < 24) {
    x += gap;
    y += gap;
    guard += 1;
  }
  return { x, y };
}

/**
 * Break identical cached centers into a compact deck. Overlap is allowed —
 * the render stack shows it. This must not jump by a full card width.
 */
export function untangleOverlappingCenters(
  nodes: ReadonlyArray<{ id: string; x: number; y: number }>,
  _nodeW = NODE_W,
  _nodeH = NODE_H,
  gapX = STACK_NUDGE,
  gapY = STACK_NUDGE,
): Map<string, { x: number; y: number }> {
  const next = nodes.map((node) => ({ ...node }));
  for (let index = 1; index < next.length; index += 1) {
    const current = next[index]!;
    let guard = 0;
    while (
      guard < 24
      && next.slice(0, index).some((previous) => cardsPiled(previous, current, COINCIDENT_SLACK))
    ) {
      current.x += gapX;
      current.y += gapY;
      guard += 1;
    }
  }
  return new Map(next.map((node) => [node.id, { x: node.x, y: node.y }]));
}

/** Keep a dragged group together while sliding it off an identical center. */
export function nudgeGroupOffOccupied(
  group: ReadonlyArray<{ id: string; x: number; y: number }>,
  occupied: ReadonlyArray<{ x: number; y: number }>,
  _nodeW = NODE_W,
  gap = STACK_NUDGE,
): Map<string, { x: number; y: number }> {
  let shiftX = 0;
  let shiftY = 0;
  let guard = 0;
  while (
    guard < 24
    && group.some((pos) => occupied.some((point) => cardsPiled(point, {
      x: pos.x + shiftX,
      y: pos.y + shiftY,
    }, COINCIDENT_SLACK)))
  ) {
    shiftX += gap;
    shiftY += gap;
    guard += 1;
  }
  return new Map(group.map((pos) => [pos.id, { x: pos.x + shiftX, y: pos.y + shiftY }]));
}

export interface CardOverlapVisual {
  stackIndex: number;
  stackSize: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Fan stacked cards so every overlapping card stays visible. Physics may still
 * share a center; this is a render-only cascade plus a count for the top card.
 */
export function stackOffsetsForOverlappingCards(
  nodes: ReadonlyArray<{ id: string; x: number; y: number }>,
  _nodeW = NODE_W,
  _nodeH = NODE_H,
  step = OVERLAP_STACK_STEP,
): Map<string, CardOverlapVisual> {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const entry = parent.get(id);
    if (entry === undefined || entry === id) return id;
    const root = find(entry);
    parent.set(id, root);
    return root;
  };
  const union = (left: string, right: string) => {
    parent.set(find(left), find(right));
  };
  for (const node of nodes) parent.set(node.id, node.id);
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      if (cardsPiled(nodes[i]!, nodes[j]!)) union(nodes[i]!.id, nodes[j]!.id);
    }
  }
  const groups = new Map<string, string[]>();
  for (const node of nodes) {
    const root = find(node.id);
    const list = groups.get(root) ?? [];
    list.push(node.id);
    groups.set(root, list);
  }
  const visuals = new Map<string, CardOverlapVisual>();
  for (const ids of groups.values()) {
    ids.sort();
    for (let index = 0; index < ids.length; index += 1) {
      const stacked = ids.length > 1;
      visuals.set(ids[index]!, {
        stackIndex: index,
        stackSize: ids.length,
        offsetX: stacked ? index * step : 0,
        offsetY: stacked ? index * step : 0,
      });
    }
  }
  return visuals;
}

export interface TreeView {
  x: number;
  y: number;
  scale: number;
}

export type MapMemberRef = MapNodeMember;

export interface PlacedNode {
  member: MapMemberRef;
  x: number;
  y: number;
  cx: number;
}

export function fitTreeView(
  content: { width: number; height: number },
  viewport: { width: number; height: number },
): TreeView {
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

export function projectFolderName(path: string): string {
  const segments = path.split(/[\\/]/);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index]) return segments[index]!;
  }
  return path;
}

export function sessionLabel(session: Session): string {
  const title = session.title?.trim();
  return title || session.id;
}

export function memberLabel(member: MapMemberRef): string {
  return sessionLabel(member.session);
}

export function memberRole(
  member: MapMemberRef,
): string | undefined {
  return mapMemberRoleLabel(member);
}

export function memberProjectCwd(
  member: MapMemberRef,
  byId: ReadonlyMap<string, Session>,
): string | undefined {
  const own = member.session.metadata?.cwd;
  if (typeof own === 'string' && own.trim()) return own.trim();
  const hostId = member.hostSessionId ?? parentSessionIdOf(member.session);
  if (hostId === undefined) return undefined;
  const hostCwd = byId.get(hostId)?.metadata?.cwd;
  return typeof hostCwd === 'string' && hostCwd.trim() ? hostCwd.trim() : undefined;
}

export function ensureGraphEdges(graph: SessionGraph): SessionGraph {
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

/** Deterministic forest seed. Live motion is owned by the map motion module. */
export function layoutSessionMountForest(
  graph: SessionGraph,
): {
  placed: PlacedNode[];
  edges: Array<{ from: PlacedNode; to: PlacedNode }>;
  width: number;
  height: number;
} {
  const normalized = ensureGraphEdges(graph);
  const byId = new Map(normalized.nodes.map((node) => [node.id, node]));
  const children = new Map<string, string[]>();
  const parentByChild = new Map<string, string>();

  for (const edge of normalized.edges) {
    if (!byId.has(edge.child_session_id) || !byId.has(edge.parent_session_id)) continue;
    const list = children.get(edge.parent_session_id) ?? [];
    list.push(edge.child_session_id);
    children.set(edge.parent_session_id, list);
    parentByChild.set(edge.child_session_id, edge.parent_session_id);
  }

  const parentOf = (target: Session): string | undefined => (
    parentSessionIdOf(target) ?? parentByChild.get(target.id)
  );

  const sessionMember = (session: Session): MapMemberRef => ({
    session,
    kind: 'session',
    hostSessionId: parentOf(session),
  });

  for (const list of children.values()) {
    list.sort((a, b) => {
      const left = byId.get(a)!;
      const right = byId.get(b)!;
      return left.updated_at.localeCompare(right.updated_at);
    });
  }

  const roots = [...normalized.nodes]
    .filter((node) => !parentByChild.has(node.id))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const placed: PlacedNode[] = [];
  let nextCol = 0;
  const placing = new Set<string>();
  const placedSessionIds = new Set<string>();

  const placeSession = (session: Session, depth: number): { left: number; right: number; node: PlacedNode } | undefined => {
    if (placedSessionIds.has(session.id) || placing.has(session.id)) return undefined;
    placing.add(session.id);
    const childIds = (children.get(session.id) ?? []).filter((id) => !placing.has(id) && !placedSessionIds.has(id));
    if (childIds.length === 0) {
      const col = nextCol++;
      const x = CANVAS_PAD + col * (NODE_W + GAP_X);
      const y = CANVAS_PAD + depth * (NODE_H + GAP_Y);
      const node = { member: sessionMember(session), x, y, cx: x + NODE_W / 2 };
      placed.push(node);
      placedSessionIds.add(session.id);
      placing.delete(session.id);
      return { left: col, right: col, node };
    }

    const childLayouts = childIds.flatMap((id) => {
      const child = byId.get(id);
      if (child === undefined) return [];
      const layout = placeSession(child, depth + 1);
      return layout === undefined ? [] : [layout];
    });
    if (childLayouts.length === 0) {
      const col = nextCol++;
      const x = CANVAS_PAD + col * (NODE_W + GAP_X);
      const y = CANVAS_PAD + depth * (NODE_H + GAP_Y);
      const node = { member: sessionMember(session), x, y, cx: x + NODE_W / 2 };
      placed.push(node);
      placedSessionIds.add(session.id);
      placing.delete(session.id);
      return { left: col, right: col, node };
    }
    const left = childLayouts[0]!.left;
    const right = childLayouts.at(-1)!.right;
    const cx = ((left + right) / 2) * (NODE_W + GAP_X) + CANVAS_PAD + NODE_W / 2;
    const x = cx - NODE_W / 2;
    const y = CANVAS_PAD + depth * (NODE_H + GAP_Y);
    const node = { member: sessionMember(session), x, y, cx };
    placed.push(node);
    placedSessionIds.add(session.id);
    placing.delete(session.id);
    return { left, right, node };
  };

  let forestOffset = 0;
  for (const root of roots) {
    nextCol = forestOffset;
    placeSession(root, 0);
    forestOffset = nextCol + 1;
  }
  for (const node of normalized.nodes) {
    if (placedSessionIds.has(node.id)) continue;
    nextCol = forestOffset;
    placeSession(node, 0);
    forestOffset = nextCol + 1;
  }

  const byKey = new Map(placed.map((node) => [nodeKey(node.member), node]));
  const edges: Array<{ from: PlacedNode; to: PlacedNode }> = [];
  for (const edge of normalized.edges) {
    const from = byKey.get(`session:${edge.parent_session_id}`);
    const to = byKey.get(`session:${edge.child_session_id}`);
    if (from !== undefined && to !== undefined) edges.push({ from, to });
  }

  const width = Math.max(NODE_W + CANVAS_PAD * 2, ...placed.map((node) => node.x + NODE_W + CANVAS_PAD), 1);
  const height = Math.max(NODE_H + CANVAS_PAD * 2, ...placed.map((node) => node.y + NODE_H + CANVAS_PAD), 1);
  return { placed, edges, width, height };
}

export function nodeKey(member: MapMemberRef): string {
  return canonicalMapPositionKey(member.session.id);
}

export { parentSessionIdOf };
