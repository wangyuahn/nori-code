import {
  APIProviderRateLimitError,
  isProviderRateLimitError,
  type TokenUsage,
} from '@nori-code/kosong';

import type { Agent } from '../agent';
import {
  BackgroundManager,
  isBackgroundTaskTerminal,
} from '../agent/background';
import type { PromptOrigin } from '../agent/context';
import { ErrorCodes, type KimiErrorPayload } from '../errors';
import { DenyAllPermissionPolicy } from '../agent/permission/policies/deny-all';
import { InMemoryAgentRecordPersistence } from '../agent/records';
import { isAbortError } from '../loop/errors';
import {
  configuredSubagentProfiles,
  DEFAULT_AGENT_PROFILES,
  prepareSystemPromptContext,
  type ResolvedAgentProfile,
} from '../profile';
import {
  linkAbortSignal,
  userCancellationReason,
} from '../utils/abort';
import { collectGitContext } from './git-context';
import type {
  Session,
  TeamAssignment,
  TeamDiscussionMeta,
  TeamDiscussionStatementRecord,
  TeamIdentity,
} from './index';
import {
  SubagentBatch,
  isSubagentPauseReason,
  resolveSubagentMaxConcurrency,
  type SubagentBatchOptions,
  type SubagentResult,
  type SubagentSuspendedEvent,
  type QueuedSubagentTask,
} from './subagent-batch';
import {
  extractNoriMemoryKeywords,
  NoriMemoryChainQuerySchema,
  retrieveNoriMemoryChain,
  type NoriMemoryChainQuery,
  type NoriMemoryChainResult,
} from '../tools/builtin/nori/memory-chain';
import type { NoriMemoryProvider } from '../tools/builtin/nori/types';
import SUMMARY_CONTINUATION_PROMPT from './summary-continuation.md?raw';
import TEAM_AGENT_EXECUTION_PROMPT from './team-agent-execution.md?raw';

export const DEFAULT_SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_SUBAGENT_TIMEOUT_DESCRIPTION = '30 minutes';

export type {
  SubagentResult as QueuedSubagentRunResult,
  QueuedSubagentTask,
  ResumeQueuedSubagentTask,
  SpawnQueuedSubagentTask,
} from './subagent-batch';

/**
 * A subagent summary shorter than this many characters triggers one
 * follow-up turn that asks the subagent to expand it, so the parent
 * agent receives a technically complete handoff.
 */
const SUMMARY_MIN_LENGTH = 200;
const SUMMARY_CONTINUATION_ATTEMPTS = 1;
const HOOK_TEXT_PREVIEW_LENGTH = 500;
const SUBAGENT_MAX_TOKENS_ERROR =
  'Subagent turn failed before completing its final summary: reason=max_tokens';
const TOOL_CALL_DISABLED_MESSAGE =
  'Tool calls are disabled for side questions. Answer with text only.';
const SIDE_QUESTION_SYSTEM_REMINDER = `
This is a side-channel conversation with the user. You should answer user questions directly based on what you already know.

IMPORTANT:
- You are a separate, lightweight instance.
- The main agent continues independently; do not reference being interrupted.
- Do not call any tools. All tool calls are disabled and will be rejected.
  Even though tool definitions are visible in this request, they exist only
  for technical reasons (prompt cache). You must not use them.
- Respond only with text based on what you already know from the conversation
  and this side-channel conversation.
- Follow-up turns may happen in this side-channel conversation.
- If you do not know the answer, say so directly.
`;

const ASK_PARENT_SYSTEM_REMINDER = `
A child agent has asked you a question and is waiting for your guidance.
You are answering as the parent agent, with access to the full task context.

IMPORTANT:
- Answer the child's question directly and concisely.
- Draw on your knowledge of the overall task, the plan, and past decisions.
- Do not call any tools. All tool calls are disabled and will be rejected.
- Answer in a single turn; the child agent is blocked waiting.
- If you do not know the answer, say so directly and suggest next steps.
`;

const ASK_PARENT_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

export interface RunSubagentOptions {
  readonly parentToolCallId: string;
  readonly parentToolCallUuid?: string;
  readonly prompt: string;
  readonly description: string;
  readonly subagentIndex?: number;
  readonly runInBackground: boolean;
  readonly signal: AbortSignal;
  readonly onReady?: () => void;
  readonly suppressRateLimitFailureEvent?: boolean;
}

export interface SpawnSubagentOptions extends RunSubagentOptions {
  readonly profileName: string;
  readonly subagentItem?: string;
}

type SubagentCompletion = {
  readonly result: string;
  readonly usage?: TokenUsage;
};

export type SubagentHandle = {
  readonly agentId: string;
  readonly profileName: string;
  readonly resumed: boolean;
  readonly completion: Promise<SubagentCompletion>;
};

export class SessionSubagentHost {
  private readonly activeChildren = new Map<
    string,
      {
        readonly controller: AbortController;
        runInBackground: boolean;
        discardWhenIdle: boolean;
      }
  >();
  private readonly accountedUsageByAgent = new Map<string, TokenUsage>();

  // Nori runtime settings propagated through nested subagents.
  private _noriMemory?: NoriMemoryProvider;
  private _noriRetrievalGate?: { triggerMode: string; maxResults: number };

  setNoriConfig(config: {
    memory?: NoriMemoryProvider;
    retrievalGate?: { triggerMode: string; maxResults: number };
  }): void {
    this._noriMemory = config.memory;
    this._noriRetrievalGate = config.retrievalGate;
  }

  constructor(
    private readonly session: Session,
    private readonly ownerAgentId: string,
  ) {}

  async createTeam(
    members: readonly TeamIdentity[],
  ): Promise<Array<{ readonly agentId: string; readonly identity: TeamIdentity }>> {
    this.assertTeamLead();
    this.preflightTeamCreation(members);
    const created: Array<{ readonly agentId: string; readonly identity: TeamIdentity }> = [];
    try {
      for (const identity of members) {
        const { id } = await this.session.createTeamMember(this.ownerAgentId, identity);
        created.push({ agentId: id, identity });
      }
    } catch (error) {
      // Profile bootstrapping can still fail after a successful preflight. Do
      // not leave the durable first members behind when a later one fails.
      if (created.length > 0) {
        await this.session.dismissTeamMembers(
          this.ownerAgentId,
          created.map(({ agentId }) => agentId),
          'Rolling back an incomplete TeamCreate operation.',
          true,
        ).catch(() => undefined);
      }
      throw error;
    }
    return created;
  }

  private preflightTeamCreation(members: readonly TeamIdentity[]): void {
    if (members.length === 0) throw new Error('TeamCreate requires at least one member.');
    const existing = this.session.teamMemberMetadata(this.ownerAgentId).map(([, meta]) => meta.name ?? '');
    const seen: string[] = [];
    for (const identity of members) {
      for (const [field, value] of Object.entries(identity)) {
        if (typeof value !== 'string' || value.trim().length === 0) {
          throw new Error(`Team identity field "${field}" must not be blank.`);
        }
      }
      if (seen.some((name) => name.localeCompare(identity.name, undefined, { sensitivity: 'accent' }) === 0)) {
        throw new Error(`TeamCreate contains duplicate member name "${identity.name}".`);
      }
      if (existing.some((name) => name.localeCompare(identity.name, undefined, { sensitivity: 'accent' }) === 0)) {
        throw new Error(`A team member named "${identity.name}" already exists.`);
      }
      seen.push(identity.name);
    }
  }

