import type { SessionGraphSummary, SessionSummary } from '@nori-code/sdk';

export interface SessionMapRow {
  readonly session: SessionSummary;
  readonly depth: number;
  readonly parentSessionId?: string;
}

export function parentSessionIdOf(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  const value = metadata?.['parent_session_id'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function sessionMapLabel(session: SessionSummary): string {
  const title = session.title?.trim();
  return title !== undefined && title.length > 0 ? title : session.id;
}

export function mountRoleOf(session: SessionSummary): string | undefined {
  const value = session.metadata?.['mount_role'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function mountMandateOf(session: SessionSummary): string | undefined {
  const value = session.metadata?.['mount_mandate'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function flattenSessionMapTree(graph: SessionGraphSummary): SessionMapRow[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const children = new Map<string, SessionSummary[]>();
  for (const edge of graph.edges) {
    if (!byId.has(edge.childSessionId) || !byId.has(edge.parentSessionId)) continue;
    const list = children.get(edge.parentSessionId) ?? [];
    list.push(byId.get(edge.childSessionId)!);
    children.set(edge.parentSessionId, list);
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.updatedAt - b.updatedAt);
  }

  const roots = graph.nodes
    .filter((node) => {
      const parentId = parentSessionIdOf(node.metadata as Record<string, unknown> | undefined);
      return parentId === undefined || !byId.has(parentId);
    })
    .toSorted((a, b) => b.updatedAt - a.updatedAt);

  const out: SessionMapRow[] = [];
  const walk = (session: SessionSummary, depth: number): void => {
    out.push({
      session,
      depth,
      parentSessionId: parentSessionIdOf(session.metadata as Record<string, unknown> | undefined),
    });
    for (const child of children.get(session.id) ?? []) {
      walk(child, depth + 1);
    }
  };
  for (const root of roots) {
    walk(root, 0);
  }
  return out;
}
