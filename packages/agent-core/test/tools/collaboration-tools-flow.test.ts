/**
 * Isolated mock flows for every Team* / Session* collaboration tool.
 *
 * Each describe covers one tool on its own: input schema, tool → host wiring,
 * and the SessionSubagentHost path against a mocked Session.
 */

import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../src/agent';
import type { Session, TeamDiscussionMeta } from '../../src/session';
import {
  SessionSubagentHost,
  type TeamDiscussionResult,
} from '../../src/session/subagent-host';
import { compileToolArgsValidator, validateToolArgs } from '../../src/tools/args-validator';
import {
  TeamAssignInputSchema,
  TeamAssignTool,
  TeamBroadcastInputSchema,
  TeamBroadcastTool,
  TeamChatInputSchema,
  TeamChatTool,
  TeamCreateInputSchema,
  TeamCreateTool,
  TeamDecideInputSchema,
  TeamDecideTool,
  TeamDismissInputSchema,
  TeamDismissTool,
  TeamDMInputSchema,
  TeamDMTool,
  TeamDiscussInviteTool,
  TeamDiscussKickTool,
  TeamSpeakInputSchema,
  TeamSpeakTool,
  TeamUpdateInputSchema,
  TeamUpdateTool,
} from '../../src/tools/builtin/collaboration/team';
import { TeamStatusInputSchema, TeamStatusTool } from '../../src/tools/builtin/collaboration/team-status';
import {
  SessionGraphInputSchema,
  SessionGraphTool,
  SessionMountInputSchema,
  SessionMountTool,
  SessionSearchInputSchema,
  SessionSearchTool,
  SessionUnmountInputSchema,
  SessionUnmountTool,
} from '../../src/tools/builtin/collaboration/session-topology';
import { executeTool } from './fixtures/execute-tool';
import { toolContentString } from './fixtures/fake-kaos';

const signal = new AbortController().signal;

function context<Input>(args: Input) {
  return { turnId: '0', toolCallId: 'call_1', args, signal };
}

function mockTeamHost<T extends Partial<SessionSubagentHost>>(
  host: T,
): T & SessionSubagentHost {
  return host as unknown as T & SessionSubagentHost;
}

function jsonOutput(result: { output?: unknown; isError?: boolean }): unknown {
  expect(result.isError).not.toBe(true);
  return JSON.parse(toolContentString(result as { output: string }));
}

function flowSession(parts: Record<string, unknown> = {}): Session {
  return {
    metadata: { title: 'Lead', agents: {} },
    options: { id: 'sess_lead' },
    assertTeamManager: vi.fn(),
    getAgentMetadata: vi.fn(() => undefined),
    teamMemberMetadata: vi.fn(() => []),
    parentSessionId: vi.fn(() => undefined),
    listDepartmentChildIds: vi.fn(() => []),
    listDepartmentSiblingIds: vi.fn(() => []),
    ensureAgentResumed: vi.fn(),
    ...parts,
  } as unknown as Session;
}

function memberMeta(name: string) {
  return {
    homedir: `/${name}`,
    type: 'sub' as const,
    parentAgentId: 'main',
    kind: 'team' as const,
    teamLeaderAgentId: 'main',
    name,
    role: name,
    mandate: `${name} mandate.`,
  };
}

function busyAgent(steer = vi.fn(() => null)): Agent {
  return {
    fullCompaction: { isCompacting: false, waitForCompletion: async () => undefined },
    turn: {
      hasActiveTurn: true,
      prompt: vi.fn(),
      steer,
      requestPrompt: vi.fn(() => ({ status: 'busy', activeTurnId: 1 })),
    },
  } as unknown as Agent;
}

const reviewerIdentity = {
  name: 'Reviewer',
  role: 'reviewer',
  mandate: 'Review behavior before changes.',
};

function discussionMeta(overrides: Partial<TeamDiscussionMeta> = {}): TeamDiscussionMeta {
  return {
    participantAgentIds: ['sess_reviewer'],
    status: 'active',
    topic: 'Cache key',
    startedAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  };
}

function discussionResult(overrides: Partial<TeamDiscussionResult> = {}): TeamDiscussionResult {
  return {
    discussionAgentId: 'agent-discussion',
    discussion: discussionMeta(),
    statements: [],
    votes: [],
    ...overrides,
  };
}

