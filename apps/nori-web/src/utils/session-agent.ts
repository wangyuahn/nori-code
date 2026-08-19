import type { SessionAgent } from '../api/client';

export function sessionAgentDisplayName(agent: SessionAgent): string {
  const name = agent.name?.trim();
  return name || agent.agent_id;
}