  private assertTeamLead(): void {
    // Narrow unit tests use a Session-shaped transport mock. Preserve their
    // main-agent behavior while enforcing the real Session guard at runtime.
    if (typeof this.session.assertTeamLead === 'function') {
      this.session.assertTeamLead(this.ownerAgentId);
      return;
    }
    if (this.ownerAgentId !== 'main') {
      throw new Error('Team management is available only to the main agent.');
    }
  }

  async dismissTeam(
    agentIds: readonly string[],
    reason: string,
    confirmActive: boolean,
  ): Promise<void> {
    await this.session.dismissTeamMembers(this.ownerAgentId, agentIds, reason, confirmActive);
  }

  async assignTeam(
    assignments: readonly TeamAssignment[],
    signal: AbortSignal,
  ): Promise<Array<{ readonly agentId: string; readonly task: string | null; readonly turnId?: number }>> {
    const assigned = await this.session.assignTeamTasks(this.ownerAgentId, assignments);
    const started: Array<{ readonly agentId: string; readonly task: string | null; readonly turnId?: number }> = [];
    for (const assignment of assigned) {
      signal.throwIfAborted();
      if (assignment.task === null) {
        started.push({ agentId: assignment.agentId, task: null });
        continue;
      }
      const turnId = assignment.agent.turn.prompt(
        [{
          type: 'text',
          text: `${assignment.task}\n\n${TEAM_AGENT_EXECUTION_PROMPT.trim()}`,
        }],
        this.teamLeadPromptOrigin(),
      );
      if (turnId === null) {
        throw new Error(`Team member "${assignment.agentId}" could not start its assigned turn.`);
      }
      started.push({ agentId: assignment.agentId, task: assignment.task, turnId });
    }
    return started;
  }

  async broadcastTeam(message: string, signal: AbortSignal): Promise<readonly string[]> {
    const members = this.session.teamMemberMetadata(this.ownerAgentId);
    if (members.length === 0) throw new Error('Create a team before sending a broadcast.');
    await Promise.all(members.map(async ([agentId]) => {
      signal.throwIfAborted();
      const agent = await this.session.ensureAgentResumed(agentId);
      if (agent.turn.hasActiveTurn) return;
      const turnId = agent.turn.prompt(
        [{ type: 'text', text: message }],
        this.teamLeadPromptOrigin(),
      );
      if (turnId === null) return;
      await runChildTurnToCompletion(agent, signal);
    }));
    return members.map(([agentId]) => agentId);
  }

  async directMessage(
    targetAgentId: string,
    message: string,
    signal: AbortSignal,
  ): Promise<'completed' | 'buffered'> {
    signal.throwIfAborted();
    const sender = this.session.getAgentMetadata(this.ownerAgentId);
    const leaderAgentId = this.ownerAgentId === 'main'
      ? 'main'
      : sender?.teamLeaderAgentId;
    if (leaderAgentId === undefined) {
      throw new Error('TeamDM is available only to the main agent and team members.');
    }
    const target = this.session.getAgentMetadata(targetAgentId);
    const targetIsLead = targetAgentId === leaderAgentId;
    const targetIsTeamMember =
      target?.kind === 'team' && target.teamLeaderAgentId === leaderAgentId;
    if (!targetIsLead && !targetIsTeamMember) {
      throw new Error(`TeamDM target "${targetAgentId}" is not in this team.`);
    }
    const recipient = await this.session.ensureAgentResumed(targetAgentId);
    const origin = this.ownerAgentId === leaderAgentId
      ? this.teamLeadPromptOrigin()
      : this.teamMemberPromptOrigin(sender);
    const input = [{ type: 'text' as const, text: wrapTeamDirectMessage(message) }];
    const recipientBusy = recipient.turn.hasActiveTurn;
    const turnId = recipientBusy
      ? recipient.turn.steer(input, origin)
      : recipient.turn.prompt(input, origin);
    if (turnId === null) {
      if (recipientBusy) return 'buffered';
      throw new Error(`TeamDM target "${targetAgentId}" could not start a turn.`);
    }
    await runChildTurnToCompletion(recipient, signal);
    return 'completed';
  }

  async inviteToDiscussion(agentIds: readonly string[]): Promise<TeamDiscussionMeta> {
    this.assertTeamLead();
    if (typeof this.session.assertTeamDiscussionMode === 'function') {
      await this.session.assertTeamDiscussionMode(this.ownerAgentId);
    }
    const active = this.requireActiveDiscussion();
    const current = new Set(active.meta.discussion!.participantAgentIds);
    const members = new Set(this.session.teamMemberMetadata(this.ownerAgentId).map(([id]) => id));
    const added: string[] = [];
    for (const id of agentIds) {
      if (!members.has(id)) throw new Error(`Discussion participant "${id}" is not in the team.`);
      if (!current.has(id)) added.push(id);
      current.add(id);
    }
    const discussion = await this.session.updateTeamDiscussion(active.id, {
      participantAgentIds: [...current],
      status: active.meta.discussion!.status,
      topic: active.meta.discussion!.topic,
    });
    await this.notifyDiscussionLifecycle(discussion, added, 'joined');
    return discussion;
  }

  async kickFromDiscussion(agentIds: readonly string[]): Promise<TeamDiscussionMeta> {
    this.assertTeamLead();
    if (typeof this.session.assertTeamDiscussionMode === 'function') {
      await this.session.assertTeamDiscussionMode(this.ownerAgentId);
    }
    const active = this.requireActiveDiscussion();
    const current = new Set(active.meta.discussion!.participantAgentIds);
    for (const id of agentIds) {
      if (!current.delete(id)) throw new Error(`Discussion participant "${id}" is not active.`);
    }
    if (current.size === 0) throw new Error('A discussion must retain at least one participant.');
    const discussion = await this.session.updateTeamDiscussion(active.id, {
      participantAgentIds: [...current],
      status: active.meta.discussion!.status,
      topic: active.meta.discussion!.topic,
    });
    // Keep the team durable while making the per-discussion removal visible
    // to the affected agents. They must not infer that they are still
    // scheduled from stale context.
    await this.notifyDiscussionLifecycle(discussion, agentIds, 'kicked');
    return discussion;
  }

  async lockTeamWritesForDiscuss(): Promise<void> {
    if (typeof this.session.lockTeamAssignments === 'function') {
      await this.session.lockTeamAssignments(this.ownerAgentId);
    }
  }