describe('TeamCreate flow', () => {
  const members = [reviewerIdentity];

  it('rejects incomplete identities and hires a child Session', async () => {
    expect(TeamCreateInputSchema.safeParse({ members }).success).toBe(true);
    expect(TeamCreateInputSchema.safeParse({ members: [] }).success).toBe(false);
    expect(TeamCreateInputSchema.safeParse({
      members: [{ name: 'Reviewer', role: 'reviewer' }],
    }).success).toBe(false);
    expect(TeamCreateInputSchema.safeParse({
      members: [{ ...reviewerIdentity, title: 'legacy' }],
    }).success).toBe(false);

    const createTeam = vi.fn(async () => [{
      agentId: 'sess_reviewer',
      sessionId: 'sess_reviewer',
      identity: reviewerIdentity,
    }]);
    const result = await executeTool(
      new TeamCreateTool(mockTeamHost({ createTeam })),
      context({ members }),
    );
    expect(jsonOutput(result)).toEqual({
      members: [{
        agent_id: 'sess_reviewer',
        session_id: 'sess_reviewer',
        identity: reviewerIdentity,
      }],
    });
    expect(createTeam).toHaveBeenCalledWith(members);
  });

  it('host flow hires a mounted child Session and returns its session id', async () => {
    const createMountedChild = vi.fn(async () => ({
      sessionId: 'sess_Reviewer',
      agentId: 'sess_Reviewer',
    }));
    const host = new SessionSubagentHost(flowSession({
      createMountedChild,
      teamMemberMetadata: vi.fn(() => []),
    }), 'main');
    const [member] = await host.createTeam([reviewerIdentity]);
    expect(member).toEqual({
      agentId: 'sess_Reviewer',
      sessionId: 'sess_Reviewer',
      identity: reviewerIdentity,
    });
    expect(createMountedChild).toHaveBeenCalledWith({
      parentSessionId: 'sess_lead',
      identity: reviewerIdentity,
      teamLeaderAgentId: 'main',
    });
  });
});

describe('TeamDismiss flow', () => {
  it('dismisses by session id and forwards confirm_active', async () => {
    expect(TeamDismissInputSchema.safeParse({
      agent_ids: ['sess_reviewer'],
      reason: 'Role retired.',
    }).success).toBe(true);
    expect(TeamDismissInputSchema.safeParse({
      agent_ids: [],
      reason: 'Role retired.',
    }).success).toBe(false);

    const dismissTeam = vi.fn(async () => undefined);
    const result = await executeTool(
      new TeamDismissTool(mockTeamHost({ dismissTeam })),
      context({
        agent_ids: ['sess_reviewer', 'frontend'],
        reason: 'Role retired.',
        confirm_active: true,
      }),
    );
    expect(jsonOutput(result)).toEqual({ dismissed: ['sess_reviewer', 'frontend'] });
    expect(dismissTeam).toHaveBeenCalledWith(
      ['sess_reviewer', 'frontend'],
      'Role retired.',
      true,
    );
  });

  it('host flow resolves a member name before dismissing', async () => {
    const dismissTeamMembers = vi.fn(async () => undefined);
    const host = new SessionSubagentHost(flowSession({
      dismissTeamMembers,
      teamMemberMetadata: vi.fn(() => [['sess_reviewer', memberMeta('Reviewer')]]),
    }), 'main');
    await host.dismissTeam(['Reviewer'], 'Role retired.', false);
    expect(dismissTeamMembers).toHaveBeenCalledWith(
      'main',
      ['sess_reviewer'],
      'Role retired.',
      false,
    );
  });
});

describe('TeamUpdate flow', () => {
  it('patches self or a named member without starting a turn', async () => {
    expect(TeamUpdateInputSchema.safeParse({ name: 'Lead reviewer' }).success).toBe(true);
    expect(TeamUpdateInputSchema.safeParse({ tags: ['review'] }).success).toBe(true);
    expect(TeamUpdateInputSchema.safeParse({}).success).toBe(false);

    const updateTeamIdentity = vi.fn(async () => undefined);
    const tool = new TeamUpdateTool(mockTeamHost({ updateTeamIdentity }));
    const self = await executeTool(tool, context({ name: 'Lead reviewer', tags: ['review'] }));
    expect(jsonOutput(self)).toEqual({ updated: true, agent_id: null });
    expect(updateTeamIdentity).toHaveBeenCalledWith({
      agentId: undefined,
      name: 'Lead reviewer',
      role: undefined,
      mandate: undefined,
      tags: ['review'],
    });

    const member = await executeTool(tool, context({
      agent_id: 'frontend',
      role: 'lead-reviewer',
      mandate: 'Own the review bar.',
    }));
    expect(jsonOutput(member)).toEqual({ updated: true, agent_id: 'frontend' });
    expect(updateTeamIdentity).toHaveBeenLastCalledWith({
      agentId: 'frontend',
      name: undefined,
      role: 'lead-reviewer',
      mandate: 'Own the review bar.',
      tags: undefined,
    });
  });

  it('host flow writes identity onto the child Session', async () => {
    const updateSessionIdentity = vi.fn(async () => undefined);
    const host = new SessionSubagentHost(flowSession({
      updateSessionIdentity,
      teamMemberMetadata: vi.fn(() => [['sess_reviewer', memberMeta('Reviewer')]]),
    }), 'main');
    await host.updateTeamIdentity({
      agentId: 'Reviewer',
      name: 'Lead reviewer',
      tags: ['review'],
    });
    expect(updateSessionIdentity).toHaveBeenCalledWith({
      sessionId: 'sess_reviewer',
      name: 'Lead reviewer',
      role: undefined,
      mandate: undefined,
      tags: ['review'],
    });
  });
});

