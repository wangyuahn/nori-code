import {
  APIProviderRateLimitError,
  isProviderRateLimitError,
} from '@nori-code/kosong';

import type { Agent } from '../agent';
import { isBackgroundTaskTerminal } from '../agent/background';
import type { PromptOrigin } from '../agent/context';
import { DenyAllPermissionPolicy } from '../agent/permission/policies/deny-all';
import { InMemoryAgentRecordPersistence } from '../agent/records';
import { ErrorCodes, type KimiErrorPayload } from '../errors';
import { isAbortError } from '../loop/errors';
import type { PromptStartResult } from '../rpc';
import type {
  TeamStatusMember,
  TeamStatusResult,
} from '../tools/builtin/collaboration/team-status';
import {
  abortError,
  createDeadlineAbortSignal,
  linkAbortSignal,
  userCancellationReason,
} from '../utils/abort';
import type {
  Session,
  TeamAssignment,
  TeamDiscussionMeta,
  TeamDiscussionStatementRecord,
  TeamIdentity,
} from './index';
import TEAM_AGENT_EXECUTION_PROMPT from './team-agent-execution.md?raw';

export const DEFAULT_TEAM_DISCUSSION_MEMBER_TIMEOUT_MS = 2 * 60 * 1000;
export const DEFAULT_TEAM_DISCUSSION_FIRST_RESPONSE_TIMEOUT_MS = 10 * 1000;
const TEAM_DISCUSSION_CANCEL_SETTLE_GRACE_MS = 5_000;
const TEAM_DISCUSSION_MEMBER_MAX_TIMEOUT_MULTIPLIER = 3;

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

export interface SessionSubagentHostOptions {
  /** Maximum time a single member may occupy a scheduled Discuss turn. */
  readonly discussionMemberTimeoutMs?: number;
  /** Maximum time before a scheduled member must emit its first response event. */
  readonly discussionMemberFirstResponseTimeoutMs?: number;
}

export class SessionSubagentHost {
  private readonly discussionMemberTimeoutMs: number;
  private readonly discussionMemberFirstResponseTimeoutMs: number;

