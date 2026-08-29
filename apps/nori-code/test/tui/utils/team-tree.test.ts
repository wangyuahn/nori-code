import { describe, expect, it } from 'vitest';

import {
  applyAgentStatusToTeam,
  applyDiscussionUpdateToTeam,
  applyTeamToolResultToTeam,
  extractTeamSpeechText,
  flattenTeamTree,
  formatTeamAgentDetails,
  formatTeamReportsStatus,
  formatTeamRowSecondary,
  shouldPaintDiscussUtterance,
  teamAgentsFromSessionMetadata,
  teamChatMessagesFromMetadata,
  teamHasBlockingReports,
  teamMemberCount,
  teamSpeakingLabel,
  departmentChatLeaderId,
  departmentPaneMode,
  type TeamAgentSnapshot,
} from '#/tui/utils/team-tree';

const main: TeamAgentSnapshot = {
  agentId: 'main',
  kind: 'main',
  name: 'Main',
  parentAgentId: null,
};

describe('teamAgentsFromSessionMetadata', () => {
  it('returns an empty list when resume metadata has no agents', () => {
    expect(teamAgentsFromSessionMetadata(undefined)).toEqual([]);
    expect(teamAgentsFromSessionMetadata({})).toEqual([]);
  });

  it('rebuilds the department tree from resume metadata', () => {
    const agents = teamAgentsFromSessionMetadata({
      agents: {
        main: { type: 'main', name: 'Main', parentAgentId: null },
        reviewer: {
          kind: 'team',
          name: 'Reviewer',
          parentAgentId: 'main',
          role: 'code review',
          mountedSessionId: 'session-reviewer',
          assignedTask: 'Review the TUI footer',
          teamReport: { status: 'blocked', summary: 'Need a decision' },
        },
      },
    });
    expect(teamMemberCount(agents)).toBe(1);
    const reviewer = agents.find((agent) => agent.agentId === 'reviewer');
    expect(reviewer?.kind).toBe('team');
    expect(reviewer?.role).toBe('code review');
    expect(reviewer?.mountedSessionId).toBe('session-reviewer');
    expect(reviewer?.reportStatus).toBe('blocked');
    expect(flattenTeamTree(agents).map((row) => `${row.depth}:${row.agent.name}`)).toEqual([
      '0:Main',
      '1:Reviewer',
    ]);
  });
});

describe('applyTeamToolResultToTeam', () => {
  it('adds hired partners from TeamCreate output', () => {
    const next = applyTeamToolResultToTeam(
      [],
      'TeamCreate',
      { members: [{ name: 'Reviewer', role: 'code review' }] },
      JSON.stringify({
        members: [
          {
            agentId: 'reviewer',
            identity: { name: 'Reviewer', role: 'code review', mandate: 'Keep diffs small' },
            session_id: 'session-reviewer',
          },
        ],
      }),
      'main',
    );
    expect(next.some((agent) => agent.kind === 'main')).toBe(true);
    expect(teamMemberCount(next)).toBe(1);
    expect(next.find((agent) => agent.agentId === 'reviewer')?.mandate).toBe('Keep diffs small');
    expect(next.find((agent) => agent.agentId === 'reviewer')?.mountedSessionId).toBe('session-reviewer');
  });

  it('records assignments and dismissals', () => {
    const hired = applyTeamToolResultToTeam(
      [main],
      'TeamCreate',
      { members: [{ name: 'Reviewer' }] },
      JSON.stringify({ members: [{ agentId: 'reviewer', identity: { name: 'Reviewer' } }] }),
      'main',
    );
    const assigned = applyTeamToolResultToTeam(
      hired,
      'TeamAssign',
      { assignments: [{ agent_id: 'reviewer', task: 'Review footer' }] },
      '{}',
      'main',
    );
    expect(assigned.find((agent) => agent.agentId === 'reviewer')?.assignedTask).toBe('Review footer');
    const dismissed = applyTeamToolResultToTeam(
      assigned,
      'TeamDismiss',
      { agent_ids: ['reviewer'] },
      '{}',
      'main',
    );
    expect(teamMemberCount(dismissed)).toBe(0);
    expect(dismissed.some((agent) => agent.kind === 'discussion')).toBe(false);
  });
});