describe('TeamAssign flow', () => {
  it('maps agent_id to session addressing and starts assigned work', async () => {
    expect(TeamAssignInputSchema.safeParse({
      assignments: [{ agent_id: 'sess_reviewer', task: 'Review tests.' }],
    }).success).toBe(true);
    expect(TeamAssignInputSchema.safeParse({
      assignments: [{ agent_id: 'sess_reviewer', task: '' }],
    }).success).toBe(false);

    const assignTeam = vi.fn(async () => [
      { agentId: 'sess_reviewer', task: 'Review tests.', turnId: 7 },
      { agentId: 'sess_backend', task: null },
    ]);
    const result = await executeTool(
      new TeamAssignTool(mockTeamHost({ assignTeam })),
      context({
        assignments: [
          { agent_id: 'Reviewer', task: 'Review tests.' },
          { agent_id: 'sess_backend', task: null },
        ],
      }),
    );
    expect(jsonOutput(result)).toEqual({
      assignments: [
        { agentId: 'sess_reviewer', task: 'Review tests.', turnId: 7 },
        { agentId: 'sess_backend', task: null },
      ],
    });
    expect(assignTeam).toHaveBeenCalledWith(
      [
        { agentId: 'Reviewer', task: 'Review tests.' },
        { agentId: 'sess_backend', task: null },
      ],
      signal,
    );
  });

  it('host flow resolves names then assigns every member', async () => {
    const agent = {
      fullCompaction: { isCompacting: false, waitForCompletion: async () => undefined },
      turn: {
        hasActiveTurn: false,
        prompt: vi.fn(),
        steer: vi.fn(),
        requestPrompt: vi.fn(() => ({ status: 'started', turnId: 7 })),
      },
    } as unknown as Agent;
    const assignTeamTasks = vi.fn(async () => [{
      agentId: 'sess_reviewer',
      task: 'Review tests.',
      agent,
      assignedAt: 'lease-1',
    }]);
    const host = new SessionSubagentHost(flowSession({
      assignTeamTasks,
      teamMemberMetadata: vi.fn(() => [['sess_reviewer', memberMeta('Reviewer')]]),
      ensureAgentResumed: vi.fn(async () => agent),
      notifyRunningTeamMember: vi.fn(),
    }), 'main');
    const assigned = await host.assignTeam(
      [{ agentId: 'Reviewer', task: 'Review tests.' }],
      signal,
    );
    expect(assignTeamTasks).toHaveBeenCalledWith(
      'main',
      [{ agentId: 'sess_reviewer', task: 'Review tests.' }],
    );
    expect(assigned).toEqual([{ agentId: 'sess_reviewer', task: 'Review tests.', turnId: 7 }]);
  });
});

describe('TeamBroadcast flow', () => {
  it('wakes every member and returns their session ids', async () => {
    expect(TeamBroadcastInputSchema.safeParse({ message: 'Sync point.' }).success).toBe(true);
    expect(TeamBroadcastInputSchema.safeParse({ message: '' }).success).toBe(false);

    const broadcastTeam = vi.fn(async () => ['sess_reviewer', 'sess_backend']);
    const result = await executeTool(
      new TeamBroadcastTool(mockTeamHost({ broadcastTeam })),
      context({ message: 'Sync point.' }),
    );
    expect(jsonOutput(result)).toEqual({ recipients: ['sess_reviewer', 'sess_backend'] });
    expect(broadcastTeam).toHaveBeenCalledWith('Sync point.', signal);
  });

  it('host flow steers every department member', async () => {
    const firstSteer = vi.fn(() => null);
    const secondSteer = vi.fn(() => null);
    const host = new SessionSubagentHost(flowSession({
      teamMemberMetadata: vi.fn(() => [
        ['sess_reviewer', memberMeta('Reviewer')],
        ['sess_backend', memberMeta('backend')],
      ]),
      ensureAgentResumed: vi.fn(async (id: string) => (
        id === 'sess_reviewer' ? busyAgent(firstSteer) : busyAgent(secondSteer)
      )),
    }), 'main');
    await expect(host.broadcastTeam('Sync point.', signal))
      .resolves.toEqual(['sess_reviewer', 'sess_backend']);
    expect(firstSteer).toHaveBeenCalledTimes(1);
    expect(secondSteer).toHaveBeenCalledTimes(1);
  });
});

