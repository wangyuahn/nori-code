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
 */
export function wouldCreateMountCycle(
  childId: string,
  parentId: string,
  nodes: readonly Session[],
): boolean {
  if (childId === parentId) return true;
  const parentById = new Map<string, string | undefined>();
  for (const node of nodes) {
    parentById.set(node.id, parentSessionIdOf(node));
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
 * Sidebar list: hide mounted children by default. Keep the active child visible
 * so opening a member from the map does not strand the user without context.
 */
export function sessionsForSidebar(
  sessions: readonly Session[],
  activeSessionId: string | null | undefined,
): Session[] {
  return sessions.filter((session) => {
    if (!isMountedChildSession(session)) return true;
    return activeSessionId !== undefined && activeSessionId !== null && session.id === activeSessionId;
  });
}
