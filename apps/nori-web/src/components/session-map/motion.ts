import type { SimulationLinkDatum, SimulationNodeDatum } from 'd3-force';

import { parentSessionIdOf } from '../../utils/session-mount';
import { lookupMapPosition } from '../sessionMapDoc';
import { CANVAS_PAD, GAP_Y, NODE_H, NODE_W, nodeKey } from './layout';
import type { MapMemberRef, PlacedNode } from './layout';

export const HOME_PULL_STRENGTH = 0.22;
/** Idle / drag must not yank children back; home pull stays unused. */
export const SESSION_MAP_AMBIENT_HOME_GRAVITY = false;
export const SETTLE_ALPHA = 0.38;
export const LINK_STRENGTH = 0.02;
export const LINK_DISTANCE = NODE_H + GAP_Y;
export const COLLIDE_RADIUS = Math.min(NODE_W, NODE_H) / 2 + 8;

export interface ForceMapNode extends SimulationNodeDatum {
  id: string;
  member: MapMemberRef;
}

export interface ForceMapLink extends SimulationLinkDatum<ForceMapNode> {
  source: string | ForceMapNode;
  target: string | ForceMapNode;
}

export interface MapComponentInfo {
  componentId: string;
  rootNodeId: string;
  nodeIds: readonly string[];
}

function linkEndpointId(endpoint: string | ForceMapNode): string {
  return typeof endpoint === 'string' ? endpoint : endpoint.id;
}

/** Connected mount subtrees. Each component can be moved as a macro group. */
export function buildMapComponents(
  nodes: readonly { id: string; member: MapMemberRef }[],
  links: readonly ForceMapLink[],
): Map<string, MapComponentInfo> {
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
  for (const link of links) union(linkEndpointId(link.source), linkEndpointId(link.target));

  const byComponent = new Map<string, string[]>();
  for (const node of nodes) {
    const componentId = find(node.id);
    const list = byComponent.get(componentId) ?? [];
    list.push(node.id);
    byComponent.set(componentId, list);
  }

  const incoming = new Set<string>();
  for (const link of links) incoming.add(linkEndpointId(link.target));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const result = new Map<string, MapComponentInfo>();
  for (const [componentId, nodeIds] of byComponent) {
    const roots = nodeIds.filter((id) => !incoming.has(id));
    const candidates = roots.length > 0 ? roots : nodeIds;
    let rootNodeId = candidates[0]!;
    for (const id of candidates) {
      const node = nodeById.get(id);
      if (node === undefined) continue;
      if (parentSessionIdOf(node.member.session) === undefined && node.member.hostSessionId === undefined) {
        rootNodeId = id;
        break;
      }
    }
    const info = { componentId, rootNodeId, nodeIds } satisfies MapComponentInfo;
    for (const id of nodeIds) result.set(id, info);
  }
  return result;
}

export function isComponentRootPin(
  nodeId: string,
  componentIndex: ReadonlyMap<string, MapComponentInfo>,
): boolean {
  const info = componentIndex.get(nodeId);
  return info === undefined || info.rootNodeId === nodeId;
}

/** Relative tree slots anchored to the component root's current position. */
export function tidyComponentAroundRoot(input: {
  rootNodeId: string;
  nodeIds: readonly string[];
  rootPosition: { x: number; y: number };
  seeds: ReadonlyMap<string, { x: number; y: number }>;
}): Map<string, { x: number; y: number }> {
  const { rootNodeId, nodeIds, rootPosition, seeds } = input;
  const rootSeed = seeds.get(rootNodeId);
  const targets = new Map<string, { x: number; y: number }>([
    [rootNodeId, { x: rootPosition.x, y: rootPosition.y }],
  ]);
  if (rootSeed === undefined) return targets;
  for (const id of nodeIds) {
    if (id === rootNodeId) continue;
    const seed = seeds.get(id);
    if (seed === undefined) continue;
    targets.set(id, {
      x: rootPosition.x + seed.x - rootSeed.x,
      y: rootPosition.y + seed.y - rootSeed.y,
    });
  }
  return targets;
}

export function snapComponentChildrenToLiveRoot(input: {
  rootNodeId: string;
  nodeIds: readonly string[];
  rootPosition: { x: number; y: number };
  seeds: ReadonlyMap<string, { x: number; y: number }>;
  nodes: ReadonlyArray<{ id: string; x?: number; y?: number; vx?: number; vy?: number }>;
}): Map<string, { x: number; y: number }> {
  const targets = tidyComponentAroundRoot(input);
  const applied = new Map<string, { x: number; y: number }>();
  for (const node of input.nodes) {
    if (node.id === input.rootNodeId || !input.nodeIds.includes(node.id)) continue;
    const target = targets.get(node.id);
    if (target === undefined) continue;
    node.x = target.x;
    node.y = target.y;
    node.vx = 0;
    node.vy = 0;
    applied.set(node.id, target);
  }
  return applied;
}

export function resolveNodeDragGroupIds(input: {
  nodeId: string;
  sessionId: string;
  selectedIds: readonly string[];
  component: MapComponentInfo | undefined;
  forceNodes: readonly { id: string; member: MapMemberRef }[];
}): string[] {
  const { nodeId, sessionId, selectedIds, component, forceNodes } = input;
  if (selectedIds.includes(sessionId) && selectedIds.length > 0) {
    return forceNodes
      .filter((candidate) => selectedIds.includes(candidate.member.session.id))
      .map((candidate) => candidate.id);
  }
  if (component?.rootNodeId === nodeId) return [...component.nodeIds];
  return [nodeId];
}