describe('TeamDM flow', () => {
  it('sends ordinary peer mail and parent reports separately', async () => {
    expect(TeamDMInputSchema.safeParse({
      agent_id: 'parent',
      message: 'Need a decision.',
    }).success).toBe(true);
    expect(TeamDMInputSchema.safeParse({
      agent_id: 'parent',
      message: 'done',
      report_status: 'completed',
    }).success).toBe(false);
    expect(TeamDMInputSchema.safeParse({
      agent_id: 'parent',
      message: 'done',
      report_status: 'completed',
      report_summary: 'Checks passed.',
    }).success).toBe(true);

    const directMessage = vi.fn(async () => ({ delivered: true as const, processing: 'completed' as const }));
    const tool = new TeamDMTool(mockTeamHost({ directMessage }));

    const ordinary = await executeTool(tool, context({
      agent_id: 'frontend',
      message: 'I will touch parser.ts.',
    }));
    expect(jsonOutput(ordinary)).toEqual({
      recipient: 'frontend',
      delivery: { delivered: true, processing: 'completed' },
    });
    expect(directMessage).toHaveBeenCalledWith(
      'frontend',
      'I will touch parser.ts.',
      signal,
      undefined,
    );

    await executeTool(tool, context({
      agent_id: 'parent',
      message: 'Parser tests pass.',
      report_status: 'completed',
      report_summary: 'Checks passed.',
    }));
    expect(directMessage).toHaveBeenLastCalledWith(
      'parent',
      'Parser tests pass.',
      signal,
      { status: 'completed', summary: 'Checks passed.' },
    );
  });

  it('host flow DMs a sibling by display name', async () => {
    const steer = vi.fn(() => null);
    const host = new SessionSubagentHost(flowSession({
      options: { id: 'sess_self', departmentRuntime: {
        ensureMain: vi.fn(async () => busyAgent(steer)),
        memberSnapshot: vi.fn(async () => undefined),
      } },
      parentSessionId: vi.fn(() => 'sess_parent'),
      listDepartmentSiblingIds: vi.fn(() => ['sess_frontend']),
      getAgentMetadata: vi.fn((id: string) => (
        id === 'sess_frontend' ? memberMeta('frontend') : undefined
      )),
    }), 'main');
    await expect(host.directMessage('frontend', 'I will touch parser.ts.', signal))
      .resolves.toEqual({ delivered: true, processing: 'queued' });
    expect(steer).toHaveBeenCalledTimes(1);
  });
});

describe('TeamChat flow', () => {
  it('posts a mentioned sibling message and rejects a mismatched schema', async () => {
    expect(TeamChatInputSchema.safeParse({
      message: '@frontend Cache key changed.',
      mentions: ['frontend'],
    }).success).toBe(true);
    expect(TeamChatInputSchema.safeParse({
      message: '@all Sync.',
      mentions: [],
    }).success).toBe(false);

    const sendChatMessage = vi.fn(async () => ({
      messageId: 9,
      agentId: 'sess_self',
      name: 'Sender',
      message: '@frontend Cache key changed.',
      mentions: ['sess_frontend'],
      sentAt: '2026-08-20T00:00:00.000Z',
    }));
    const result = await executeTool(
      new TeamChatTool(mockTeamHost({ sendChatMessage })),
      context({
        message: '@frontend Cache key changed.',
        mentions: ['frontend'],
      }),
    );
    expect(jsonOutput(result)).toEqual({
      posted: {
        messageId: 9,
        agentId: 'sess_self',
        name: 'Sender',
        message: '@frontend Cache key changed.',
        mentions: ['sess_frontend'],
        sentAt: '2026-08-20T00:00:00.000Z',
      },
    });
    expect(sendChatMessage).toHaveBeenCalledWith(
      '@frontend Cache key changed.',
      ['frontend'],
      signal,
    );
  });

  it('host flow delivers Chat by sibling display name', async () => {
    const steer = vi.fn(() => null);
    const postChat = vi.fn(async () => ({
      messageId: 3,
      agentId: 'sess_self',
      name: 'Sender',
      message: '@frontend Cache key changed.',
      mentions: ['sess_frontend'],
      sentAt: '2026-08-20T00:00:00.000Z',
    }));
    const host = new SessionSubagentHost(flowSession({
      options: {
        id: 'sess_self',
        departmentRuntime: {
          postChat,
          memberSnapshot: vi.fn(async (id: string) => (
            id === 'sess_frontend'
              ? { sessionId: id, name: 'frontend', role: 'frontend', mandate: 'Ship UI.' }
              : undefined
          )),
          ensureMain: vi.fn(async () => busyAgent(steer)),
        },
      },
      parentSessionId: vi.fn(() => 'sess_parent'),
      listDepartmentSiblingIds: vi.fn(() => ['sess_frontend']),
      getAgentMetadata: vi.fn((id: string) => (
        id === 'main' ? { name: 'Sender' } : undefined
      )),
    }), 'main');
    const record = await host.sendChatMessage('@frontend Cache key changed.', ['frontend'], signal);
    expect(record.mentions).toEqual(['sess_frontend']);
    expect(postChat).toHaveBeenCalledWith(
      'sess_parent',
      'sess_self',
      'Sender',
      '@frontend Cache key changed.',
      ['sess_frontend'],
    );
    expect(steer).toHaveBeenCalledTimes(1);
  });
});

