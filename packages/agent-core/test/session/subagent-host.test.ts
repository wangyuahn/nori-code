import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { testKaos } from '../fixtures/test-kaos';
import { APIStatusError, type Message, type ToolCall } from '@nori-code/kosong';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Agent, AgentOptions } from '../../src/agent';
import type { BackgroundTaskInfo } from '../../src/agent/background';
import type { BackgroundTask } from '../../src/agent/background/task';
import { AGENT_WIRE_PROTOCOL_VERSION } from '../../src/agent/records';
import type { ResolvedAgentProfile } from '../../src/profile';
import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { collectGitContext } from '../../src/session/git-context';
import {
  SessionSubagentHost,
  type QueuedSubagentTask,
} from '../../src/session/subagent-host';
import type { NoriMemoryProvider } from '../../src/tools/builtin/nori/types';
import { abortError, userCancellationReason } from '../../src/utils/abort';
import { testAgent, type AgentTestContext } from '../agent/harness/agent';
import { createFakeKaos } from '../tools/fixtures/fake-kaos';
import { executeTool } from '../tools/fixtures/execute-tool';

// Git context collection is exercised in git-context.test.ts; here it is
// mocked so subagent-host tests stay deterministic and assert only the
// wiring (explore subagents get the block prepended, others do not).
vi.mock('../../src/session/git-context', () => ({
  collectGitContext: vi.fn(async () => ''),
}));