  async decideTeamDiscussion(
    action: 'start' | 'continue' | 'archive' | 'vote',
    topic: string | undefined,
    participantAgentIds: readonly string[] | undefined,
    signal: AbortSignal,
    statement?: string,
  ): Promise<TeamDiscussionResult> {
    this.assertTeamLead();
    if ((action === 'start' || action === 'continue')
      && typeof this.session.assertTeamDiscussionMode === 'function') {
      await this.session.assertTeamDiscussionMode(this.ownerAgentId);
    }
    let active = this.session.activeTeamDiscussion(this.ownerAgentId);
    if (action === 'start') {
      if (active !== undefined) throw new Error('A team discussion is already active. Use continue or archive it first.');
      const discussionTopic = topic?.trim() ?? '';
      if (discussionTopic.length === 0) throw new Error('A discussion topic is required.');
      const participants = participantAgentIds ?? this.session.teamMemberMetadata(this.ownerAgentId).map(([id]) => id);
      const created = await this.session.createTeamDiscussion(
        this.ownerAgentId,
        discussionTopic,
        participants,
      );
      await this.notifyDiscussionLifecycle(created.discussion, created.discussion.participantAgentIds, 'started');
      active = [created.id, this.session.getAgentMetadata(created.id)!];
    }
    if (active === undefined) throw new Error('There is no active team discussion. Start one first.');
    const activeDiscussion = active[1].discussion;
    if (activeDiscussion === undefined) {
      throw new Error('The active team discussion metadata is unavailable.');
    }
    if (action === 'archive') {
      const discussion = await this.session.updateTeamDiscussion(active[0], {
        participantAgentIds: activeDiscussion.participantAgentIds,
        status: 'archived',
        topic: activeDiscussion.topic,
      });
      await this.notifyDiscussionLifecycle(discussion, Object.keys(discussion.readCursors ?? {}), 'ended');
      return { discussionAgentId: active[0], discussion, statements: [], votes: [] };
    }
    if (action === 'vote') {
      return this.runTeamVote(active[0], activeDiscussion, signal);
    }
    return this.runTeamDiscussionRound(active[0], activeDiscussion, signal, statement);
  }

  async speakInDiscussion(message: string): Promise<{ readonly discussionAgentId: string; readonly entryId: number }> {
    return this.session.publishTeamDiscussionStatement(this.ownerAgentId, message);
  }

  private async notifyDiscussionLifecycle(
    discussion: TeamDiscussionMeta,
    agentIds: readonly string[],
    phase: 'started' | 'joined' | 'kicked' | 'ended',
  ): Promise<void> {
    if (agentIds.length === 0) return;
    const text = phase === 'started'
      ? `You have been invited to a team discussion on: ${discussion.topic}. Wait for a scheduled turn before responding; shared updates are injected only when your turn starts.`
      : phase === 'joined'
        ? `You joined the active team discussion on: ${discussion.topic}. Wait for a scheduled turn before responding; you will receive only unread shared updates.`
        : phase === 'kicked'
          ? `You were removed from the active team discussion on: ${discussion.topic}. Do not send further discussion statements unless invited again.`
          : `The team discussion on "${discussion.topic}" has ended and is archived. Do not send further discussion statements.`;
    await Promise.all(agentIds.map(async (agentId) => {
      const participant = await this.session.ensureAgentResumed(agentId);
      const noticeId = `${discussion.startedAt}:${phase}:${agentId}`;
      const alreadyNotified = participant.context.history.some((message) => (
        message.origin?.kind === 'system_trigger'
        && message.origin.name === 'team_discussion_lifecycle'
        && message.origin.discussionLifecycleNoticeId === noticeId
      ));
      if (alreadyNotified) return;
      participant.context.appendUserMessage(
        [{ type: 'text', text }],
        this.teamDiscussionLifecycleOrigin(noticeId),
      );
    }));
  }

  private requireActiveDiscussion(): { readonly id: string; readonly meta: NonNullable<ReturnType<Session['getAgentMetadata']>> } {
    const active = this.session.activeTeamDiscussion(this.ownerAgentId);
    if (active === undefined) throw new Error('There is no active team discussion.');
    return { id: active[0], meta: active[1] };
  }

  private async runTeamDiscussionRound(
    discussionAgentId: string,
    discussion: TeamDiscussionMeta,
    signal: AbortSignal,
    statement?: string,
  ): Promise<TeamDiscussionResult> {
    const statements: TeamDiscussionStatement[] = [];
    const leadStatement = statement?.trim();
    if (leadStatement) {
      if (typeof this.session.publishLeadDiscussionStatement === 'function') {
        await this.session.publishLeadDiscussionStatement(this.ownerAgentId, leadStatement);
      }
      statements.push({ agentId: this.ownerAgentId, statement: leadStatement, skipped: false });
    }
    for (const agentId of discussion.participantAgentIds) {
      signal.throwIfAborted();
      const meta = this.session.getAgentMetadata(agentId);
      if (meta?.kind !== 'team') continue;
      const participant = await this.session.ensureAgentResumed(agentId);
      if (participant.turn.hasActiveTurn) {
        statements.push({ agentId, skipped: true, reason: 'active' });
        continue;
      }
      const unread = await this.session.unreadTeamDiscussionStatements(discussionAgentId, agentId);
      this.session.beginTeamDiscussionTurn(discussionAgentId, agentId);
      try {
        const turnId = participant.turn.prompt(
          [{ type: 'text', text: discussionRoundPrompt(unread.statements) }],
          this.teamLeadPromptOrigin(),
        );
        if (turnId === null) {
          statements.push({ agentId, skipped: true, reason: 'unavailable' });
          continue;
        }
        // Mark messages as read only after this agent accepted the turn. That
        // prevents a rejected prompt from silently losing an unread update,
        // while keeping accepted messages from being replayed into its cache.
        await this.session.acknowledgeTeamDiscussionStatements(discussionAgentId, agentId, unread.cursor);
        await runChildTurnToCompletion(participant, signal);
      } catch {
        const sent = this.session.consumeTeamDiscussionSpeak(discussionAgentId, agentId);
        statements.push(sent === undefined
          ? { agentId, skipped: true, reason: 'failed' }
          : { agentId, statement: sent.message, skipped: false });
        continue;
      } finally {
        this.session.endTeamDiscussionTurn(discussionAgentId, agentId);
      }
      const sent = this.session.consumeTeamDiscussionSpeak(discussionAgentId, agentId);
      statements.push(sent === undefined
        ? { agentId, skipped: true }
        : { agentId, statement: sent.message, skipped: false });
    }
    return { discussionAgentId, discussion, statements, votes: [] };
  }

  private async runTeamVote(
    discussionAgentId: string,
    discussion: TeamDiscussionMeta,
    signal: AbortSignal,
  ): Promise<TeamDiscussionResult> {
    const transcript = await this.session.ensureAgentResumed(discussionAgentId);
    const voters = discussion.participantAgentIds.map((agentId) =>
      [agentId, this.session.getAgentMetadata(agentId)] as const,
    );
    const activeVoterIds: string[] = [];
    for (const [agentId] of voters) {
      const participant = await this.session.ensureAgentResumed(agentId);
      if (participant.turn.hasActiveTurn) activeVoterIds.push(agentId);
    }
    if (activeVoterIds.length > 0) {
      throw new Error(
        `TeamDecide vote must wait for team execution turns to finish: ${activeVoterIds.join(', ')}.`,
      );
    }
    const votes: TeamVote[] = [];
    for (const [agentId] of voters) {
      signal.throwIfAborted();
      const participant = await this.session.ensureAgentResumed(agentId);
      if (participant.turn.hasActiveTurn) {
        votes.push({ agentId, vote: 'abstain' });
        continue;
      }
      // Voting is a scheduled participant turn too. Deliver only this
      // participant's unread statement suffix, then acknowledge it only after
      // the prompt was accepted so a failed/unavailable vote can retry without
      // losing discussion context.
      const unread = await this.session.unreadTeamDiscussionStatements(discussionAgentId, agentId);
      const turnId = participant.turn.prompt(
        [{
          type: 'text',
          text: discussionVotePrompt(unread.statements),
        }],
        this.teamLeadPromptOrigin(),
      );
      if (turnId === null) {
        votes.push({ agentId, vote: 'abstain' });
        continue;
      }
      await this.session.acknowledgeTeamDiscussionStatements(discussionAgentId, agentId, unread.cursor);
      try {
        await runChildTurnToCompletion(participant, signal);
      } catch {
        votes.push({ agentId, vote: 'abstain' });
        continue;
      }
      const vote = parseTeamVote(lastAssistantText(participant));
      votes.push({ agentId, vote });
      transcript.context.appendUserMessage(
        [{ type: 'text', text: `${this.session.getAgentMetadata(agentId)?.name ?? '团队成员'} voted: ${vote}` }],
        {
          kind: 'system_trigger',
          name: 'team_discussion_vote',
          speaker: {
            from: 'team',
            speakerId: agentId,
            speakerName: this.session.getAgentMetadata(agentId)?.name ?? '团队成员',
          },
        },
      );
    }
    return { discussionAgentId, discussion, statements: [], votes };
  }