describe('TeamStatus flow', () => {
  it('returns members, colleagues, and the parent session id', async () => {
    expect(TeamStatusInputSchema.safeParse({}).success).toBe(true);
    expect(TeamStatusInputSchema.safeParse({ extra: true }).success).toBe(false);

    const getTeamStatus = vi.fn(async () => ({
      agent_id: 'sess_self',
      parent_agent_id: 'sess_parent',
      member_count: 1,
      message: '1 member(s) hired by you; 1 peer(s) in your own department, reachable directly with TeamChat or TeamDM.',
      members: [{
        agent_id: 'sess_child',
        session_id: 'sess_child',
        name: 'Intern',
        role: 'intern',
        mandate: 'Draft tests.',
        status: 'idle' as const,
        assigned_task: null,
        report_status: 'unreported' as const,
        report_summary: null,
        report_received: false,
      }],
      colleagues: [{
        agent_id: 'sess_frontend',
        name: 'frontend',
        role: 'frontend',
        status: 'running' as const,
        assigned_task: 'Ship UI.',
        report_status: 'unreported' as const,
      }],
    }));
    const result = await executeTool(
      new TeamStatusTool(mockTeamHost({ getTeamStatus })),
      context({}),
    );
    expect(jsonOutput(result)).toMatchObject({
      agent_id: 'sess_self',
      parent_agent_id: 'sess_parent',
      member_count: 1,
      members: [{ agent_id: 'sess_child', session_id: 'sess_child' }],
      colleagues: [{ agent_id: 'sess_frontend', name: 'frontend' }],
    });
    expect(getTeamStatus).toHaveBeenCalledWith();
  });

  it('host flow lists hired child Sessions and their running state', async () => {
    const host = new SessionSubagentHost(flowSession({
      refreshDepartmentDirectory: vi.fn(async () => undefined),
      teamMemberMetadata: vi.fn(() => [['sess_reviewer', memberMeta('Reviewer')]]),
      ensureAgentResumed: vi.fn(async () => busyAgent()),
      notifyRunningTeamMember: vi.fn(),
    }), 'main');
    await expect(host.getTeamStatus()).resolves.toMatchObject({
      agent_id: 'sess_lead',
      member_count: 1,
      members: [{
        agent_id: 'sess_reviewer',
        name: 'Reviewer',
        status: 'running',
        session_id: 'sess_reviewer',
      }],
    });
  });
});

describe('TeamDiscussInvite flow', () => {
  it('invites members by session id or name into the active round', async () => {
    const inviteToDiscussion = vi.fn(async () => discussionMeta({
      participantAgentIds: ['sess_reviewer', 'sess_backend'],
    }));
    const tool = new TeamDiscussInviteTool(mockTeamHost({ inviteToDiscussion }));
    const validator = compileToolArgsValidator(tool.parameters);
    expect(validateToolArgs(validator, { agent_ids: ['sess_backend'] })).toBeNull();
    expect(validateToolArgs(validator, { agent_ids: [] })).not.toBeNull();

    const result = await executeTool(tool, context({ agent_ids: ['backend'] }));
    expect(jsonOutput(result)).toEqual({
      participant_agent_ids: ['sess_reviewer', 'sess_backend'],
      status: 'active',
      topic: 'Cache key',
    });
    expect(inviteToDiscussion).toHaveBeenCalledWith(['backend']);
  });

  it('host flow invites a member by display name', async () => {
    const discussion = discussionMeta({ participantAgentIds: ['sess_reviewer'] });
    const updateTeamDiscussion = vi.fn(async (
      _id: string,
      patch: { participantAgentIds: readonly string[] },
    ) => discussionMeta({ ...discussion, participantAgentIds: patch.participantAgentIds }));
    const host = new SessionSubagentHost(flowSession({
      assertTeamDiscussionMode: vi.fn(async () => undefined),
      activeTeamDiscussion: vi.fn(() => ['agent-discussion', {
        ...memberMeta('Discussion'),
        discussion,
      }]),
      teamMemberMetadata: vi.fn(() => [
        ['sess_reviewer', memberMeta('Reviewer')],
        ['sess_backend', memberMeta('backend')],
      ]),
      updateTeamDiscussion,
      ensureAgentResumed: vi.fn(async () => ({
        context: { history: [], appendUserMessage: vi.fn() },
      })),
    }), 'main');
    await expect(host.inviteToDiscussion(['backend'])).resolves.toMatchObject({
      participantAgentIds: ['sess_reviewer', 'sess_backend'],
    });
  });
});