describe('live team events', () => {
  it('updates report status and discussion speaker', () => {
    const withMember = applyTeamToolResultToTeam(
      [main],
      'TeamCreate',
      { members: [{ name: 'Reviewer' }] },
      JSON.stringify({ members: [{ agentId: 'reviewer', identity: { name: 'Reviewer' } }] }),
      'main',
    );
    const status = applyAgentStatusToTeam(withMember, {
      agentId: 'reviewer',
      team: {
        assignedTask: 'Review footer',
        status: 'running',
        reportStatus: 'needs_decision',
        reportSummary: 'Which badge first?',
      },
    });
    expect(status.find((agent) => agent.agentId === 'reviewer')?.reportStatus).toBe('needs_decision');
    const discussion = applyDiscussionUpdateToTeam(status, {
      discussionAgentId: 'discuss-1',
      currentTurnAgentId: 'reviewer',
    });
    expect(discussion.find((agent) => agent.kind === 'discussion')?.discussionTurnAgentId).toBe(
      'reviewer',
    );
    expect(formatTeamAgentDetails(status.find((agent) => agent.agentId === 'reviewer')!)).toContain(
      'needs_decision',
    );
  });

  it('ignores a live turn hint from another department', () => {
    const withMember = applyTeamToolResultToTeam(
      [main],
      'TeamCreate',
      { members: [{ name: 'Reviewer' }] },
      JSON.stringify({ members: [{ agentId: 'reviewer', identity: { name: 'Reviewer' } }] }),
      'main',
    );
    const discussion = applyDiscussionUpdateToTeam(withMember, {
      discussionAgentId: 'discuss-1',
      currentTurnAgentId: 'reviewer',
      participantAgentIds: ['reviewer'],
    });
    const hijacked = applyDiscussionUpdateToTeam(discussion, {
      discussionAgentId: 'discuss-1',
      currentTurnAgentId: 'outsider',
    });
    expect(hijacked.find((agent) => agent.kind === 'discussion')?.discussionTurnAgentId).toBe(
      'reviewer',
    );
    expect(teamSpeakingLabel(hijacked)).toBe('Reviewer');
  });

  it('does not highlight a department sibling who is not in this round', () => {
    const agents: TeamAgentSnapshot[] = [
      main,
      { agentId: 'reviewer', kind: 'team', name: 'Reviewer', parentAgentId: 'main' },
      { agentId: 'coder', kind: 'team', name: 'Coder', parentAgentId: 'main' },
    ];
    const discussion = applyDiscussionUpdateToTeam(agents, {
      discussionAgentId: 'discuss-1',
      currentTurnAgentId: 'reviewer',
      participantAgentIds: ['reviewer'],
    });
    const hijacked = applyDiscussionUpdateToTeam(discussion, {
      discussionAgentId: 'discuss-1',
      currentTurnAgentId: 'coder',
    });
    expect(hijacked.find((agent) => agent.kind === 'discussion')?.discussionTurnAgentId).toBe(
      'reviewer',
    );
    expect(teamSpeakingLabel(hijacked)).toBe('Reviewer');
  });

  it('nests grandchildren under their department lead', () => {
    const agents: TeamAgentSnapshot[] = [
      main,
      { agentId: 'lead', kind: 'team', name: 'Lead', parentAgentId: 'main' },
      { agentId: 'child', kind: 'team', name: 'Child', parentAgentId: 'lead' },
    ];
    expect(flattenTeamTree(agents).map((row) => `${row.depth}:${row.agent.name}`)).toEqual([
      '0:Main',
      '1:Lead',
      '2:Child',
    ]);
  });

  it('formats speaking, blocked reports, and discussion speak labels', () => {
    const agents: TeamAgentSnapshot[] = [
      main,
      {
        agentId: 'reviewer',
        kind: 'team',
        name: 'Reviewer',
        parentAgentId: 'main',
        reportStatus: 'blocked',
      },
      {
        agentId: 'coder',
        kind: 'team',
        name: 'Coder',
        parentAgentId: 'main',
        reportStatus: 'needs_decision',
      },
      {
        agentId: 'discuss-1',
        kind: 'discussion',
        name: 'Discussion',
        parentAgentId: 'main',
        discussionTurnAgentId: 'reviewer',
        discussionParticipantAgentIds: ['reviewer', 'coder'],
      },
    ];
    expect(formatTeamRowSecondary(agents[1]!, agents)).toContain('speaking');
    expect(formatTeamRowSecondary(agents[1]!, agents)).toContain('blocked');
    expect(formatTeamRowSecondary(agents[2]!, agents)).toContain('needs decision');
    expect(formatTeamRowSecondary(agents[3]!, agents)).toBe('discuss · speak:Reviewer');
    expect(formatTeamReportsStatus(agents)).toBe('1 blocked, 1 needs decision');
    expect(teamHasBlockingReports(agents)).toBe(true);
    expect(formatTeamAgentDetails(agents[3]!, agents)).toContain('Speaking: Reviewer');
    expect(formatTeamAgentDetails(agents[3]!, agents)).toContain('Participants: Reviewer, Coder');
  });
});

