import { describe, expect, it } from 'vitest';
import type { SessionAgent } from '../src/api/client';
import { discussionSpeakingAgentIds, findAgentDiscussion } from '../src/utils/team-discussion';

function agent(partial: Partial<SessionAgent> & Pick<SessionAgent, 'agent_id' | 'kind'>): SessionAgent {
  return { status: 'idle', ...partial };
}

const MAIN = agent({ agent_id: 'main', kind: 'main', name: 'Main' });
const LEAD = agent({ agent_id: 'lead', kind: 'team', name: 'Lead', parent_agent_id: 'main' });
const MEMBER = agent({ agent_id: 'member', kind: 'team', name: 'Member', parent_agent_id: 'lead' });

describe('findAgentDiscussion', () => {
  it('finds the round the viewer convened', () => {
    const round = agent({ agent_id: 'round-1', kind: 'discussion', parent_agent_id: 'main', discussion_turn_agent_id: 'lead' });
    expect(findAgentDiscussion([MAIN, LEAD, round], 'main')).toEqual({
      discussionAgentId: 'round-1',
      leaderAgentId: 'main',
      turnAgentId: 'lead',
    });
  });

  it('finds the round a member takes part in through its own lead', () => {
    const round = agent({ agent_id: 'round-2', kind: 'discussion', parent_agent_id: 'lead' });
    expect(findAgentDiscussion([MAIN, LEAD, MEMBER, round], 'member')).toEqual({
      discussionAgentId: 'round-2',
      leaderAgentId: 'lead',
    });
  });

  it('prefers the round the viewer chairs over the one it joined', () => {
    const chaired = agent({ agent_id: 'round-own', kind: 'discussion', parent_agent_id: 'lead' });
    const joined = agent({ agent_id: 'round-up', kind: 'discussion', parent_agent_id: 'main' });
    expect(findAgentDiscussion([MAIN, LEAD, joined, chaired], 'lead')?.discussionAgentId).toBe('round-own');
  });

  it('ignores archived rounds and unknown viewers', () => {
    const archived = agent({ agent_id: 'round-3', kind: 'discussion', parent_agent_id: 'main', archived: true });
    expect(findAgentDiscussion([MAIN, archived], 'main')).toBeUndefined();
    expect(findAgentDiscussion([MAIN], null)).toBeUndefined();
  });

  it('lets the live turn hint win over the polled tree', () => {
    const round = agent({ agent_id: 'round-4', kind: 'discussion', parent_agent_id: 'main', discussion_turn_agent_id: 'lead' });
    expect(findAgentDiscussion([MAIN, LEAD, round], 'main', 'member')?.turnAgentId).toBe('member');
  });
});

describe('discussionSpeakingAgentIds', () => {
  it('collects the speaker of every live round plus the live hint', () => {
    const first = agent({ agent_id: 'round-a', kind: 'discussion', parent_agent_id: 'main', discussion_turn_agent_id: 'lead' });
    const second = agent({ agent_id: 'round-b', kind: 'discussion', parent_agent_id: 'lead', discussion_turn_agent_id: 'member' });
    const stale = agent({ agent_id: 'round-c', kind: 'discussion', parent_agent_id: 'main', archived: true, discussion_turn_agent_id: 'ghost' });
    const speaking = discussionSpeakingAgentIds([MAIN, LEAD, MEMBER, first, second, stale], 'fresh');
    expect([...speaking].sort()).toEqual(['fresh', 'lead', 'member']);
  });

  it('is empty without any live round', () => {
    expect(discussionSpeakingAgentIds([MAIN, LEAD, MEMBER]).size).toBe(0);
  });
});
