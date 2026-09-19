import type { Session } from '../api/client';
import type { MapNodeMember } from './session-graph';

export type MapOpenTarget =
  | { kind: 'session'; sessionId: string };

export function mapOpenTarget(member: MapNodeMember): MapOpenTarget | undefined {
  const sessionId = member.session.id.trim();
  return sessionId.length > 0 ? { kind: 'session', sessionId } : undefined;
}

export function dedupeMapMembers(members: readonly MapNodeMember[], sessions: readonly Session[]): MapNodeMember[] {
  const bySessionId = new Map<string, MapNodeMember>();
  for (const member of members) {
    const sessionId = member.session.id.trim();
    if (sessionId.length === 0) continue;
    if (!bySessionId.has(sessionId)) bySessionId.set(sessionId, member);
  }
  const order = new Map(sessions.map((session, index) => [session.id, index]));
  return [...bySessionId.values()].sort((left, right) => (
    (order.get(left.session.id) ?? Number.MAX_SAFE_INTEGER)
      - (order.get(right.session.id) ?? Number.MAX_SAFE_INTEGER)
  ));
}
