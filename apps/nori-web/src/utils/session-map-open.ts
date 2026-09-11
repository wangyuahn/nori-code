import type { Session, SessionAgent } from '../api/client';
import type { MapNodeMember } from './session-graph';

export type MapOpenTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'agent'; hostSessionId: string; agent: SessionAgent };

export function mapOpenTarget(member: MapNodeMember): MapOpenTarget | undefined {
  if (member.agent !== undefined && member.hostSessionId !== undefined) {
    return { kind: 'agent', hostSessionId: member.hostSessionId, agent: member.agent };
  }
  if (!member.session.id.startsWith('agent:')) return { kind: 'session', sessionId: member.session.id };
  return undefined;
}

export function dedupeMapMembers(members: readonly MapNodeMember[], sessions: readonly Session[]): MapNodeMember[] {
  const sessionIds = new Set(sessions.map((session) => session.id));
  const mounted = new Set<string>();
  const agentKeys = new Set<string>();
  const output: MapNodeMember[] = [];
  for (const member of members) {
    const mountedId = member.agent?.mounted_session_id;
    if (mountedId !== undefined && sessionIds.has(mountedId)) continue;
    if (mountedId !== undefined) {
      if (mounted.has(mountedId)) continue;
      mounted.add(mountedId);
    }
    if (member.agent !== undefined && member.hostSessionId !== undefined) {
      const key = `${member.hostSessionId}:${member.agent.agent_id}`;
      if (agentKeys.has(key)) continue;
      agentKeys.add(key);
    }
    output.push(member);
  }
  return output;
}