describe('shouldPaintDiscussUtterance', () => {
  const agents: TeamAgentSnapshot[] = [
    main,
    { agentId: 'reviewer', kind: 'team', name: 'Reviewer', parentAgentId: 'main' },
    {
      agentId: 'btw-1',
      kind: 'independent',
      name: 'Side question',
      parentAgentId: 'main',
    },
    {
      agentId: 'discuss-1',
      kind: 'discussion',
      name: 'Discussion',
      parentAgentId: 'main',
      discussionTurnAgentId: 'reviewer',
      discussionParticipantAgentIds: ['reviewer'],
    },
  ];

  it('paints department members and TeamSpeak during Discuss', () => {
    expect(shouldPaintDiscussUtterance(agents, 'reviewer', { discussMode: true })).toBe(true);
    expect(
      shouldPaintDiscussUtterance(agents, 'reviewer', {
        discussMode: true,
        toolName: 'TeamSpeak',
      }),
    ).toBe(true);
  });

  it('still swallows independent / BTW agents', () => {
    expect(shouldPaintDiscussUtterance(agents, 'btw-1', { discussMode: true })).toBe(false);
    expect(
      shouldPaintDiscussUtterance(agents, 'btw-1', { discussMode: true, toolName: 'TeamSpeak' }),
    ).toBe(false);
  });

  it('does not paint partner assistant text when Discuss is off', () => {
    expect(shouldPaintDiscussUtterance(agents, 'reviewer', { discussMode: false })).toBe(false);
  });
});

describe('extractTeamSpeechText', () => {
  it('reads TeamSpeak messages and TeamDecide statements', () => {
    expect(extractTeamSpeechText('TeamSpeak', { message: 'Ship the footer first.' })).toBe(
      'Ship the footer first.',
    );
    expect(
      extractTeamSpeechText('TeamDecide', { action: 'start', statement: 'What is the risk?' }),
    ).toBe('What is the risk?');
    expect(extractTeamSpeechText('TeamDecide', { action: 'vote' })).toBeUndefined();
  });
});

describe('department pane helpers', () => {
  it('maps Discuss on to the meeting track and off to Chat', () => {
    expect(departmentPaneMode(true)).toBe('discuss');
    expect(departmentPaneMode(false)).toBe('chat');
  });

  it('places sibling Chat on the department lead, not on main itself', () => {
    expect(departmentChatLeaderId(main)).toBeUndefined();
    expect(
      departmentChatLeaderId({
        agentId: 'reviewer',
        kind: 'team',
        name: 'Reviewer',
        parentAgentId: 'main',
      }),
    ).toBe('main');
  });

  it('reads department chat history from resume metadata', () => {
    const messages = teamChatMessagesFromMetadata(
      {
        agents: {
          main: {
            chat: {
              messages: [
                { messageId: 1, agentId: 'reviewer', name: 'Reviewer', message: 'Taking the footer.' },
              ],
            },
          },
        },
      },
      'main',
    );
    expect(messages).toEqual([
      expect.objectContaining({ messageId: 1, agentId: 'reviewer', message: 'Taking the footer.' }),
    ]);
  });
});

describe('formatTeamAgentDetails speech', () => {
  it('appends this-round Discuss speech under the member card', () => {
    const reviewer: TeamAgentSnapshot = {
      agentId: 'reviewer',
      kind: 'team',
      name: 'Reviewer',
      parentAgentId: 'main',
      role: 'code review',
    };
    const details = formatTeamAgentDetails(reviewer, [main, reviewer], ['Drop the tips first.']);
    expect(details).toContain('Role: code review');
    expect(details).toContain('Recent speech:');
    expect(details).toContain('Drop the tips first.');
  });
});