const signal = new AbortController().signal;
const tempDirs: string[] = [];
type GenerateFn = NonNullable<AgentOptions['generate']>;

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('SessionSubagentHost', () => {
  it('treats a member response without TeamSpeak as a private abstention', async () => {
    const transcript = testAgent({ type: 'sub' });
    const member = testAgent({ type: 'sub' });
    member.configure();
    member.mockNextResponse({ type: 'text', text: 'private model output that must not be shared' });
    const discussionMeta = {
      homedir: '/discussion',
      type: 'sub' as const,
      parentAgentId: 'main',
      kind: 'sub' as const,
      teamLeaderAgentId: 'main',
      discussion: {
        participantAgentIds: ['agent-review'],
        status: 'active' as const,
        topic: 'Review the cache path',
        startedAt: '2026-08-17T00:00:00.000Z',
        updatedAt: '2026-08-17T00:00:00.000Z',
      },
    };
    const memberMeta = {
      homedir: '/review',
      type: 'sub' as const,
      parentAgentId: 'main',
      kind: 'team' as const,
      teamLeaderAgentId: 'main',
      name: 'Reviewer',
    };
    const session = {
      metadata: { agents: { 'agent-discussion': discussionMeta, 'agent-review': memberMeta } },
      activeTeamDiscussion: vi.fn(() => ['agent-discussion', discussionMeta] as const),
      getAgentMetadata: vi.fn((id: string) =>
        id === 'agent-discussion' ? discussionMeta : id === 'agent-review' ? memberMeta : undefined,
      ),
      ensureAgentResumed: vi.fn(async (id: string) =>
        id === 'agent-discussion' ? transcript.agent : member.agent,
      ),
      unreadTeamDiscussionStatements: vi.fn(async () => ({ statements: [], cursor: 0 })),
      acknowledgeTeamDiscussionStatements: vi.fn(async () => undefined),
      beginTeamDiscussionTurn: vi.fn(),
      endTeamDiscussionTurn: vi.fn(),
      consumeTeamDiscussionSpeak: vi.fn(() => undefined),
    } as unknown as Session;
    const host = new SessionSubagentHost(session, 'main');

    const result = await host.decideTeamDiscussion('continue', undefined, undefined, signal);

    expect(result.statements).toEqual([{ agentId: 'agent-review', skipped: true }]);
    const modelInput = JSON.stringify(member.lastLlmInput());
    expect(modelInput).toContain('Your scheduled discussion turn has started.');
    expect(modelInput).not.toContain('Discuss this topic as a team partner');
    expect(modelInput).not.toContain('There are no unread shared statements');
    expect(transcript.agent.context.history).not.toContainEqual(
      expect.objectContaining({ content: expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('private model output') }),
      ]) }),
    );
  });

  it('injects shared discussion deltas only when each participant is scheduled', async () => {
    const transcript = testAgent({ type: 'sub' });
    const first = testAgent({ type: 'sub' });
    const second = testAgent({ type: 'sub' });
    first.configure();
    second.configure();
    first.mockNextResponse({ type: 'text', text: 'The first member abstains.' });
    second.mockNextResponse({ type: 'text', text: 'The second member abstains.' });
    const discussionMeta = {
      homedir: '/discussion',
      type: 'sub' as const,
      parentAgentId: 'main',
      kind: 'sub' as const,
      teamLeaderAgentId: 'main',
      discussion: {
        participantAgentIds: ['agent-first', 'agent-second'],
        status: 'active' as const,
        topic: 'Review the cache path',
        startedAt: '2026-08-17T00:00:00.000Z',
        updatedAt: '2026-08-17T00:00:00.000Z',
      },
    };
    const memberMeta = (name: string) => ({
      homedir: `/${name.toLowerCase()}`,
      type: 'sub' as const,
      parentAgentId: 'main',
      kind: 'team' as const,
      teamLeaderAgentId: 'main',
      name,
    });
    const firstMeta = memberMeta('First');
    const secondMeta = memberMeta('Second');
    const unreadTeamDiscussionStatements = vi.fn(async (
      _discussionAgentId: string,
      recipientAgentId: string,
    ) => recipientAgentId === 'agent-second'
      ? {
          statements: [{
            entryId: 1,
            agentId: 'agent-first',
            name: 'First',
            message: 'Only the scheduled recipient may receive this shared statement.',
          }],
          cursor: 1,
        }
      : { statements: [], cursor: 0 });
    const session = {
      metadata: {
        agents: {
          'agent-discussion': discussionMeta,
          'agent-first': firstMeta,
          'agent-second': secondMeta,
        },
      },
      activeTeamDiscussion: vi.fn(() => ['agent-discussion', discussionMeta] as const),
      getAgentMetadata: vi.fn((id: string) =>
        id === 'agent-discussion'
          ? discussionMeta
          : id === 'agent-first'
            ? firstMeta
            : id === 'agent-second'
              ? secondMeta
              : undefined,
      ),
      ensureAgentResumed: vi.fn(async (id: string) =>
        id === 'agent-discussion'
          ? transcript.agent
          : id === 'agent-first'
            ? first.agent
            : second.agent,
      ),
      unreadTeamDiscussionStatements,
      acknowledgeTeamDiscussionStatements: vi.fn(async () => undefined),
      beginTeamDiscussionTurn: vi.fn(),
      endTeamDiscussionTurn: vi.fn(),
      consumeTeamDiscussionSpeak: vi.fn(() => undefined),
    } as unknown as Session;
    const host = new SessionSubagentHost(session, 'main');

    await host.decideTeamDiscussion('continue', undefined, undefined, signal);

    const firstInput = JSON.stringify(first.lastLlmInput());
    const secondInput = JSON.stringify(second.lastLlmInput());
    expect(firstInput).toContain('Your scheduled discussion turn has started.');
    expect(firstInput).not.toContain('Only the scheduled recipient may receive this shared statement.');
    expect(secondInput).toContain('Only the scheduled recipient may receive this shared statement.');
    expect(unreadTeamDiscussionStatements).toHaveBeenNthCalledWith(1, 'agent-discussion', 'agent-first');
    expect(unreadTeamDiscussionStatements).toHaveBeenNthCalledWith(2, 'agent-discussion', 'agent-second');
  });

  it('delivers a participant unread discussion suffix when that participant is scheduled to vote', async () => {
    const transcript = testAgent({ type: 'sub' });
    const member = testAgent({ type: 'sub' });
    const idle = testAgent({ type: 'sub' });
    member.configure();
    idle.configure();
    member.mockNextResponse({ type: 'text', text: 'proceed' });
    idle.mockNextResponse({ type: 'text', text: 'abstain' });
    const discussionMeta = {
      homedir: '/discussion',
      type: 'sub' as const,
      parentAgentId: 'main',
      kind: 'sub' as const,
      teamLeaderAgentId: 'main',
      discussion: {
        participantAgentIds: ['agent-review'],
        status: 'active' as const,
        topic: 'Verify the cache behavior.',
        startedAt: '2026-08-18T00:00:00.000Z',
        updatedAt: '2026-08-18T00:00:00.000Z',
        nextStatementId: 1,
      },
    };
    const memberMeta = {
      homedir: '/member',
      type: 'sub' as const,
      parentAgentId: 'main',
      kind: 'team' as const,
      teamLeaderAgentId: 'main',
      name: 'Reviewer',
    };
    const idleMeta = {
      homedir: '/idle',
      type: 'sub' as const,
      parentAgentId: 'main',
      kind: 'team' as const,
      teamLeaderAgentId: 'main',
      name: 'Idle',
    };
    const unreadTeamDiscussionStatements = vi.fn(async () => ({
      statements: [{
        entryId: 1,
        agentId: 'agent-author',
        name: 'Author',
        message: 'The cache key must remain stable.',
      }],
      cursor: 1,
    }));
    const acknowledgeTeamDiscussionStatements = vi.fn(async () => undefined);
    const assertTeamDiscussionMode = vi.fn(async () => {
      throw new Error('EnterDiscussMode is required before starting or continuing a team discussion.');
    });
    const session = {
      metadata: {
        agents: {
          'agent-discussion': discussionMeta,
          'agent-review': memberMeta,
          'agent-idle': idleMeta,
        },
      },
      activeTeamDiscussion: vi.fn(() => ['agent-discussion', discussionMeta] as const),
      getAgentMetadata: vi.fn((id: string) =>
        id === 'agent-discussion'
          ? discussionMeta
          : id === 'agent-review'
            ? memberMeta
            : id === 'agent-idle'
              ? idleMeta
              : undefined,
      ),
      teamMemberMetadata: vi.fn(() => [
        ['agent-review', memberMeta],
        ['agent-idle', idleMeta],
      ]),
      assertTeamDiscussionMode,
      ensureAgentResumed: vi.fn(async (id: string) =>
        id === 'agent-discussion' ? transcript.agent : id === 'agent-idle' ? idle.agent : member.agent,
      ),
      unreadTeamDiscussionStatements,
      acknowledgeTeamDiscussionStatements,
    } as unknown as Session;
    const host = new SessionSubagentHost(session, 'main');

    const result = await host.decideTeamDiscussion('vote', undefined, undefined, signal);

    expect(result.votes).toEqual([
      { agentId: 'agent-review', vote: 'proceed' },
    ]);
    expect(idle.llmCalls).toHaveLength(0);
    expect(assertTeamDiscussionMode).not.toHaveBeenCalled();
    expect(JSON.stringify(member.lastLlmInput())).toContain('The cache key must remain stable.');
    expect(unreadTeamDiscussionStatements).toHaveBeenCalledWith('agent-discussion', 'agent-review');
    expect(acknowledgeTeamDiscussionStatements).toHaveBeenCalledWith(
      'agent-discussion',
      'agent-review',
      1,
    );
  });

  it('does not collect votes while an assigned team turn is still running', async () => {
    const discussionMeta = {
      homedir: '/discussion',
      type: 'sub' as const,
      parentAgentId: 'main',
      kind: 'sub' as const,
      teamLeaderAgentId: 'main',
      discussion: {
        participantAgentIds: ['agent-review'],
        status: 'active' as const,
        topic: 'Review the cache path',
        startedAt: '2026-08-18T00:00:00.000Z',
        updatedAt: '2026-08-18T00:00:00.000Z',
      },
    };
    const memberMeta = {
      homedir: '/review',
      type: 'sub' as const,
      parentAgentId: 'main',
      kind: 'team' as const,
      teamLeaderAgentId: 'main',
      assignedTask: 'Finish the assigned implementation.',
      name: 'Reviewer',
    };
    const session = {
      metadata: {
        agents: {
          'agent-discussion': discussionMeta,
          'agent-review': memberMeta,
        },
      },
      activeTeamDiscussion: vi.fn(() => ['agent-discussion', discussionMeta] as const),
      getAgentMetadata: vi.fn((id: string) =>
        id === 'agent-discussion' ? discussionMeta : id === 'agent-review' ? memberMeta : undefined,
      ),
      teamMemberMetadata: vi.fn(() => [['agent-review', memberMeta]]),
      ensureAgentResumed: vi.fn(async (id: string) =>
        id === 'agent-review'
          ? { turn: { hasActiveTurn: true } }
          : { turn: { hasActiveTurn: false } },
      ),
    } as unknown as Session;
    const host = new SessionSubagentHost(session, 'main');

    await expect(host.decideTeamDiscussion('vote', undefined, undefined, signal))
      .rejects.toThrow('must wait for team execution turns to finish');
  });

  it('records the lead statement before members take their TeamSpeak turn', async () => {
    const transcript = testAgent({ type: 'sub' });
    const member = testAgent({ type: 'sub' });
    member.configure();
    member.mockNextResponse({ type: 'text', text: 'private reasoning' });
    const discussionMeta = {
      homedir: '/discussion',
      type: 'sub' as const,
      parentAgentId: 'main',
      kind: 'sub' as const,
      teamLeaderAgentId: 'main',
      discussion: {
        participantAgentIds: ['agent-review'],
        status: 'active' as const,
        topic: 'Review the cache path',
        startedAt: '2026-08-18T00:00:00.000Z',
        updatedAt: '2026-08-18T00:00:00.000Z',
      },
    };
    const memberMeta = {
      homedir: '/review',
      type: 'sub' as const,
      parentAgentId: 'main',
      kind: 'team' as const,
      teamLeaderAgentId: 'main',
      name: 'Reviewer',
    };
    const order: string[] = [];
    const publishLeadDiscussionStatement = vi.fn(async () => {
      order.push('lead');
      return { discussionAgentId: 'agent-discussion', entryId: 1 };
    });
    const beginTeamDiscussionTurn = vi.fn(() => {
      order.push('member');
    });
    const session = {
      metadata: { agents: { 'agent-discussion': discussionMeta, 'agent-review': memberMeta } },
      activeTeamDiscussion: vi.fn(() => ['agent-discussion', discussionMeta] as const),
      getAgentMetadata: vi.fn((id: string) =>
        id === 'agent-discussion' ? discussionMeta : id === 'agent-review' ? memberMeta : undefined,
      ),
      ensureAgentResumed: vi.fn(async (id: string) =>
        id === 'agent-discussion' ? transcript.agent : member.agent,
      ),
      unreadTeamDiscussionStatements: vi.fn(async () => ({ statements: [], cursor: 0 })),
      acknowledgeTeamDiscussionStatements: vi.fn(async () => undefined),
      publishLeadDiscussionStatement,
      beginTeamDiscussionTurn,
      endTeamDiscussionTurn: vi.fn(),
      consumeTeamDiscussionSpeak: vi.fn(() => undefined),
    } as unknown as Session;
    const host = new SessionSubagentHost(session, 'main');

    await host.decideTeamDiscussion('continue', undefined, undefined, signal, 'The cache key stays.');

    expect(publishLeadDiscussionStatement).toHaveBeenCalledWith('main', 'The cache key stays.');
    expect(order[0]).toBe('lead');
    expect(order).toContain('member');
  });

  it('rejects TeamDecide start without a topic even when the field is an empty string', async () => {
    const session = {
      metadata: { agents: {} },
      activeTeamDiscussion: vi.fn(() => undefined),
      teamMemberMetadata: vi.fn(() => [['agent-review', { kind: 'team' }]]),
      createTeamDiscussion: vi.fn(),
    } as unknown as Session;
    const host = new SessionSubagentHost(session, 'main');

    await expect(host.decideTeamDiscussion('start', '', ['agent-review'], signal, 'Lead first.'))
      .rejects.toThrow('A discussion topic is required.');
    await expect(host.decideTeamDiscussion('start', undefined, ['agent-review'], signal, 'Lead first.'))
      .rejects.toThrow('A discussion topic is required.');
    expect(session.createTeamDiscussion).not.toHaveBeenCalled();
  });

  it('wakes TeamBroadcast and TeamDM recipients with turn.prompt', async () => {
    const first = testAgent({ type: 'sub' });
    const second = testAgent({ type: 'sub' });
    first.configure();
    second.configure();
    first.mockNextResponse({ type: 'text', text: 'gathered first' });
    second.mockNextResponse({ type: 'text', text: 'gathered second' });
    const firstMeta = {
      homedir: '/first',
      type: 'sub' as const,
      parentAgentId: 'main',
      kind: 'team' as const,
      teamLeaderAgentId: 'main',
      name: 'First',
    };
    const secondMeta = {
      homedir: '/second',
      type: 'sub' as const,
      parentAgentId: 'main',
      kind: 'team' as const,
      teamLeaderAgentId: 'main',
      name: 'Second',
    };
    const session = {
      metadata: { agents: { 'agent-first': firstMeta, 'agent-second': secondMeta } },
      teamMemberMetadata: vi.fn(() => [
        ['agent-first', firstMeta],
        ['agent-second', secondMeta],
      ]),
      getAgentMetadata: vi.fn((id: string) =>
        id === 'agent-first' ? firstMeta : id === 'agent-second' ? secondMeta : { kind: 'main' as const, type: 'main' as const, parentAgentId: null, homedir: '/main' },
      ),
      ensureAgentResumed: vi.fn(async (id: string) =>
        id === 'agent-first' ? first.agent : second.agent,
      ),
    } as unknown as Session;
    const host = new SessionSubagentHost(session, 'main');
    const firstPrompt = vi.spyOn(first.agent.turn, 'prompt');
    const secondPrompt = vi.spyOn(second.agent.turn, 'prompt');

    await expect(host.broadcastTeam('Gather the cache facts.', signal)).resolves.toEqual([
      'agent-first',
      'agent-second',
    ]);
    expect(firstPrompt).toHaveBeenCalled();
    expect(secondPrompt).toHaveBeenCalled();

    first.mockNextResponse({ type: 'text', text: 'dm reply' });
    await host.directMessage('agent-first', 'Private follow-up.', signal);
    expect(firstPrompt).toHaveBeenCalledTimes(2);
    const directMessageCall = firstPrompt.mock.calls[1]!;
    expect(directMessageCall[0]).toEqual([{
      type: 'text',
      text: '<system-reminder>\nPrivate follow-up.\n</system-reminder>',
    }]);
    expect(directMessageCall[1]).toMatchObject({
      kind: 'system_trigger',
      name: 'team_lead',
      speaker: { from: 'lead', speakerId: 'main' },
    });
  });

  it('buffers TeamDM as a system reminder when the recipient is active', async () => {
    const steer = vi.fn(() => null);
    const recipient = {
      turn: {
        hasActiveTurn: true,
        prompt: vi.fn(),
        steer,
      },
    } as unknown as Agent;
    const memberMeta = {
      homedir: '/member',
      type: 'sub' as const,
      parentAgentId: 'main',
      kind: 'team' as const,
      teamLeaderAgentId: 'main',
      name: 'Member',
    };
    const mainMeta = {
      homedir: '/main',
      type: 'main' as const,
      parentAgentId: null,
      kind: 'main' as const,
    };
    const session = {
      getAgentMetadata: vi.fn((id: string) => id === 'main' ? mainMeta : memberMeta),
      ensureAgentResumed: vi.fn(async () => recipient),
    } as unknown as Session;
    const host = new SessionSubagentHost(session, 'agent-member');

    await expect(host.directMessage('main', 'The parent is still running.', signal))
      .resolves.toBe('buffered');
    expect(steer).toHaveBeenCalledWith(
      [{
        type: 'text',
        text: '<system-reminder>\nThe parent is still running.\n</system-reminder>',
      }],
      expect.objectContaining({
        kind: 'system_trigger',
        name: 'team_member',
        speaker: { from: 'team', speakerId: 'agent-member', speakerName: 'Member' },
      }),
    );
  });

  it('does not claim delivery when an idle TeamDM cannot start or is cancelled', async () => {
    const prompt = vi.fn(() => null);
    const recipient = {
      turn: {
        hasActiveTurn: false,
        prompt,
        steer: vi.fn(),
      },
    } as unknown as Agent;
    const mainMeta = {
      homedir: '/main',
      type: 'main' as const,
      parentAgentId: null,
      kind: 'main' as const,
    };
    const session = {
      getAgentMetadata: vi.fn(() => mainMeta),
      ensureAgentResumed: vi.fn(async () => recipient),
    } as unknown as Session;
    const host = new SessionSubagentHost(session, 'main');

    await expect(host.directMessage('main', 'Cannot start.', signal))
      .rejects.toThrow('could not start a turn');
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(host.directMessage('main', 'Cancelled.', controller.signal))
      .rejects.toThrow('cancelled');
  });

  it('tags team-spawned SubAgent prompts as from=team', async () => {
    const partner = testAgent();
    partner.configure();
    const child = testAgent();
    child.mockNextResponse({
      type: 'text',
      text: 'Completed the delegated audit with enough detail for the parent partner to continue without repeating the investigation. '.repeat(3),
    });
    const metadataAgents: Session['metadata']['agents'] = {
      'agent-review': {
        homedir: '/review',
        type: 'sub',
        parentAgentId: 'main',
        kind: 'team',
        name: 'Reviewer',
      },
    };
    const session = fakeSession(partner.agent, child.agent, metadataAgents);
    session.agents.set('agent-review', partner.agent);
    const host = new SessionSubagentHost(session, 'agent-review');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_subagent',
      prompt: 'Audit the cache path',
      description: 'Audit cache',
      runInBackground: false,
      signal,
    });
    await handle.completion;

    expect(userTextMessages(child.llmCalls[0]?.history ?? []).some(
      (text) => text.includes('from="team:agent-review"') && text.includes('Audit the cache path'),
    )).toBe(true);
  });

  it('emits a suspended event for a requeued child', () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();
    const child = testAgent();
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    host.suspended({
      task: queuedTask(1),
      agentId: 'agent-0',
      reason: 'Provider rate limit; subagent requeued for retry.',
    });

    expect(parent.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.suspended',
        args: expect.objectContaining({
          subagentId: 'agent-0',
          reason: 'Provider rate limit; subagent requeued for retry.',
        }),
      }),
    );
  });

  it('runQueued suppresses raw live Aborted failures from queued attempts', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const controller = new AbortController();
    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const running = host.runQueued([{ ...queuedTask(1), signal: controller.signal }]);
    void running.catch(() => {});

    await child.untilApprovalRequest();
    controller.abort(abortError());
    await expect(running).rejects.toThrow('Aborted');
    await child.untilTurnEnd();

    expect(parent.agent.usage.data().total).toEqual(child.agent.usage.data().total);
    expect(parent.allEvents).not.toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.failed',
        args: expect.objectContaining({
          error: 'Aborted',
        }),
      }),
    );
  });

  it('fires subagent lifecycle hooks around the child turn', async () => {
    const child = testAgent();
    const calls: Array<{ readonly event: string; readonly childLlmCallCount: number }> = [];
    const trigger = vi.fn(async (event: string, _args?: unknown) => {
      calls.push({ event, childLlmCallCount: child.llmCalls.length });
      return [];
    });
    const fireAndForgetTrigger = vi.fn((event: string) => {
      calls.push({ event, childLlmCallCount: child.llmCalls.length });
      return Promise.resolve([]);
    });
    const parent = testAgent({
      hookEngine: { trigger, fireAndForgetTrigger } as unknown as NonNullable<Agent['hooks']>,
    });
    parent.configure();
    parent.newEvents();

    const summary =
      'Implemented the subagent task completely and returned a detailed enough summary for the parent agent to continue confidently without repeating the child agent work. '.repeat(
        2,
      );
    child.mockNextResponse({ type: 'text', text: summary });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Implement the fix',
      description: 'Fix bug',
      runInBackground: false,
      signal,
    });
    await handle.completion;

    const startArgs = trigger.mock.calls[0]?.[1];
    expect(trigger.mock.calls[0]?.[0]).toBe('SubagentStart');
    expect(startArgs).toMatchObject({
      matcherValue: 'coder',
      inputData: {
        agentName: 'coder',
        prompt: 'Implement the fix',
      },
    });
    expect((startArgs as { readonly signal?: unknown } | undefined)?.signal).toBeInstanceOf(
      AbortSignal,
    );
    expect(fireAndForgetTrigger).toHaveBeenCalledWith('SubagentStop', {
      matcherValue: 'coder',
      inputData: {
        agentName: 'coder',
        response: summary.trim(),
      },
    });
    expect(calls).toEqual([
      { event: 'SubagentStart', childLlmCallCount: 0 },
      { event: 'SubagentStop', childLlmCallCount: 1 },
    ]);
  });

  it('archives a completed SubAgent in the parent session instead of destroying it', async () => {
    const parent = testAgent();
    parent.configure();
    const child = testAgent();
    child.mockNextResponse({
      type: 'text',
      text: 'Completed the delegated task and returned enough detail for the parent to continue without reopening this temporary worker.'.repeat(2),
    });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');
    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_subagent',
      prompt: 'Complete the task',
      description: 'Complete task',
      runInBackground: true,
      signal,
    });

    await handle.completion;
    await host.discard(handle.agentId);

    expect(session.archiveCompletedSubagent).toHaveBeenCalledWith(handle.agentId);
    expect(session.metadata.agents[handle.agentId]).toMatchObject({ archived: true });
    expect(session.agents.has(handle.agentId)).toBe(true);
  });

  it('ignores blocking results from subagent lifecycle hooks', async () => {
    const trigger = vi.fn(async () => [{ action: 'block', reason: 'observer only' }]);
    const fireAndForgetTrigger = vi.fn(() => Promise.resolve([{ action: 'block' }]));
    const parent = testAgent({
      hookEngine: { trigger, fireAndForgetTrigger } as unknown as NonNullable<Agent['hooks']>,
    });
    parent.configure();
    parent.newEvents();

    const summary =
      'Completed the subagent task with enough implementation detail and verification context for the parent agent to continue without repeating the work. '.repeat(
        2,
      );
    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: summary });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Implement the fix',
      description: 'Fix bug',
      runInBackground: false,
      signal,
    });

    await expect(handle.completion).resolves.toMatchObject({ result: summary.trim() });
    expect(parent.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.completed',
        args: expect.objectContaining({ subagentId: 'agent-0' }),
      }),
    );
    expect(parent.allEvents).not.toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.failed',
      }),
    );
  });

  it('marks a queued child ready when the model emits thinking output', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const child = testAgent();
    const summary =
      'Completed the delegated subagent task with enough concrete detail for the parent agent to continue without repeating the work. '.repeat(
        2,
      );
    child.mockNextResponse({ type: 'think', think: 'I can start.' }, { type: 'text', text: summary });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');
    const onReady = vi.fn();

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Implement the fix',
      description: 'Fix bug',
      runInBackground: false,
      signal,
      onReady,
    });

    await vi.waitFor(() => {
      expect(onReady).toHaveBeenCalledTimes(1);
    });
    await expect(handle.completion).resolves.toMatchObject({ result: summary.trim() });
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('runs a child agent turn and returns the last assistant text', async () => {
    const telemetryTrack = vi.fn();
    const parent = testAgent({ telemetry: { track: telemetryTrack } });
    parent.configure();
    await parent.rpc.setPermission({ mode: 'yolo' });
    parent.agent.permission.rules.splice(0, parent.agent.permission.rules.length, {
      decision: 'allow',
      scope: 'session-runtime',
      pattern: 'Read',
    });
    parent.newEvents();

    const child = testAgent({
      type: 'sub',
      permission: { parent: parent.agent.permission },
    });
    child.mockNextResponse({ type: 'text', text: 'Investigated the request and completed the child task end to end. The relevant module was located, its behavior traced through every call site, and the requested change applied and verified against the existing test suite.' });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_agent',
      prompt: 'Find the cause',
      description: 'Find cause',
      runInBackground: false,
      signal,
    });

    const completion = await handle.completion;
    expect(completion).toMatchObject({
      result: 'Investigated the request and completed the child task end to end. The relevant module was located, its behavior traced through every call site, and the requested change applied and verified against the existing test suite.',
    });
    expect(parent.agent.usage.data().total).toEqual(completion.usage);
    expect(handle.agentId).toBe('agent-0');
    expect(handle.profileName).toBe('explore');

    expect(parent.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.spawned',
        args: expect.objectContaining({
          subagentId: 'agent-0',
          subagentName: 'explore',
          parentAgentId: 'main',
          parentToolCallId: 'call_agent',
        }),
      }),
    );
    expect(telemetryTrack).toHaveBeenCalledWith('subagent_created', {
      subagent_name: 'explore',
      run_in_background: false,
    });
    expect(parent.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.completed',
        args: expect.objectContaining({
          subagentId: 'agent-0',
          resultSummary: 'Investigated the request and completed the child task end to end. The relevant module was located, its behavior traced through every call site, and the requested change applied and verified against the existing test suite.',
        }),
      }),
    );
    expect(child.agent.config.data()).toMatchObject({
      cwd: parent.agent.config.cwd,
      provider: parent.agent.config.data().provider,
      profileName: 'explore',
      thinkingEffort: parent.agent.config.thinkingEffort,
    });
    expect(child.agent.config.systemPrompt).toContain('codebase exploration specialist');
    expect(child.agent.permission.mode).toBe('yolo');
    expect(child.agent.permission.rules).toEqual([]);
    expect(child.agent.permission.data().rules).toEqual(parent.agent.permission.rules);
    expect(child.llmCalls[0]?.systemPrompt).toContain('codebase exploration specialist');
    expect(child.llmCalls[0]?.tools.map((tool) => tool.name).toSorted()).toEqual([
      'Bash',
      'Glob',
      'Grep',
      'Read',
      'ReadMediaFile',
      'WebSearch',
    ]);
    expect(child.llmCalls[0]?.history).toMatchObject([
      {
        role: 'user',
        content: [{ type: 'text', text: '<message from="lead:main" name="主代理">Find the cause</message>' }],
      },
    ]);
  });

  it('keeps a child running until its nested background agent wakes and finishes it', async () => {
    const parent = testAgent();
    parent.configure();
    const child = testAgent({ type: 'sub' });
    const firstSummary = 'The nested agent is still running, so I am retaining this node and waiting for its automatic completion notification before I report final results. '.repeat(2);
    const finalSummary = 'The nested agent completed and its notification was consumed. I verified the returned result and can now provide the parent with the final consolidated handoff. '.repeat(2);
    child.mockNextResponse({ type: 'text', text: firstSummary });
    child.mockNextResponse({ type: 'text', text: finalSummary });

    let releaseNested!: () => void;
    const nestedGate = new Promise<void>(resolve => { releaseNested = resolve; });
    const nestedTask: BackgroundTask = {
      idPrefix: 'agent',
      kind: 'agent',
      description: 'Nested agent work',
      async start(sink) {
        await nestedGate;
        sink.appendOutput('Nested agent finished successfully.');
        await sink.settle({ status: 'completed' });
      },
      toInfo: base => ({
        ...base,
        kind: 'agent',
        agentId: 'agent-nested',
        subagentType: 'orchestrator',
      }),
    };
    child.agent.background.registerTask(nestedTask, { detached: true });

    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');
    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Coordinate nested work',
      description: 'Coordinate nested work',
      runInBackground: false,
      signal,
    });

    await child.untilTurnEnd();
    let completed = false;
    void handle.completion.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);

    releaseNested();
    await expect(handle.completion).resolves.toMatchObject({ result: finalSummary.trim() });
    expect(child.llmCalls).toHaveLength(2);
    expect(userTextMessages(child.llmCalls[1]?.history ?? [])).toEqual(expect.arrayContaining([
      expect.stringContaining('task.completed'),
    ]));
  });

  it('inherits active parent user tools when spawning a subagent', async () => {
    const parent = testAgent();
    parent.configure();
    await parent.rpc.registerTool(lookupToolRegistration());
    parent.newEvents();

    const summary =
      'Investigated the delegated task thoroughly, used the inherited custom lookup surface where appropriate, and returned a detailed summary that lets the parent agent continue without repeating the work. '.repeat(
        2,
      );
    const child = testAgent();
    child.mockNextResponse({
      type: 'text',
      text: summary,
    });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Use the available lookup tool',
      description: 'Use lookup',
      runInBackground: false,
      signal,
    });

    await expect(handle.completion).resolves.toMatchObject({
      result: summary.trim(),
    });
    expect(child.llmCalls[0]?.tools.map((tool) => tool.name)).toContain('Lookup');
    expect(child.agent.tools.data()).toContainEqual({
      name: 'Lookup',
      description: 'Look up a short test value.',
      active: true,
      source: 'user',
    });

    const lookupTool = child.agent.tools.loopTools.find((tool) => tool.name === 'Lookup');
    expect(lookupTool).toBeDefined();

    const execution = executeTool(lookupTool!, {
      turnId: '0',
      toolCallId: 'call_lookup',
      args: { query: 'moon' },
      signal,
    });
    const routedTo = await Promise.race([
      child.untilToolCall({ output: 'moon-result' }).then(() => 'child'),
      parent.untilToolCall({ output: 'moon-result' }).then(() => 'parent'),
      new Promise<'timeout'>((resolve) => setTimeout(() => {
        resolve('timeout');
      }, 50)),
    ]);

    expect(routedTo).toBe('child');
    await expect(execution).resolves.toMatchObject({ output: 'moon-result' });
  });

  it('falls back to bundled subagent profiles when the parent profile is missing', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: 'Implemented the requested fix in the target module, updated all affected call sites, and confirmed the change compiles cleanly and passes the existing test suite. No unrelated code paths were touched while making this change.' });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Implement the fix',
      description: 'Fix bug',
      runInBackground: false,
      signal,
    });

    await expect(handle.completion).resolves.toMatchObject({
      result:
        'Implemented the requested fix in the target module, updated all affected call sites, and confirmed the change compiles cleanly and passes the existing test suite. No unrelated code paths were touched while making this change.',
    });
    expect(child.agent.config.profileName).toBe('coder');
    expect(child.llmCalls[0]?.systemPrompt).toContain('You are now running as a subagent.');
    expect(child.llmCalls[0]?.tools.map((tool) => tool.name).toSorted()).toEqual([
      'Bash',
      'Edit',
      'Glob',
      'Grep',
      'Read',
      'ReadMediaFile',
      'WebSearch',
      'Write',
    ]);
    expect(child.llmCalls[0]?.history).toMatchObject([
      {
        role: 'user',
        content: [{ type: 'text', text: '<message from="lead:main" name="主代理">Implement the fix</message>' }],
      },
    ]);
  });

  it('accepts the legacy nori-coder input without advertising it as a profile', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();
    const child = testAgent();
    const result = 'Prepared a complete delegation plan with explicit implementation tasks, dependencies, validation steps, and ownership boundaries. The parent can now launch the worker agents without relying on the legacy profile name.';
    child.mockNextResponse({ type: 'text', text: result });
    const host = new SessionSubagentHost(fakeSession(parent.agent, child.agent), 'main');

    const handle = await host.spawn({
      profileName: 'nori-coder',
      parentToolCallId: 'call_legacy_agent',
      prompt: 'Plan and delegate this change',
      description: 'Legacy profile compatibility',
      runInBackground: false,
      signal,
    });

    await expect(handle.completion).resolves.toMatchObject({ result });
    expect(handle.profileName).toBe('orchestrator');
    expect(child.agent.config.profileName).toBe('orchestrator');
    expect(child.llmCalls[0]?.tools.map(tool => tool.name)).not.toContain('Write');
  });

  it('rejects unknown subagent types before creating a child agent', async () => {
    const parent = testAgent();
    parent.configure();
    const createAgent = vi.fn();
    const host = new SessionSubagentHost(
      {
        agents: new Map([['main', parent.agent]]),
        ensureAgentResumed: vi.fn(async () => parent.agent),
        createAgent,
      } as never,
      'main',
    );

    await expect(
      host.spawn({
        profileName: 'missing',
        parentToolCallId: 'call_agent',
        prompt: 'Find the cause',
        description: 'Find cause',
        runInBackground: false,
        signal,
      }),
    ).rejects.toThrow('Subagent profile "missing" was not found');
    expect(createAgent).not.toHaveBeenCalled();
  });

  it('rejects unavailable subagent profiles even when a same-named fork label exists', async () => {
    const parent = testAgent();
    parent.configure();
    const createAgent = vi.fn();
    const host = new SessionSubagentHost(
      {
        agents: new Map([['main', parent.agent]]),
        ensureAgentResumed: vi.fn(async () => parent.agent),
        createAgent,
      } as never,
      'main',
    );

    await expect(
      host.spawn({
        profileName: 'btw',
        parentToolCallId: 'call_agent',
        prompt: 'Answer a side question',
        description: 'Side question',
        runInBackground: false,
        signal,
      }),
    ).rejects.toThrow('Subagent profile "btw" was not found');
    expect(createAgent).not.toHaveBeenCalled();
  });

  it('cancels the child turn when the caller signal aborts', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const controller = new AbortController();
    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_agent',
      prompt: 'Keep working',
      description: 'Long task',
      runInBackground: false,
      signal: controller.signal,
    });

    await child.untilApprovalRequest();
    controller.abort();

    await expect(handle.completion).rejects.toThrow('Aborted');
    expect(child.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[wire]',
        event: 'turn.cancel',
        args: expect.objectContaining({ turnId: 0 }),
      }),
    );
    expect(parent.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.failed',
        args: expect.objectContaining({
          subagentId: 'agent-0',
          error: 'Aborted',
        }),
      }),
    );
  });

  it('cancelAll aborts foreground children', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_agent',
      prompt: 'Keep working',
      description: 'Long task',
      runInBackground: false,
      signal,
    });

    await child.untilApprovalRequest();
    host.cancelAll();

    await expect(handle.completion).rejects.toThrow('Aborted');
    expect(child.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[wire]',
        event: 'turn.cancel',
        args: expect.objectContaining({ turnId: 0 }),
      }),
    );
  });

  it("tells a cancelled subagent's in-flight tools the user interrupted them", async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const controller = new AbortController();
    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_agent',
      prompt: 'Keep working',
      description: 'Long task',
      runInBackground: false,
      signal: controller.signal,
    });

    await child.untilApprovalRequest();
    // The parent turn signal aborts with a user-cancellation reason; linkAbortSignal
    // forwards it to the child exactly as Turn.cancel does on a real ESC.
    controller.abort(userCancellationReason());
    await expect(handle.completion).rejects.toThrow();
    await child.untilTurnEnd();

    const output = childBashToolResultOutput(child);
    expect(output).toContain('manually interrupted');
    expect(output).toContain('not a system error');
  });

  it('does not mislabel a non-user subagent abort (e.g. a deadline) as a user interruption', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const controller = new AbortController();
    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_agent',
      prompt: 'Keep working',
      description: 'Long task',
      runInBackground: false,
      signal: controller.signal,
    });

    await child.untilApprovalRequest();
    // A generic (non-user) abort — e.g. a foreground subagent's deadline timeout
    // propagating through waitForCurrentTurn — must NOT be reported to the
    // child's tools as a deliberate user interruption.
    controller.abort(abortError());
    await expect(handle.completion).rejects.toThrow();
    await child.untilTurnEnd();

    const output = childBashToolResultOutput(child);
    expect(output).toBe('Tool "Bash" was aborted');
    expect(output).not.toContain('manually interrupted');
  });

  it('cancelAll leaves background children running until their task signal aborts', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const backgroundController = new AbortController();
    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_agent',
      prompt: 'Keep working',
      description: 'Long task',
      runInBackground: true,
      signal: backgroundController.signal,
    });

    await child.untilApprovalRequest();
    host.cancelAll();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(child.agent.turn.hasActiveTurn).toBe(true);
    expect(child.allEvents).not.toContainEqual(
      expect.objectContaining({
        type: '[wire]',
        event: 'turn.cancel',
        args: expect.objectContaining({ turnId: 0 }),
      }),
    );

    backgroundController.abort();

    await expect(handle.completion).rejects.toThrow('Aborted');
    expect(child.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[wire]',
        event: 'turn.cancel',
        args: expect.objectContaining({ turnId: 0 }),
      }),
    );
  });

  it('re-prompts the child when the first summary is too short', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const longSummary = 'Detailed findings: '.repeat(20);
    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: 'done' });
    child.mockNextResponse({ type: 'text', text: longSummary });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Investigate',
      description: 'Investigate',
      runInBackground: false,
      signal,
    });

    await expect(handle.completion).resolves.toMatchObject({ result: longSummary.trim() });
    expect(child.llmCalls).toHaveLength(2);
    expect(child.llmCalls[1]?.history.at(-1)).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: expect.stringContaining('too brief') }],
    });
  });

  it('fails the child instead of re-prompting when the response is truncated', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const child = testAgent();
    child.mockNextProviderResponse({
      parts: [
        { type: 'think', think: 'The child used its output budget before writing a summary.' },
      ],
      finishReason: 'truncated',
      rawFinishReason: 'length',
    });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Investigate',
      description: 'Investigate',
      runInBackground: false,
      signal,
    });

    await expect(handle.completion).rejects.toThrow(
      'Subagent turn failed before completing its final summary: reason=max_tokens',
    );
    expect(child.llmCalls).toHaveLength(1);
    expect(parent.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.failed',
        args: expect.objectContaining({
          subagentId: 'agent-0',
          error: expect.stringContaining(
            'Subagent turn failed before completing its final summary: reason=max_tokens',
          ),
        }),
      }),
    );
    expect(parent.allEvents).not.toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.completed',
      }),
    );
  });

  it('does not re-prompt when the first summary is long enough', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const longSummary = 'Comprehensive technical summary. '.repeat(10);
    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: longSummary });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Investigate',
      description: 'Investigate',
      runInBackground: false,
      signal,
    });

    await expect(handle.completion).resolves.toMatchObject({ result: longSummary.trim() });
    expect(child.llmCalls).toHaveLength(1);
  });

  it('prepends git context to the prompt for explore subagents', async () => {
    vi.mocked(collectGitContext).mockResolvedValueOnce(
      '<git-context>\nWorking directory: /repo\nBranch: main\n</git-context>',
    );
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const summary =
      'Explored the repository thoroughly and reported the findings in a complete and detailed summary that gives the parent agent everything it needs to continue the work without redoing the investigation all over again.';
    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: summary });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_agent',
      prompt: 'Find the cause',
      description: 'Find cause',
      runInBackground: false,
      signal,
    });
    await handle.completion;

    expect(child.llmCalls[0]?.history[0]).toMatchObject({
      role: 'user',
      content: [
        {
          type: 'text',
          text: '<message from="lead:main" name="主代理">&lt;git-context&gt;\nWorking directory: /repo\nBranch: main\n&lt;/git-context&gt;\n\nFind the cause</message>',
        },
      ],
    });
  });

  it('does not prepend git context for non-explore subagents', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const summary =
      'Implemented the requested change in full and verified it against the existing test suite, leaving a thorough and complete summary so the parent agent can proceed without repeating any of the finished investigation work.';
    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: summary });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Implement the fix',
      description: 'Fix bug',
      runInBackground: false,
      signal,
    });
    await handle.completion;

    expect(child.llmCalls[0]?.history[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: '<message from="lead:main" name="主代理">Implement the fix</message>' }],
    });
  });

  it('injects retrieved Nori memory into the child task prompt', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const memory: NoriMemoryProvider = {
      multiRetrieve: vi.fn(async () => [
        {
          title: 'Coder write decision',
          path: 'analysis/coder-write.md',
          score: 0.875,
          excerpt:
            'Known subagent context: coder_write_enabled is enabled through runtime settings.',
        },
      ]),
      writeNote: vi.fn(async () => ({ path: 'analysis/unused.md' })),
      removeNote: vi.fn(async () => false),
    };
    const summary =
      'Investigated the delegated implementation task with the retrieved shared memory context, confirmed the relevant runtime setting behavior, and returned a detailed summary for the parent agent to continue without repeating the lookup. '.repeat(
        2,
      );
    const child = testAgent();
    child.mockNextResponse({
      type: 'text',
      text: [
        '<retrieval_query>',
        JSON.stringify({
          keywords: ['coder_write_enabled'],
          note_types: ['analysis'],
          include_linked: false,
          link_depth: 0,
          chain_depth: 0,
          max_results: 3,
        }),
        '</retrieval_query>',
      ].join('\n'),
    });
    child.mockNextResponse({ type: 'text', text: summary });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');
    host.setNoriConfig({
      memory,
      retrievalGate: { triggerMode: 'always', maxResults: 5 },
    });

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Investigate coder_write_enabled behavior',
      description: 'Investigate memory injection',
      runInBackground: false,
      signal,
    });
    await expect(handle.completion).resolves.toMatchObject({ result: summary.trim() });

    expect(child.llmCalls).toHaveLength(2);
    expect(userTextMessages(child.llmCalls[0]?.history ?? [])).toEqual([
      expect.stringContaining('<message from="lead:main" name="主代理">Output ONLY one &lt;retrieval_query&gt; block'),
    ]);
    expect(memory.multiRetrieve).toHaveBeenCalledWith(
      ['coder_write_enabled'],
      expect.objectContaining({
        top_k: 3,
        type_filter: ['analysis'],
        link_depth: 0,
      }),
    );

    const taskPrompt = userTextMessages(child.llmCalls[1]?.history ?? []).at(-1) ?? '';
    expect(taskPrompt).toContain('<message from="lead:main" name="主代理">');
    expect(taskPrompt).toContain('&lt;retrieved_context unique_count=&quot;1&quot; hops=&quot;1&quot;&gt;');
    expect(taskPrompt).toContain('&lt;title&gt;Coder write decision&lt;/title&gt;');
    expect(taskPrompt).toContain(
      'Known subagent context: coder_write_enabled is enabled through runtime settings.',
    );
    expect(taskPrompt).toContain('&lt;/retrieved_context&gt;\n\nInvestigate coder_write_enabled behavior</message>');
  });

  it('resumes an idle child agent by id', async () => {
    const parent = testAgent();
    parent.configure();
    parent.agent.permission.setMode('yolo');

    const child = testAgent({
      type: 'sub',
      permission: { parent: parent.agent.permission },
    });
    child.configure({ tools: ['Read'] });
    child.agent.useProfile(
      profile({ name: 'explore', tools: ['Read'], systemPrompt: 'explore prompt' }),
    );
    child.agent.context.appendUserMessage([{ type: 'text', text: 'Earlier context' }]);
    child.mockNextResponse({
      type: 'text',
      text: 'Resumed the subagent from its earlier context and carried the task through to completion, then reported a full and detailed technical summary so the parent agent can continue without repeating prior work.',
    });
    vi.mocked(collectGitContext).mockReset().mockResolvedValue('');

    const session = fakeSession(parent.agent, child.agent, {
      'agent-0': {
        homedir: '/tmp/kimi-session/agents/agent-0',
        type: 'sub',
        parentAgentId: 'main',
      },
    });
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.resume('agent-0', {
      parentToolCallId: 'call_agent',
      prompt: 'Continue from context',
      description: 'Continue work',
      runInBackground: false,
      signal,
    });

    expect(handle).toMatchObject({
      agentId: 'agent-0',
      profileName: 'explore',
      resumed: true,
    });
    await expect(handle.completion).resolves.toMatchObject({
      result:
        'Resumed the subagent from its earlier context and carried the task through to completion, then reported a full and detailed technical summary so the parent agent can continue without repeating prior work.',
    });
    expect(session.createAgent).not.toHaveBeenCalled();
    expect(child.agent.permission.mode).toBe('yolo');
    expect(userTextMessages(child.llmCalls[0]?.history ?? [])).toEqual([
      '<message from="user" name="用户">Earlier context</message>',
      '<message from="lead:main" name="主代理">Continue from context</message>',
    ]);
    expect(parent.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.spawned',
        args: expect.objectContaining({
          subagentId: 'agent-0',
          subagentName: 'explore',
          parentToolCallId: 'call_agent',
        }),
      }),
    );
  });

  it('accounts usage before a failed child turn without double counting on resume', async () => {
    const parent = testAgent();
    parent.configure();
    parent.agent.permission.setMode('yolo');

    const child = testAgent({
      type: 'sub',
      permission: { parent: parent.agent.permission },
    });
    child.configure({ tools: ['Read'] });
    child.agent.useProfile(
      profile({ name: 'explore', tools: ['Read'], systemPrompt: 'explore prompt' }),
    );
    child.mockNextResponse({ type: 'text', text: 'Too short.' });

    const session = fakeSession(parent.agent, child.agent, {
      'agent-0': {
        homedir: '/tmp/kimi-session/agents/agent-0',
        type: 'sub',
        parentAgentId: 'main',
      },
    });
    const host = new SessionSubagentHost(session, 'main');

    const failed = await host.resume('agent-0', {
      parentToolCallId: 'call_failed',
      prompt: 'Start work',
      description: 'Start work',
      runInBackground: true,
      signal,
    });
    await expect(failed.completion).rejects.toThrow();
    expect(parent.agent.usage.data().total).toEqual(child.agent.usage.data().total);

    child.mockNextResponse({
      type: 'text',
      text: 'Resumed after the interruption, completed the remaining work, verified the result with focused tests, reviewed the affected call paths, and returned a sufficiently detailed technical summary without repeating usage from the earlier failed attempt. The final state is ready for the parent agent to consume directly.',
    });
    const resumed = await host.resume('agent-0', {
      parentToolCallId: 'call_resumed',
      prompt: 'Continue work',
      description: 'Continue work',
      runInBackground: true,
      signal,
    });
    await expect(resumed.completion).resolves.toMatchObject({
      result: expect.stringContaining('Resumed after the interruption'),
    });
    expect(parent.agent.usage.data().total).toEqual(child.agent.usage.data().total);
  });

  it('runQueued resumes tasks that carry an existing agent id', async () => {
    const parent = testAgent();
    parent.configure();

    const child = testAgent({ type: 'sub' });
    child.configure();
    child.agent.useProfile(
      profile({ name: 'coder', tools: [], systemPrompt: 'coder prompt' }),
    );
    child.agent.context.appendUserMessage([{ type: 'text', text: 'Earlier SubAgent context' }]);
    const summary =
      'Resumed the queued SubAgent from its prior context, completed the missing work, and returned a detailed enough handoff for the parent to proceed without starting over. '.repeat(
        2,
      );
    child.mockNextResponse({ type: 'text', text: summary });

    const session = fakeSession(parent.agent, child.agent, {
      'agent-0': {
        homedir: '/tmp/kimi-session/agents/agent-0',
        type: 'sub',
        parentAgentId: 'main',
      },
    });
    const host = new SessionSubagentHost(session, 'main');

    await expect(
      host.runQueued(
        [
          {
            ...queuedTask(1),
            kind: 'resume',
            prompt: 'Continue the previous SubAgent task',
            resumeAgentId: 'agent-0',
            signal,
          },
        ],
      ),
    ).resolves.toMatchObject([
      {
        agentId: 'agent-0',
        status: 'completed',
        result: summary.trim(),
      },
    ]);

    expect(session.createAgent).not.toHaveBeenCalled();
    expect(userTextMessages(child.llmCalls[0]?.history ?? [])).toEqual([
      '<message from="user" name="用户">Earlier SubAgent context</message>',
      '<message from="lead:main" name="主代理">Continue the previous SubAgent task</message>',
    ]);
  });

  it('runQueued archives completed SubAgent metadata instead of deleting it', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const child = testAgent({ type: 'sub' });
    child.configure();
    const summary =
      'Completed the queued SubAgent item and returned a detailed technical handoff so the parent can map the result back to the original SubAgent input. '.repeat(
        2,
      );
    child.mockNextResponse({ type: 'text', text: summary });

    const metadataAgents: Session['metadata']['agents'] = {};
    const session = fakeSession(parent.agent, child.agent, metadataAgents);
    const host = new SessionSubagentHost(session, 'main');

    await expect(
      host.runQueuedControlled(
        [{ ...queuedTask(1), subagentItem: 'src/a.ts', signal }],
        () => undefined,
        { discardTerminalAgents: true },
      ),
    ).resolves.toMatchObject([
      {
        agentId: 'agent-0',
        status: 'completed',
        result: summary.trim(),
      },
    ]);

    expect(session.createAgent).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        parentAgentId: 'main',
        subagentItem: 'src/a.ts',
      }),
    );
    expect(session.archiveCompletedSubagent).toHaveBeenCalledWith('agent-0');
    expect(metadataAgents['agent-0']).toMatchObject({
      subagentItem: 'src/a.ts',
      archived: true,
    });
    expect(host.getSubagentItem('agent-0')).toBe('src/a.ts');
    expect(parent.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.spawned',
        args: expect.objectContaining({
          subagentId: 'agent-0',
          parentToolCallId: 'call_subagent',
          subagentIndex: 1,
        }),
      }),
    );
    expect(parent.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.started',
        args: expect.objectContaining({
          subagentId: 'agent-0',
        }),
      }),
    );
  });

  it('retries a rate-limited child turn without appending the original prompt again', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const summary =
      'Recovered from a provider rate limit by retrying the latest subagent step with the original context intact, then completed the delegated work with a detailed enough summary for the parent to continue confidently. '.repeat(
        2,
      );
    const histories: Message[][] = [];
    let generateCalls = 0;
    const generate: GenerateFn = async (
      _provider,
      _systemPrompt,
      _tools,
      history,
      callbacks,
    ) => {
      histories.push(structuredClone(history));
      generateCalls += 1;
      if (generateCalls === 1) {
        throw new APIStatusError(429, 'Rate limited', 'req-429');
      }
      await callbacks?.onMessagePart?.({ type: 'text', text: summary });
      return textResult(summary);
    };
    const child = testAgent({
      generate,
      initialConfig: {
        providers: {},
        loopControl: { maxRetriesPerStep: 1 },
      },
    });
    child.configure();

    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Implement the retry-safe change',
      description: 'Fix rate-limit retry',
      runInBackground: false,
      signal,
    });
    await expect(handle.completion).rejects.toThrow('Rate limited');

    const retryHandle = await host.retry(handle.agentId, {
      parentToolCallId: 'call_agent',
      prompt: 'Implement the retry-safe change',
      description: 'Fix rate-limit retry',
      runInBackground: false,
      signal,
    });

    await expect(retryHandle.completion).resolves.toMatchObject({ result: summary.trim() });
    expect(generateCalls).toBe(2);
    expect(userTextMessages(histories[1] ?? [])).toEqual([
      '<message from="lead:main" name="主代理">Implement the retry-safe change</message>',
    ]);
  });

  it('uses the model assigned to a custom agent profile', async () => {
    const parent = testAgent({
      initialConfig: {
        providers: {},
        customAgents: {
          reviewer: {
            description: 'Review risky changes',
            role: 'Find correctness bugs.',
            baseProfile: 'explore',
            model: 'mock-model',
            enabled: true,
          },
        },
      },
    });
    parent.configure();
    parent.agent.config.update({ modelAlias: 'parent-model' });

    const child = testAgent();
    child.configure();
    const summary = 'Reviewed the requested changes, identified the relevant behavior, and returned a complete technical result for the parent agent. '.repeat(2);
    child.mockNextResponse({ type: 'text', text: summary });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'reviewer',
      parentToolCallId: 'call_agent',
      prompt: 'Review the implementation',
      description: 'Review changes',
      runInBackground: false,
      signal,
    });

    await expect(handle.completion).resolves.toMatchObject({ result: summary.trim() });
    expect(child.agent.config.modelAlias).toBe('mock-model');
    expect(child.agent.config.modelAlias).not.toBe(parent.agent.config.modelAlias);
  });

  it('restores the assigned custom model when resuming a subagent', async () => {
    const parent = testAgent({
      initialConfig: {
        providers: {},
        customAgents: {
          reviewer: {
            description: 'Review risky changes',
            role: 'Find correctness bugs.',
            baseProfile: 'explore',
            model: 'mock-model',
            enabled: true,
          },
        },
      },
    });
    parent.configure();
    parent.agent.config.update({ modelAlias: 'parent-model' });

    const child = testAgent();
    child.configure();
    child.agent.config.update({ modelAlias: 'stale-model' });
    child.agent.useProfile(
      profile({ name: 'reviewer', tools: ['Read'], systemPrompt: 'review prompt' }),
    );
    const summary = 'Resumed the custom reviewer and completed the requested follow-up with enough technical detail for the parent agent to proceed. '.repeat(2);
    child.mockNextResponse({ type: 'text', text: summary });

    const session = fakeSession(parent.agent, child.agent, {
      'agent-0': {
        homedir: '/tmp/kimi-session/agents/agent-0',
        type: 'sub',
        parentAgentId: 'main',
      },
    });
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.resume('agent-0', {
      parentToolCallId: 'call_agent',
      prompt: 'Continue the review',
      description: 'Continue review',
      runInBackground: false,
      signal,
    });

    await expect(handle.completion).resolves.toMatchObject({ result: summary.trim() });
    expect(child.agent.config.modelAlias).toBe('mock-model');
  });

  it('realigns a resumed built-in subagent to the parent agent current model', async () => {
    const parent = testAgent();
    parent.configure();
    parent.agent.permission.setMode('yolo');

    const child = testAgent();
    child.configure({ tools: ['Read'] });
    // The child was originally spawned with a model that no longer matches the
    // parent agent's current model (as if the parent ran setModel afterwards).
    child.agent.config.update({ modelAlias: 'stale-model-from-initial-spawn' });
    child.agent.useProfile(
      profile({ name: 'explore', tools: ['Read'], systemPrompt: 'explore prompt' }),
    );
    child.agent.context.appendUserMessage([{ type: 'text', text: 'Earlier context' }]);
    child.mockNextResponse({
      type: 'text',
      text: 'Resumed the subagent from its earlier context and carried the task through to completion, then reported a full and detailed technical summary so the parent agent can continue without repeating prior work.',
    });

    const session = fakeSession(parent.agent, child.agent, {
      'agent-0': {
        homedir: '/tmp/kimi-session/agents/agent-0',
        type: 'sub',
        parentAgentId: 'main',
      },
    });
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.resume('agent-0', {
      parentToolCallId: 'call_agent',
      prompt: 'Continue from context',
      description: 'Continue work',
      runInBackground: false,
      signal,
    });

    await handle.completion;
    // resume must realign the child to the parent agent's current model rather
    // than leave it on the stale model from its initial spawn.
    expect(child.agent.config.modelAlias).toBe(parent.agent.config.modelAlias);
    expect(child.agent.config.modelAlias).not.toBe('stale-model-from-initial-spawn');
  });
});