export function resolveMapNodeSpawnPosition(input: {
  id: string;
  previous?: { x?: number; y?: number; fx?: number | null; fy?: number | null };
  cached?: { x: number; y: number };
  hostPosition?: { x: number; y: number };
  seed?: { x: number; y: number };
}): { x: number; y: number } {
  const { previous, cached, hostPosition, seed } = input;
  if (previous?.x !== undefined && previous.y !== undefined
    && Number.isFinite(previous.x) && Number.isFinite(previous.y)) {
    return { x: previous.x, y: previous.y };
  }
  if (cached !== undefined) return { x: cached.x, y: cached.y };
  if (hostPosition !== undefined) return { x: hostPosition.x, y: hostPosition.y + NODE_H + GAP_Y };
  if (seed !== undefined) return { x: seed.x, y: seed.y };
  return { x: CANVAS_PAD + NODE_W / 2, y: CANVAS_PAD + NODE_H / 2 };
}

function forestSeedCenter(placed: PlacedNode): { x: number; y: number } {
  return { x: placed.x + NODE_W / 2, y: placed.y + NODE_H / 2 };
}

/**
 * Force-node world coordinates are card **centers**. Forest layout stores
 * top-left `placed.x/y`; convert once here so persist/render never mix them.
 *
 * Persisted / previous centers are pinned (`fx/fy`). Brand-new nodes stay
 * unpinned for one collision settle and spawn beside their host — never (0,0).
 */
export function buildForceMapNodes(input: {
  placed: readonly PlacedNode[];
  previousById: ReadonlyMap<string, ForceMapNode>;
  positions: ReadonlyMap<string, { x: number; y: number }>;
}): { nodes: ForceMapNode[]; seeds: Map<string, { x: number; y: number }> } {
  const seeds = new Map<string, { x: number; y: number }>();
  for (const placed of input.placed) {
    seeds.set(nodeKey(placed.member), forestSeedCenter(placed));
  }

  const provisional = new Map<string, { x: number; y: number }>();
  for (const placed of input.placed) {
    const id = nodeKey(placed.member);
    const prev = input.previousById.get(id);
    const cached = lookupMapPosition(input.positions, id);
    provisional.set(id, resolveMapNodeSpawnPosition({
      id,
      previous: prev,
      cached,
      seed: seeds.get(id),
    }));
  }

  for (const placed of input.placed) {
    const id = nodeKey(placed.member);
    const prev = input.previousById.get(id);
    const cached = lookupMapPosition(input.positions, id);
    if (prev !== undefined || cached !== undefined) continue;
    const hostId = placed.member.hostSessionId ?? parentSessionIdOf(placed.member.session);
    if (hostId === undefined) continue;
    const hostPos = provisional.get(`session:${hostId}`)
      ?? lookupMapPosition(input.positions, `session:${hostId}`);
    if (hostPos === undefined) continue;
    provisional.set(id, resolveMapNodeSpawnPosition({
      id,
      hostPosition: hostPos,
      seed: seeds.get(id),
    }));
  }

  const nodes: ForceMapNode[] = input.placed.map((placed) => {
    const id = nodeKey(placed.member);
    const prev = input.previousById.get(id);
    const pos = provisional.get(id) ?? seeds.get(id)!;
    const cached = lookupMapPosition(input.positions, id);
    const hasStablePosition = prev !== undefined || cached !== undefined;
    return {
      id,
      member: placed.member,
      x: pos.x,
      y: pos.y,
      fx: hasStablePosition ? pos.x : undefined,
      fy: hasStablePosition ? pos.y : undefined,
      vx: prev?.vx ?? 0,
      vy: prev?.vy ?? 0,
    };
  });

  return { nodes, seeds };
}

/** Collision force scoped to one component, so unrelated roots never attract. */
export function forceIntraComponentCollide(
  componentOf: (node: ForceMapNode) => string,
  radius: number,
  strength: number,
): ((alpha: number) => void) & { initialize?: (nodes: ForceMapNode[]) => void } {
  let nodes: ForceMapNode[] = [];
  function force(alpha: number): void {
    for (let i = 0; i < nodes.length; i += 1) {
      const left = nodes[i]!;
      const leftPinned = left.fx !== null && left.fx !== undefined
        && left.fy !== null && left.fy !== undefined;
      for (let j = i + 1; j < nodes.length; j += 1) {
        const right = nodes[j]!;
        if (componentOf(left) !== componentOf(right)) continue;
        const rightPinned = right.fx !== null && right.fx !== undefined
          && right.fy !== null && right.fy !== undefined;
        if (leftPinned && rightPinned) continue;
        const ax = left.x ?? 0;
        const ay = left.y ?? 0;
        const bx = right.x ?? 0;
        const by = right.y ?? 0;
        let dx = bx - ax;
        let dy = by - ay;
        let distance = Math.hypot(dx, dy);
        if (distance === 0) {
          dx = 0.01;
          dy = 0.01;
          distance = Math.hypot(dx, dy);
        }
        if (distance >= radius * 2) continue;
        const push = ((radius * 2 - distance) / distance) * alpha * strength;
        const px = dx * push * 0.5;
        const py = dy * push * 0.5;
        if (!leftPinned) {
          const scale = rightPinned ? 2 : 1;
          left.vx = (left.vx ?? 0) - px * scale;
          left.vy = (left.vy ?? 0) - py * scale;
        }
        if (!rightPinned) {
          const scale = leftPinned ? 2 : 1;
          right.vx = (right.vx ?? 0) + px * scale;
          right.vy = (right.vy ?? 0) + py * scale;
        }
      }
    }
  }
  force.initialize = (initialized: ForceMapNode[]) => { nodes = initialized; };
  return force;
}