describe('TeamDiscussKick flow', () => {
  it('removes a participant without dismissing the member', async () => {
    const kickFromDiscussion = vi.fn(async () => discussionMeta({
      participantAgentIds: ['sess_reviewer'],
    }));
    const tool = new TeamDiscussKickTool(mockTeamHost({ kickFromDiscussion }));
    const result = await executeTool(tool, context({ agent_ids: ['sess_backend'] }));
    expect(jsonOutput(result)).toEqual({
      participant_agent_ids: ['sess_reviewer'],
      status: 'active',
      topic: 'Cache key',
    });
    expect(kickFromDiscussion).toHaveBeenCalledWith(['sess_backend']);
  });

  it('host flow kicks a participant by display name without dismissing', async () => {
    const discussion = discussionMeta({
      participantAgentIds: ['sess_reviewer', 'sess_backend'],
    });
    const updateTeamDiscussion = vi.fn(async (
      _id: string,
      patch: { participantAgentIds: readonly string[] },
    ) => discussionMeta({ ...discussion, participantAgentIds: patch.participantAgentIds }));
    const host = new SessionSubagentHost(flowSession({
      assertTeamDiscussionMode: vi.fn(async () => undefined),
      activeTeamDiscussion: vi.fn(() => ['agent-discussion', {
        ...memberMeta('Discussion'),
        discussion,
      }]),
      teamMemberMetadata: vi.fn(() => [
        ['sess_reviewer', memberMeta('Reviewer')],
        ['sess_backend', memberMeta('backend')],
      ]),
      updateTeamDiscussion,
      ensureAgentResumed: vi.fn(async () => ({
        context: { history: [], appendUserMessage: vi.fn() },
      })),
    }), 'main');
    await expect(host.kickFromDiscussion(['backend'])).resolves.toMatchObject({
      participantAgentIds: ['sess_reviewer'],
    });
  });
});

describe('TeamDecide flow', () => {
  it('starts, continues, votes, and archives through the chair API', async () => {
    expect(TeamDecideInputSchema.safeParse({
      action: 'start',
      topic: 'Cache key',
      statement: 'What is the strongest objection?',
    }).success).toBe(true);
    expect(TeamDecideInputSchema.safeParse({
      action: 'start',
      statement: 'Lead first.',
    }).success).toBe(false);
    expect(TeamDecideInputSchema.safeParse({ action: 'continue' }).success).toBe(false);
    expect(TeamDecideInputSchema.safeParse({
      action: 'continue',
      statement: 'Next slice.',
    }).success).toBe(true);
    expect(TeamDecideInputSchema.safeParse({ action: 'vote' }).success).toBe(true);
    expect(TeamDecideInputSchema.safeParse({ action: 'archive' }).success).toBe(true);

    const decideTeamDiscussion = vi.fn(async (
      action: 'start' | 'continue' | 'archive' | 'vote',
    ) => discussionResult({
      statements: action === 'start'
        ? [{ agentId: 'sess_parent', statement: 'What is the strongest objection?', skipped: false }]
        : [],
      votes: action === 'vote'
        ? [{ agentId: 'sess_reviewer', vote: 'proceed' }]
        : [],
      discussion: discussionMeta({
        status: action === 'archive' ? 'archived' : 'active',
      }),
    }));
    const tool = new TeamDecideTool(mockTeamHost({ decideTeamDiscussion }));

    const started = await executeTool(tool, context({
      action: 'start',
      topic: 'Cache key',
      statement: 'What is the strongest objection?',
      participant_agent_ids: ['sess_reviewer'],
    }));
    expect(jsonOutput(started)).toMatchObject({
      discussion_agent_id: 'agent-discussion',
      discussion: { status: 'active', topic: 'Cache key' },
      statements: [{ agentId: 'sess_parent', skipped: false }],
    });
    expect(decideTeamDiscussion).toHaveBeenCalledWith(
      'start',
      'Cache key',
      ['sess_reviewer'],
      signal,
      'What is the strongest objection?',
    );

    await executeTool(tool, context({ action: 'continue', statement: 'Next slice.' }));
    expect(decideTeamDiscussion).toHaveBeenLastCalledWith(
      'continue',
      undefined,
      undefined,
      signal,
      'Next slice.',
    );

    const voted = await executeTool(tool, context({ action: 'vote' }));
    expect(jsonOutput(voted)).toMatchObject({
      votes: [{ agentId: 'sess_reviewer', vote: 'proceed' }],
    });

    const archived = await executeTool(tool, context({ action: 'archive' }));
    expect(jsonOutput(archived)).toMatchObject({
      discussion: { status: 'archived' },
    });
  });

  it('host flow refuses to start Discuss with no members', async () => {
    const host = new SessionSubagentHost(flowSession({
      activeTeamDiscussion: vi.fn(() => undefined),
      teamMemberMetadata: vi.fn(() => []),
    }), 'main');
    await expect(host.decideTeamDiscussion(
      'start',
      'Cache key',
      undefined,
      signal,
      'What is the strongest objection?',
    )).rejects.toThrow('Cannot start a discussion with no participants');
  });

  it('host flow archives the active discussion', async () => {
    const discussion = discussionMeta();
    const updateTeamDiscussion = vi.fn(async () => discussionMeta({ status: 'archived' }));
    const transcript = {
      context: { history: [], appendUserMessage: vi.fn() },
      emitEvent: vi.fn(),
    };
    const host = new SessionSubagentHost(flowSession({
      activeTeamDiscussion: vi.fn(() => ['agent-discussion', {
        ...memberMeta('Discussion'),
        discussion,
      }]),
      lockTeamAssignments: vi.fn(async () => undefined),
      updateTeamDiscussion,
      ensureAgentResumed: vi.fn(async () => transcript),
    }), 'main');
    await expect(host.decideTeamDiscussion('archive', undefined, undefined, signal))
      .resolves.toMatchObject({
        discussionAgentId: 'agent-discussion',
        discussion: { status: 'archived' },
        statements: [],
        votes: [],
      });
    expect(updateTeamDiscussion).toHaveBeenCalledWith('agent-discussion', {
      participantAgentIds: ['sess_reviewer'],
      status: 'archived',
      topic: 'Cache key',
    });
  });
});