describe('Session resume permission parent chain', () => {
  it('restores subagent live-derived permission when metadata lists the child first', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-permission-chain-'));
    tempDirs.push(dir);
    const sessionDir = join(dir, 'session');
    const workDir = join(dir, 'work');
    const mainDir = join(sessionDir, 'agents', 'main');
    const childDir = join(sessionDir, 'agents', 'agent-0');
    const sessionApprovalRule = 'Bash(printf parent)';
    await mkdir(workDir, { recursive: true });
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, 'state.json'),
      JSON.stringify(
        {
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          title: 'Permission Chain',
          isCustomTitle: false,
          agents: {
            'agent-0': {
              homedir: childDir,
              type: 'sub',
              parentAgentId: 'main',
            },
            main: {
              homedir: mainDir,
              type: 'main',
              parentAgentId: null,
            },
          },
          custom: {},
        },
        null,
        2,
      ),
      'utf-8',
    );
    await writeWire(mainDir, [
      {
        type: 'permission.set_mode',
        mode: 'yolo',
      },
      {
        type: 'permission.record_approval_result',
        turnId: 0,
        toolCallId: 'call_parent_bash',
        toolName: 'Bash',
        action: 'run command',
        sessionApprovalRule,
        result: {
          decision: 'approved',
          scope: 'session',
          selectedLabel: 'Approve for this session',
        },
      },
    ]);
    await writeWire(childDir, []);

    const session = new Session({
      kaos: testKaos.withCwd(workDir),
      homedir: sessionDir,
      rpc: createSessionRpc(),
      initializeMainAgent: false,
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });

    try {
      await session.resume();

      const child = await session.ensureAgentResumed('agent-0');
      expect(child?.permission.mode).toBe('yolo');
      expect(child?.permission.rules).toEqual([]);
      expect(child?.permission.data().rules).toEqual([]);
      expect(child?.permission.sessionApprovalRulePatterns).toContain(sessionApprovalRule);
    } finally {
      await session.close();
    }
  });
});