  constructor(
    private readonly session: Session,
    private readonly ownerAgentId: string,
    options: SessionSubagentHostOptions = {},
  ) {
    const timeout = options.discussionMemberTimeoutMs ?? DEFAULT_TEAM_DISCUSSION_MEMBER_TIMEOUT_MS;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new Error('discussionMemberTimeoutMs must be a positive finite number.');
    }
    this.discussionMemberTimeoutMs = timeout;
    const firstResponseTimeout =
      options.discussionMemberFirstResponseTimeoutMs ?? DEFAULT_TEAM_DISCUSSION_FIRST_RESPONSE_TIMEOUT_MS;
    if (!Number.isFinite(firstResponseTimeout) || firstResponseTimeout <= 0) {
      throw new Error('discussionMemberFirstResponseTimeoutMs must be a positive finite number.');
    }
    this.discussionMemberFirstResponseTimeoutMs = Math.min(firstResponseTimeout, timeout);
  }

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
    const requested = new Set(
      assignments.filter((assignment) => assignment.task !== null).map((assignment) => assignment.agentId),
    );
    const busy: string[] = [];
    for (const [agentId] of this.session.teamMemberMetadata(this.ownerAgentId)) {
      if (!requested.has(agentId)) continue;
      signal.throwIfAborted();
      const agent = await this.session.ensureAgentResumed(agentId);
      await waitForAgentCompaction(agent, signal);
      if (agent.turn.hasActiveTurn) busy.push(agentId);
    }
    if (busy.length > 0) {
      throw new Error(`TeamAssign cannot replace active member work: ${busy.join(', ')}.`);
    }

    const assigned = await this.session.assignTeamTasks(this.ownerAgentId, assignments);
    const unavailable = assigned.filter((assignment) => (
      assignment.task !== null && assignment.agent.turn.hasActiveTurn
    ));
    if (unavailable.length > 0) {
      await Promise.all(assigned.map(async (assignment) => {
        if (assignment.assignedAt === undefined) return;
        await this.session.releaseTeamAssignment(
          this.ownerAgentId,
          assignment.agentId,
          assignment.assignedAt,
        );
      }));
      throw new Error(
        `TeamAssign cannot replace active member work: ${unavailable.map(({ agentId }) => agentId).join(', ')}.`,
      );
    }
    const started: Array<{ readonly agentId: string; readonly task: string | null; readonly turnId?: number }> = [];
    const observedLeases = new Set<string>();
    try {
      for (const assignment of assigned) {
        signal.throwIfAborted();
        if (assignment.task === null) {
          started.push({ agentId: assignment.agentId, task: null });
          continue;
        }
        const assignedAt = assignment.assignedAt;
        if (assignedAt === undefined) {
          throw new Error(`Team member "${assignment.agentId}" is missing its assignment lease token.`);
        }
        const start = await startAgentPrompt(
          assignment.agent,
          [{
            type: 'text',
            text: `${assignment.task}\n\n${TEAM_AGENT_EXECUTION_PROMPT.trim()}`,
          }],
          this.teamLeadPromptOrigin(),
          signal,
        );
        if (start.kind !== 'started') {
          throw new Error(`Team member "${assignment.agentId}" could not start its assigned turn.`);
        }
        observedLeases.add(assignment.agentId);
        // A real prompt id always owns an active turn. Keep this guard for
        // lightweight transports/tests that stub prompt() without creating a
        // turn; there is no settlement to observe in that case.
        if (assignment.agent.turn.hasActiveTurn) {
          this.observeTeamAssignmentTurn(assignment.agentId, assignedAt, assignment.agent);
          this.session.notifyRunningTeamMember?.(assignment.agentId, assignedAt);
        }
        started.push({
          agentId: assignment.agentId,
          task: assignment.task,
          ...(start.turnId === undefined ? {} : { turnId: start.turnId }),
        });
      }
      return started;
    } catch (error) {
      await Promise.all(assigned.map(async (assignment) => {
        if (
          assignment.task === null
          || assignment.assignedAt === undefined
          || observedLeases.has(assignment.agentId)
        ) return;
        try {
          await this.session.releaseTeamAssignment(
            this.ownerAgentId,
            assignment.agentId,
            assignment.assignedAt,
          );
        } catch {
          // Preserve the original TeamAssign failure. A metadata write error
          // must not hide the prompt/abort reason that caused this cleanup.
        }
      }));
      throw error;
    }
  }

  private observeTeamAssignmentTurn(agentId: string, assignedAt: string, agent: Agent): void {
    void (async () => {
      try {
        await agent.turn.waitForCurrentTurn();
      } catch {
        // The write lease is tied to settlement, regardless of turn outcome.
      } finally {
        try {
          if (typeof this.session.notifyMissingTeamReport === 'function') {
            await this.session.notifyMissingTeamReport(agentId, assignedAt);
          }
          await this.session.releaseTeamAssignment(this.ownerAgentId, agentId, assignedAt);
        } catch {
          // Lease cleanup is fire-and-forget after a terminal turn. The
          // session's normal metadata/error path remains authoritative.
        }
      }
    })();
  }

  async broadcastTeam(message: string, signal: AbortSignal): Promise<readonly string[]> {
    const members = this.session.teamMemberMetadata(this.ownerAgentId);
    if (members.length === 0) throw new Error('Create a team before sending a broadcast.');
    await Promise.all(members.map(async ([agentId]) => {
      signal.throwIfAborted();
      const agent = await this.session.ensureAgentResumed(agentId);
      await waitForAgentCompaction(agent, signal);
      const input = [{ type: 'text' as const, text: message }];
      if (agent.turn.hasActiveTurn) {
        agent.turn.steer(input, this.teamLeadPromptOrigin());
        return;
      }
      const start = await startAgentPrompt(agent, input, this.teamLeadPromptOrigin(), signal);
      if (start.kind === 'busy') {
        agent.turn.steer(input, this.teamLeadPromptOrigin());
        return;
      }
      // Nothing is carrying the broadcast for this member. A broadcast is
      // best-effort across the whole team, so one member that could not be woken
      // is skipped rather than failing the other members' deliveries.
      if (start.kind === 'unstarted') return;
      await runAgentTurnToCompletion(agent, signal);
    }));
    return members.map(([agentId]) => agentId);
  }

  async directMessage(
    targetAgentId: string,
    message: string,
    signal: AbortSignal,
    report?: { readonly status: 'completed' | 'blocked' | 'needs_decision'; readonly summary: string },
  ): Promise<TeamDirectMessageDelivery> {
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
    const reportToParent = report;
    if (reportToParent !== undefined) {
      if (this.ownerAgentId === leaderAgentId || !targetIsLead) {
        throw new Error('Team reports must be sent by a Team Agent to its direct parent.');
      }
      await this.session.recordTeamReport(this.ownerAgentId, reportToParent.status, reportToParent.summary);
    }
    const recipient = await this.session.ensureAgentResumed(targetAgentId);
    // TeamDM is an internal prompt transport. Keep it in the recipient's
    // model context, but tag it distinctly so transcript projections can
    // avoid rendering it as a normal user/Discuss message after refresh.
    const origin = this.teamDirectMessagePromptOrigin(
      this.ownerAgentId === leaderAgentId ? undefined : sender,
      this.ownerAgentId === leaderAgentId ? leaderAgentId : this.ownerAgentId,
      this.ownerAgentId === leaderAgentId ? 'lead' : 'team',
    );
    const input = [{
      type: 'text' as const,
      text: wrapTeamDirectMessage(
        reportToParent === undefined
          ? message
          : `[TeamDM report: ${reportToParent.status}]\n${message}\nReport summary: ${reportToParent.summary}`,
      ),
    }];
    await waitForAgentCompaction(recipient, signal);
    const recipientBusy = recipient.turn.hasActiveTurn;
    if (recipientBusy) {
      recipient.turn.steer(input, origin);
      if (reportToParent !== undefined) {
        void runAgentTurnToCompletion(recipient)
          .then(() => this.session.acknowledgeTeamReport(this.ownerAgentId))
          .catch(() => undefined);
      }
      return { delivered: true, processing: 'queued' };
    }
    const start = await startAgentPrompt(recipient, input, origin, signal);
    if (start.kind === 'busy') {
      recipient.turn.steer(input, origin);
      if (reportToParent !== undefined) {
        void runAgentTurnToCompletion(recipient)
          .then(() => this.session.acknowledgeTeamReport(this.ownerAgentId))
          .catch(() => undefined);
      }
      return { delivered: true, processing: 'queued' };
    }
    // An idle recipient that never launched a turn has nothing to steer into and
    // nothing that will pick the message up later. Reporting delivery here is the
    // lie that made TeamDM look like it woke a member when it had not.
    if (start.kind === 'unstarted') {
      throw new Error(`TeamDM target "${targetAgentId}" could not start a turn.`);
    }
    await runAgentTurnToCompletion(recipient, signal);
    if (reportToParent !== undefined) {
      await this.session.acknowledgeTeamReport(this.ownerAgentId);
    }
    return { delivered: true, processing: 'completed' };
  }

  async getTeamStatus(): Promise<TeamStatusResult> {
    const directMembers = this.session.teamMemberMetadata(this.ownerAgentId);
    const members: TeamStatusMember[] = [];
    for (const [agentId, meta] of directMembers) {
      const agent = await this.session.ensureAgentResumed(agentId);
      members.push({
        agent_id: agentId,
        name: meta.name ?? null,
        role: meta.role ?? null,
        mandate: meta.mandate ?? null,
        status: agent.turn.hasActiveTurn ? 'running' : 'idle',
        assigned_task: meta.assignedTask ?? meta.teamReport?.task ?? null,
        report_status: meta.teamReport?.status ?? null,
        report_summary: meta.teamReport?.summary ?? null,
        report_received: meta.teamReport?.receivedAt !== undefined,
      });
      if (agent.turn.hasActiveTurn && meta.assignedAt !== undefined) {
        this.session.notifyRunningTeamMember(agentId, meta.assignedAt);
      }
    }
    return {
      agent_id: this.ownerAgentId,
      member_count: members.length,
      message: members.length === 0
        ? 'No direct persistent Team Agents.'
        : 'Direct persistent Team Agent status.',
      members,
    };
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
      await this.appendDiscussionEvent(
        created.id,
        `讨论已开始：${discussionTopic}`,
        this.teamDiscussionLifecycleOrigin(`${created.discussion.startedAt}:started`),
      );
      await this.notifyDiscussionLifecycle(created.discussion, created.discussion.participantAgentIds, 'started');
      active = [created.id, this.session.getAgentMetadata(created.id)!];
    }
    if (active === undefined) throw new Error('There is no active team discussion. Start one first.');
    if (action === 'continue' && typeof this.session.ensureTeamDiscussionMode === 'function') {
      await this.session.ensureTeamDiscussionMode(this.ownerAgentId);
    }
    const activeDiscussion = active[1].discussion;
    if (activeDiscussion === undefined) {
      throw new Error('The active team discussion metadata is unavailable.');
    }
    if (action === 'archive') {
      // Archiving closes the execution/discussion lifecycle. Revoke any
      // TeamAssign write lease so an idle member cannot keep editing through
      // its sub-session after the discussion has formally ended.
      await this.lockTeamWritesForDiscuss();
      const discussion = await this.session.updateTeamDiscussion(active[0], {
        participantAgentIds: activeDiscussion.participantAgentIds,
        status: 'archived',
        topic: activeDiscussion.topic,
      });
      await this.appendDiscussionEvent(
        active[0],
        `讨论已结束并归档：${discussion.topic}`,
        this.teamDiscussionLifecycleOrigin(`${discussion.startedAt}:ended`),
      );
      await this.notifyDiscussionLifecycle(discussion, Object.keys(discussion.readCursors ?? {}), 'ended');
      return { discussionAgentId: active[0], discussion, statements: [], votes: [] };
    }
    if (action === 'vote') {
      return this.runTeamVote(active[0], activeDiscussion, signal);
    }
    let scheduledAgentIds: readonly string[] | undefined;
    if (action === 'start') {
      scheduledAgentIds = activeDiscussion.participantAgentIds;
    } else if (participantAgentIds !== undefined) {
      const participants = new Set(activeDiscussion.participantAgentIds);
      const unique = new Set(participantAgentIds);
      if (unique.size !== participantAgentIds.length || participantAgentIds.some((id) => !participants.has(id))) {
        throw new Error('participant_agent_ids must be distinct active discussion participants.');
      }
      scheduledAgentIds = participantAgentIds;
    }
    const targetedRetry = action === 'continue' && participantAgentIds !== undefined;
    return this.runTeamDiscussionRound(
      active[0],
      activeDiscussion,
      signal,
      statement,
      scheduledAgentIds,
      !targetedRetry,
    );
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

  private async appendDiscussionEvent(
    discussionAgentId: string,
    text: string,
    origin: PromptOrigin,
  ): Promise<void> {
    const transcript = await this.session.ensureAgentResumed(discussionAgentId);
    transcript.context.appendUserMessage([{ type: 'text', text }], origin);
    const kind = origin.kind === 'system_trigger' && origin.name === 'team_discussion_round'
      ? 'round'
      : origin.kind === 'system_trigger' && origin.name === 'team_discussion_skip'
        ? 'skip'
        : origin.kind === 'system_trigger' && origin.name === 'team_discussion_vote'
          ? 'vote'
          : 'lifecycle';
    transcript.emitEvent({
      type: 'discussion.updated',
      discussionAgentId,
      kind,
    });
  }

  private async appendDiscussionSkip(
    discussionAgentId: string,
    memberName: string,
    reason = 'abstain',
    detail?: string,
  ): Promise<void> {
    const suffix = detail === undefined ? '' : `：${detail}`;
    await this.appendDiscussionEvent(
      discussionAgentId,
      `${memberName} 跳过本轮（弃权${reason === 'abstain' ? '' : `：${reason}`}${suffix}）`,
      {
        kind: 'system_trigger',
        name: 'team_discussion_skip',
        discussionSkipReason: reason,
        speaker: { from: 'team', speakerName: memberName },
      },
    );
  }

  private async appendDiscussionVote(
    discussionAgentId: string,
    agentId: string,
    vote: TeamVote['vote'],
  ): Promise<void> {
    const memberName = this.session.getAgentMetadata(agentId)?.name ?? '团队成员';
    await this.appendDiscussionEvent(
      discussionAgentId,
      `${memberName} 投票：${vote}`,
      {
        kind: 'system_trigger',
        name: 'team_discussion_vote',
        speaker: { from: 'team', speakerId: agentId, speakerName: memberName },
      },
    );
  }

  private async appendDiscussionToolErrors(
    discussionAgentId: string,
    agentId: string,
    errors: readonly DiscussionToolError[],
  ): Promise<void> {
    if (errors.length === 0) return;
    const memberName = this.session.getAgentMetadata(agentId)?.name ?? '团队成员';
    for (const error of errors) {
      await this.appendDiscussionEvent(
        discussionAgentId,
        `${memberName} 的 ${error.toolName} 失败：${error.message}`,
        {
          kind: 'system_trigger',
          name: 'team_discussion_tool_error',
          discussionToolName: error.toolName,
          speaker: { from: 'team', speakerId: agentId, speakerName: memberName },
        },
      );
    }
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
    scheduledAgentIds?: readonly string[],
    publishLeadStatement = true,
  ): Promise<TeamDiscussionResult> {
    const round = (discussion.round ?? 0) + 1;
    const updatedDiscussion = typeof this.session.updateTeamDiscussion === 'function'
      ? await this.session.updateTeamDiscussion(discussionAgentId, {
        participantAgentIds: discussion.participantAgentIds,
        status: discussion.status,
        topic: discussion.topic,
        round,
      })
      : { ...discussion, round };
    await this.appendDiscussionEvent(
      discussionAgentId,
      `第 ${String(round)} 轮讨论开始`,
      this.teamDiscussionRoundOrigin(round),
    );
    const statements: TeamDiscussionStatement[] = [];
    const leadStatement = statement?.trim();
    // A targeted retry carries a routing instruction rather than a new shared
    // lead statement. The initial round may also specify participants, but its
    // lead statement must still be published before the first member turn.
    if (leadStatement && publishLeadStatement) {
      if (typeof this.session.publishLeadDiscussionStatement === 'function') {
        await this.session.publishLeadDiscussionStatement(this.ownerAgentId, leadStatement);
      }
      statements.push({ agentId: this.ownerAgentId, statement: leadStatement, skipped: false });
    }
    for (const agentId of scheduledAgentIds ?? discussion.participantAgentIds) {
      signal.throwIfAborted();
      const meta = this.session.getAgentMetadata(agentId);
      if (meta?.kind !== 'team') continue;
      const participant = await this.session.ensureAgentResumed(agentId);
      let historyStart = participant.context?.history.length ?? 0;
      let sent: TeamDiscussionStatementRecord | undefined;
      let failure: unknown;
      let cancelDiscussion = false;
      try {
        // A member may still be finishing an assigned execution turn. Wait that
        // turn out instead of reading a status flag and abstaining on the
        // member's behalf — but cap the wait, so one wedged member is skipped
        // (and its turn cancelled) rather than stalling the whole round.
        await waitForAgentAvailabilityWithTimeout(
          participant,
          signal,
          this.discussionMemberTimeoutMs,
        );
        historyStart = participant.context?.history.length ?? 0;
        const unread = await this.session.unreadTeamDiscussionStatements(discussionAgentId, agentId);
        this.session.beginTeamDiscussionTurn(discussionAgentId, agentId);
        let acknowledged = false;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (attempt > 0) signal.throwIfAborted();
          await startScheduledAgentPrompt(
            participant,
            [{ type: 'text', text: discussionRoundPrompt(unread.statements) }],
            this.teamLeadPromptOrigin(),
            signal,
            this.discussionMemberTimeoutMs,
          );
          // Mark messages as read only after this agent accepted the turn. That
          // prevents a rejected prompt from silently losing an unread update,
          // while keeping accepted messages from being replayed into its cache.
          if (!acknowledged) {
            await this.session.acknowledgeTeamDiscussionStatements(discussionAgentId, agentId, unread.cursor);
            acknowledged = true;
          }
          try {
            await runDiscussionMemberTurn(
              participant,
              signal,
              this.discussionMemberTimeoutMs,
              this.discussionMemberFirstResponseTimeoutMs,
            );
          } catch (error) {
            sent = this.session.consumeTeamDiscussionSpeak(discussionAgentId, agentId);
            if (sent !== undefined) break;
            if (
              error instanceof DiscussionNoResponseError
              && attempt === 0
              && !signal.aborted
            ) {
              continue;
            }
            failure = error instanceof DiscussionNoResponseError && attempt > 0
              ? new DiscussionNoResponseError(this.discussionMemberFirstResponseTimeoutMs, true)
              : error;
            break;
          }
          sent = this.session.consumeTeamDiscussionSpeak(discussionAgentId, agentId);
          break;
        }
        if (sent === undefined && failure === undefined) {
          sent = this.session.consumeTeamDiscussionSpeak(discussionAgentId, agentId);
        }
      } catch (error) {
        failure = error;
      } finally {
        const toolErrors = collectDiscussionToolErrors(participant, historyStart);
        await this.appendDiscussionToolErrors(discussionAgentId, agentId, toolErrors);
        this.session.endTeamDiscussionTurn(discussionAgentId, agentId);
        if (sent !== undefined) {
          statements.push({
            agentId,
            statement: sent.message,
            skipped: false,
            ...(toolErrors.length > 0 ? { toolErrors } : {}),
          });
        } else if (failure !== undefined && signal.aborted) {
          cancelDiscussion = true;
        } else if (failure !== undefined) {
          const reason = failure instanceof DiscussionNoResponseError
            ? failure.reason
            : failure instanceof DiscussionTurnTimeoutError
              ? 'timeout'
              : isAbortError(failure)
                ? 'cancelled'
              : toolErrors.length > 0
                ? 'tool_failed'
                : 'failed';
          const detail = failure instanceof DiscussionNoResponseError || failure instanceof DiscussionTurnTimeoutError
            ? failure.message
            : discussionFailureDetail(failure, toolErrors);
          const skipped = {
            agentId,
            skipped: true,
            reason,
            error: detail,
            ...(toolErrors.length > 0 ? { toolErrors } : {}),
          };
          statements.push(skipped);
          await this.appendDiscussionSkip(discussionAgentId, meta.name ?? '团队成员', reason, detail);
        } else {
          const detail = toolErrors.length > 0 ? discussionToolErrorText(toolErrors) : undefined;
          const reason = detail === undefined ? 'abstain' : 'tool_failed';
          const skipped = {
            agentId,
            skipped: true,
            ...(detail === undefined ? {} : { reason, error: detail, toolErrors }),
          };
          statements.push(skipped);
          await this.appendDiscussionSkip(discussionAgentId, meta.name ?? '团队成员', reason, detail);
        }
      }
      if (cancelDiscussion) throw signal.reason;
    }
    return { discussionAgentId, discussion: updatedDiscussion, statements, votes: [] };
  }

  private async runTeamVote(
    discussionAgentId: string,
    discussion: TeamDiscussionMeta,
    signal: AbortSignal,
  ): Promise<TeamDiscussionResult> {
    const voters = discussion.participantAgentIds.map((agentId) =>
      [agentId, this.session.getAgentMetadata(agentId)] as const,
    );
    const activeVoterIds: string[] = [];
    for (const [agentId] of voters) {
      const participant = await this.session.ensureAgentResumed(agentId);
      // A pure precondition read: a member still executing an assigned turn means
      // "come back later", so this must not wait on compaction first. The per-voter
      // loop below does the real availability wait.
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
      // One deadline covers waiting the member out, claiming its turn, and the
      // vote turn itself, so a member that never frees its turn abstains instead
      // of failing the whole vote — and its wedged turn is cancelled on the way.
      const deadline = createDeadlineAbortSignal(signal, this.discussionMemberTimeoutMs);
      let vote: TeamVote['vote'];
      try {
        await waitForAgentAvailability(participant, deadline.signal);
        // Voting is a scheduled participant turn too. Deliver only this
        // participant's unread statement suffix, then acknowledge it only after
        // the prompt was accepted so a failed vote can retry without losing
        // discussion context.
        const unread = await this.session.unreadTeamDiscussionStatements(discussionAgentId, agentId);
        await startScheduledAgentPrompt(
          participant,
          [{ type: 'text', text: discussionVotePrompt(unread.statements) }],
          this.teamLeadPromptOrigin(),
          deadline.signal,
        );
        await this.session.acknowledgeTeamDiscussionStatements(discussionAgentId, agentId, unread.cursor);
        await runDiscussionChildTurnToCompletion(participant, deadline.signal);
        vote = parseTeamVote(lastAssistantText(participant));
      } catch (error) {
        // A session-level cancel must not be laundered into an abstention.
        if (signal.aborted) throw signal.reason;
        void error;
        vote = 'abstain';
      } finally {
        deadline.clear();
      }
      votes.push({ agentId, vote });
      await this.appendDiscussionVote(discussionAgentId, agentId, vote);
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

  private teamDiscussionRoundOrigin(round: number): PromptOrigin {
    return {
      kind: 'system_trigger',
      name: 'team_discussion_round',
      discussionRound: round,
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

  private teamDirectMessagePromptOrigin(
    sender: { readonly name?: string } | undefined,
    speakerId: string,
    from: 'lead' | 'team',
  ): PromptOrigin {
    return {
      kind: 'system_trigger',
      name: 'team_dm',
      speaker: {
        from,
        speakerId,
        speakerName: from === 'lead' ? '主代理' : sender?.name ?? '团队成员',
      },
    };
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
        speaker: { from: 'sub', speakerId: childId, speakerName: 'Team member' },
      },
    );

    if (turnId === null) {
      throw new Error('Could not start ask-parent turn for the parent agent');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('askParent timed out')), ASK_PARENT_TIMEOUT_MS);

    try {
      await runAgentTurnToCompletion(answerer, controller.signal);
      return lastAssistantText(answerer);
    } finally {
      clearTimeout(timeout);
    }
  }

}