describe('TeamSpeak flow', () => {
  it('publishes one statement and stops the scheduled turn', async () => {
    expect(TeamSpeakInputSchema.safeParse({ message: 'Keep the cache key stable.' }).success).toBe(true);
    expect(TeamSpeakInputSchema.safeParse({ message: '' }).success).toBe(false);

    const speakInDiscussion = vi.fn(async () => ({
      discussionAgentId: 'agent-discussion',
      entryId: 4,
    }));
    const result = await executeTool(
      new TeamSpeakTool(mockTeamHost({ speakInDiscussion })),
      context({ message: 'Keep the cache key stable.' }),
    );
    expect(result).toMatchObject({ output: 'Statement published.', stopTurn: true });
    expect(speakInDiscussion).toHaveBeenCalledWith('Keep the cache key stable.');
  });

  it('host flow publishes the statement onto the discussion transcript', async () => {
    const publishTeamDiscussionStatement = vi.fn(async () => ({
      discussionAgentId: 'agent-discussion',
      entryId: 4,
    }));
    const host = new SessionSubagentHost(flowSession({
      publishTeamDiscussionStatement,
    }), 'main');
    await expect(host.speakInDiscussion('Keep the cache key stable.')).resolves.toEqual({
      discussionAgentId: 'agent-discussion',
      entryId: 4,
    });
    expect(publishTeamDiscussionStatement).toHaveBeenCalledWith(
      'main',
      'Keep the cache key stable.',
    );
  });
});

describe('SessionSearch flow', () => {
  it('searches the forest by title, role, or cwd', async () => {
    expect(SessionSearchInputSchema.safeParse({ query: 'review' }).success).toBe(true);
    expect(SessionSearchInputSchema.safeParse({}).success).toBe(true);

    const searchSessions = vi.fn(async () => [{
      sessionId: 'sess_reviewer',
      title: 'Reviewer',
      role: 'reviewer',
      cwd: '/workspace',
    }]);
    const result = await executeTool(
      new SessionSearchTool(mockTeamHost({ searchSessions })),
      context({ query: 'review' }),
    );
    expect(jsonOutput(result)).toEqual({
      hits: [{
        sessionId: 'sess_reviewer',
        title: 'Reviewer',
        role: 'reviewer',
        cwd: '/workspace',
      }],
    });
    expect(searchSessions).toHaveBeenCalledWith('review');
  });

  it('host flow searches through the session topology runtime', async () => {
    const searchSessions = vi.fn(async () => [{
      sessionId: 'sess_reviewer',
      title: 'Reviewer',
      role: 'reviewer',
    }]);
    const host = new SessionSubagentHost(flowSession({ searchSessions }), 'main');
    await expect(host.searchSessions('review')).resolves.toEqual([{
      sessionId: 'sess_reviewer',
      title: 'Reviewer',
      role: 'reviewer',
    }]);
  });
});