describe('Session.createAgent', () => {
  it('uses the Kaos current directory when the session cwd is omitted', async () => {
    const workDir = '/remote/project';
    const kaos = createFakeKaos({
      getcwd: () => workDir,
      mkdir: vi.fn(async () => {}),
      writeText: vi.fn().mockResolvedValue(0),
      stat: vi.fn(async (path: string) => {
        if ([workDir, `${workDir}/.git`].includes(path)) {
          return stat('dir');
        }
        if ([`${workDir}/README.md`, `${workDir}/AGENTS.md`].includes(path)) {
          return stat('file');
        }
        throw new Error(`ENOENT ${path}`);
      }),
      iterdir: async function* (path: string) {
        if (path === workDir) {
          yield `${workDir}/README.md`;
          return;
        }
        throw new Error(`ENOENT ${path}`);
      },
      readText: vi.fn(async (path: string) => {
        if (path === `${workDir}/AGENTS.md`) return 'remote instructions';
        throw new Error(`ENOENT ${path}`);
      }),
    });
    const session = new Session({
      id: 'test-subagent-remote-context',
      kaos,
      homedir: '/tmp/kimi-session',
      rpc: createSessionRpc(),
      initializeMainAgent: false,
    });

    const created = await session.createAgent({ type: 'main' }, { profile: contextProfile() });

    expect(created.agent.config.systemPrompt).toContain('cwd=/remote/project');
    expect(created.agent.config.systemPrompt).toContain('listing=└── README.md');
    expect(created.agent.config.systemPrompt).toContain('remote instructions');
  });

  it('renders profiles with the current directory listing and merged AGENTS.md files', async () => {
    const workDir = '/repo/packages/app';
    const kaos = createFakeKaos({
      mkdir: vi.fn(async () => {}),
      writeText: vi.fn().mockResolvedValue(0),
      stat: vi.fn(async (path: string) => {
        if (
          [
            '/repo',
            '/repo/.git',
            '/repo/packages',
            workDir,
            `${workDir}/.agents`,
            `${workDir}/.github`,
            `${workDir}/.github/workflows`,
            `${workDir}/src`,
            `${workDir}/.nori-code`,
          ].includes(path)
        ) {
          return stat('dir');
        }
        if (
          [
            '/repo/AGENTS.md',
            `${workDir}/.nori-code/AGENTS.md`,
            `${workDir}/AGENTS.md`,
            `${workDir}/package.json`,
            `${workDir}/src/index.ts`,
            `${workDir}/.agents/hidden.md`,
            `${workDir}/.github/workflows/ci.yml`,
          ].includes(path)
        ) {
          return stat('file');
        }
        throw new Error(`ENOENT ${path}`);
      }),
      iterdir: async function* (path: string) {
        if (path === workDir) {
          yield `${workDir}/.agents`;
          yield `${workDir}/.github`;
          yield `${workDir}/src`;
          yield `${workDir}/package.json`;
          return;
        }
        if (path === `${workDir}/.agents`) {
          yield `${workDir}/.agents/hidden.md`;
          return;
        }
        if (path === `${workDir}/.github`) {
          yield `${workDir}/.github/workflows`;
          return;
        }
        if (path === `${workDir}/.github/workflows`) {
          yield `${workDir}/.github/workflows/ci.yml`;
          return;
        }
        if (path === `${workDir}/src`) {
          yield `${workDir}/src/index.ts`;
          return;
        }
        throw new Error(`ENOENT ${path}`);
      },
      readText: vi.fn(async (path: string) => {
        if (path === '/repo/AGENTS.md') return 'root instructions';
        if (path === `${workDir}/.nori-code/AGENTS.md`) return 'brand instructions';
        if (path === `${workDir}/AGENTS.md`) return 'leaf instructions';
        throw new Error(`ENOENT ${path}`);
      }),
    });
    const session = new Session({
      id: 'test-subagent-agents-md',
      kaos: kaos.withCwd(workDir),
      homedir: '/tmp/kimi-session',
      rpc: createSessionRpc(),
      initializeMainAgent: false,
    });

    const created = await session.createAgent({ type: 'main' }, { profile: contextProfile() });

    expect(created.agent.config.systemPrompt).toContain('cwd=/repo/packages/app');
    expect(created.agent.config.systemPrompt).toContain('listing=├── .agents/');
    expect(created.agent.config.systemPrompt).toContain('├── .github/');
    expect(created.agent.config.systemPrompt).toContain('├── src/');
    expect(created.agent.config.systemPrompt).toContain('│   └── index.ts');
    expect(created.agent.config.systemPrompt).toContain('└── package.json');
    expect(created.agent.config.systemPrompt).not.toContain('hidden.md');
    expect(created.agent.config.systemPrompt).not.toContain('ci.yml');
    expect(created.agent.config.systemPrompt).toContain('<!-- From: /repo/AGENTS.md -->');
    expect(created.agent.config.systemPrompt).toContain('root instructions');
    expect(created.agent.config.systemPrompt).toContain(
      '<!-- From: /repo/packages/app/.nori-code/AGENTS.md -->',
    );
    expect(created.agent.config.systemPrompt).toContain('brand instructions');
    expect(created.agent.config.systemPrompt).toContain(
      '<!-- From: /repo/packages/app/AGENTS.md -->',
    );
    expect(created.agent.config.systemPrompt).toContain('leaf instructions');
  });

  it('uses the kimi home for global branded AGENTS.md files', async () => {
    const realHome = '/real-home';
    const kimiHome = '/kimi-home';
    const workDir = '/repo/packages/app';
    const kaos = createFakeKaos({
      gethome: () => realHome,
      mkdir: vi.fn(async () => {}),
      writeText: vi.fn().mockResolvedValue(0),
      stat: vi.fn(async (path: string) => {
        if (['/repo', '/repo/.git', '/repo/packages', workDir].includes(path)) {
          return stat('dir');
        }
        if ([`${kimiHome}/AGENTS.md`, `${realHome}/.nori-code/AGENTS.md`].includes(path)) {
          return stat('file');
        }
        throw new Error(`ENOENT ${path}`);
      }),
      // oxlint-disable-next-line require-yield
      iterdir: async function* () {
        return;
      },
      readText: vi.fn(async (path: string) => {
        if (path === `${kimiHome}/AGENTS.md`) return 'kimi home instructions';
        if (path === `${realHome}/.nori-code/AGENTS.md`) return 'stale real-home instructions';
        throw new Error(`ENOENT ${path}`);
      }),
    });
    const session = new Session({
      id: 'test-kimi-home-agents-md',
      kaos: kaos.withCwd(workDir),
      homedir: '/tmp/kimi-session',
      kimiHomeDir: kimiHome,
      rpc: createSessionRpc(),
      initializeMainAgent: false,
    });

    const created = await session.createAgent({ type: 'main' }, { profile: contextProfile() });

    expect(created.agent.config.systemPrompt).toContain('kimi home instructions');
    expect(created.agent.config.systemPrompt).not.toContain('stale real-home instructions');
  });

  it('inherits the parent agent cwd when creating a subagent', async () => {
    const sessionWorkDir = '/session/work';
    const parentWorkDir = '/parent/work';

    const kaos = createFakeKaos({
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeText: vi.fn().mockResolvedValue(0),
      stat: vi.fn(async (path: string) => {
        if ([sessionWorkDir, parentWorkDir].includes(path)) {
          return stat('dir');
        }
        throw new Error(`ENOENT ${path}`);
      }),
      // oxlint-disable-next-line require-yield
      iterdir: async function* () {
        return;
      },
      getcwd: () => sessionWorkDir,
    });

    const session = new Session({
      id: 'test-subagent-parent-cwd',
      kaos,
      homedir: '/tmp/kimi-session',
      rpc: createSessionRpc(),
      initializeMainAgent: false,
    });

    // Create a parent agent — it should start at the session workDir.
    const parent = await session.createAgent({ type: 'main' }, { profile: contextProfile() });
    expect(parent.agent.config.systemPrompt).toContain(`cwd=${sessionWorkDir}`);

    // Move the parent agent to a different cwd (e.g. after a config.update replay).
    parent.agent.config.update({ cwd: parentWorkDir });

    // Create a subagent from the moved parent.
    const child = await session.createAgent(
      { type: 'sub' },
      { profile: contextProfile(), parentAgentId: parent.id },
    );

    // The subagent should inherit the parent's current cwd, not the session default.
    expect(child.agent.config.systemPrompt).toContain(`cwd=${parentWorkDir}`);
    expect(child.agent.config.systemPrompt).not.toContain(`cwd=${sessionWorkDir}`);
  });

  it('passes session additional dirs to main and child agents', async () => {
    const extraDir = '/extra/work';
    const directories = new Set(['/workspace', extraDir]);
    const files = new Map([
      [join(extraDir, 'AGENTS.md'), 'extra agents instructions'],
      [join(extraDir, 'extra-file.ts'), 'export const extra = 1;'],
    ]);
    const session = new Session({
      id: 'test-subagent-additional-dirs',
      kaos: createFakeKaos({
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeText: vi.fn().mockResolvedValue(0),
        stat: vi.fn(async (path: string) => {
          if (directories.has(path)) return stat('dir');
          if (files.has(path)) return stat('file');
          throw new Error(`ENOENT ${path}`);
        }),
        iterdir: async function* (path: string) {
          if (path === extraDir) {
            yield join(extraDir, 'AGENTS.md');
            yield join(extraDir, 'extra-file.ts');
          }
        },
        readText: vi.fn(async (path: string) => {
          const content = files.get(path);
          if (content === undefined) throw new Error(`ENOENT ${path}`);
          return content;
        }),
      }),
      homedir: '/tmp/kimi-session',
      rpc: createSessionRpc(),
      initializeMainAgent: false,
      additionalDirs: [extraDir],
    });

    const main = await session.createMain();
    const child = await session.createAgent(
      { type: 'sub' },
      { profile: contextProfile(), parentAgentId: 'main' },
    );

    expect(main.getAdditionalDirs()).toEqual([extraDir]);
    expect(child.agent.getAdditionalDirs()).toEqual([extraDir]);
    expect(child.agent.config.systemPrompt).toContain(`additional=### ${extraDir}`);
    expect(child.agent.config.systemPrompt).toContain('extra-file.ts');
  });

  it('allocates the next unused generated agent id', async () => {
    const session = new Session({
      id: 'test-subagent-agent-id',
      kaos: createFakeKaos({
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeText: vi.fn().mockResolvedValue(0),
      }),
      homedir: '/tmp/kimi-session',
      rpc: createSessionRpc(),
      initializeMainAgent: false,
    });
    session.metadata.agents['agent-0'] = {
      homedir: '/tmp/kimi-session/agents/agent-0',
      type: 'sub',
      parentAgentId: null,
    };

    const created = await session.createAgent({ type: 'sub' });

    expect(created.id).toBe('agent-1');
    expect(session.agents.get('agent-1')).toBe(created.agent);
    expect(session.metadata.agents['agent-1']).toMatchObject({
      homedir: '/tmp/kimi-session/agents/agent-1',
      type: 'sub',
    });
  });

  it('shares the session McpConnectionManager with sub and main agents', async () => {
    const session = new Session({
      kaos: createFakeKaos({
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeText: vi.fn().mockResolvedValue(0),
      }),
      homedir: '/tmp/kimi-session',
      rpc: createSessionRpc(),
      initializeMainAgent: false,
    });

    const main = await session.createAgent({ type: 'main' });
    expect(main.agent.mcp).toBe(session.mcp);

    const sub = await session.createAgent({ type: 'sub' }, { parentAgentId: main.id });
    expect(sub.agent.mcp).toBe(session.mcp);
  });

  it('adds team controls without removing profile tools before builtin registration', async () => {
    const session = new Session({
      kaos: createFakeKaos({
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeText: vi.fn().mockResolvedValue(0),
      }),
      homedir: '/tmp/kimi-session',
      rpc: createSessionRpc(),
      initializeMainAgent: false,
    });
    const main = await session.createAgent(
      { type: 'main' },
      {
        profile: {
          ...contextProfile(),
          tools: ['SubAgent', 'GetGoal', 'UpdateGoal', 'mcp__*'],
        },
      },
    );

    expect(main.agent.tools.activeToolNames()).toEqual(expect.arrayContaining([
      'SubAgent',
      'GetGoal',
      'UpdateGoal',
      'mcp__*',
      'TeamCreate',
      'TeamDecide',
      'TeamStatus',
    ]));
  });

  it('keeps durable team identity in the stable system prefix and speaker envelopes out of history', async () => {
    const session = new Session({
      id: 'test-team-identity',
      kaos: createFakeKaos({
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeText: vi.fn().mockResolvedValue(0),
      }),
      homedir: '/tmp/kimi-session',
      rpc: createSessionRpc(),
      initializeMainAgent: false,
    });
    const main = await session.createAgent({ type: 'main' }, { profile: contextProfile() });
    const member = await session.createAgent(
      { type: 'sub' },
      {
        kind: 'team',
        parentAgentId: main.id,
        teamLeaderAgentId: main.id,
        profile: contextProfile(),
        teamIdentity: {
          name: 'Reviewer',
          title: 'Risk reviewer',
          intro: 'Checks regressions.',
          mandate: 'Review behavior before changes.',
          role: 'reviewer',
        },
      },
    );

    expect(member.agent.config.systemPrompt.startsWith('<team_identity>')).toBe(true);
    expect(member.agent.config.systemPrompt).toContain('Name: Reviewer');
    expect(member.agent.config.systemPrompt).toContain('You are not the main lead');
    expect(member.agent.config.systemPrompt).toContain('Do not call `TeamCreate`, `TeamAssign`, `TeamDecide`, or `TeamDismiss`.');
    expect(member.agent.config.systemPrompt).toContain('temporary `SubAgent` tool');
    expect(member.agent.config.systemPrompt).not.toContain('You are the main lead');
    await member.agent.refreshSystemPrompt();
    expect(member.agent.config.systemPrompt.startsWith('<team_identity>')).toBe(true);
    expect(member.agent.teamWriteLocked).toBe(true);
    expect(member.agent.teamWriteEnabled).toBe(false);

    const discussion = await session.createTeamDiscussion(
      main.id,
      'Keep the prompt cache warm.',
      [member.id],
    );
    expect(discussion.agent.config.systemPrompt).toContain('<team_discussion_transcript>');
    expect(discussion.agent.config.systemPrompt).toContain('Topic: Keep the prompt cache warm.');
    expect(discussion.agent.config.systemPrompt).not.toContain(discussion.discussion.startedAt);
    expect(discussion.agent.config.systemPrompt).not.toContain(discussion.discussion.updatedAt);
    await discussion.agent.refreshSystemPrompt();
    expect(discussion.agent.config.systemPrompt).not.toContain(discussion.discussion.startedAt);
    expect(discussion.agent.config.systemPrompt).not.toContain(discussion.discussion.updatedAt);

    member.agent.context.appendUserMessage(
      [{ type: 'text', text: 'Inspect the cache behavior.' }],
      {
        kind: 'system_trigger',
        name: 'team_message',
        speaker: { from: 'lead', speakerId: 'main', speakerName: '主代理' },
      },
    );
    const rawText = member.agent.context.history.at(-1)?.content[0];
    expect(rawText).toMatchObject({ type: 'text', text: 'Inspect the cache behavior.' });
    expect(member.agent.context.messages.at(-1)?.content[0]).toMatchObject({
      type: 'text',
      text: '<message from="lead:main" name="主代理">Inspect the cache behavior.</message>',
    });
  });

  it('preflights TeamCreate so a later duplicate leaves no partial team', async () => {
    const session = new Session({
      id: 'test-team-create-atomic',
      kaos: createFakeKaos({
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeText: vi.fn().mockResolvedValue(0),
      }),
      homedir: '/tmp/kimi-session',
      rpc: createSessionRpc(),
      initializeMainAgent: false,
    });
    const main = await session.createAgent({ type: 'main' }, { profile: contextProfile() });
    const host = new SessionSubagentHost(session, main.id);
    const identity = {
      name: 'Reviewer',
      title: 'Risk reviewer',
      intro: 'Checks regressions.',
      mandate: 'Review behavior before changes.',
      role: 'reviewer',
    };

    await expect(host.createTeam([identity, { ...identity, title: 'Second reviewer' }]))
      .rejects.toThrow('duplicate member name');

    expect(session.teamMemberMetadata(main.id)).toEqual([]);
    expect(Object.keys(session.metadata.agents)).toEqual([main.id]);
  });

  it('keeps Invite, Kick, and Decide exclusive to the main team lead', async () => {
    const session = new Session({
      id: 'test-team-lead-boundary',
      kaos: createFakeKaos({
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeText: vi.fn().mockResolvedValue(0),
      }),
      homedir: '/tmp/kimi-session',
      rpc: createSessionRpc(),
      initializeMainAgent: false,
    });
    const main = await session.createAgent({ type: 'main' }, { profile: contextProfile() });
    const member = await session.createAgent(
      { type: 'sub' },
      {
        kind: 'team',
        parentAgentId: main.id,
        teamLeaderAgentId: main.id,
        profile: contextProfile(),
        teamIdentity: {
          name: 'Reviewer',
          title: 'Risk reviewer',
          intro: 'Checks regressions.',
          mandate: 'Review behavior before changes.',
          role: 'reviewer',
        },
      },
    );
    const host = new SessionSubagentHost(session, member.id);

    await expect(host.inviteToDiscussion([member.id])).rejects.toThrow('main agent');
    await expect(host.kickFromDiscussion([member.id])).rejects.toThrow('main agent');
    await expect(host.decideTeamDiscussion('continue', undefined, undefined, signal)).rejects.toThrow('main agent');
  });

  it('delivers each shared TeamSpeak statement once per participant and blocks unscheduled sends', async () => {
    const session = new Session({
      id: 'test-team-discussion-cursors',
      kaos: createFakeKaos({
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeText: vi.fn().mockResolvedValue(0),
      }),
      homedir: '/tmp/kimi-session',
      rpc: createSessionRpc(),
      initializeMainAgent: false,
    });
    const main = await session.createAgent({ type: 'main' }, { profile: contextProfile() });
    const identity = (name: string) => ({
      name,
      title: `${name} title`,
      intro: `${name} intro`,
      mandate: `${name} mandate`,
      role: `${name} role`,
    });
    const author = await session.createAgent(
      { type: 'sub' },
      { kind: 'team', parentAgentId: main.id, teamLeaderAgentId: main.id, profile: contextProfile(), teamIdentity: identity('Author') },
    );
    const reader = await session.createAgent(
      { type: 'sub' },
      { kind: 'team', parentAgentId: main.id, teamLeaderAgentId: main.id, profile: contextProfile(), teamIdentity: identity('Reader') },
    );
    const discussion = await session.createTeamDiscussion(main.id, 'Review the cache path.', [author.id, reader.id]);

    await expect(session.publishTeamDiscussionStatement(author.id, 'Only send this through TeamSpeak.'))
      .rejects.toThrow('scheduled discussion turn');

    session.beginTeamDiscussionTurn(discussion.id, author.id);
    await expect(session.publishTeamDiscussionStatement(author.id, 'Only send this through TeamSpeak.'))
      .resolves.toEqual({ discussionAgentId: discussion.id, entryId: 1 });
    await expect(session.publishTeamDiscussionStatement(author.id, 'A duplicate must fail.'))
      .rejects.toThrow('at most once');
    session.endTeamDiscussionTurn(discussion.id, author.id);
    expect(session.consumeTeamDiscussionSpeak(discussion.id, author.id)?.message)
      .toBe('Only send this through TeamSpeak.');

    // The discussion transcript may compact independently from the transport
    // journal. A recipient that has not been scheduled must still receive the
    // shared statement exactly once.
    discussion.agent.context.clear();

    const unread = await session.unreadTeamDiscussionStatements(discussion.id, reader.id);
    expect(unread).toMatchObject({
      cursor: 1,
      statements: [{ entryId: 1, agentId: author.id, name: 'Author', message: 'Only send this through TeamSpeak.' }],
    });
    await session.acknowledgeTeamDiscussionStatements(discussion.id, reader.id, unread.cursor);
    await expect(session.unreadTeamDiscussionStatements(discussion.id, reader.id)).resolves.toMatchObject({
      cursor: 1,
      statements: [],
    });
    await expect(session.unreadTeamDiscussionStatements(discussion.id, author.id)).resolves.toMatchObject({
      cursor: 0,
      statements: [],
    });
  });

  it('notifies every historical invitee once without starting extra lifecycle turns', async () => {
    const session = new Session({
      id: 'test-team-discussion-lifecycle',
      kaos: createFakeKaos({
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeText: vi.fn().mockResolvedValue(0),
      }),
      homedir: '/tmp/kimi-session',
      rpc: createSessionRpc(),
      initializeMainAgent: false,
    });
    const main = await session.createAgent({ type: 'main' }, { profile: contextProfile() });
    const current = await session.createAgent(
      { type: 'sub' },
      {
        kind: 'team',
        parentAgentId: main.id,
        teamLeaderAgentId: main.id,
        profile: contextProfile(),
        teamIdentity: {
          name: 'Reviewer',
          title: 'Risk reviewer',
          intro: 'Checks regressions.',
          mandate: 'Review behavior.',
          role: 'reviewer',
        },
      },
    );
    const removed = await session.createAgent(
      { type: 'sub' },
      {
        kind: 'team',
        parentAgentId: main.id,
        teamLeaderAgentId: main.id,
        profile: contextProfile(),
        teamIdentity: {
          name: 'Removed',
          title: 'Former reviewer',
          intro: 'Checks architecture.',
          mandate: 'Review the design.',
          role: 'reviewer',
        },
      },
    );
    const host = new SessionSubagentHost(session, main.id);
    await main.agent.discussMode.enter();
    await host.lockTeamWritesForDiscuss();
    expect(main.agent.discussMode.isActive).toBe(true);

    const members = [current, removed];
    const prompts = members.map(({ agent }) => vi.spyOn(agent.turn, 'prompt'));
    const started = await host.decideTeamDiscussion(
      'start',
      'Check the cache key.',
      members.map(({ id }) => id),
      signal,
      'The cache key must stay stable.',
    );
    main.agent.discussMode.exit();
    await expect(host.decideTeamDiscussion('continue', undefined, undefined, signal))
      .rejects.toThrow('EnterDiscussMode');
    await main.agent.discussMode.enter();
    await host.lockTeamWritesForDiscuss();
    const continued = await host.decideTeamDiscussion('continue', undefined, undefined, signal);
    expect(continued.discussionAgentId).toBe(started.discussionAgentId);
    expect(continued.discussion.startedAt).toBe(started.discussion.startedAt);
    expect(main.agent.discussMode.isActive).toBe(true);
    main.agent.discussMode.exit();
    await expect(host.decideTeamDiscussion('continue', undefined, undefined, signal))
      .rejects.toThrow('EnterDiscussMode');
    await expect(host.kickFromDiscussion([removed.id]))
      .rejects.toThrow('EnterDiscussMode');
    await main.agent.discussMode.enter();
    await host.lockTeamWritesForDiscuss();
    for (const [index, { agent }] of members.entries()) {
      expect(agent.context.history.filter((message) => message.content.some(
        (part) => part.type === 'text' && part.text.startsWith('You have been invited to a team discussion'),
      ))).toHaveLength(1);
      // The one scheduled turn is part of the normal discussion round; the
      // notification itself must not create another turn.
      expect(prompts[index]).toHaveBeenCalledTimes(2);
    }

    await host.kickFromDiscussion([removed.id]);
    await host.decideTeamDiscussion('archive', undefined, undefined, signal);
    expect(main.agent.discussMode.isActive).toBe(false);
    for (const [index, { agent }] of members.entries()) {
      expect(agent.context.history.filter((message) => message.content.some(
        (part) => part.type === 'text' && part.text.includes('has ended and is archived'),
      ))).toHaveLength(1);
      expect(prompts[index]).toHaveBeenCalledTimes(2);
    }
  });

  it('requires explicit complete team assignments and grants writes only to assigned members', async () => {
    const session = new Session({
      id: 'test-team-assignments',
      kaos: createFakeKaos({
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeText: vi.fn().mockResolvedValue(0),
      }),
      homedir: '/tmp/kimi-session',
      rpc: createSessionRpc(),
      initializeMainAgent: false,
    });
    const main = await session.createAgent({ type: 'main' }, { profile: contextProfile() });
    const identity = (name: string) => ({
      name,
      title: `${name} title`,
      intro: `${name} intro`,
      mandate: `${name} mandate`,
      role: `${name} role`,
    });
    const first = await session.createAgent(
      { type: 'sub' },
      { kind: 'team', parentAgentId: main.id, teamLeaderAgentId: main.id, profile: contextProfile(), teamIdentity: identity('First') },
    );
    const second = await session.createAgent(
      { type: 'sub' },
      { kind: 'team', parentAgentId: main.id, teamLeaderAgentId: main.id, profile: contextProfile(), teamIdentity: identity('Second') },
    );
    const host = new SessionSubagentHost(session, main.id);
    const firstPrompt = vi.spyOn(first.agent.turn, 'prompt').mockReturnValue(1);
    const secondPrompt = vi.spyOn(second.agent.turn, 'prompt').mockReturnValue(2);

    await expect(session.assignTeamTasks(main.id, [
      { agentId: first.id, task: null },
      { agentId: second.id, task: null },
    ])).rejects.toThrow('all-null');
    await expect(session.assignTeamTasks(main.id, [
      { agentId: first.id, task: 'Implement the focused change.' },
    ])).rejects.toThrow('explicitly include every team member');

    await main.agent.discussMode.enter();
    await session.lockTeamAssignments(main.id);
    expect(main.agent.discussMode.isActive).toBe(true);
    await host.assignTeam([
      { agentId: first.id, task: 'Implement the focused change.' },
      { agentId: second.id, task: null },
    ], signal);
    expect(main.agent.discussMode.isActive).toBe(false);
    expect(first.agent.teamWriteEnabled).toBe(true);
    expect(first.agent.permission.mode).toBe('auto');
    expect(second.agent.teamWriteEnabled).toBe(false);
    expect(second.agent.permission.mode).toBe('manual');
    expect(firstPrompt).toHaveBeenCalledTimes(1);
    const assignedPrompt = firstPrompt.mock.calls[0]?.[0]?.[0];
    expect(assignedPrompt?.type).toBe('text');
    const assignedText = assignedPrompt?.type === 'text' ? assignedPrompt.text : '';
    expect(assignedText).toContain('Implement the focused change.');
    expect(assignedText).toContain('TeamSpeak');
    expect(assignedText).toContain('TeamDM');
    expect(assignedText).toContain('completed');
    expect(assignedText).toContain('blocked');
    expect(assignedText).toContain('needs_decision');
    expect(assignedText).toContain('results from temporary SubAgents');
    expect(assignedText).toContain('Result summary');
    expect(assignedText).toContain('Files changed or behavior verified');
    expect(assignedText).toContain('Verification actually run');
    expect(assignedText).toContain('Remaining risks or blockers');
    expect(secondPrompt).not.toHaveBeenCalled();

    await session.lockTeamAssignments(main.id);
    expect(session.getAgentMetadata(first.id)?.assignedTask).toBeUndefined();
    expect(first.agent.teamWriteEnabled).toBe(false);
    expect(first.agent.permission.mode).toBe('manual');
  });

  it('dismisses a team member together with its temporary descendant branch', async () => {
    const session = new Session({
      id: 'test-team-dismiss-subtree',
      kaos: createFakeKaos({
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeText: vi.fn().mockResolvedValue(0),
      }),
      homedir: '/tmp/kimi-session',
      rpc: createSessionRpc(),
      initializeMainAgent: false,
    });
    const main = await session.createAgent({ type: 'main' }, { profile: contextProfile() });
    const member = await session.createAgent(
      { type: 'sub' },
      {
        kind: 'team',
        parentAgentId: main.id,
        teamLeaderAgentId: main.id,
        profile: contextProfile(),
        teamIdentity: {
          name: 'Builder',
          title: 'Implementation partner',
          intro: 'Builds the assigned change.',
          mandate: 'Implement only assigned work.',
          role: 'builder',
        },
      },
    );
    const temporary = await session.createAgent(
      { type: 'sub' },
      {
        parentAgentId: member.id,
        profile: contextProfile(),
      },
    );
    const unrelated = await session.createAgent(
      { type: 'sub' },
      {
        parentAgentId: main.id,
        profile: contextProfile(),
      },
    );

    await session.dismissTeamMembers(main.id, [member.id], 'No longer needed.', true);

    expect(session.getAgentMetadata(member.id)).toBeUndefined();
    expect(session.getAgentMetadata(temporary.id)).toBeUndefined();
    expect(session.agents.has(member.id)).toBe(false);
    expect(session.agents.has(temporary.id)).toBe(false);
    expect(session.getAgentMetadata(unrelated.id)).toBeDefined();
  });

  it('reports direct Team Agent identity, observable status, and assigned task', async () => {
    const session = new Session({
      id: 'test-team-status',
      kaos: createFakeKaos({
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeText: vi.fn().mockResolvedValue(0),
      }),
      homedir: '/tmp/kimi-session',
      rpc: createSessionRpc(),
      initializeMainAgent: false,
    });
    const main = await session.createAgent({ type: 'main' }, { profile: contextProfile() });
    const member = await session.createAgent(
      { type: 'sub' },
      {
        kind: 'team',
        parentAgentId: main.id,
        teamLeaderAgentId: main.id,
        profile: contextProfile(),
        teamIdentity: {
          name: 'Builder',
          title: 'Implementation partner',
          intro: 'Builds changes.',
          mandate: 'Implement assigned work.',
          role: 'builder',
        },
      },
    );
    await session.assignTeamTasks(main.id, [{ agentId: member.id, task: 'Implement TeamStatus.' }]);

    const status = await new SessionSubagentHost(session, main.id).getTeamStatus();

    expect(status).toMatchObject({
      agent_id: main.id,
      member_count: 1,
      members: [{
        agent_id: member.id,
        name: 'Builder',
        title: 'Implementation partner',
        intro: 'Builds changes.',
        mandate: 'Implement assigned work.',
        role: 'builder',
        status: 'idle',
        assigned_task: 'Implement TeamStatus.',
      }],
    });
  });

  it('returns empty direct reports for a Team Agent and a lead without members', async () => {
    const session = new Session({
      id: 'test-empty-team-status',
      kaos: createFakeKaos({
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeText: vi.fn().mockResolvedValue(0),
      }),
      homedir: '/tmp/kimi-session',
      rpc: createSessionRpc(),
      initializeMainAgent: false,
    });
    const main = await session.createAgent({ type: 'main' }, { profile: contextProfile() });
    const member = await session.createAgent(
      { type: 'sub' },
      {
        kind: 'team',
        parentAgentId: main.id,
        teamLeaderAgentId: main.id,
        profile: contextProfile(),
        teamIdentity: {
          name: 'Reader',
          title: 'Reader',
          intro: 'Reads status.',
          mandate: 'Report status.',
          role: 'reader',
        },
      },
    );

    await expect(new SessionSubagentHost(session, main.id).getTeamStatus()).resolves.toMatchObject({
      member_count: 1,
    });
    await expect(new SessionSubagentHost(session, member.id).getTeamStatus()).resolves.toMatchObject({
      agent_id: member.id,
      member_count: 0,
      message: 'No direct persistent Team Agents.',
      members: [],
    });

    const emptySession = new Session({
      id: 'test-empty-main-team-status',
      kaos: createFakeKaos({
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeText: vi.fn().mockResolvedValue(0),
      }),
      homedir: '/tmp/kimi-session',
      rpc: createSessionRpc(),
      initializeMainAgent: false,
    });
    const emptyMain = await emptySession.createAgent({ type: 'main' }, { profile: contextProfile() });
    await expect(new SessionSubagentHost(emptySession, emptyMain.id).getTeamStatus()).resolves.toMatchObject({
      member_count: 0,
      members: [],
    });
  });
});

