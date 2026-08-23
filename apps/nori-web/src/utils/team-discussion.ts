import type { SessionAgent } from '../api/client';

export interface AgentDiscussion {
  /** The discussion transcript node itself. */
  readonly discussionAgentId: string;
  /** The agent that convened it — the department lead, never a participant. */
  readonly leaderAgentId: string;
  /** The member whose serial Discuss turn is running right now, if any. */
  readonly turnAgentId?: string;
}

/**
 * The Discuss round that concerns `agentId`, whether it convened the round or
 * takes part in it.
 *
 * A discussion is its own node in the agent tree, parented to the department
 * lead that opened it. Only that node carries `discussion_turn_agent_id`, which
 * is why the current turn cannot be read off the viewed agent's own node.
 * `liveTurnAgentId` is the last value seen on a `discussion.updated` event and
 * wins over the polled tree, which lags by a poll interval.
 */
export function findAgentDiscussion(
  agents: readonly SessionAgent[],
  agentId: string | null | undefined,
  liveTurnAgentId?: string | null,
): AgentDiscussion | undefined {
  if (!agentId) return undefined;
  const viewer = agents.find(candidate => candidate.agent_id === agentId);
  const departmentLeaderAgentId = viewer?.kind === 'team' ? viewer.parent_agent_id : undefined;
  const discussions = agents.filter(candidate => candidate.kind === 'discussion' && candidate.archived !== true);
  // A node can be both a lead and a member. Its own round comes first: that is
  // the one it chairs and the one whose rail it can act on.
  const own = discussions.find(candidate => candidate.parent_agent_id === agentId);
  const joined = departmentLeaderAgentId === undefined
    ? undefined
    : discussions.find(candidate => candidate.parent_agent_id === departmentLeaderAgentId);
  const discussion = own ?? joined;
  if (discussion === undefined || discussion.parent_agent_id === undefined) return undefined;
  const turnAgentId = liveTurnAgentId ?? discussion.discussion_turn_agent_id;
  return {
    discussionAgentId: discussion.agent_id,
    leaderAgentId: discussion.parent_agent_id,
    ...(turnAgentId ? { turnAgentId } : {}),
  };
}

/**
 * Every agent currently holding a Discuss turn, across all departments — the
 * set the team tree highlights. Built from the discussion nodes before they are
 * filtered out of the rendered tree.
 */
export function discussionSpeakingAgentIds(
  agents: readonly SessionAgent[],
  liveTurnAgentId?: string | null,
): ReadonlySet<string> {
  const speaking = new Set<string>();
  for (const agent of agents) {
    if (agent.kind !== 'discussion' || agent.archived === true) continue;
    if (agent.discussion_turn_agent_id) speaking.add(agent.discussion_turn_agent_id);
  }
  if (liveTurnAgentId) speaking.add(liveTurnAgentId);
  return speaking;
}