  private teamLeadPromptOrigin(): PromptOrigin {
    return {
      kind: 'system_trigger',
      name: 'team_lead',
      speaker: {
        from: 'lead',
        speakerId: this.ownerAgentId,
        speakerName: '主代理',
      },
    };
  }

  private teamDiscussionLifecycleOrigin(noticeId: string): PromptOrigin {
    return {
      kind: 'system_trigger',
      name: 'team_discussion_lifecycle',
      discussionLifecycleNoticeId: noticeId,
      speaker: {
        from: 'lead',
        speakerId: this.ownerAgentId,
        speakerName: '主代理',
      },
    };
  }

  private teamMemberPromptOrigin(
    meta: { readonly name?: string } | undefined,
    speakerId = this.ownerAgentId,
  ): PromptOrigin {
    return {
      kind: 'system_trigger',
      name: 'team_member',
      speaker: {
        from: 'team',
        speakerId,
        speakerName: meta?.name ?? '团队成员',
      },
    };
  }

  async spawn(options: SpawnSubagentOptions): Promise<SubagentHandle> {
    options.signal.throwIfAborted();

    const parent = await this.session.ensureAgentResumed(this.ownerAgentId);
    const profile = this.resolveProfile(parent, options.profileName);
    const { id, agent } = await this.session.createAgent(
      { type: 'sub', generate: parent.rawGenerate },
      { parentAgentId: this.ownerAgentId, subagentItem: options.subagentItem },
    );

    // Propagate Nori memory and retrieval settings to the child host.
    const childHost = agent.subagentHost as SessionSubagentHost;
    childHost?.setNoriConfig({
      memory: this._noriMemory,
      retrievalGate: this._noriRetrievalGate,
    });

    const completion = this.runWithActiveChild(id, agent, options, async (runOptions) => {
      this.emitSubagentSpawned(parent, id, profile.name, runOptions);
      try {
        await this.configureChild(parent, agent, profile);
        return await this.runPromptTurn(parent, id, agent, profile.name, runOptions);
      } catch (error) {
        if (!isSubagentPauseReason(runOptions.signal.reason)) {
          this.emitSubagentFailed(parent, id, runOptions, error);
        }
        throw error;
      }
    });
    return {
      agentId: id,
      profileName: profile.name,
      resumed: false,
      completion,
    };
  }

  private async sessionBackgroundManagers(): Promise<
    Array<{ readonly ownerAgentId: string; readonly background: BackgroundManager }>
  > {
    const agentIds = new Set([
      ...Object.keys(this.session.metadata.agents),
      this.ownerAgentId,
    ]);
    return Promise.all(
      Array.from(agentIds, async (ownerAgentId) => ({
        ownerAgentId,
        background: (await this.session.ensureAgentResumed(ownerAgentId)).background,
      })),
    );
  }

  async resume(agentId: string, options: RunSubagentOptions): Promise<SubagentHandle> {
    options.signal.throwIfAborted();
    const { parent, child, profileName } = await this.ensureIdleSubagent(agentId);
    this.rememberUsageBaseline(agentId, child);
    const completion = this.runWithActiveChild(agentId, child, options, async (runOptions) => {
      this.emitSubagentSpawned(parent, agentId, profileName, runOptions);
      try {
        child.config.update({ modelAlias: this.modelAliasForProfile(parent, profileName) });
        return await this.runPromptTurn(parent, agentId, child, profileName, runOptions);
      } catch (error) {
        if (!isSubagentPauseReason(runOptions.signal.reason)) {
          this.emitSubagentFailed(parent, agentId, runOptions, error);
        }
        throw error;
      }
    });
    return { agentId, profileName, resumed: true, completion };
  }

  async retry(agentId: string, options: RunSubagentOptions): Promise<SubagentHandle> {
    options.signal.throwIfAborted();
    const { parent, child, profileName } = await this.ensureIdleSubagent(agentId);
    this.rememberUsageBaseline(agentId, child);
    const completion = this.runWithActiveChild(agentId, child, options, async (runOptions) => {
      try {
        runOptions.signal.throwIfAborted();
        child.config.update({ modelAlias: this.modelAliasForProfile(parent, profileName) });
        this.emitSubagentStarted(parent, agentId);
        const turnId = child.turn.retry('agent-host');
        if (turnId === null) {
          throw new Error(`Agent instance "${agentId}" could not start a retry turn`);
        }
        this.observeFirstRequest(child, runOptions);
        return await this.waitForChildCompletion(parent, agentId, child, profileName, runOptions);
      } catch (error) {
        if (!isSubagentPauseReason(runOptions.signal.reason)) {
          this.emitSubagentFailed(parent, agentId, runOptions, error);
        }
        throw error;
      }
    });
    return { agentId, profileName, resumed: true, completion };
  }

  private async ensureIdleSubagent(
    agentId: string,
  ): Promise<{ readonly parent: Agent; readonly child: Agent; readonly profileName: string }> {
    const parent = await this.session.ensureAgentResumed(this.ownerAgentId);
    const metadata = this.session.metadata.agents[agentId];
    if (metadata?.type !== 'sub') {
      throw new Error(`Agent instance "${agentId}" is not a subagent`);
    }
    if (metadata.parentAgentId !== this.ownerAgentId) {
      throw new Error(`Agent instance "${agentId}" does not belong to this parent agent`);
    }
    const child = await this.session.ensureAgentResumed(agentId);
    if (this.activeChildren.has(agentId) || child.turn.hasActiveTurn) {
      throw new Error(`Agent instance "${agentId}" is already running and cannot run concurrently`);
    }

    const profileName = child.config.profileName ?? 'subagent';
    return { parent, child, profileName };
  }

  async runQueued<T>(tasks: readonly QueuedSubagentTask<T>[]): Promise<Array<SubagentResult<T>>> {
    const maxConcurrency = resolveSubagentMaxConcurrency();
    return new SubagentBatch(this, tasks, { maxConcurrency }).run();
  }