function fakeSession(
  parent: Agent,
  child: Agent,
  metadataAgents: Session['metadata']['agents'] = {},
) {
  const agents = new Map<string, Agent>([['main', parent]]);
  if (metadataAgents['agent-0'] !== undefined) {
    agents.set('agent-0', child);
  }
  return {
    agents,
    options: { kimiHomeDir: undefined },
    metadata: {
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      title: 'Test Session',
      isCustomTitle: false,
      agents: metadataAgents,
      custom: {},
    },
    writeMetadata: vi.fn(async () => {}),
    archiveCompletedSubagent: vi.fn(async (id: string) => {
      const meta = metadataAgents[id];
      if (meta === undefined) return;
      metadataAgents[id] = {
        ...meta,
        archived: true,
        completedAt: '2026-08-18T00:00:00.000Z',
      };
    }),
    systemContextKaos: vi.fn((cwd: string) => parent.kaos.withCwd(cwd)),
    getReadyAgent: vi.fn((id: string) => agents.get(id)),
    getAgentMetadata: vi.fn((id: string) => metadataAgents[id]),
    ensureAgentResumed: vi.fn(async (id: string) => {
      const agent = agents.get(id);
      if (agent === undefined) {
        throw new Error(`Agent "${id}" was not found`);
      }
      return agent;
    }),
    createAgent: vi.fn(
      async (
        config: Parameters<Session['createAgent']>[0],
        options: Parameters<Session['createAgent']>[1] = {},
      ) => {
        agents.set('agent-0', child);
        const parentAgentId = options.parentAgentId ?? null;
        if (options.persistMetadata !== false) {
          metadataAgents['agent-0'] = {
            homedir: '/tmp/kimi-session/agents/agent-0',
            type: config.type ?? 'main',
            parentAgentId,
            subagentItem: options.subagentItem,
          };
        }
        if (options.profile !== undefined) {
          child.useProfile(options.profile);
        }
        return { id: 'agent-0', agent: child };
      },
    ),
  } as unknown as Session;
}

