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

/** Shift a new child so it does not land on an existing sibling card. */
export function offsetSpawnFromSiblings(
  occupied: ReadonlyArray<{ x: number; y: number }>,
  worldX: number,
  worldY: number,
  nodeW = NODE_W,
  gap = GAP_X,
): { x: number; y: number } {
  let x = worldX;
  let guard = 0;
  while (occupied.some((point) => Math.hypot(point.x - x, point.y - worldY) < nodeW * 0.85) && guard < 24) {
    x += nodeW + gap;
    guard += 1;
  }
  return { x, y: worldY };
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
