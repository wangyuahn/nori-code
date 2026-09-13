import type { Session } from '../api/client';
import type { MapNodeMember } from './session-graph';

export type MapOpenTarget =
  | { kind: 'session'; sessionId: string };

export function mapOpenTarget(member: MapNodeMember): MapOpenTarget | undefined {
  // Every map card represents a Session. Agent metadata is decoration; the
  // card always opens the session object it is rendering.
  const sessionId = member.session.id.trim();
  return sessionId.length > 0 ? { kind: 'session', sessionId } : undefined;
}

export function dedupeMapMembers(members: readonly MapNodeMember[], sessions: readonly Session[]): MapNodeMember[] {
  const agentKeys = new Set<string>();
  const bySessionId = new Map<string, MapNodeMember>();
  for (const member of members) {
    // A TeamCreate agent without a durable Session is not a map object.
    // Mounted sessions may still carry agent metadata, but they arrive as
    // `kind: 'session'` and are handled below.
    if (member.kind === 'agent') continue;
    if (member.agent !== undefined && member.hostSessionId !== undefined) {
      const key = `${member.hostSessionId}:${member.agent.agent_id}`;
      if (agentKeys.has(key)) continue;
      agentKeys.add(key);
    }
    const sessionId = member.session.id.trim();
    if (sessionId.length === 0) continue;
    const existing = bySessionId.get(sessionId);
    if (existing === undefined || (existing.agent === undefined && member.agent !== undefined)) {
      bySessionId.set(sessionId, member);
    }
  }
  // Keep the durable session list's order when it is available. This makes a
  // duplicate agent overlay deterministic without moving a card on refresh.
  const order = new Map(sessions.map((session, index) => [session.id, index]));
  return [...bySessionId.values()].sort((left, right) => (
    (order.get(left.session.id) ?? Number.MAX_SAFE_INTEGER)
      - (order.get(right.session.id) ?? Number.MAX_SAFE_INTEGER)
  ));
}