function contextProfile(): ResolvedAgentProfile {
  return {
    name: 'context-profile',
    systemPrompt: (context) =>
      [
        `cwd=${context.cwd}`,
        `listing=${context.cwdListing ?? ''}`,
        `agents=${context.agentsMd ?? ''}`,
        `additional=${context.additionalDirsInfo ?? ''}`,
      ].join('\n'),
    tools: [],
  };
}

function lookupToolRegistration() {
  return {
    name: 'Lookup',
    description: 'Look up a short test value.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  };
}

function profile(input: {
  readonly name: string;
  readonly tools: readonly string[];
  readonly systemPrompt: string;
  readonly description?: string | undefined;
  readonly subagents?: Record<string, ResolvedAgentProfile> | undefined;
}): ResolvedAgentProfile {
  return {
    name: input.name,
    description: input.description,
    systemPrompt: () => input.systemPrompt,
    tools: [...input.tools],
    subagents: input.subagents,
  };
}

function stat(kind: 'dir' | 'file') {
  return {
    stMode: kind === 'dir' ? 0o040000 : 0o100000,
    stIno: 0,
    stDev: 0,
    stNlink: 1,
    stUid: 0,
    stGid: 0,
    stSize: 0,
    stAtime: 0,
    stMtime: 0,
    stCtime: 0,
  };
}

function queuedTask(index: number): QueuedSubagentTask<number> {
  return {
    kind: 'spawn',
    data: index,
    profileName: 'coder',
    parentToolCallId: 'call_subagent',
    prompt: `Review item-${String(index)}`,
    description: `Review #${String(index)}`,
    subagentIndex: index,
    runInBackground: false,
  };
}

function textResult(text: string): Awaited<ReturnType<GenerateFn>> {
  return {
    id: 'mock-text',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      toolCalls: [],
    },
    usage: {
      inputOther: 0,
      output: 0,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    },
    finishReason: 'completed',
    rawFinishReason: 'stop',
  };
}