  async runQueuedControlled<T>(
    tasks: readonly QueuedSubagentTask<T>[],
    observe: (batch: SubagentBatch<T> | undefined) => void,
    options: Pick<SubagentBatchOptions, 'discardTerminalAgents'> = {},
  ): Promise<Array<SubagentResult<T>>> {
    const batch = new SubagentBatch(this, tasks, {
      maxConcurrency: resolveSubagentMaxConcurrency(),
      discardTerminalAgents: options.discardTerminalAgents,
    });
    observe(batch);
    try {
      return await batch.run();
    } finally {
      observe(undefined);
    }
  }

  suspended(event: SubagentSuspendedEvent): void {
    const parent = this.session.getReadyAgent?.(this.ownerAgentId);
    parent?.emitEvent({
      type: 'subagent.suspended',
      subagentId: event.agentId,
      reason: event.reason,
    });
  }

  async startBtw(): Promise<string> {
    const parent = await this.session.ensureAgentResumed(this.ownerAgentId);
    const { id, agent: child } = await this.session.createAgent(
      {
        type: 'sub',
        generate: parent.rawGenerate,
        persistence: new InMemoryAgentRecordPersistence(),
      },
      { parentAgentId: this.ownerAgentId, persistMetadata: false },
    );

    child.config.update({
      modelAlias: parent.config.modelAlias,
      thinkingEffort: parent.config.thinkingEffort,
      systemPrompt: parent.config.systemPrompt,
    });
    child.tools.copyLoopToolsFrom(parent.tools);
    child.context.useProjectedHistoryFrom(parent.context);
    child.context.appendSystemReminder(SIDE_QUESTION_SYSTEM_REMINDER.trim(), {
      kind: 'system_trigger',
      name: 'btw',
    });
    child.permission.policies.unshift(new DenyAllPermissionPolicy(TOOL_CALL_DISABLED_MESSAGE));
    return id;
  }

  async askOwnerParent(question: string): Promise<string> {
    const metadata = this.session.metadata.agents[this.ownerAgentId];
    if (metadata?.type !== 'sub' || metadata.parentAgentId === null) {
      throw new Error('nori_ask_parent is only available from a subagent with a parent agent');
    }
    const parent = await this.session.ensureAgentResumed(metadata.parentAgentId);
    const parentHost = parent.subagentHost as SessionSubagentHost | undefined;
    if (parentHost === undefined) {
      throw new Error('Parent agent does not have a subagent host');
    }
    return parentHost.askParent(question, this.ownerAgentId);
  }

  async askParent(question: string, childId: string): Promise<string> {
    const parent = await this.session.ensureAgentResumed(this.ownerAgentId);

    const { agent: answerer } = await this.session.createAgent(
      {
        type: 'sub',
        generate: parent.rawGenerate,
        persistence: new InMemoryAgentRecordPersistence(),
      },
      { parentAgentId: this.ownerAgentId, persistMetadata: false },
    );

    answerer.config.update({
      modelAlias: parent.config.modelAlias,
      thinkingEffort: parent.config.thinkingEffort,
      systemPrompt: parent.config.systemPrompt,
    });
    answerer.tools.copyLoopToolsFrom(parent.tools);
    answerer.context.useProjectedHistoryFrom(parent.context);
    answerer.context.appendSystemReminder(ASK_PARENT_SYSTEM_REMINDER.trim(), {
      kind: 'system_trigger',
      name: 'ask_parent',
    });
    answerer.permission.policies.unshift(new DenyAllPermissionPolicy(TOOL_CALL_DISABLED_MESSAGE));

    const turnId = answerer.turn.prompt(
      [{ type: 'text', text: `[Child agent ${childId} asks]\n${question}` }],
      {
        kind: 'system_trigger',
        name: 'ask_parent',
        speaker: { from: 'sub', speakerId: childId, speakerName: 'SubAgent' },
      },
    );

    if (turnId === null) {
      throw new Error('Could not start ask-parent turn for the parent agent');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('askParent timed out')), ASK_PARENT_TIMEOUT_MS);