export interface TeamDiscussionStatement {
  readonly agentId: string;
  readonly statement?: string;
  readonly skipped: boolean;
  readonly reason?: string;
  readonly error?: string;
  readonly toolErrors?: readonly DiscussionToolError[];
}

export interface DiscussionToolError {
  readonly toolName: string;
  readonly message: string;
}

export interface TeamDirectMessageDelivery {
  /** The message was accepted by the recipient turn queue. */
  readonly delivered: true;
  /** Whether the recipient processed it now or will process it in its active turn. */
  readonly processing: 'completed' | 'queued';
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


function wrapTeamDirectMessage(message: string): string {
  return `<system-reminder>\n${message.trim()}\n</system-reminder>`;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Compaction defers new prompts, so it is the first thing a scheduler waits out. */
async function waitForAgentCompaction(agent: Agent, signal: AbortSignal): Promise<void> {
  await agent.fullCompaction.waitForCompletion(signal);
}

/**
 * Waits until `agent` can accept a fresh prompt: no compaction in flight and no
 * active turn. Team schedulers use this instead of reading a status flag, because
 * the flag can lag the turn lifecycle and would make a member look permanently
 * busy. The loop re-checks both conditions because a completing turn may itself
 * trigger compaction, and a steered turn may roll straight into another one.
 */
async function waitForAgentAvailability(agent: Agent, signal: AbortSignal): Promise<void> {
  await waitForAgentCompaction(agent, signal);
  while (agent.turn.hasActiveTurn) {
    try {
      await agent.turn.waitForCurrentTurn(signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      // The turn ended by failing or was already gone; either way availability
      // is what we are after, so only a still-active turn is a real error.
      if (agent.turn.hasActiveTurn) throw error;
    }
    await waitForAgentCompaction(agent, signal);
  }
}

type AgentPromptStart =
  | { readonly kind: 'started'; readonly turnId: number }
  /**
   * Another turn already holds the agent and this input was dropped. The agent is
   * alive and working, so steering the input into the running turn is the correct
   * recovery — never an error.
   */
  | { readonly kind: 'busy'; readonly activeTurnId: number }
  /**
   * Nothing is carrying this input: compaction deferred it and no turn had
   * launched by the time compaction finished. There is no running turn to steer
   * into and nothing will pick it up, so a caller must not claim delivery.
   */
  | { readonly kind: 'unstarted' };

/**
 * Starts one agent turn without collapsing `busy` and compaction-deferred into
 * the old `null` result. A deferred prompt is already buffered by the turn, so
 * it is waited through rather than submitted a second time.
 */
async function startAgentPrompt(
  agent: Agent,
  input: Parameters<Agent['turn']['requestPrompt']>[0],
  origin: PromptOrigin,
  signal: AbortSignal,
): Promise<AgentPromptStart> {
  signal.throwIfAborted();
  await waitForAgentCompaction(agent, signal);
  const start: PromptStartResult = agent.turn.requestPrompt(input, origin);
  if (start.status === 'started') return { kind: 'started', turnId: start.turnId };
  if (start.status === 'busy') return { kind: 'busy', activeTurnId: start.activeTurnId };
  // `deferred` means compaction took the prompt to replay once it finishes.
  await waitForAgentCompaction(agent, signal);
  if (!agent.turn.hasActiveTurn) return { kind: 'unstarted' };
  return { kind: 'started', turnId: agent.turn.currentId };
}

/**
 * Waits for `agent` to go idle and then starts a turn, returning its id. This is
 * how scheduled team work (a discussion round, a vote) claims a member: one that
 * is momentarily busy gets waited for instead of being recorded as an
 * abstention. `timeoutMs` bounds the wait *and* the retries, so a member that
 * keeps re-arming a turn cannot livelock the scheduler.
 */
async function startScheduledAgentPrompt(
  agent: Agent,
  input: Parameters<Agent['turn']['requestPrompt']>[0],
  origin: PromptOrigin,
  signal: AbortSignal,
  timeoutMs?: number,
): Promise<number> {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return startAgentPromptWhenIdle(agent, input, origin, signal);
  }
  const deadline = createDeadlineAbortSignal(signal, timeoutMs);
  try {
    return await startAgentPromptWhenIdle(agent, input, origin, deadline.signal);
  } catch (error) {
    if (deadline.timedOut() && !signal.aborted) throw new DiscussionTurnTimeoutError(timeoutMs);
    throw error;
  } finally {
    deadline.clear();
  }
}

async function startAgentPromptWhenIdle(
  agent: Agent,
  input: Parameters<Agent['turn']['requestPrompt']>[0],
  origin: PromptOrigin,
  signal: AbortSignal,
): Promise<number> {
  while (true) {
    await waitForAgentAvailability(agent, signal);
    const start = await startAgentPrompt(agent, input, origin, signal);
    if (start.kind === 'started') return start.turnId;
    // `busy` means the agent re-armed a turn in the gap after the availability
    // wait, so looping is real progress. `unstarted` means it accepted nothing at
    // all — retrying would spin against a member that cannot be woken, so it is
    // reported and the caller records a skip.
    if (start.kind === 'unstarted') {
      throw new Error('Agent accepted no turn for the scheduled prompt.');
    }
  }
}

async function waitForAgentAvailabilityWithTimeout(
  agent: Agent,
  signal: AbortSignal,
  timeoutMs?: number,
): Promise<void> {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    await waitForAgentAvailability(agent, signal);
    return;
  }
  const deadline = createDeadlineAbortSignal(signal, timeoutMs);
  try {
    await waitForAgentAvailability(agent, deadline.signal);
  } catch (error) {
    // The deadline cancels the member's in-flight turn on the way out, which is
    // how a wedged turn's lease gets reclaimed. Report it as a timeout so the
    // caller records a `timeout` skip rather than an opaque abort.
    if (deadline.timedOut() && !signal.aborted) {
      throw new DiscussionTurnTimeoutError(timeoutMs);
    }
    throw error;
  } finally {
    deadline.clear();
  }
}

/** Wait for `agent`'s current turn and translate a non-completed outcome into a throw. */
async function runAgentTurnToCompletion(agent: Agent, signal?: AbortSignal): Promise<void> {
  const completion = await agent.turn.waitForCurrentTurn(signal);
  const turnEnded = completion.event;
  if (turnEnded.reason !== 'completed') {
    if (turnEnded.reason === 'cancelled') {
      throw abortError('Member turn was cancelled.');
    }
    if (turnEnded.reason === 'filtered') {
      throw new Error('Member turn blocked by provider safety policy.');
    }
    if (turnEnded.error?.code === ErrorCodes.PROVIDER_RATE_LIMIT) {
      throw providerRateLimitErrorFromPayload(turnEnded.error);
    }
    throw new Error(
      turnEnded.error === undefined
        ? `Member turn ${turnEnded.reason}`
        : `[${turnEnded.error.code}] ${turnEnded.error.message}`,
    );
  }
  if (completion.stopReason === 'max_tokens') {
    throw new Error('Member turn hit the output token limit before finishing.');
  }
}

class DiscussionNoResponseError extends Error {
  readonly reason = 'no_response' as const;