function userTextMessages(history: readonly Message[]): string[] {
  return history
    .filter((message) => message.role === 'user')
    .map((message) =>
      message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join(''),
    );
}

async function writeWire(homedir: string, records: readonly Record<string, unknown>[]) {
  await mkdir(homedir, { recursive: true });
  const wireRecords =
    records.length === 0
      ? []
      : [
          {
            type: 'metadata',
            protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
            created_at: 1,
          },
          ...records,
        ];
  const text = wireRecords.map((record) => JSON.stringify(record)).join('\n');
  await writeFile(join(homedir, 'wire.jsonl'), text.length === 0 ? '' : `${text}\n`, 'utf-8');
}

function childBashToolResultOutput(child: AgentTestContext): string | undefined {
  for (const entry of child.allEvents) {
    if (entry.type !== '[wire]' || entry.event !== 'context.append_loop_event') continue;
    const loopEvent = (
      entry.args as {
        event?: { type?: string; toolCallId?: string; result?: { output?: unknown } };
      }
    ).event;
    if (loopEvent?.type === 'tool.result' && loopEvent.toolCallId === 'call_bash') {
      const output = loopEvent.result?.output;
      return typeof output === 'string' ? output : undefined;
    }
  }
  return undefined;
}

function bashCall(): ToolCall {
  return {
    type: 'function',
    id: 'call_bash',
    name: 'Bash',
      arguments: '{"command":"printf should-not-run","timeout":60}',
  };
}

function createSessionRpc(): SDKSessionRPC {
  return new Proxy(
    {},
    {
      get: () => vi.fn(),
    },
  ) as SDKSessionRPC;
}