describe('SessionMount flow', () => {
  it('remounts under an explicit parent or the current session', async () => {
    expect(SessionMountInputSchema.safeParse({ session_id: 'sess_reviewer' }).success).toBe(true);
    expect(SessionMountInputSchema.safeParse({
      session_id: 'sess_reviewer',
      parent_session_id: 'sess_parent',
      role: 'reviewer',
      mandate: 'Review diffs.',
    }).success).toBe(true);

    const remountSession = vi.fn(async () => undefined);
    const tool = new SessionMountTool(mockTeamHost({
      remountSession,
      currentSessionId: () => 'sess_lead',
    }));

    const explicit = await executeTool(tool, context({
      session_id: 'sess_reviewer',
      parent_session_id: 'sess_parent',
      role: 'reviewer',
      mandate: 'Review diffs.',
    }));
    expect(jsonOutput(explicit)).toEqual({
      mounted: 'sess_reviewer',
      parent_session_id: 'sess_parent',
    });
    expect(remountSession).toHaveBeenCalledWith(
      'sess_reviewer',
      'sess_parent',
      'reviewer',
      'Review diffs.',
    );

    const implied = await executeTool(tool, context({ session_id: 'sess_reviewer' }));
    expect(jsonOutput(implied)).toEqual({
      mounted: 'sess_reviewer',
      parent_session_id: 'sess_lead',
    });
    expect(remountSession).toHaveBeenLastCalledWith(
      'sess_reviewer',
      'sess_lead',
      undefined,
      undefined,
    );
  });

  it('fails when no parent session id is available', async () => {
    const remountSession = vi.fn(async () => undefined);
    const tool = new SessionMountTool(mockTeamHost({
      remountSession,
      currentSessionId: () => undefined,
    }));
    await expect(executeTool(tool, context({ session_id: 'sess_reviewer' })))
      .rejects.toThrow('SessionMount requires parent_session_id.');
    expect(remountSession).not.toHaveBeenCalled();
  });

  it('host flow remounts onto the requested parent Session', async () => {
    const remountPeerSession = vi.fn(async () => undefined);
    const host = new SessionSubagentHost(flowSession({ remountPeerSession }), 'main');
    await host.remountSession('sess_reviewer', 'sess_lead', 'reviewer', 'Review diffs.');
    expect(remountPeerSession).toHaveBeenCalledWith(
      'sess_reviewer',
      'sess_lead',
      'reviewer',
      'Review diffs.',
    );
  });
});

describe('SessionUnmount flow', () => {
  it('detaches a child Session without deleting it', async () => {
    expect(SessionUnmountInputSchema.safeParse({ session_id: 'sess_reviewer' }).success).toBe(true);
    expect(SessionUnmountInputSchema.safeParse({}).success).toBe(false);

    const unmountSession = vi.fn(async () => undefined);
    const result = await executeTool(
      new SessionUnmountTool(mockTeamHost({ unmountSession })),
      context({ session_id: 'sess_reviewer' }),
    );
    expect(jsonOutput(result)).toEqual({ unmounted: 'sess_reviewer' });
    expect(unmountSession).toHaveBeenCalledWith('sess_reviewer');
  });

  it('host flow detaches without deleting the child Session', async () => {
    const unmountPeerSession = vi.fn(async () => undefined);
    const host = new SessionSubagentHost(flowSession({ unmountPeerSession }), 'main');
    await host.unmountSession('sess_reviewer');
    expect(unmountPeerSession).toHaveBeenCalledWith('sess_reviewer');
  });
});

describe('SessionGraph flow', () => {
  it('reads the Session forest topology', async () => {
    expect(SessionGraphInputSchema.safeParse({}).success).toBe(true);
    expect(SessionGraphInputSchema.safeParse({ extra: true }).success).toBe(false);

    const sessionGraph = vi.fn(async () => ({
      nodes: [
        { id: 'sess_lead', title: 'Lead' },
        { id: 'sess_reviewer', title: 'Reviewer', parentSessionId: 'sess_lead' },
      ],
    }));
    const result = await executeTool(
      new SessionGraphTool(mockTeamHost({ sessionGraph })),
      context({}),
    );
    expect(jsonOutput(result)).toEqual({
      nodes: [
        { id: 'sess_lead', title: 'Lead' },
        { id: 'sess_reviewer', title: 'Reviewer', parentSessionId: 'sess_lead' },
      ],
    });
    expect(sessionGraph).toHaveBeenCalledWith();
  });

  it('host flow reads the mount forest', async () => {
    const readSessionGraph = vi.fn(async () => ({
      nodes: [
        { id: 'sess_lead', title: 'Lead' },
        { id: 'sess_reviewer', title: 'Reviewer', parentSessionId: 'sess_lead' },
      ],
    }));
    const host = new SessionSubagentHost(flowSession({ readSessionGraph }), 'main');
    await expect(host.sessionGraph()).resolves.toEqual({
      nodes: [
        { id: 'sess_lead', title: 'Lead' },
        { id: 'sess_reviewer', title: 'Reviewer', parentSessionId: 'sess_lead' },
      ],
    });
  });
});
