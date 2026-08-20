import { describe, expect, it } from 'vitest';

import {
  activeDiscussionAsParticipant,
  canCreateDepartment,
  DEFAULT_TEAM_MAX_DEPTH,
  directMessageRelation,
  teamDepth,
  type TeamDirectMessageRelation,
  type TeamTree,
} from '../../src/session/team-tree';

/**
 * A three-level department tree:
 *
 *   main
 *   ├── lead-a            (department: lead-a + its two members)
 *   │   ├── a-one
 *   │   └── a-two
 *   └── lead-b
 *       └── b-one
 */
const tree: TeamTree = {
  main: {},
  'lead-a': { kind: 'team', teamLeaderAgentId: 'main' },
  'a-one': { kind: 'team', teamLeaderAgentId: 'lead-a' },
  'a-two': { kind: 'team', teamLeaderAgentId: 'lead-a' },
  'lead-b': { kind: 'team', teamLeaderAgentId: 'main' },
  'b-one': { kind: 'team', teamLeaderAgentId: 'lead-b' },
};

describe('teamDepth', () => {
  it('counts Team levels below the root', () => {
    expect(teamDepth(tree, 'main')).toBe(0);
    expect(teamDepth(tree, 'lead-a')).toBe(1);
    expect(teamDepth(tree, 'a-one')).toBe(2);
  });

  it('treats an unknown agent as the root rather than throwing', () => {
    expect(teamDepth(tree, 'never-hired')).toBe(0);
  });

  it('stops at a parent that no longer exists instead of looping', () => {
    const orphaned: TeamTree = { orphan: { kind: 'team', teamLeaderAgentId: 'dismissed' } };
    expect(teamDepth(orphaned, 'orphan')).toBe(1);
  });

  it('terminates on a cycle in the parent chain', () => {
    const cyclic: TeamTree = {
      x: { kind: 'team', teamLeaderAgentId: 'y' },
      y: { kind: 'team', teamLeaderAgentId: 'x' },
    };
    // Counts the hops it managed before revisiting `x`. The depth is meaningless
    // for a corrupt chain; what matters is that it returns at all.
    expect(teamDepth(cyclic, 'x')).toBe(1);
  });
});

describe('canCreateDepartment', () => {
  it('lets the root and every level above the limit hire', () => {
    expect(canCreateDepartment(tree, 'main', 2)).toBe(true);
    expect(canCreateDepartment(tree, 'lead-a', 2)).toBe(true);
  });

  it('refuses the last level, whose members would exceed the limit', () => {
    expect(canCreateDepartment(tree, 'a-one', 2)).toBe(false);
  });

  it('keeps the team flat at maxDepth 1', () => {
    expect(canCreateDepartment(tree, 'main', 1)).toBe(true);
    expect(canCreateDepartment(tree, 'lead-a', 1)).toBe(false);
  });

  it('allows one department level below main by default', () => {
    expect(DEFAULT_TEAM_MAX_DEPTH).toBe(2);
    expect(canCreateDepartment(tree, 'lead-a', DEFAULT_TEAM_MAX_DEPTH)).toBe(true);
    expect(canCreateDepartment(tree, 'a-one', DEFAULT_TEAM_MAX_DEPTH)).toBe(false);
  });
});

describe('directMessageRelation', () => {
  /** Looks both ends up in `from`, the way the host looks them up in a Session. */
  const relation = (
    senderAgentId: string,
    targetAgentId: string,
    from: TeamTree = tree,
  ): TeamDirectMessageRelation | undefined => directMessageRelation(
    { agentId: senderAgentId, node: from[senderAgentId] },
    { agentId: targetAgentId, node: from[targetAgentId] },
  );

  it('reaches a parent upward', () => {
    expect(relation('a-one', 'lead-a')).toBe('parent');
    expect(relation('lead-a', 'main')).toBe('parent');
  });

  it('reaches a peer in the same department', () => {
    expect(relation('a-one', 'a-two')).toBe('sibling');
    expect(relation('lead-a', 'lead-b')).toBe('sibling');
  });

  it('reaches the members a node hired itself', () => {
    expect(relation('main', 'lead-a')).toBe('member');
    // The case a flat main-only rule got wrong: a mid-tree node could not
    // message the members it had just hired.
    expect(relation('lead-a', 'a-one')).toBe('member');
  });

  it('refuses a node outside both of the sender\'s departments', () => {
    expect(relation('a-one', 'b-one')).toBeUndefined();
    expect(relation('a-one', 'lead-b')).toBeUndefined();
    expect(relation('a-one', 'main')).toBeUndefined();
  });

  it('refuses the sender itself and agents that do not exist', () => {
    expect(relation('a-one', 'a-one')).toBeUndefined();
    expect(relation('a-one', 'never-hired')).toBeUndefined();
    expect(relation('never-hired', 'main')).toBeUndefined();
  });

  it('refuses a discussion transcript on either end', () => {
    const withDiscussion: TeamTree = {
      ...tree,
      'discussion-1': {
        kind: 'sub',
        teamLeaderAgentId: 'main',
        discussion: { status: 'active', participantAgentIds: ['lead-a'] },
      },
    };
    expect(relation('main', 'discussion-1', withDiscussion)).toBeUndefined();
    expect(relation('discussion-1', 'main', withDiscussion)).toBeUndefined();
  });
});

describe('activeDiscussionAsParticipant', () => {
  const discussing: TeamTree = {
    ...tree,
    'discussion-main': {
      kind: 'sub',
      teamLeaderAgentId: 'main',
      discussion: { status: 'active', participantAgentIds: ['lead-a', 'lead-b'] },
    },
    'discussion-a-archived': {
      kind: 'sub',
      teamLeaderAgentId: 'lead-a',
      discussion: { status: 'archived', participantAgentIds: ['a-one', 'a-two'] },
    },
  };

  it('finds the discussion a node owes a statement to', () => {
    expect(activeDiscussionAsParticipant(discussing, 'lead-a')).toBe('discussion-main');
  });

  it('ignores an archived discussion', () => {
    expect(activeDiscussionAsParticipant(discussing, 'a-one')).toBeUndefined();
  });

  it('reports nothing for the node chairing the discussion', () => {
    // main runs `discussion-main`; it is not one of its participants, which is
    // what leaves it free to chair while its members answer.
    expect(activeDiscussionAsParticipant(discussing, 'main')).toBeUndefined();
  });
});
