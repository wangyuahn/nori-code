import type { Session } from '../api/client';

/** Mount parent id when this session is a map/TeamCreate child. */
export function parentSessionIdOf(session: Session | undefined | null): string | undefined {
  const value = session?.metadata?.parent_session_id;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** True when the session belongs under another session (not a sidebar top-level). */
export function isMountedChildSession(session: Session | undefined | null): boolean {
  return parentSessionIdOf(session) !== undefined;
}

/**
 * Client-side mirror of server `assertAcyclicMount` — blocks wire drops that
 * would eventually return SESSION_MOUNT_CYCLE.
 * Optional `mapParentByChild` merges layout/mapDoc parents when metadata lags.
 */
export function wouldCreateMountCycle(
  childId: string,
  parentId: string,
  nodes: readonly Session[],
  mapParentByChild?: ReadonlyMap<string, string>,
): boolean {
  if (childId === parentId) return true;
  const parentById = new Map<string, string | undefined>();
  for (const node of nodes) {
    parentById.set(node.id, parentSessionIdOf(node) ?? mapParentByChild?.get(node.id));
  }
  if (mapParentByChild !== undefined) {
    for (const [child, parent] of mapParentByChild) {
      if (!parentById.has(child) || parentById.get(child) === undefined) {
        parentById.set(child, parent);
      }
    }
  }
  parentById.set(childId, parentId);
  let cursor: string | undefined = parentId;
  const seen = new Set<string>([childId]);
  while (cursor !== undefined) {
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    cursor = parentById.get(cursor);
  }
  return false;
}

/**
 * Sidebar list: the same Session forest as the map. Mounted children stay
 * visible so hire / map / sidebar never disagree about who exists.
 */
export function sessionsForSidebar(
  sessions: readonly Session[],
  _activeSessionId?: string | null,
): Session[] {
  return [...sessions];
}