  constructor(timeoutMs: number, retryExhausted: boolean) {
    super(
      retryExhausted
        ? `Member discussion turn produced no text, tool call, or response event within ${timeoutMs}ms; retry exhausted (timeout/no_response).`
        : `Member discussion turn produced no text, tool call, or response event within ${timeoutMs}ms; retrying once.`,
    );
    this.name = 'DiscussionNoResponseError';
  }
}

class DiscussionTurnTimeoutError extends Error {
  readonly reason = 'timeout' as const;

  constructor(timeoutMs: number, hardLimit = false) {
    super(
      hardLimit
        ? `Member discussion turn exceeded its maximum duration of ${timeoutMs}ms.`
        : `Member discussion turn timed out after ${timeoutMs}ms.`,
    );
    this.name = 'DiscussionTurnTimeoutError';
  }
}

async function runDiscussionMemberTurn(
  child: Agent,
  parentSignal: AbortSignal,
  fullTimeoutMs: number,
  firstResponseTimeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  const unlinkParentSignal = linkAbortSignal(parentSignal, controller);
  let activityTimedOut = false;
  let hardTimedOut = false;
  let firstResponseTimedOut = false;
  let firstResponseTimer: ReturnType<typeof setTimeout> | undefined;
  let activityTimer: ReturnType<typeof setTimeout> | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  let firstResponseObserved = false;
  let fullPhaseStarted = false;
  const completion = runDiscussionChildTurnToCompletion(child, controller.signal);
  void completion.catch(() => undefined);

  // Lightweight test transports may not expose this internal turn signal. The
  // production Agent does, so only the production path gets the shorter first
  // response deadline.
  const waitForFirstResponse = typeof child.turn.waitForTurnFirstRequest === 'function'
    ? child.turn.waitForTurnFirstRequest()
    : undefined;
  const firstResponse = waitForFirstResponse?.then(() => {
    firstResponseObserved = true;
  });
  const maxDurationMs = fullTimeoutMs * TEAM_DISCUSSION_MEMBER_MAX_TIMEOUT_MULTIPLIER;
  const clearActivityTimer = (): void => {
    if (activityTimer !== undefined) {
      clearTimeout(activityTimer);
      activityTimer = undefined;
    }
  };
  const armActivityTimer = (): void => {
    clearActivityTimer();
    if (!fullPhaseStarted) return;
    activityTimer = setTimeout(() => {
      activityTimer = undefined;
      activityTimedOut = true;
      controller.abort(abortError());
    }, fullTimeoutMs);
  };
  const unsubscribeProgress = typeof child.turn.onTurnProgress === 'function'
    ? child.turn.onTurnProgress(() => {
      if (fullPhaseStarted) armActivityTimer();
    })
    : undefined;

  try {
    // The hard cap starts with the member turn and bounds a stream of
    // continuous progress. The normal full-turn deadline is an inactivity
    // deadline and starts only after the first response event.
    hardTimer = setTimeout(() => {
      hardTimer = undefined;
      hardTimedOut = true;
      controller.abort(abortError());
    }, maxDurationMs);
    if (firstResponse !== undefined) {
      const firstResponseTimeout = new Promise<never>((_, reject) => {
        firstResponseTimer = setTimeout(() => {
          firstResponseTimedOut = true;
          controller.abort(abortError());
          reject(new DiscussionNoResponseError(firstResponseTimeoutMs, false));
        }, firstResponseTimeoutMs);
      });
      await Promise.race([completion, firstResponse, firstResponseTimeout]);
      if (!firstResponseObserved) {
        await completion;
        throw new DiscussionNoResponseError(firstResponseTimeoutMs, false);
      }
      if (firstResponseTimer !== undefined) clearTimeout(firstResponseTimer);
    }
    fullPhaseStarted = true;
    armActivityTimer();
    await completion;
  } catch (error) {
    // Always wait for the cancelled attempt to settle before the caller can
    // launch a retry; otherwise the old turn can become a zombie TeamSpeak
    // publisher or race the new turn for the same qualification.
    if (firstResponseTimedOut || activityTimedOut || hardTimedOut) {
      await completion.catch(() => undefined);
      if (firstResponseTimedOut) {
        throw new DiscussionNoResponseError(firstResponseTimeoutMs, false);
      }
      throw new DiscussionTurnTimeoutError(
        hardTimedOut ? maxDurationMs : fullTimeoutMs,
        hardTimedOut,
      );
    }
    throw error;
  } finally {
    if (firstResponseTimer !== undefined) clearTimeout(firstResponseTimer);
    clearActivityTimer();
    if (hardTimer !== undefined) clearTimeout(hardTimer);
    unsubscribeProgress?.();
    unlinkParentSignal();
  }
}

/**
 * A cancelled parent wait must not release the discussion lease while the child
 * turn is still settling. The member may have an in-flight tool result and can
 * still publish TeamSpeak before its turn actually ends.
 */
async function runDiscussionChildTurnToCompletion(child: Agent, signal: AbortSignal): Promise<void> {
  try {
    await runAgentTurnToCompletion(child, signal);
  } catch (error) {
    if (signal.aborted && child.turn.hasActiveTurn) {
      // waitForCurrentTurn(signal) has already cancelled the child. Give the
      // provider/tool worker a bounded grace period to settle, then release the
      // Discuss scheduler so one uncooperative provider cannot deadlock every
      // later participant.
      await Promise.race([
        runAgentTurnToCompletion(child).catch(() => undefined),
        new Promise<void>((resolve) => {
          setTimeout(resolve, TEAM_DISCUSSION_CANCEL_SETTLE_GRACE_MS);
        }),
      ]);
    }
    throw error;
  }
}

function collectDiscussionToolErrors(
  agent: Agent,
  historyStart: number,
): DiscussionToolError[] {
  const toolNames = new Map<string, string>();
  const history = agent.context?.history ?? [];
  for (const message of history.slice(historyStart)) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls) toolNames.set(call.id, call.name);
  }
  const errors: DiscussionToolError[] = [];
  for (const message of history.slice(historyStart)) {
    if (
      message.role !== 'tool'
      || message.isError !== true
      || message.toolCallId === undefined
    ) continue;
    const text = message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .replace(/^\s*<system>ERROR:[\s\S]*?<\/system>\s*/i, '')
      .trim();
    errors.push({
      toolName: toolNames.get(message.toolCallId) ?? 'Tool',
      message: text || 'Tool execution failed without an error message.',
    });
  }
  return errors;
}

function discussionToolErrorText(errors: readonly DiscussionToolError[]): string {
  return errors.map((error) => `${error.toolName}: ${error.message}`).join('\n');
}

function discussionFailureDetail(error: unknown, toolErrors: readonly DiscussionToolError[]): string {
  const turnError = error instanceof Error ? error.message : String(error);
  const toolErrorText = discussionToolErrorText(toolErrors);
  if (toolErrorText.length === 0) return turnError;
  if (turnError.length === 0 || toolErrorText.includes(turnError)) return toolErrorText;
  return `${turnError}\n${toolErrorText}`;
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
