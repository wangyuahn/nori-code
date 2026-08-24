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
import { ProviderManager } from '../../src/session/provider-manager';
import { SessionSubagentHost } from '../../src/session/subagent-host';
import type { NoriMemoryProvider } from '../../src/tools/builtin/nori/types';
import { abortError, userCancellationReason } from '../../src/utils/abort';
import { testAgent, type AgentTestContext } from '../agent/harness/agent';
import { createScriptedGenerate } from '../agent/harness/scripted-generate';
import { createFakeKaos } from '../tools/fixtures/fake-kaos';
import { executeTool } from '../tools/fixtures/execute-tool';

const signal = new AbortController().signal;
const tempDirs: string[] = [];
type GenerateFn = NonNullable<AgentOptions['generate']>;

/**
 * Wraps a hand-rolled turn double in the collaborator surface the team
 * schedulers call, so each scenario below only has to spell out the behaviour it
 * is actually asserting.
 *
 * - `requestPrompt` is derived from the double's own `prompt` mock, so call-count
 *   and argument assertions keep working unchanged.
 * - `fullCompaction` reports "not compacting": these scenarios are about turn
 *   scheduling, and a scheduler waits compaction out before every prompt.
 *
 * Without this the alternative would be defensive optional access in production
 * code (`agent.fullCompaction?.…`) that only ever guards against test doubles.
 */
function agentDouble(parts: { context?: unknown; turn: Record<string, unknown> }): Agent {
  const turn = parts.turn;
  let lastTurnId = 0;
  const requestPrompt = (input: unknown, origin: unknown) => {
    const prompt = turn['prompt'] as ((i: unknown, o: unknown) => number | null | undefined) | undefined;
    const turnId = prompt?.(input, origin) ?? null;
    if (turnId !== null) {
      lastTurnId = turnId;
      return { status: 'started', turnId };
    }
    // A double reports `busy` only while it claims an active turn. An *idle*
    // double that refuses the prompt is the "member never woke up" case, which
    // reaches the scheduler as `deferred` and then resolves to unstarted.
    return turn['hasActiveTurn'] === true
      ? { status: 'busy', activeTurnId: lastTurnId }
      : { status: 'deferred' };
  };
  return {
    ...parts,
    fullCompaction: { isCompacting: false, waitForCompletion: async () => {} },
    // Descriptors rather than a spread: several doubles expose `hasActiveTurn` as
    // a getter over mutable scenario state, and a spread would snapshot it.
    turn: Object.defineProperties({}, {
      ...Object.getOwnPropertyDescriptors(turn),
      requestPrompt: { value: requestPrompt },
      currentId: { get: () => lastTurnId },
    }),
  } as unknown as Agent;
}

/** Every `Session` member `SessionSubagentHost` reaches for. */
type HostSessionMember =
  | 'metadata'
  | 'acknowledgeTeamDiscussionStatements'
  | 'acknowledgeTeamReport'
  | 'activeTeamDiscussion'
  | 'assertTeamDiscussionMode'
  | 'assertTeamManager'
  | 'assignTeamTasks'
  | 'beginTeamDiscussionTurn'
  | 'consumeTeamDiscussionSpeak'
  | 'createAgent'
  | 'createTeamDiscussion'
  | 'createTeamMember'
  | 'dismissTeamMembers'
  | 'endTeamDiscussionTurn'
  | 'ensureAgentResumed'
  | 'ensureTeamDiscussionMode'
  | 'getAgentMetadata'
  | 'lockTeamAssignments'
  | 'notifyMissingTeamReport'
  | 'notifyRunningTeamMember'
  | 'postTeamChatMessage'
  | 'publishLeadDiscussionStatement'
  | 'publishTeamDiscussionStatement'
  | 'recordTeamReport'
  | 'releaseTeamAssignment'
  | 'teamMemberMetadata'
  | 'unreadTeamDiscussionStatements'
  | 'updateTeamDiscussion';

/**
 * A complete Session double: every member the host may call, answering "nothing
 * configured", with the scenario's own overrides on top.
 *
 * Completeness is the point. A double that merely omitted the members a
 * scenario did not care about used to push the host into
 * `typeof this.session.x === 'function'` guards — production code branching on
 * the shape of a test, and silently skipping real work when the guard was
 * wrong. Filling the surface here is what lets those guards not exist.
 *
 * Authorization defaults to permissive: these scenarios are about turn
 * scheduling, and the department guards are exercised against a real Session.
 */