    try {
      await runChildTurnToCompletion(answerer, controller.signal);
      return lastAssistantText(answerer);
    } finally {
      clearTimeout(timeout);
    }
  }

  cancelAll(reason: unknown = userCancellationReason()): void {
    const foregroundChildren = Array.from(this.activeChildren).filter(
      ([, child]) => !child.runInBackground,
    );
    for (const [childId, child] of foregroundChildren) {
      this.session.getReadyAgent(childId)?.subagentHost?.cancelAll(reason);
      // Abort with the cancel reason (a user interruption by default) so the
      // subagent's in-flight tools report the cause accurately to the model.
      child.controller.abort(reason);
    }
  }

  markActiveChildDetached(agentId: string): void {
    const child = this.activeChildren.get(agentId);
    if (child !== undefined) child.runInBackground = true;
  }

  async getProfileName(agentId: string): Promise<string | undefined> {
    const metadata = this.session.metadata.agents[agentId];
    if (metadata?.type !== 'sub' || metadata.parentAgentId !== this.ownerAgentId) {
      return undefined;
    }
    return (await this.session.ensureAgentResumed(agentId)).config.profileName;
  }

  /**
   * Completed SubAgents are archived in the parent session so the live tree
   * can drop them while ChatView can still reopen the transcript.
   */
  async discard(agentId: string): Promise<void> {
    const active = this.activeChildren.get(agentId);
    if (active !== undefined) {
      active.discardWhenIdle = true;
      return;
    }
    await this.session.archiveCompletedSubagent(agentId);
  }

  getSubagentItem(agentId: string): string | undefined {
    const metadata = this.session.metadata.agents[agentId];
    if (metadata?.type !== 'sub' || metadata.parentAgentId !== this.ownerAgentId) {
      return undefined;
    }
    return metadata.subagentItem;
  }

  private resolveProfile(parent: Agent, profileName: string): ResolvedAgentProfile {
    const profile = this.findProfile(parent, profileName);
    if (profile === undefined) {
      throw new Error(`Subagent profile "${profileName}" was not found`);
    }
    return profile;
  }

  private findProfile(parent: Agent, profileName: string): ResolvedAgentProfile | undefined {
    const builtins = DEFAULT_AGENT_PROFILES[parent.config.profileName ?? 'agent']?.subagents ?? DEFAULT_AGENT_PROFILES['agent']?.subagents;
    // Keep old persisted/tool-call inputs working without advertising the
    // confusing legacy name in current SubAgent descriptions.
    const resolvedName = profileName === 'nori-coder' ? 'orchestrator' : profileName;
    return configuredSubagentProfiles(builtins, parent.kimiConfig?.customAgents)?.[resolvedName];
  }

  private modelAliasForProfile(parent: Agent, profileName: string): string | undefined {
    return this.findProfile(parent, profileName)?.modelAlias ?? parent.config.modelAlias;
  }

  private runWithActiveChild(
    childId: string,
    child: Agent,
    options: RunSubagentOptions,
    run: (options: RunSubagentOptions) => Promise<SubagentCompletion>,
  ): Promise<SubagentCompletion> {
    const controller = new AbortController();
    const unlinkAbortSignal = linkAbortSignal(options.signal, controller);
    this.activeChildren.set(childId, {
      controller,
      runInBackground: options.runInBackground,
      discardWhenIdle: false,
    });

    return (async () => {
      try {
        return await run({ ...options, signal: controller.signal });
      } finally {
        await this.accountChildUsage(childId, child).catch(() => undefined);
        unlinkAbortSignal();
        const active = this.activeChildren.get(childId);
        this.activeChildren.delete(childId);
        if (active?.discardWhenIdle === true) {
          await this.session.archiveCompletedSubagent(childId);
        }
      }
    })();
  }

  private async runPromptTurn(
    parent: Agent,
    childId: string,
    child: Agent,
    profileName: string,
    options: RunSubagentOptions,
  ): Promise<SubagentCompletion> {
    options.signal.throwIfAborted();
    await this.triggerSubagentStart(parent, profileName, options.prompt, options.signal);
    options.signal.throwIfAborted();

    let childPrompt = options.prompt;
    if (profileName === 'explore') {
      const gitContext = await collectGitContext(child.kaos, child.config.cwd);
      if (gitContext) childPrompt = `${gitContext}\n\n${childPrompt}`;
    }

    const retrievedContext = await this.tryBuildNoriRetrievedContext(child, childPrompt, options.signal);
    if (retrievedContext !== undefined) childPrompt = `${retrievedContext}\n\n${childPrompt}`;

    this.emitSubagentStarted(parent, childId);
    const turnId = child.turn.prompt([{ type: 'text', text: childPrompt }], this.subagentPromptOrigin());
    if (turnId === null) {
      throw new Error(`Agent instance "${childId}" could not start a turn`);
    }
    this.observeFirstRequest(child, options);
    return this.waitForChildCompletion(parent, childId, child, profileName, options);
  }

  private subagentPromptOrigin(): PromptOrigin {
    const owner = this.session.getAgentMetadata?.(this.ownerAgentId);
    if (owner?.kind === 'team') {
      return {
        kind: 'system_trigger',
        name: 'subagent',
        speaker: {
          from: 'team',
          speakerId: this.ownerAgentId,
          speakerName: owner.name ?? '团队成员',
        },
      };
    }
    return {
      kind: 'system_trigger',
      name: 'subagent',
      speaker: {
        from: 'lead',
        speakerId: this.ownerAgentId,
        speakerName: '主代理',
      },
    };
  }

  private async tryBuildNoriRetrievedContext(
    child: Agent,
    childPrompt: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const memory = this._noriMemory;
    if (memory === undefined || !this.shouldRunNoriRetrieval(childPrompt)) return undefined;

    try {
      const maxResults = clampInteger(this._noriRetrievalGate?.maxResults, 10, 1, 20);
      const query =
        (await this.requestNoriRetrievalQuery(child, maxResults, signal)) ??
        fallbackNoriMemoryQuery(childPrompt, maxResults);
      if (query === undefined) return undefined;
      const result = await retrieveNoriMemoryChain(memory, query);
      if (result.uniqueResults.length === 0) return undefined;
      return renderNoriRetrievedContext(result);
    } catch {
      // Retrieval failure should not block the subagent's primary task.
      return undefined;
    }
  }

  private shouldRunNoriRetrieval(childPrompt: string): boolean {
    const triggerMode = this._noriRetrievalGate?.triggerMode ?? 'always';
    if (['never', 'disabled', 'off', 'none'].includes(triggerMode)) return false;
    if (triggerMode === 'on_keywords') {
      return extractNoriMemoryKeywords(childPrompt, 1).length > 0;
    }
    return true;
  }

  private async requestNoriRetrievalQuery(
    child: Agent,
    maxResults: number,
    signal: AbortSignal,
  ): Promise<NoriMemoryChainQuery | undefined> {
    const retrievalPrompt = [
      'Output ONLY one <retrieval_query> block for shared memory search.',
      'Use concrete keywords from the task: file paths, symbols, errors, settings, feature names.',
      'Use chain_depth 1 or 2 when linked context may matter. Add follow_up_keywords if you can predict second-hop terms.',
      'Do not include markdown, explanation, or any text outside the XML block.',
      '',
      '<retrieval_query>',
      JSON.stringify(
        {
          keywords: ['specific', 'technical', 'terms'],
          note_types: ['analysis', 'decisions', 'reviews'],
          include_linked: true,
          link_depth: 1,
          chain_depth: 1,
          follow_up_keywords: [['related', 'second-hop', 'terms']],
          max_results: maxResults,
        },
        null,
        2,
      ),
      '</retrieval_query>',
    ].join('\n');
    const retrievalTurnId = child.turn.prompt(
      [{ type: 'text', text: retrievalPrompt }],
      this.subagentPromptOrigin(),
    );
    if (retrievalTurnId === null) return undefined;
    await runChildTurnToCompletion(child, signal);
    return parseNoriRetrievalQuery(lastAssistantText(child), maxResults);
  }

  private async waitForChildCompletion(
    parent: Agent,
    childId: string,
    child: Agent,
    profileName: string,
    options: RunSubagentOptions,
  ): Promise<SubagentCompletion> {
    await runChildTurnToCompletion(child, options.signal);
    await waitForNestedAgentWork(child, options.signal);

    // A subagent that returns an overly terse summary leaves the parent
    // agent under-informed. Give it a bounded number of chances to expand
    // the handoff; if it is still short after that, accept it as-is rather
    // than retrying indefinitely.
    let result = lastAssistantText(child);
    let remainingContinuations = SUMMARY_CONTINUATION_ATTEMPTS;
    while (remainingContinuations > 0 && result.length < SUMMARY_MIN_LENGTH) {
      remainingContinuations -= 1;
      options.signal.throwIfAborted();
      child.turn.prompt(
        [{ type: 'text', text: SUMMARY_CONTINUATION_PROMPT }],
        this.subagentPromptOrigin(),
      );
      await runChildTurnToCompletion(child, options.signal);
      result = lastAssistantText(child);
    }
    const usage = await this.accountChildUsage(childId, child);
    parent.emitEvent({
      type: 'subagent.completed',
      subagentId: childId,
      resultSummary: result,
      usage,
      contextTokens: child.context.tokenCount,
    });
    this.triggerSubagentStop(parent, profileName, result);
    if (typeof this.session.archiveCompletedSubagent === 'function') {
      await this.session.archiveCompletedSubagent(childId);
    }
    return { result, usage };
  }

  private rememberUsageBaseline(agentId: string, child: Agent): void {
    if (this.accountedUsageByAgent.has(agentId)) return;
    const usage = child.usage.data().total;
    if (usage !== undefined) this.accountedUsageByAgent.set(agentId, usage);
  }

  private async accountChildUsage(agentId: string, child: Agent): Promise<TokenUsage | undefined> {
    const cumulativeUsage = child.usage.data().total;
    const usage = usageDelta(cumulativeUsage, this.accountedUsageByAgent.get(agentId));
    if (usage !== undefined && usageTotal(usage) > 0) {
      const main = await this.session.ensureAgentResumed('main');
      main.usage.record(child.config.modelAlias ?? 'unknown', usage, 'session');
    }
    if (cumulativeUsage !== undefined) this.accountedUsageByAgent.set(agentId, cumulativeUsage);
    return usage;
  }

  private async configureChild(
    parent: Agent,
    child: Agent,
    profile: ResolvedAgentProfile,
  ): Promise<void> {
    // Custom profiles may pin a model; all other profiles inherit the parent model.
    child.config.update({
      cwd: parent.config.cwd,
      modelAlias: profile.modelAlias ?? parent.config.modelAlias,
      thinkingEffort: parent.config.thinkingEffort,
    });

    // Inherit coderWriteEnabled so the ReadonlyPermissionPolicy honors it.
    child.coderWriteEnabled = parent.coderWriteEnabled;

    const context = await prepareSystemPromptContext(
      this.session.systemContextKaos(child.kaos.getcwd()),
      this.session.options.kimiHomeDir,
      { additionalDirs: child.getAdditionalDirs(), customAgents: parent.kimiConfig?.customAgents },
    );
    child.useProfile(profile, context, this.session.options.kimiHomeDir);
    child.tools.inheritUserTools(parent.tools);

    // When coderWriteEnabled is true, grant the child agent auto permission
    // mode so coding agents don't require manual approval for every
    // tool call. Without this, FallbackAskPolicy blocks Write/Edit/Bash in
    // manual mode even when coderWriteEnabled bypasses ReadonlyPermissionPolicy.
    if (child.coderWriteEnabled) {
      child.permission.setMode('auto');
    }

    // Nori retrieval gate prompt, driven by runtime settings.
    const gate = this._noriRetrievalGate;
    const triggerMode = gate?.triggerMode ?? 'always';
    const maxResults = gate?.maxResults ?? 10;

    const triggerInstruction =
      triggerMode === 'always'
        ? 'This step is MANDATORY. You MUST output the retrieval query before any other work.'
        : triggerMode === 'on_keywords'
          ? 'Perform this step if the task contains technical keywords that may match existing notes.'
          : 'Perform this step to ensure you have the latest context from shared memory.';

    const retrievalGatePrompt = this._noriMemory === undefined
      ? ''
      : `
## Phase 0: Knowledge Retrieval

Before you begin, output a retrieval query to search the shared memory:

<retrieval_query>
{
  "keywords": ["specific", "technical", "terms"],
  "note_types": ["analysis", "decisions", "reviews"],
  "include_linked": true,
  "link_depth": 1,
  "chain_depth": 1,
  "follow_up_keywords": [["related", "second-hop", "terms"]],
  "max_results": ${maxResults}
}
</retrieval_query>

${triggerInstruction}

Wait for the system to inject <retrieved_context>, then continue with your task. If the injected
memory is incomplete, call nori_memory_search again with better keywords.
`;

    // Append Nori runtime context to the child system prompt.
    const currentPrompt = child.config.systemPrompt;
    const noriPrompt = retrievalGatePrompt;
    child.config.update({
      systemPrompt: currentPrompt + '\n\n' + noriPrompt,
    });
  }

  private async triggerSubagentStart(
    parent: Agent,
    profileName: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<void> {
    await parent.hooks?.trigger('SubagentStart', {
      matcherValue: profileName,
      signal,
      inputData: {
        agentName: profileName,
        prompt: prompt.slice(0, HOOK_TEXT_PREVIEW_LENGTH),
      },
    });
  }

  private triggerSubagentStop(parent: Agent, profileName: string, result: string): void {
    void parent.hooks?.fireAndForgetTrigger('SubagentStop', {
      matcherValue: profileName,
      inputData: {
        agentName: profileName,
        response: result.slice(0, HOOK_TEXT_PREVIEW_LENGTH),
      },
    });
  }

  private observeFirstRequest(
    child: Agent,
    options: RunSubagentOptions,
  ): void {
    if (options.onReady === undefined) return;
    void child.turn
      .waitForTurnFirstRequest()
      .then(() => {
        options.onReady?.();
      })
      .catch(() => {});
  }

  private emitSubagentSpawned(
    parent: Agent,
    childId: string,
    profileName: string,
    options: RunSubagentOptions,
  ): void {
    parent.emitEvent({
      type: 'subagent.spawned',
      subagentId: childId,
      subagentName: profileName,
      parentToolCallId: options.parentToolCallId,
      parentToolCallUuid: options.parentToolCallUuid,
      parentAgentId: this.ownerAgentId,
      description: options.description,
      subagentIndex: options.subagentIndex,
      runInBackground: options.runInBackground,
    });
    parent.telemetry.track('subagent_created', {
      subagent_name: profileName,
      run_in_background: options.runInBackground,
    });
  }

  private emitSubagentStarted(
    parent: Agent,
    childId: string,
  ): void {
    parent.emitEvent({
      type: 'subagent.started',
      subagentId: childId,
    });
  }

  private emitSubagentFailed(
    parent: Agent,
    childId: string,
    options: RunSubagentOptions,
    error: unknown,
  ): void {
    if (shouldSuppressQueuedAttemptFailureEvent(options, error)) return;
    parent.emitEvent({
      type: 'subagent.failed',
      subagentId: childId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface TeamDiscussionStatement {
  readonly agentId: string;
  readonly statement?: string;
  readonly skipped: boolean;
  readonly reason?: string;
}

export interface TeamVote {
  readonly agentId: string;
  readonly vote: 'discuss_again' | 'proceed' | 'abstain';
}

export interface TeamDiscussionResult {
  readonly discussionAgentId: string;
  readonly discussion: TeamDiscussionMeta;
  readonly statements: readonly TeamDiscussionStatement[];
  readonly votes: readonly TeamVote[];
}

function discussionRoundPrompt(
  unreadStatements: readonly TeamDiscussionStatementRecord[],
): string {
  const updates = unreadStatements
    .map(({ name, message }) => `${name}: ${message}`)
    .join('\n');
  return [
    'Your scheduled discussion turn has started.',
    'Call TeamSpeak with your concise final position. Not calling TeamSpeak records this turn as skipped (abstention); your reasoning stays private.',
    updates.length === 0 ? '' : `Unread shared statements:\n${updates}`,
  ].filter(Boolean).join('\n\n');
}

function discussionVotePrompt(
  unreadStatements: readonly TeamDiscussionStatementRecord[],
): string {
  const updates = unreadStatements
    .map(({ name, message }) => `${name}: ${message}`)
    .join('\n');
  return [
    'Your scheduled team vote turn has started.',
    updates.length === 0 ? '' : `Unread shared statements:\n${updates}`,
    'Reply with exactly one token: discuss_again, proceed, or abstain. Returning no vote is an abstention.',
  ].filter(Boolean).join('\n\n');
}

function parseTeamVote(text: string): TeamVote['vote'] {
  const normalized = text.trim().toLowerCase();
  if (normalized === 'discuss_again') return 'discuss_again';
  if (normalized === 'proceed') return 'proceed';
  return 'abstain';
}


function parseNoriRetrievalQuery(
  text: string,
  maxResults: number,
): NoriMemoryChainQuery | undefined {
  const queryText = extractRetrievalQueryText(text);
  if (queryText === undefined) return undefined;
  try {
    const raw = JSON.parse(stripJsonFence(queryText)) as unknown;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
    const parsed = NoriMemoryChainQuerySchema.safeParse(
      normalizeNoriRetrievalQuery(raw as Record<string, unknown>, maxResults),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function extractRetrievalQueryText(text: string): string | undefined {
  const match = text.match(/<retrieval_query>([\s\S]*?)<\/retrieval_query>/i);
  if (match?.[1] !== undefined) return match[1];
  const trimmed = text.trim();
  return trimmed.startsWith('{') && trimmed.endsWith('}') ? trimmed : undefined;
}

function normalizeNoriRetrievalQuery(
  raw: Record<string, unknown>,
  maxResults: number,
): Record<string, unknown> {
  const linkDepth = clampInteger(raw['link_depth'] ?? raw['link_traverse_depth'], 1, 0, 2);
  return {
    keywords: toStringArray(raw['keywords']),
    note_types: toStringArray(raw['note_types']),
    top_k: clampInteger(raw['top_k'] ?? raw['max_results'], maxResults, 1, 20),
    include_linked: booleanFromUnknown(raw['include_linked'], linkDepth > 0),
    link_depth: linkDepth,
    chain_depth: clampInteger(raw['chain_depth'] ?? raw['memory_chain_depth'], 1, 0, 3),
    follow_up_keywords: normalizeFollowUpKeywords(raw['follow_up_keywords']),
  };
}

function fallbackNoriMemoryQuery(
  prompt: string,
  maxResults: number,
): NoriMemoryChainQuery | undefined {
  const keywords = extractNoriMemoryKeywords(prompt, 8);
  if (keywords.length === 0) return undefined;
  const parsed = NoriMemoryChainQuerySchema.safeParse({
    keywords,
    note_types: ['analysis', 'decisions', 'reviews'],
    top_k: maxResults,
    include_linked: true,
    link_depth: 1,
    chain_depth: 1,
  });
  return parsed.success ? parsed.data : undefined;
}

function renderNoriRetrievedContext(result: NoriMemoryChainResult): string {
  const lines = [
    `<retrieved_context unique_count="${String(result.uniqueResults.length)}" hops="${String(result.hops.length)}">`,
    '<instruction>Use this shared memory as prior context. You may call nori_memory_search again with new keywords if needed.</instruction>',
  ];
  const renderedPaths = new Set<string>();
  for (const hop of result.hops) {
    lines.push(
      `<memory_hop index="${String(hop.index)}" source="${hop.source}" keywords="${escapeXmlAttribute(hop.keywords.join(', '))}">`,
    );
    for (const note of hop.results) {
      if (renderedPaths.has(note.path)) continue;
      renderedPaths.add(note.path);
      const score = note.score === undefined ? '' : ` score="${escapeXmlAttribute(note.score.toFixed(3))}"`;
      lines.push(
        `<note path="${escapeXmlAttribute(note.path)}"${score}>`,
        `<title>${escapeXmlText(note.title)}</title>`,
        `<content>${escapeXmlText(truncateForRetrievedContext(note.excerpt ?? note.content ?? ''))}</content>`,
        '</note>',
      );
    }
    lines.push('</memory_hop>');
  }
  lines.push('</retrieved_context>');
  return lines.join('\n');
}

function normalizeFollowUpKeywords(value: unknown): string[][] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.every((entry) => typeof entry === 'string')) {
    const keywords = toStringArray(value);
    if (keywords === undefined) return undefined;
    return keywords.length === 0 ? undefined : [keywords];
  }
  const normalized = value
    .filter((entry): entry is unknown[] => Array.isArray(entry))
    .map((entry) => toStringArray(entry))
    .filter((entry): entry is string[] => entry !== undefined && entry.length > 0);
  return normalized.length === 0 ? undefined : normalized;
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return strings.length === 0 ? undefined : strings;
}

function usageDelta(current: TokenUsage | undefined, previous: TokenUsage | undefined): TokenUsage | undefined {
  if (current === undefined) return undefined;
  if (previous === undefined) return { ...current };
  return {
    inputOther: Math.max(0, current.inputOther - previous.inputOther),
    output: Math.max(0, current.output - previous.output),
    inputCacheRead: Math.max(0, current.inputCacheRead - previous.inputCacheRead),
    inputCacheCreation: Math.max(0, current.inputCacheCreation - previous.inputCacheCreation),
  };
}

function usageTotal(usage: TokenUsage): number {
  return usage.inputOther + usage.output + usage.inputCacheRead + usage.inputCacheCreation;
}

function stripJsonFence(text: string): string {
  return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
}

function clampInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : Number.NaN;
  const integer = Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
  return Math.min(max, Math.max(min, integer));
}

function booleanFromUnknown(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
  }
  return fallback;
}

function truncateForRetrievedContext(text: string): string {
  const normalized = text.replaceAll(/\s+/g, ' ').trim();
  if (normalized.length <= 1200) return normalized;
  return `${normalized.slice(0, 1197)}...`;
}

function escapeXmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function wrapTeamDirectMessage(message: string): string {
  return `<system-reminder>\n${message.trim()}\n</system-reminder>`;
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replaceAll('"', '&quot;');
}

async function runChildTurnToCompletion(child: Agent, signal: AbortSignal): Promise<void> {
  const completion = await child.turn.waitForCurrentTurn(signal);
  const turnEnded = completion.event;
  if (turnEnded.reason !== 'completed') {
    if (turnEnded.reason === 'filtered') {
      throw new Error('Subagent turn blocked by provider safety policy');
    }
    if (turnEnded.error?.code === ErrorCodes.PROVIDER_RATE_LIMIT) {
      throw providerRateLimitErrorFromPayload(turnEnded.error);
    }
    throw new Error(
      turnEnded.error === undefined
        ? `Subagent turn ${turnEnded.reason}`
        : `[${turnEnded.error.code}] ${turnEnded.error.message}`,
    );
  }
  if (completion.stopReason === 'max_tokens') {
    throw new Error(`${SUBAGENT_MAX_TOKENS_ERROR}.`);
  }
}

async function waitForNestedAgentWork(child: Agent, signal: AbortSignal): Promise<void> {
  while (true) {
    signal.throwIfAborted();
    const activeAgentTasks = child.background.list(true).filter(task => task.kind === 'agent');
    if (activeAgentTasks.length > 0) {
      await Promise.all(activeAgentTasks.map(task => waitForBackgroundTask(child, task.taskId, signal)));
    }

    // Terminal notifications are delivered before BackgroundManager.wait resolves.
    // If a child is idle, steer() starts its wake-up turn immediately; if it was
    // still finishing, turnWorker starts the buffered reminder before settling.
    if (child.turn.hasActiveTurn) {
      await runChildTurnToCompletion(child, signal);
      continue;
    }
    if (child.background.list(true).some(task => task.kind === 'agent')) continue;
    return;
  }
}

async function waitForBackgroundTask(child: Agent, taskId: string, signal: AbortSignal): Promise<void> {
  while (true) {
    signal.throwIfAborted();
    const task = await child.background.wait(taskId, 250);
    if (task === undefined || isBackgroundTaskTerminal(task.status)) return;
  }
}

function providerRateLimitErrorFromPayload(error: KimiErrorPayload): APIProviderRateLimitError {
  const requestId =
    typeof error.details?.['requestId'] === 'string' ? error.details['requestId'] : null;
  return new APIProviderRateLimitError(error.message, requestId);
}

function lastAssistantText(agent: Agent): string {
  for (const message of [...agent.context.history].toReversed()) {
    if (message.role !== 'assistant') continue;
    const text = message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('');
    if (text.trim().length > 0) return text.trim();
  }
  return '';
}

function shouldSuppressQueuedAttemptFailureEvent(
  options: RunSubagentOptions,
  error: unknown,
): boolean {
  if (options.suppressRateLimitFailureEvent !== true) return false;
  if (isProviderRateLimitError(error)) return true;
  return isAbortError(error) || options.signal.aborted;
}