function teamSessionDouble(parts: Partial<Record<HostSessionMember, unknown>>): Session {
  return {
    metadata: { agents: {} },
    acknowledgeTeamDiscussionStatements: vi.fn(async () => undefined),
    acknowledgeTeamReport: vi.fn(async () => undefined),
    activeTeamDiscussion: vi.fn(() => undefined),
    assertTeamDiscussionMode: vi.fn(async () => undefined),
    assertTeamManager: vi.fn(),
    assignTeamTasks: vi.fn(async () => []),
    beginTeamDiscussionTurn: vi.fn(),
    consumeTeamDiscussionSpeak: vi.fn(() => undefined),
    createAgent: vi.fn(),
    createTeamDiscussion: vi.fn(),
    createTeamMember: vi.fn(),
    dismissTeamMembers: vi.fn(async () => undefined),
    endTeamDiscussionTurn: vi.fn(),
    ensureAgentResumed: vi.fn(),
    ensureTeamDiscussionMode: vi.fn(async () => undefined),
    getAgentMetadata: vi.fn(() => undefined),
    lockTeamAssignments: vi.fn(async () => undefined),
    notifyMissingTeamReport: vi.fn(async () => undefined),
    notifyRunningTeamMember: vi.fn(),
    postTeamChatMessage: vi.fn(async (
      _leaderAgentId: string,
      senderAgentId: string,
      senderName: string,
      message: string,
      mentions: readonly string[],
    ) => ({ messageId: 1, agentId: senderAgentId, name: senderName, message, mentions, sentAt: '2026-08-20T00:00:00.000Z' })),
    publishLeadDiscussionStatement: vi.fn(async () => ({ discussionAgentId: 'agent-discussion', entryId: 1 })),
    publishTeamDiscussionStatement: vi.fn(async () => ({ discussionAgentId: 'agent-discussion', entryId: 1 })),
    recordTeamReport: vi.fn(async () => undefined),
    releaseTeamAssignment: vi.fn(async () => undefined),
    teamMemberMetadata: vi.fn(() => []),
    unreadTeamDiscussionStatements: vi.fn(async () => ({ statements: [], cursor: 0 })),
    // Echoes the patch back, which is what a real persist returns: the four
    // fields the callers then read off the updated discussion.
    updateTeamDiscussion: vi.fn(async (_discussionAgentId: string, patch: unknown) => patch),
    ...parts,
  } as unknown as Session;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('SessionSubagentHost', () => {
  it('keeps the scheduled lease across an ordinary tool call and then accepts TeamSpeak', async () => {
    const transcript = testAgent({ type: 'sub' });
    let leaseAgentId: string | undefined;
    let published: { entryId: number; agentId: string; name: string; message: string } | undefined;
    const memberHost = {
      speakInDiscussion: vi.fn(async (message: string) => {
        if (leaseAgentId !== 'agent-review') throw new Error('scheduled discussion turn lease was released');
        published = { entryId: 1, agentId: 'agent-review', name: 'Reviewer', message };
        return { discussionAgentId: 'agent-discussion', entryId: 1 };
      }),
      cancelAll: vi.fn(),
    } as unknown as SessionSubagentHost;
    const member = testAgent({
      type: 'sub',
      subagentHost: memberHost,
      runtime: {
        webSearcher: {
          search: vi.fn(async () => [{
            title: 'Cache result',
            url: 'https://example.test/cache',
            snippet: 'The prompt cache key remains stable.',
          }]),
        },
      },
    });
    member.configure({ tools: ['WebSearch', 'TeamSpeak'] });
    member.mockNextResponse(
      { type: 'text', text: 'I will verify the cache behavior first.' },
      {
        type: 'function',
        id: 'call_search',
        name: 'WebSearch',
        arguments: JSON.stringify({ query: 'prompt cache behavior' }),
      },
    );
    member.mockNextResponse(
      { type: 'text', text: 'The search confirms the cache key is stable.' },
      {
        type: 'function',
        id: 'call_team_speak',
        name: 'TeamSpeak',
        arguments: JSON.stringify({ message: 'The search confirms the cache key is stable.' }),
      },
    );
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
    const session = teamSessionDouble({
      metadata: { agents: { 'agent-discussion': discussionMeta, 'agent-review': memberMeta } },
      activeTeamDiscussion: vi.fn(() => ['agent-discussion', discussionMeta] as const),
      getAgentMetadata: vi.fn((id: string) => id === 'agent-discussion' ? discussionMeta : id === 'agent-review' ? memberMeta : undefined),
      ensureAgentResumed: vi.fn(async (id: string) => id === 'agent-discussion' ? transcript.agent : member.agent),
      unreadTeamDiscussionStatements: vi.fn(async () => ({ statements: [], cursor: 0 })),
      acknowledgeTeamDiscussionStatements: vi.fn(async () => undefined),
      beginTeamDiscussionTurn: vi.fn((_discussionAgentId: string, agentId: string) => { leaseAgentId = agentId; }),
      endTeamDiscussionTurn: vi.fn((_discussionAgentId: string, agentId: string) => {
        if (leaseAgentId === agentId) leaseAgentId = undefined;
      }),
      consumeTeamDiscussionSpeak: vi.fn(() => {
        const result = published;
        published = undefined;
        return result;
      }),
    });
    const host = new SessionSubagentHost(session, 'main');

    const result = await host.decideTeamDiscussion('continue', undefined, undefined, signal);

    expect(memberHost.speakInDiscussion).toHaveBeenCalledWith('The search confirms the cache key is stable.');
    expect(member.llmCalls).toHaveLength(2);
    expect(result.statements).toEqual([{
      agentId: 'agent-review',
      statement: 'The search confirms the cache key is stable.',
      skipped: false,
    }]);
    expect(leaseAgentId).toBeUndefined();
  });

  it('switches from first response timeout to a resettable full-turn activity deadline', async () => {
    vi.useFakeTimers();
    try {
      const transcript = testAgent({ type: 'sub' });
      let active = false;
      let spoken = false;
      let firstResponse!: () => void;
      let complete!: () => void;
      let progressListener: (() => void) | undefined;
      const member = agentDouble({
        context: { history: [] },
        turn: {
          get hasActiveTurn() {
            return active;
          },
          prompt: vi.fn(() => {
            active = true;
            setTimeout(() => {
              progressListener?.();
              firstResponse();
            }, 1);
            return 1;
          }),
          waitForTurnFirstRequest: vi.fn(() => new Promise<void>((resolve) => {
            firstResponse = resolve;
          })),
          onTurnProgress: vi.fn((listener: () => void) => {
            progressListener = listener;
            return () => {
              progressListener = undefined;
            };
          }),
          waitForCurrentTurn: vi.fn(async (waitSignal?: AbortSignal) => new Promise((resolve, reject) => {
            complete = () => {
              active = false;
              spoken = true;
              resolve({ event: { reason: 'completed' } });
            };
            waitSignal?.addEventListener('abort', () => {
              active = false;
              reject(waitSignal.reason);
            }, { once: true });
          })),
        },
      });
      const discussionMeta = {
        homedir: '/discussion',
        type: 'sub' as const,
        parentAgentId: 'main',
        kind: 'sub' as const,
        teamLeaderAgentId: 'main',
        discussion: {
          participantAgentIds: ['agent-review'],
          status: 'active' as const,
          topic: 'Allow long member progress',
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
      const session = teamSessionDouble({
        metadata: { agents: { 'agent-discussion': discussionMeta, 'agent-review': memberMeta } },
        activeTeamDiscussion: vi.fn(() => ['agent-discussion', discussionMeta] as const),
        getAgentMetadata: vi.fn((id: string) =>
          id === 'agent-discussion' ? discussionMeta : id === 'agent-review' ? memberMeta : undefined,
        ),
        ensureAgentResumed: vi.fn(async (id: string) =>
          id === 'agent-discussion' ? transcript.agent : member,
        ),
        unreadTeamDiscussionStatements: vi.fn(async () => ({ statements: [], cursor: 0 })),
        acknowledgeTeamDiscussionStatements: vi.fn(async () => undefined),
        beginTeamDiscussionTurn: vi.fn(),
        endTeamDiscussionTurn: vi.fn(),
        consumeTeamDiscussionSpeak: vi.fn(() => spoken ? {
          entryId: 1,
          agentId: 'agent-review',
          name: 'Reviewer',
          message: 'The long tool call completed.',
        } : undefined),
      });
      const host = new SessionSubagentHost(session, 'main', {
        discussionMemberTimeoutMs: 20,
        discussionMemberFirstResponseTimeoutMs: 10,
      });
      let settled = false;
      const resultPromise = host.decideTeamDiscussion('continue', undefined, undefined, signal)
        .finally(() => {
          settled = true;
        });

      await vi.advanceTimersByTimeAsync(16);
      // This is after the 10ms first-response deadline. It must reset the
      // 20ms inactivity deadline rather than being treated as a timeout.
      progressListener?.();
      await vi.advanceTimersByTimeAsync(19);
      expect(settled).toBe(false);

      complete();
      const result = await resultPromise;
      expect(result.statements).toEqual([{
        agentId: 'agent-review',
        statement: 'The long tool call completed.',
        skipped: false,
      }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a full-turn timeout after first response without retrying', async () => {
    vi.useFakeTimers();
    try {
      const transcript = testAgent({ type: 'sub' });
      let active = false;
      let firstResponse!: () => void;
      const member = agentDouble({
        context: { history: [] },
        turn: {
          get hasActiveTurn() {
            return active;
          },
          prompt: vi.fn(() => {
            active = true;
            return 1;
          }),
          waitForTurnFirstRequest: vi.fn(() => new Promise<void>((resolve) => {
            firstResponse = resolve;
            setTimeout(firstResponse, 1);
          })),
          onTurnProgress: vi.fn(() => () => {}),
          waitForCurrentTurn: vi.fn(async (waitSignal?: AbortSignal) => new Promise((_resolve, reject) => {
            waitSignal?.addEventListener('abort', () => {
              active = false;
              reject(waitSignal.reason);
            }, { once: true });
          })),
        },
      });
      const discussionMeta = {
        homedir: '/discussion',
        type: 'sub' as const,
        parentAgentId: 'main',
        kind: 'sub' as const,
        teamLeaderAgentId: 'main',
        discussion: {
          participantAgentIds: ['agent-review'],
          status: 'active' as const,
          topic: 'Bound active member turns',
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
      const session = teamSessionDouble({
        metadata: { agents: { 'agent-discussion': discussionMeta, 'agent-review': memberMeta } },
        activeTeamDiscussion: vi.fn(() => ['agent-discussion', discussionMeta] as const),
        getAgentMetadata: vi.fn((id: string) =>
          id === 'agent-discussion' ? discussionMeta : id === 'agent-review' ? memberMeta : undefined,
        ),
        ensureAgentResumed: vi.fn(async (id: string) =>
          id === 'agent-discussion' ? transcript.agent : member,
        ),
        unreadTeamDiscussionStatements: vi.fn(async () => ({ statements: [], cursor: 0 })),
        acknowledgeTeamDiscussionStatements: vi.fn(async () => undefined),
        beginTeamDiscussionTurn: vi.fn(),
        endTeamDiscussionTurn: vi.fn(),
        consumeTeamDiscussionSpeak: vi.fn(() => undefined),
      });
      const host = new SessionSubagentHost(session, 'main', {
        discussionMemberTimeoutMs: 5,
        discussionMemberFirstResponseTimeoutMs: 2,
      });
      const resultPromise = host.decideTeamDiscussion('continue', undefined, undefined, signal);
      await vi.advanceTimersByTimeAsync(7);
      const result = await resultPromise;

      expect(member.turn.prompt).toHaveBeenCalledTimes(1);
      expect(result.statements).toEqual([{
        agentId: 'agent-review',
        skipped: true,
        reason: 'timeout',
        error: 'Member discussion turn timed out after 5ms.',
      }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries no-response members once and continues after consecutive failures', async () => {
    const transcript = testAgent({ type: 'sub' });
    let firstActive = false;
    const firstSignals: AbortSignal[] = [];
    const first = agentDouble({
      turn: {
        get hasActiveTurn() { return firstActive; },
        prompt: vi.fn(() => { firstActive = true; return 1; }),
        waitForTurnFirstRequest: vi.fn(() => new Promise<void>(() => {})),
        waitForCurrentTurn: vi.fn(async (waitSignal?: AbortSignal) => {
          if (waitSignal !== undefined) firstSignals.push(waitSignal);
          if (waitSignal === undefined) return { event: { reason: 'cancelled' } };
          await new Promise<void>((_resolve, reject) => {
            waitSignal.addEventListener('abort', () => {
              firstActive = false;
              reject(waitSignal.reason);
            }, { once: true });
          });
          return { event: { reason: 'cancelled' } };
        }),
      },
    });
    const second = agentDouble({
      turn: {
        hasActiveTurn: false,
        prompt: vi.fn(() => 2),
        waitForTurnFirstRequest: vi.fn(() => new Promise<void>(() => {})),
        waitForCurrentTurn: vi.fn(async () => ({ event: { reason: 'completed' } })),
      },
    });
    const discussionMeta = {
      homedir: '/discussion',
      type: 'sub' as const,
      parentAgentId: 'main',
      kind: 'sub' as const,
      teamLeaderAgentId: 'main',
      discussion: {
        participantAgentIds: ['agent-first', 'agent-second'],
        status: 'active' as const,
        topic: 'Bound each member turn',
        startedAt: '2026-08-18T00:00:00.000Z',
        updatedAt: '2026-08-18T00:00:00.000Z',
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
    const endTeamDiscussionTurn = vi.fn();
    const session = teamSessionDouble({
      metadata: { agents: { 'agent-discussion': discussionMeta, 'agent-first': firstMeta, 'agent-second': secondMeta } },
      activeTeamDiscussion: vi.fn(() => ['agent-discussion', discussionMeta] as const),
      getAgentMetadata: vi.fn((id: string) => id === 'agent-discussion' ? discussionMeta : id === 'agent-first' ? firstMeta : id === 'agent-second' ? secondMeta : undefined),
      ensureAgentResumed: vi.fn(async (id: string) => id === 'agent-discussion' ? transcript.agent : id === 'agent-first' ? first : second),
      unreadTeamDiscussionStatements: vi.fn(async () => ({ statements: [], cursor: 0 })),
      acknowledgeTeamDiscussionStatements: vi.fn(async () => undefined),
      beginTeamDiscussionTurn: vi.fn(),
      endTeamDiscussionTurn,
      consumeTeamDiscussionSpeak: vi.fn(() => undefined),
    });
    const host = new SessionSubagentHost(session, 'main', {
      discussionMemberTimeoutMs: 10,
      discussionMemberFirstResponseTimeoutMs: 1,
    });

    const result = await host.decideTeamDiscussion('continue', undefined, undefined, signal);

    expect(firstSignals).toHaveLength(2);
    expect(firstSignals.every((candidate) => candidate.aborted)).toBe(true);
    expect(first.turn.waitForCurrentTurn).toHaveBeenCalledTimes(2);
    expect(second.turn.prompt).toHaveBeenCalledTimes(2);
    expect(endTeamDiscussionTurn).toHaveBeenNthCalledWith(1, 'agent-discussion', 'agent-first');
    expect(endTeamDiscussionTurn).toHaveBeenNthCalledWith(2, 'agent-discussion', 'agent-second');
    expect(result.statements).toEqual([
      {
        agentId: 'agent-first',
        skipped: true,
        reason: 'no_response',
        error: 'Member discussion turn produced no text, tool call, or response event within 1ms; retry exhausted (timeout/no_response).',
      },
      {
        agentId: 'agent-second',
        skipped: true,
        reason: 'no_response',
        error: 'Member discussion turn produced no text, tool call, or response event within 1ms; retry exhausted (timeout/no_response).',
      },
    ]);
  });

  it('cancels the first no-response attempt before retrying successfully', async () => {
    const transcript = testAgent({ type: 'sub' });
    let attempt = 0;
    let active = false;
    let consumed = false;
    const member = agentDouble({
      turn: {
        get hasActiveTurn() {
          return active;
        },
        prompt: vi.fn(() => {
          attempt += 1;
          active = true;
          return attempt;
        }),
        waitForTurnFirstRequest: vi.fn(() =>
          attempt === 1 ? new Promise<void>(() => {}) : Promise.resolve(),
        ),
        waitForCurrentTurn: vi.fn(async (waitSignal?: AbortSignal) => {
          if (attempt === 1) {
            await new Promise<void>((_resolve, reject) => {
              waitSignal?.addEventListener('abort', () => {
                active = false;
                reject(waitSignal.reason);
              }, { once: true });
            });
          }
          active = false;
          return { event: { reason: 'completed' } };
        }),
      },
    });
    const discussionMeta = {
      homedir: '/discussion',
      type: 'sub' as const,
      parentAgentId: 'main',
      kind: 'sub' as const,
      teamLeaderAgentId: 'main',
      discussion: {
        participantAgentIds: ['agent-review'],
        status: 'active' as const,
        topic: 'Retry a quiet member',
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
    const session = teamSessionDouble({
      metadata: { agents: { 'agent-discussion': discussionMeta, 'agent-review': memberMeta } },
      activeTeamDiscussion: vi.fn(() => ['agent-discussion', discussionMeta] as const),
      getAgentMetadata: vi.fn((id: string) =>
        id === 'agent-discussion' ? discussionMeta : id === 'agent-review' ? memberMeta : undefined,
      ),
      ensureAgentResumed: vi.fn(async (id: string) =>
        id === 'agent-discussion' ? transcript.agent : member,
      ),
      unreadTeamDiscussionStatements: vi.fn(async () => ({ statements: [], cursor: 0 })),
      acknowledgeTeamDiscussionStatements: vi.fn(async () => undefined),
      beginTeamDiscussionTurn: vi.fn(),
      endTeamDiscussionTurn: vi.fn(),
      consumeTeamDiscussionSpeak: vi.fn(() => {
        if (attempt < 2 || consumed) return undefined;
        consumed = true;
        return {
          entryId: 1,
          agentId: 'agent-review',
          name: 'Reviewer',
          message: 'The retry produced a stable answer.',
        };
      }),
    });
    const host = new SessionSubagentHost(session, 'main', {
      discussionMemberTimeoutMs: 100,
      discussionMemberFirstResponseTimeoutMs: 1,
    });

    const result = await host.decideTeamDiscussion('continue', undefined, undefined, signal);

    expect(member.turn.prompt).toHaveBeenCalledTimes(2);
    expect(member.turn.waitForCurrentTurn).toHaveBeenCalledTimes(2);
    expect(result.statements).toEqual([{
      agentId: 'agent-review',
      statement: 'The retry produced a stable answer.',
      skipped: false,
    }]);
  });

  it('does not retry when the parent turn is cancelled by the user', async () => {
    const transcript = testAgent({ type: 'sub' });
    const parent = new AbortController();
    let active = false;
    const member = agentDouble({
      turn: {
        get hasActiveTurn() {
          return active;
        },
        prompt: vi.fn(() => {
          active = true;
          return 1;
        }),
        waitForTurnFirstRequest: vi.fn(() => new Promise<void>(() => {})),
        waitForCurrentTurn: vi.fn(async (waitSignal?: AbortSignal) => {
          setTimeout(() => parent.abort(userCancellationReason()), 0);
          await new Promise<void>((_resolve, reject) => {
            waitSignal?.addEventListener('abort', () => {
              active = false;
              reject(waitSignal.reason);
            }, { once: true });
          });
          return { event: { reason: 'cancelled' } };
        }),
      },
    });
    const discussionMeta = {
      homedir: '/discussion',
      type: 'sub' as const,
      parentAgentId: 'main',
      kind: 'sub' as const,
      teamLeaderAgentId: 'main',
      discussion: {
        participantAgentIds: ['agent-review'],
        status: 'active' as const,
        topic: 'Respect cancellation',
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
    const session = teamSessionDouble({
      metadata: { agents: { 'agent-discussion': discussionMeta, 'agent-review': memberMeta } },
      activeTeamDiscussion: vi.fn(() => ['agent-discussion', discussionMeta] as const),
      getAgentMetadata: vi.fn((id: string) =>
        id === 'agent-discussion' ? discussionMeta : id === 'agent-review' ? memberMeta : undefined,
      ),
      ensureAgentResumed: vi.fn(async (id: string) =>
        id === 'agent-discussion' ? transcript.agent : member,
      ),
      unreadTeamDiscussionStatements: vi.fn(async () => ({ statements: [], cursor: 0 })),
      acknowledgeTeamDiscussionStatements: vi.fn(async () => undefined),
      beginTeamDiscussionTurn: vi.fn(),
      endTeamDiscussionTurn: vi.fn(),
      consumeTeamDiscussionSpeak: vi.fn(() => undefined),
    });
    const host = new SessionSubagentHost(session, 'main', {
      discussionMemberTimeoutMs: 100,
      discussionMemberFirstResponseTimeoutMs: 20,
    });

    await expect(host.decideTeamDiscussion('continue', undefined, undefined, parent.signal))
      .rejects.toThrow('Aborted by the user');
    expect(member.turn.prompt).toHaveBeenCalledTimes(1);
  });

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
    const session = teamSessionDouble({
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
    });
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
    expect(transcript.agent.context.history).toContainEqual(
      expect.objectContaining({
        origin: expect.objectContaining({
          kind: 'system_trigger',
          name: 'team_discussion_skip',
        }),
      }),
    );
  });

  it('keeps the TeamSpeak lease until an interrupted member turn actually settles', async () => {
    const transcript = testAgent({ type: 'sub' });
    let leaseActive = false;
    let spoke = false;
    let activeTurn = false;
    const controller = new AbortController();
    const member = agentDouble({
      turn: {
        get hasActiveTurn() {
          return activeTurn;
        },
        prompt: vi.fn(() => {
          activeTurn = true;
          return 1;
        }),
        waitForCurrentTurn: vi.fn(async (waitSignal?: AbortSignal) => {
          if (waitSignal !== undefined) {
            controller.abort(new Error('member tool interrupted'));
            throw new Error('member tool interrupted');
          }
          expect(leaseActive).toBe(true);
          spoke = true;
          activeTurn = false;
          return { event: { reason: 'cancelled' } };
        }),
      },
    });
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
    const session = teamSessionDouble({
      metadata: { agents: { 'agent-discussion': discussionMeta, 'agent-review': memberMeta } },
      activeTeamDiscussion: vi.fn(() => ['agent-discussion', discussionMeta] as const),
      getAgentMetadata: vi.fn((id: string) => id === 'agent-discussion' ? discussionMeta : id === 'agent-review' ? memberMeta : undefined),
      ensureAgentResumed: vi.fn(async (id: string) => id === 'agent-discussion' ? transcript.agent : member),
      unreadTeamDiscussionStatements: vi.fn(async () => ({ statements: [], cursor: 0 })),
      acknowledgeTeamDiscussionStatements: vi.fn(async () => undefined),
      beginTeamDiscussionTurn: vi.fn(() => { leaseActive = true; }),
      endTeamDiscussionTurn: vi.fn(() => { leaseActive = false; }),
      consumeTeamDiscussionSpeak: vi.fn(() => spoke ? {
        entryId: 1,
        agentId: 'agent-review',
        name: 'Reviewer',
        message: 'The cache key is stable.',
      } : undefined),
    });
    const host = new SessionSubagentHost(session, 'main');

    const result = await host.decideTeamDiscussion('continue', undefined, undefined, controller.signal);

    expect(member.turn.waitForCurrentTurn).toHaveBeenCalledTimes(2);
    expect(result.statements).toEqual([{
      agentId: 'agent-review',
      statement: 'The cache key is stable.',
      skipped: false,
    }]);
    expect(leaseActive).toBe(false);
  });

  it('routes a retry round only to the explicitly selected discussion participants', async () => {
    const transcript = testAgent({ type: 'sub' });
    const alpha = testAgent({ type: 'sub' });
    const beta = testAgent({ type: 'sub' });
    alpha.configure();
    beta.configure();
    alpha.mockNextResponse({ type: 'text', text: 'alpha must not be scheduled' });
    beta.mockNextResponse({ type: 'text', text: 'beta abstains' });
    const discussionMeta = {
      homedir: '/discussion',
      type: 'sub' as const,
      parentAgentId: 'main',
      kind: 'sub' as const,
      teamLeaderAgentId: 'main',
      discussion: {
        participantAgentIds: ['agent-alpha', 'agent-beta'],
        status: 'active' as const,
        topic: 'Retry the failed member turn',
        startedAt: '2026-08-18T00:00:00.000Z',
        updatedAt: '2026-08-18T00:00:00.000Z',
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
    const alphaMeta = memberMeta('Alpha');
    const betaMeta = memberMeta('Beta');
    const session = teamSessionDouble({
      metadata: { agents: { 'agent-discussion': discussionMeta, 'agent-alpha': alphaMeta, 'agent-beta': betaMeta } },
      activeTeamDiscussion: vi.fn(() => ['agent-discussion', discussionMeta] as const),
      getAgentMetadata: vi.fn((id: string) => id === 'agent-discussion' ? discussionMeta : id === 'agent-alpha' ? alphaMeta : id === 'agent-beta' ? betaMeta : undefined),
      ensureAgentResumed: vi.fn(async (id: string) => id === 'agent-discussion' ? transcript.agent : id === 'agent-alpha' ? alpha.agent : beta.agent),
      unreadTeamDiscussionStatements: vi.fn(async () => ({ statements: [], cursor: 0 })),
      acknowledgeTeamDiscussionStatements: vi.fn(async () => undefined),
      beginTeamDiscussionTurn: vi.fn(),
      endTeamDiscussionTurn: vi.fn(),
      consumeTeamDiscussionSpeak: vi.fn(() => undefined),
    });
    const host = new SessionSubagentHost(session, 'main');

    const result = await host.decideTeamDiscussion(
      'continue',
      undefined,
      ['agent-beta'],
      signal,
      'Please ask beta to provide the missing statement.',
    );

    expect(alpha.llmCalls).toHaveLength(0);
    expect(beta.llmCalls).toHaveLength(1);
    expect(result.statements).toEqual([{ agentId: 'agent-beta', skipped: true }]);
  });

  it('returns the full member failure detail to the lead', async () => {
    const transcript = testAgent({ type: 'sub' });
    const member = agentDouble({
      turn: {
        hasActiveTurn: false,
        prompt: vi.fn(() => 1),
        waitForCurrentTurn: vi.fn(async () => ({
          event: {
            reason: 'failed',
            error: { code: 'MEMBER_TOOL_FAILED', message: 'WebSearch returned a malformed response.' },
          },
        })),
      },
    });
    const discussionMeta = {
      homedir: '/discussion',
      type: 'sub' as const,
      parentAgentId: 'main',
      kind: 'sub' as const,
      teamLeaderAgentId: 'main',
      discussion: {
        participantAgentIds: ['agent-review'],
        status: 'active' as const,
        topic: 'Surface failure details',
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
    const session = teamSessionDouble({
      metadata: { agents: { 'agent-discussion': discussionMeta, 'agent-review': memberMeta } },
      activeTeamDiscussion: vi.fn(() => ['agent-discussion', discussionMeta] as const),
      getAgentMetadata: vi.fn((id: string) => id === 'agent-discussion' ? discussionMeta : id === 'agent-review' ? memberMeta : undefined),
      ensureAgentResumed: vi.fn(async (id: string) => id === 'agent-discussion' ? transcript.agent : member),
      unreadTeamDiscussionStatements: vi.fn(async () => ({ statements: [], cursor: 0 })),
      acknowledgeTeamDiscussionStatements: vi.fn(async () => undefined),
      beginTeamDiscussionTurn: vi.fn(),
      endTeamDiscussionTurn: vi.fn(),
      consumeTeamDiscussionSpeak: vi.fn(() => undefined),
    });
    const host = new SessionSubagentHost(session, 'main');

    const result = await host.decideTeamDiscussion('continue', undefined, undefined, signal);

    expect(result.statements).toEqual([{
      agentId: 'agent-review',
      skipped: true,
      reason: 'failed',
      error: '[MEMBER_TOOL_FAILED] WebSearch returned a malformed response.',
    }]);
    expect(JSON.stringify(transcript.agent.context.history)).toContain('WebSearch returned a malformed response.');
  });

  it('returns full tool error records when a member tool fails before TeamSpeak', async () => {
    const transcript = testAgent({ type: 'sub' });
    const memberHistory: any[] = [];
    const member = agentDouble({
      context: { history: memberHistory },
      turn: {
        hasActiveTurn: false,
        prompt: vi.fn(() => {
          memberHistory.push(
            {
              role: 'assistant',
              content: [{ type: 'text', text: '' }],
              toolCalls: [{ type: 'function', id: 'search-1', name: 'WebSearch', arguments: '{}' }],
            },
            {
              role: 'tool',
              content: [{ type: 'text', text: '<system>ERROR: Tool execution failed.</system>Search timed out after 10 seconds' }],
              toolCalls: [],
              toolCallId: 'search-1',
              isError: true,
            },
          );
          return 1;
        }),
        waitForCurrentTurn: vi.fn(async () => ({ event: { reason: 'failed', error: { code: 'TOOL_FAILED', message: 'member turn failed' } } })),
      },
    });
    const discussionMeta = {
      homedir: '/discussion', type: 'sub' as const, parentAgentId: 'main', kind: 'sub' as const, teamLeaderAgentId: 'main',
      discussion: { participantAgentIds: ['agent-review'], status: 'active' as const, topic: 'Surface tool failure', startedAt: '2026-08-18T00:00:00.000Z', updatedAt: '2026-08-18T00:00:00.000Z' },
    };
    const memberMeta = { homedir: '/review', type: 'sub' as const, parentAgentId: 'main', kind: 'team' as const, teamLeaderAgentId: 'main', name: 'Reviewer' };
    const session = teamSessionDouble({
      metadata: { agents: { 'agent-discussion': discussionMeta, 'agent-review': memberMeta } },
      activeTeamDiscussion: vi.fn(() => ['agent-discussion', discussionMeta] as const),
      getAgentMetadata: vi.fn((id: string) => id === 'agent-discussion' ? discussionMeta : id === 'agent-review' ? memberMeta : undefined),
      ensureAgentResumed: vi.fn(async (id: string) => id === 'agent-discussion' ? transcript.agent : member),
      unreadTeamDiscussionStatements: vi.fn(async () => ({ statements: [], cursor: 0 })),
      acknowledgeTeamDiscussionStatements: vi.fn(async () => undefined),
      beginTeamDiscussionTurn: vi.fn(),
      endTeamDiscussionTurn: vi.fn(),
      consumeTeamDiscussionSpeak: vi.fn(() => undefined),
    });
    const host = new SessionSubagentHost(session, 'main');

    const result = await host.decideTeamDiscussion('continue', undefined, undefined, signal);

    expect(result.statements).toEqual([{
      agentId: 'agent-review',
      skipped: true,
      reason: 'tool_failed',
      error: '[TOOL_FAILED] member turn failed\nWebSearch: Search timed out after 10 seconds',
      toolErrors: [{ toolName: 'WebSearch', message: 'Search timed out after 10 seconds' }],
    }]);
    expect(JSON.stringify(transcript.agent.context.history)).toContain('Search timed out after 10 seconds');
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
    const session = teamSessionDouble({
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
    });
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
    const session = teamSessionDouble({
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
      ensureAgentResumed: vi.fn(async (id: string) =>
        id === 'agent-discussion' ? transcript.agent : id === 'agent-idle' ? idle.agent : member.agent,
      ),
      unreadTeamDiscussionStatements,
      acknowledgeTeamDiscussionStatements,
    });
    const host = new SessionSubagentHost(session, 'main');

    const result = await host.decideTeamDiscussion('vote', undefined, undefined, signal);

    expect(result.votes).toEqual([
      { agentId: 'agent-review', vote: 'proceed' },
    ]);
    expect(idle.llmCalls).toHaveLength(0);
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
    const session = teamSessionDouble({
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
    });
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
    const session = teamSessionDouble({
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
    });
    const host = new SessionSubagentHost(session, 'main');

    await host.decideTeamDiscussion('continue', undefined, undefined, signal, 'The cache key stays.');

    expect(publishLeadDiscussionStatement).toHaveBeenCalledWith('main', 'The cache key stays.');
    expect(order[0]).toBe('lead');
    expect(order).toContain('member');
    expect(transcript.agent.context.history).toContainEqual(
      expect.objectContaining({
        origin: expect.objectContaining({
          name: 'team_discussion_round',
          discussionRound: 1,
        }),
      }),
    );
  });

  it('rejects TeamDecide start without a topic even when the field is an empty string', async () => {
    const session = teamSessionDouble({
      metadata: { agents: {} },
      activeTeamDiscussion: vi.fn(() => undefined),
      teamMemberMetadata: vi.fn(() => [['agent-review', { kind: 'team' }]]),
      createTeamDiscussion: vi.fn(),
    });
    const host = new SessionSubagentHost(session, 'main');

    await expect(host.decideTeamDiscussion('start', '', ['agent-review'], signal, 'Lead first.'))
      .rejects.toThrow('A discussion topic is required.');
    await expect(host.decideTeamDiscussion('start', undefined, ['agent-review'], signal, 'Lead first.'))
      .rejects.toThrow('A discussion topic is required.');
    expect(session.createTeamDiscussion).not.toHaveBeenCalled();
  });

  it('rolls back the automatic Discuss entry when TeamDecide start cannot create its transcript', async () => {
    const session = new Session({
      id: 'test-team-discussion-start-rollback',
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
          mandate: 'Review the cache behavior.',
          role: 'reviewer',
        },
      },
    );
    vi.spyOn(session, 'createAgent').mockRejectedValueOnce(new Error('transcript creation failed'));
    const host = new SessionSubagentHost(session, main.id);

    await expect(host.decideTeamDiscussion(
      'start',
      'Review the cache path.',
      [member.id],
      signal,
      'The cache key must remain stable.',
    )).rejects.toThrow('transcript creation failed');

    expect(main.agent.discussMode.isActive).toBe(false);
    expect(session.activeTeamDiscussion(main.id)).toBeUndefined();
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
    const session = teamSessionDouble({
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
    });
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
      name: 'team_dm',
      speaker: { from: 'lead', speakerId: 'main' },
    });
  });

  it('buffers TeamDM as a system reminder when the recipient is active', async () => {
    const steer = vi.fn(() => null);
    const recipient = agentDouble({
      turn: {
        hasActiveTurn: true,
        prompt: vi.fn(),
        steer,
      },
    });
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
    const session = teamSessionDouble({
      getAgentMetadata: vi.fn((id: string) => id === 'main' ? mainMeta : memberMeta),
      ensureAgentResumed: vi.fn(async () => recipient),
    });
    const host = new SessionSubagentHost(session, 'agent-member');

    await expect(host.directMessage('main', 'The parent is still running.', signal))
      .resolves.toEqual({ delivered: true, processing: 'queued' });
    expect(steer).toHaveBeenCalledWith(
      [{
        type: 'text',
        text: '<system-reminder>\nThe parent is still running.\n</system-reminder>',
      }],
      expect.objectContaining({
        kind: 'system_trigger',
        name: 'team_dm',
        speaker: { from: 'team', speakerId: 'agent-member', speakerName: 'Member' },
      }),
    );
  });

  it('posts Chat to the department log and steers only the mentioned sibling', async () => {
    const mentionedSteer = vi.fn(() => null);
    const mentioned = agentDouble({
      turn: { hasActiveTurn: true, prompt: vi.fn(), steer: mentionedSteer },
    });
    const unmentionedSteer = vi.fn(() => null);
    const unmentioned = agentDouble({
      turn: { hasActiveTurn: true, prompt: vi.fn(), steer: unmentionedSteer },
    });
    const senderMeta = {
      homedir: '/sender',
      type: 'sub' as const,
      parentAgentId: 'main',
      kind: 'team' as const,
      teamLeaderAgentId: 'main',
      name: 'Sender',
    };
    const mentionedMeta = { ...senderMeta, homedir: '/mentioned', name: 'Mentioned' };
    const unmentionedMeta = { ...senderMeta, homedir: '/unmentioned', name: 'Unmentioned' };
    const postTeamChatMessage = vi.fn(async (
      _leaderAgentId: string,
      senderAgentId: string,
      senderName: string,
      message: string,
      mentions: readonly string[],
    ) => ({ messageId: 7, agentId: senderAgentId, name: senderName, message, mentions, sentAt: '2026-08-20T00:00:00.000Z' }));
    const session = teamSessionDouble({
      getAgentMetadata: vi.fn((id: string) =>
        id === 'agent-sender' ? senderMeta
          : id === 'agent-mentioned' ? mentionedMeta
            : id === 'agent-unmentioned' ? unmentionedMeta
              : undefined,
      ),
      teamMemberMetadata: vi.fn(() => [
        ['agent-sender', senderMeta],
        ['agent-mentioned', mentionedMeta],
        ['agent-unmentioned', unmentionedMeta],
      ]),
      ensureAgentResumed: vi.fn(async (id: string) =>
        id === 'agent-mentioned' ? mentioned : unmentioned,
      ),
      postTeamChatMessage,
    });
    const host = new SessionSubagentHost(session, 'agent-sender');

    const record = await host.sendChatMessage('Cache key changed.', ['agent-mentioned'], signal);

    expect(record).toMatchObject({ messageId: 7, agentId: 'agent-sender', name: 'Sender' });
    expect(postTeamChatMessage).toHaveBeenCalledWith(
      'main',
      'agent-sender',
      'Sender',
      'Cache key changed.',
      ['agent-mentioned'],
    );
    expect(mentionedSteer).toHaveBeenCalledWith(
      [{ type: 'text', text: '<system-reminder>\n[Chat] Sender: Cache key changed.\n</system-reminder>' }],
      expect.objectContaining({
        kind: 'system_trigger',
        name: 'team_chat',
        speaker: { from: 'team', speakerId: 'agent-sender', speakerName: 'Sender' },
      }),
    );
    expect(unmentionedSteer).not.toHaveBeenCalled();
  });

  it('delivers Chat to every sibling except the sender on an all mention', async () => {
    const firstSteer = vi.fn(() => null);
    const secondSteer = vi.fn(() => null);
    const first = agentDouble({ turn: { hasActiveTurn: true, prompt: vi.fn(), steer: firstSteer } });
    const second = agentDouble({ turn: { hasActiveTurn: true, prompt: vi.fn(), steer: secondSteer } });
    const senderMeta = {
      homedir: '/sender',
      type: 'sub' as const,
      parentAgentId: 'main',
      kind: 'team' as const,
      teamLeaderAgentId: 'main',
      name: 'Sender',
    };
    const firstMeta = { ...senderMeta, homedir: '/first', name: 'First' };
    const secondMeta = { ...senderMeta, homedir: '/second', name: 'Second' };
    const session = teamSessionDouble({
      getAgentMetadata: vi.fn(() => senderMeta),
      teamMemberMetadata: vi.fn(() => [
        ['agent-sender', senderMeta],
        ['agent-first', firstMeta],
        ['agent-second', secondMeta],
      ]),
      ensureAgentResumed: vi.fn(async (id: string) => id === 'agent-first' ? first : second),
    });
    const host = new SessionSubagentHost(session, 'agent-sender');

    await host.sendChatMessage('Sync point.', ['all'], signal);

    expect(firstSteer).toHaveBeenCalledTimes(1);
    expect(secondSteer).toHaveBeenCalledTimes(1);
  });

  it('rejects Chat from a non-member and unknown mentions', async () => {
    const mainMeta = {
      homedir: '/main',
      type: 'main' as const,
      parentAgentId: null,
      kind: 'main' as const,
    };
    const memberMeta = {
      homedir: '/member',
      type: 'sub' as const,
      parentAgentId: 'main',
      kind: 'team' as const,
      teamLeaderAgentId: 'main',
      name: 'Member',
    };
    const session = teamSessionDouble({
      getAgentMetadata: vi.fn((id: string) => id === 'main' ? mainMeta : memberMeta),
      teamMemberMetadata: vi.fn(() => [['agent-member', memberMeta]]),
    });

    const mainHost = new SessionSubagentHost(session, 'main');
    await expect(mainHost.sendChatMessage('Hello.', ['all'], signal))
      .rejects.toThrow('Chat is only available to a member of a department.');

    const memberHost = new SessionSubagentHost(session, 'agent-member');
    await expect(memberHost.sendChatMessage('Hello.', ['agent-ghost'], signal))
      .rejects.toThrow('Chat mention target(s) not in this department: agent-ghost');
  });

  it('does not claim delivery when an idle TeamDM cannot start or is cancelled', async () => {
    const prompt = vi.fn(() => null);
    const recipient = agentDouble({
      turn: {
        hasActiveTurn: false,
        prompt,
        steer: vi.fn(),
      },
    });
    const memberMeta = {
      homedir: '/member',
      type: 'sub' as const,
      parentAgentId: 'main',
      kind: 'team' as const,
      teamLeaderAgentId: 'main',
      name: 'Member',
    };
    const session = teamSessionDouble({
      getAgentMetadata: vi.fn(() => memberMeta),
      ensureAgentResumed: vi.fn(async () => recipient),
    });
    const host = new SessionSubagentHost(session, 'main');

    await expect(host.directMessage('agent-member', 'Cannot start.', signal))
      .rejects.toThrow('could not start a turn');
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(host.directMessage('agent-member', 'Cancelled.', controller.signal))
      .rejects.toThrow('cancelled');
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
          tools: ['Read', 'GetGoal', 'UpdateGoal', 'mcp__*'],
        },
      },
    );

    expect(main.agent.tools.activeToolNames()).toEqual(expect.arrayContaining([
      'Read',
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
    const main = await session.createAgent(
      { type: 'main' },
      {
        profile: {
          ...contextProfile(),
          tools: [
            'Read',
            'Write',
            'Edit',
            'Bash',
            'CreateGoal',
            'GetGoal',
            'SetGoalBudget',
            'UpdateGoal',
            'CronCreate',
            'CronList',
            'CronDelete',
            'nori_memory_search',
            'nori_memory_write',
            'nori_memory_remove',
            'mcp__*',
          ],
        },
      },
    );
    const member = await session.createAgent(
      { type: 'sub' },
      {
        kind: 'team',
        parentAgentId: main.id,
        teamLeaderAgentId: main.id,
        profile: contextProfile(),
        teamIdentity: {
          name: 'Reviewer',
          mandate: 'Review behavior before changes.',
          role: 'reviewer',
        },
      },
    );

    expect(member.agent.config.systemPrompt.startsWith('<team_identity>')).toBe(true);
    expect(member.agent.config.systemPrompt).toContain('Name: Reviewer');
    expect(member.agent.config.systemPrompt).toContain('Your **parent** is the agent that hired you');
    // A member manages its own department, so the prompt must hand it the rules
    // for that rather than telling it management is somebody else's job.
    expect(member.agent.config.systemPrompt).toContain('### Managing your own department');
    expect(member.agent.config.systemPrompt).toContain('Hire for work you can name right now');
    expect(member.agent.config.systemPrompt).not.toContain('Team management belongs to the main Agent');
    expect(member.agent.config.systemPrompt).toContain('`Write`, `Edit`, and `Bash` are denied until it closes');
    expect(member.agent.config.systemPrompt).not.toContain('SubAgent');
    expect(member.agent.config.systemPrompt).toContain('exactly one agent: a peer, a member you hired, or your parent');
    expect(member.agent.config.systemPrompt).toContain('every peer in your department, all at once');
    // The routing rule the member must not get wrong: a handoff goes to the peer
    // that continues the work, never up to the parent to be passed along.
    expect(member.agent.config.systemPrompt).toContain('Your parent is a recipient in its own right, never a relay');
    expect(member.agent.config.systemPrompt).toContain('hand it to the peer who continues it');
    expect(member.agent.config.systemPrompt).toContain('Work on the task your parent assigned you');
    expect(member.agent.config.systemPrompt).toContain('latest content tag');
    expect(member.agent.config.systemPrompt).toContain('Edit tag mismatch');
    expect(member.agent.config.systemPrompt).toContain('automatic branch or merge');
    expect(member.agent.config.systemPrompt).toContain('completed`, `blocked`, or `needs_decision');
    expect(member.agent.config.systemPrompt).toContain('times out, is cancelled, or produces no output');
    expect(member.agent.config.systemPrompt).not.toContain('EnterDiscussMode');
    expect(member.agent.config.systemPrompt).toContain('## Team Engineering');
    expect(member.agent.config.systemPrompt).toContain('Be concrete and brief in every Discuss turn and every report');
    expect(member.agent.config.systemPrompt).toContain('Never overwrite verified work');
    expect(member.agent.config.systemPrompt.match(/## Team Engineering/g)).toHaveLength(1);
    expect(member.agent.config.systemPrompt).not.toContain('Swarm');
    expect(member.agent.config.systemPrompt).not.toContain('Graph');
    expect(member.agent.config.systemPrompt).not.toContain('You are the main lead');
    await member.agent.refreshSystemPrompt();
    expect(member.agent.config.systemPrompt.startsWith('<team_identity>')).toBe(true);
    expect(member.agent.teamWriteLocked).toBe(false);
    expect(member.agent.teamWriteEnabled).toBe(true);
    expect(member.agent.permission.toolsReadonly).toBe(false);
    expect(member.agent.permission.mode).toBe('manual');
    expect(member.agent.tools.activeToolNames()).toEqual(expect.arrayContaining([
      'Read',
      'Write',
      'Edit',
      'Bash',
      'CreateGoal',
      'GetGoal',
      'SetGoalBudget',
      'UpdateGoal',
      'CronCreate',
      'CronList',
      'CronDelete',
      'nori_memory_search',
      'nori_memory_write',
      'nori_memory_remove',
      'mcp__*',
      'TeamDM',
      'TeamSpeak',
      'TeamStatus',
    ]));
    // A member runs a department of its own, so it gets the same management
    // tools as main. Depth is bounded when a member is actually created, not by
    // withholding the tool — `team.maxDepth` is editable while agents run.
    expect(member.agent.tools.activeToolNames()).toEqual(expect.arrayContaining([
      'TeamCreate',
      'TeamDismiss',
      'TeamAssign',
      'TeamBroadcast',
      'TeamDiscussInvite',
      'TeamDiscussKick',
      'TeamDecide',
    ]));
    expect(member.agent.tools.activeToolNames()).not.toContain('EnterDiscussMode');
    expect(member.agent.tools.activeToolNames()).not.toContain('ContextInjection');

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
      mandate: 'Review behavior before changes.',
      role: 'reviewer',
    };

    await expect(host.createTeam([identity, { ...identity, name: 'Reviewer' }]))
      .rejects.toThrow('duplicate member name');

    expect(session.teamMemberMetadata(main.id)).toEqual([]);
    expect(Object.keys(session.metadata.agents)).toEqual([main.id]);
  });

  it('lets a Team Agent manage its own department and refuses a discussion transcript', async () => {
    const session = new Session({
      id: 'test-department-boundary',
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
          mandate: 'Review behavior before changes.',
          role: 'reviewer',
        },
      },
    );
    const transcript = await session.createTeamDiscussion(main.id, 'Review the boundary.', [member.id]);

    // A Team Agent chairs a department of its own, so the guard admits it. What
    // it hits is the state it is actually missing — no Discuss mode, no active
    // discussion — never a refusal to manage.
    const memberHost = new SessionSubagentHost(session, member.id);
    await expect(memberHost.inviteToDiscussion([member.id])).rejects.toThrow('Discuss mode is required');
    await expect(memberHost.kickFromDiscussion([member.id])).rejects.toThrow('Discuss mode is required');
    await expect(memberHost.decideTeamDiscussion('continue', undefined, undefined, signal))
      .rejects.toThrow('There is no active team discussion');

    // A discussion transcript records a department's discussion; it is not a
    // node in the tree, so it manages nothing.
    const transcriptHost = new SessionSubagentHost(session, transcript.id);
    const refused = 'Only the main agent and Team Agents manage a department.';
    await expect(transcriptHost.inviteToDiscussion([member.id])).rejects.toThrow(refused);
    await expect(transcriptHost.kickFromDiscussion([member.id])).rejects.toThrow(refused);
    await expect(transcriptHost.decideTeamDiscussion('continue', undefined, undefined, signal))
      .rejects.toThrow(refused);
    await expect(transcriptHost.createTeam([
      { name: 'Nobody', mandate: 'Should never be hired.', role: 'none' },
    ])).rejects.toThrow(refused);
  });

  it('lets a Team Agent hire its own members up to the configured depth', async () => {
    const session = new Session({
      id: 'test-department-depth',
      kaos: createFakeKaos({
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeText: vi.fn().mockResolvedValue(0),
      }),
      homedir: '/tmp/kimi-session',
      rpc: createSessionRpc(),
      initializeMainAgent: false,
      config: { providers: {}, team: { maxDepth: 2 } },
    });
    const main = await session.createAgent({ type: 'main' }, { profile: contextProfile() });
    const hire = async (managerAgentId: string, name: string): Promise<string> => {
      const host = new SessionSubagentHost(session, managerAgentId);
      const [member] = await host.createTeam([{
        name,
        mandate: `${name} mandate`,
        role: `${name} role`,
      }]);
      if (member === undefined) throw new Error('TeamCreate returned no member.');
      return member.agentId;
    };

    const leadId = await hire(main.id, 'Lead');
    // Depth 1 hires depth 2: the tree grows without going through main.
    const workerId = await hire(leadId, 'Worker');
    expect(session.getAgentMetadata(workerId)?.teamLeaderAgentId).toBe(leadId);

    // Depth 2 is the limit, so its own hire would land at depth 3.
    await expect(hire(workerId, 'TooDeep')).rejects.toThrow('depth');
    expect(session.teamMemberMetadata(workerId)).toEqual([]);
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
          mandate: 'Review the design.',
          role: 'reviewer',
        },
      },
    );
    const host = new SessionSubagentHost(session, main.id);
    const members = [current, removed];
    const prompts = members.map(({ agent }) => vi.spyOn(agent.turn, 'prompt'));
    const started = await host.decideTeamDiscussion(
      'start',
      'Check the cache key.',
      members.map(({ id }) => id),
      signal,
      'The cache key must stay stable.',
    );
    expect(started.statements[0]).toEqual({
      agentId: main.id,
      statement: 'The cache key must stay stable.',
      skipped: false,
    });
    expect(main.agent.discussMode.isActive).toBe(true);
    expect(current.agent.context.history.some(message => message.content.some(
      part => part.type === 'text' && part.text.includes('The cache key must stay stable.'),
    ))).toBe(true);
    main.agent.discussMode.exit();
    const continued = await host.decideTeamDiscussion('continue', undefined, undefined, signal);
    expect(continued.discussionAgentId).toBe(started.discussionAgentId);
    expect(continued.discussion.startedAt).toBe(started.discussion.startedAt);
    expect(main.agent.discussMode.isActive).toBe(true);
    main.agent.discussMode.exit();
    await expect(host.kickFromDiscussion([removed.id]))
      .rejects.toThrow('Discuss mode is required');
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
    await session.assignTeamTasks(main.id, [
      { agentId: current.id, task: 'Apply the accepted cache fix.' },
      { agentId: removed.id, task: null },
    ]);
    expect(current.agent.teamWriteEnabled).toBe(true);
    await host.decideTeamDiscussion('archive', undefined, undefined, signal);
    expect(main.agent.discussMode.isActive).toBe(false);
    expect(current.agent.teamWriteEnabled).toBe(true);
    expect(session.getAgentMetadata(current.id)?.assignedTask).toBeUndefined();
    for (const [index, { agent }] of members.entries()) {
      expect(agent.context.history.filter((message) => message.content.some(
        (part) => part.type === 'text' && part.text.includes('has ended and is archived'),
      ))).toHaveLength(1);
      expect(prompts[index]).toHaveBeenCalledTimes(2);
    }
  });

  it('requires explicit complete team assignments without changing member capabilities', async () => {
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
    expect(first.agent.teamWriteLocked).toBe(true);
    expect(second.agent.teamWriteLocked).toBe(true);
    expect(first.agent.permission.toolsReadonly).toBe(true);
    expect(second.agent.permission.toolsReadonly).toBe(true);
    await host.assignTeam([
      { agentId: first.id, task: 'Implement the focused change.' },
      { agentId: second.id, task: null },
    ], signal);
    expect(main.agent.discussMode.isActive).toBe(false);
    expect(first.agent.teamWriteLocked).toBe(false);
    expect(second.agent.teamWriteLocked).toBe(false);
    expect(first.agent.permission.toolsReadonly).toBe(false);
    expect(second.agent.permission.toolsReadonly).toBe(false);
    expect(first.agent.teamWriteEnabled).toBe(true);
    expect(first.agent.permission.mode).toBe('manual');
    expect(second.agent.teamWriteEnabled).toBe(true);
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
    expect(assignedText).toContain('Before touching files');
    expect(assignedText).toContain('current contents and latest content tag');
    expect(assignedText).toContain('Edit tag mismatches');
    expect(assignedText).toContain('automatic branch or merge');
    expect(assignedText).toContain('risks, version conflicts, and decision requests');
    // Code-phase routing: peers coordinate and hand off in Chat, the parent gets
    // the report. An assignment that only mentions the parent is what makes a
    // member ask its parent to pass a handoff along.
    expect(assignedText).toContain('runs peer to peer in `TeamChat`');
    expect(assignedText).toContain('addressed to the peer who continues from here');
    expect(assignedText).toContain('Files or behavior verified');
    expect(assignedText).toContain('Verification actually run');
    expect(assignedText).toContain('Remaining risks, conflicts, or blockers');
    expect(secondPrompt).not.toHaveBeenCalled();

    await session.lockTeamAssignments(main.id);
    expect(session.getAgentMetadata(first.id)?.assignedTask).toBeUndefined();
    expect(first.agent.teamWriteEnabled).toBe(true);
    expect(first.agent.permission.mode).toBe('manual');
  });

  it('reclaims each TeamAssign lease after completed, failed, cancelled, or unstarted turns', async () => {
    const scripted = createScriptedGenerate();
    scripted.mockNextResponse({ type: 'text', text: 'completed assignment' });
    const failedGenerate: GenerateFn = async () => {
      throw new Error('assigned member failed');
    };
    const cancelledGenerate: GenerateFn = async (...args) => {
      const cancellationSignal = args[5]?.signal;
      if (cancellationSignal === undefined) return new Promise<never>(() => {});
      return new Promise<never>((_resolve, reject) => {
        cancellationSignal.addEventListener('abort', () => reject(cancellationSignal.reason), { once: true });
      });
    };
    const session = new Session({
      id: 'test-team-assignment-leases',
      kaos: createFakeKaos({
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeText: vi.fn().mockResolvedValue(0),
      }),
      homedir: '/tmp/kimi-session',
      rpc: createSessionRpc(),
      providerManager: new ProviderManager({
        config: {
          providers: { test: { type: 'kimi', apiKey: 'test-key' } },
          models: {
            'mock-model': {
              provider: 'test',
              model: 'mock-model',
              maxContextSize: 1_000_000,
              capabilities: ['image_in', 'tool_use'],
            },
          },
        },
      }),
      initializeMainAgent: false,
    });
    const main = await session.createAgent({ type: 'main' }, { profile: contextProfile() });
    const identity = (name: string) => ({
      name,
      mandate: `${name} mandate`,
      role: `${name} role`,
    });
    const completed = await session.createAgent(
      { type: 'sub', generate: scripted.generate },
      { kind: 'team', parentAgentId: main.id, teamLeaderAgentId: main.id, profile: contextProfile(), teamIdentity: identity('Completed') },
    );
    const failed = await session.createAgent(
      { type: 'sub', generate: failedGenerate },
      { kind: 'team', parentAgentId: main.id, teamLeaderAgentId: main.id, profile: contextProfile(), teamIdentity: identity('Failed') },
    );
    const cancelled = await session.createAgent(
      { type: 'sub', generate: cancelledGenerate },
      { kind: 'team', parentAgentId: main.id, teamLeaderAgentId: main.id, profile: contextProfile(), teamIdentity: identity('Cancelled') },
    );
    for (const member of [completed, failed, cancelled]) {
      member.agent.config.update({ modelAlias: 'mock-model', thinkingEffort: 'off' });
    }
    const host = new SessionSubagentHost(session, main.id);

    await host.assignTeam([
      { agentId: completed.id, task: 'Complete the assigned check.' },
      { agentId: failed.id, task: 'Fail while running the assigned check.' },
      { agentId: cancelled.id, task: 'Wait for cancellation.' },
    ], signal);
    expect(cancelled.agent.turn.hasActiveTurn).toBe(true);
    expect(session.getAgentMetadata(cancelled.id)?.assignedTask).toBe('Wait for cancellation.');
    await vi.waitFor(() => expect(session.getAgentMetadata(completed.id)?.assignedTask).toBeUndefined());
    await vi.waitFor(() => expect(session.getAgentMetadata(failed.id)?.assignedTask).toBeUndefined());
    expect(cancelled.agent.teamWriteEnabled).toBe(true);

    cancelled.agent.turn.cancel(cancelled.agent.turn.currentId);
    await vi.waitFor(() => expect(session.getAgentMetadata(cancelled.id)?.assignedTask).toBeUndefined());
    expect(cancelled.agent.teamWriteEnabled).toBe(true);

    // A stale completion token cannot revoke a newer assignment for the same
    // member, even when both turns belong to one durable Team Agent.
    const reassigned = await session.assignTeamTasks(main.id, [
      { agentId: completed.id, task: 'A newer assignment.' },
      { agentId: failed.id, task: null },
      { agentId: cancelled.id, task: null },
    ]);
    const currentToken = reassigned.find(({ agentId }) => agentId === completed.id)?.assignedAt;
    expect(currentToken).toBeDefined();
    await expect(session.releaseTeamAssignment(main.id, completed.id, 'stale-token')).resolves.toBe(false);
    expect(session.getAgentMetadata(completed.id)?.assignedTask).toBe('A newer assignment.');
    await expect(session.releaseTeamAssignment(main.id, completed.id, currentToken!)).resolves.toBe(true);
    expect(session.getAgentMetadata(completed.id)?.assignedTask).toBeUndefined();

    // A prompt that returns no turn id must release its lease immediately.
    const promptNull = vi.spyOn(completed.agent.turn, 'prompt').mockReturnValue(null);
    await expect(host.assignTeam([
      { agentId: completed.id, task: 'This turn cannot start.' },
      { agentId: failed.id, task: null },
      { agentId: cancelled.id, task: null },
    ], signal)).rejects.toThrow('could not start its assigned turn');
    expect(promptNull).toHaveBeenCalledTimes(1);
    expect(session.getAgentMetadata(completed.id)?.assignedTask).toBeUndefined();
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
        mandate: 'Implement assigned work.',
        role: 'builder',
        status: 'idle',
        assigned_task: 'Implement TeamStatus.',
        report_status: 'unreported',
        report_summary: null,
        report_received: false,
      }],
    });

    const assignmentId = session.getAgentMetadata(member.id)?.assignedAt;
    expect(assignmentId).toBeDefined();
    vi.spyOn(member.agent.turn, 'hasActiveTurn', 'get').mockReturnValue(true);
    await expect(new SessionSubagentHost(session, main.id).getTeamStatus()).resolves.toMatchObject({
      members: [{ status: 'running', report_status: 'unreported' }],
    });
    expect(main.agent.context.history.at(-1)?.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Do not take over or repeat the work'),
    });
    await expect(session.notifyMissingTeamReport(member.id, assignmentId!)).resolves.toBe(true);
    expect(member.agent.context.history.at(-1)?.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('without a TeamDM report'),
    });
    vi.spyOn(member.agent.turn, 'hasActiveTurn', 'get').mockReturnValue(false);
    await expect(session.recordTeamReport(member.id, 'blocked', 'Waiting for a parent decision.')).resolves.toBe(true);
    await expect(new SessionSubagentHost(session, main.id).getTeamStatus()).resolves.toMatchObject({
      members: [{
        report_status: 'blocked',
        report_summary: 'Waiting for a parent decision.',
        report_received: false,
      }],
    });
    await expect(session.acknowledgeTeamReport(member.id)).resolves.toBe(true);
    await expect(new SessionSubagentHost(session, main.id).getTeamStatus()).resolves.toMatchObject({
      members: [{ report_status: 'blocked', report_received: true }],
    });
    const currentMeta = session.getAgentMetadata(member.id)!;
    session.metadata.agents[member.id] = {
      ...currentMeta,
      teamReport: {
        assignmentId: 'decision-assignment',
        task: 'Choose the implementation path.',
        status: 'unreported',
      },
    };
    await expect(session.recordTeamReport(member.id, 'needs_decision', 'Choose the safer implementation.')).resolves.toBe(true);
    await expect(new SessionSubagentHost(session, main.id).getTeamStatus()).resolves.toMatchObject({
      members: [{
        report_status: 'needs_decision',
        report_summary: 'Choose the safer implementation.',
        report_received: false,
      }],
    });
  });

  it('persists department Chat messages on the parent metadata, isolated from Discuss', async () => {
    const session = new Session({
      id: 'test-team-chat',
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
          mandate: 'Implement assigned work.',
          role: 'builder',
        },
      },
    );

    const first = await session.postTeamChatMessage(
      main.id,
      member.id,
      'Builder',
      'Cache key changed.',
      ['all'],
    );
    const second = await session.postTeamChatMessage(
      main.id,
      member.id,
      'Builder',
      'Rebased on top of it.',
      [],
    );

    expect(first).toMatchObject({ messageId: 1, agentId: member.id, name: 'Builder', mentions: ['all'] });
    expect(second).toMatchObject({ messageId: 2, message: 'Rebased on top of it.' });
    const chat = session.getAgentMetadata(main.id)?.chat;
    expect(chat?.nextMessageId).toBe(3);
    expect(chat?.messages).toHaveLength(2);
    // Chat lives on the parent's own metadata but never touches its discussion.
    expect(session.getAgentMetadata(main.id)?.discussion).toBeUndefined();
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
      parent_agent_id: main.id,
      member_count: 0,
      message: 'No members hired by you; no peers in your own department.',
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

  // A member that cannot see its own department has no way to name the peer a
  // handoff belongs to, and asks its parent to pass the work along instead.
  it('shows a member the peers hired alongside it, and the lead none', async () => {
    const session = new Session({
      id: 'test-department-team-status',
      kaos: createFakeKaos({
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeText: vi.fn().mockResolvedValue(0),
      }),
      homedir: '/tmp/kimi-session',
      rpc: createSessionRpc(),
      initializeMainAgent: false,
    });
    const main = await session.createAgent({ type: 'main' }, { profile: contextProfile() });
    const memberOptions = (name: string, role: string) => ({
      kind: 'team' as const,
      parentAgentId: main.id,
      teamLeaderAgentId: main.id,
      profile: contextProfile(),
      teamIdentity: { name, mandate: `${name} mandate.`, role },
    });
    const builder = await session.createAgent({ type: 'sub' }, memberOptions('Builder', 'builder'));
    const reviewer = await session.createAgent({ type: 'sub' }, memberOptions('Reviewer', 'reviewer'));
    await session.assignTeamTasks(main.id, [
      { agentId: builder.id, task: 'Write the parser.' },
      { agentId: reviewer.id, task: 'Review the parser.' },
    ]);

    const fromBuilder = await new SessionSubagentHost(session, builder.id).getTeamStatus();
    expect(fromBuilder).toMatchObject({
      agent_id: builder.id,
      parent_agent_id: main.id,
      member_count: 0,
      colleagues: [{
        agent_id: reviewer.id,
        name: 'Reviewer',
        role: 'reviewer',
        status: 'idle',
        assigned_task: 'Review the parser.',
        report_status: 'unreported',
      }],
    });
    // A peer's own report belongs to the shared parent; only its status travels.
    expect(fromBuilder.colleagues?.[0]).not.toHaveProperty('report_summary');
    expect(fromBuilder.message).toContain('1 peer(s) in your own department');

    // The lead is in nobody's department, so it sees its members and no peers.
    const fromMain = await new SessionSubagentHost(session, main.id).getTeamStatus();
    expect(fromMain.colleagues).toBeUndefined();
    expect(fromMain.parent_agent_id).toBeUndefined();
    expect(fromMain.member_count).toBe(2);
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
}): ResolvedAgentProfile {
  return {
    name: input.name,
    description: input.description,
    systemPrompt: () => input.systemPrompt,
    tools: [...input.tools],
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
