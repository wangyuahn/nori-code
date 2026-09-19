import {
  APIProviderRateLimitError,
} from '@nori-code/kosong';

import type { Agent } from '../agent';
import type { PromptOrigin } from '../agent/context';
import { DenyAllPermissionPolicy } from '../agent/permission/policies/deny-all';
import { InMemoryAgentRecordPersistence } from '../agent/records';
import { ErrorCodes, type KimiErrorPayload } from '../errors';
import { isAbortError } from '../loop/errors';
import type { PromptStartResult } from '../rpc';
import type {
  TeamStatusColleague,
  TeamStatusMember,
  TeamStatusResult,
} from '../tools/builtin/collaboration/team-status';
import {
  abortError,
  linkAbortSignal,
} from '../utils/abort';
import type {
  Session,
  TeamAssignment,
  TeamChatMessageRecord,
  TeamDiscussionMeta,
  TeamDiscussionStatementRecord,
  TeamIdentity,
} from './index';
import TEAM_AGENT_EXECUTION_PROMPT from './team-agent-execution.md?raw';
import { directMessageRelation } from './team-tree';
import { validateTeamChatMentions } from './team-chat';

const TEAM_DISCUSSION_CANCEL_SETTLE_GRACE_MS = 5_000;

const DISCUSSION_TURN_INVITE_RULES = [
  'Discuss is multi-round: each scheduled turn is one short, decidable point, never the whole design. Remaining work belongs in later rounds.',
  '讨论是多轮的：每轮只推进一步，禁止一轮想完/写完。完整方案留给后续轮次。',
].join(' ');

const DISCUSSION_SCHEDULED_TURN_RULES = [
  'Rules for this turn (multi-round Discuss — do not finish the problem here):',
  '- Publish exactly one short TeamSpeak: one claim, one disagreement, or one concrete suggestion.',
  '- Do not solve the whole problem, write a full plan, or dump a complete design in this turn.',
  '- Later rounds exist for the rest. The chair will call TeamDecide action=continue.',
  '- Read earlier statements this round and answer them; repeating them is not a contribution.',
  '- Do not call Write/Edit/Bash. Do not tool-spam to think harder. If a fact is missing, say TBD.',
  '- Lead with the decidable point, then at most one sentence of reason.',
  '- Not calling TeamSpeak records this turn as skipped (abstention); your reasoning stays private.',
  '本轮纪律（多轮讨论，禁止一轮想完整）：',
  '- 只发一条短 TeamSpeak：一个观点、一个分歧、或一个具体建议。',
  '- 禁止一轮内想完、写完、做成完整方案或长计划。',
  '- 细节和完整方案留给后续轮次（主席会 action=continue）。',
  '- 先读本轮已有发言再回应；复述不是贡献。',
  '- 不要为了想清楚狂调工具；缺事实就标明 TBD。',
  '- 先结论，理由最多一句。',
  '- 不调用 TeamSpeak 记为弃权。',
].join('\n');

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

export class SessionSubagentHost {
  constructor(
    private readonly session: Session,
    private readonly ownerAgentId: string,
  ) {}

  async createTeam(
    members: readonly TeamIdentity[],
  ): Promise<Array<{
    readonly agentId: string;
    readonly sessionId: string;
    readonly identity: TeamIdentity;
  }>> {
    this.assertDepartmentManager();
    this.preflightTeamCreation(members);
    const currentSessionId = this.session.options.id;
    if (currentSessionId === undefined) {
      throw new Error('TeamCreate requires a session id.');
    }
    const ownerMeta = this.session.getAgentMetadata(this.ownerAgentId);
    const forestParentId = this.ownerAgentId !== 'main' && this.ownerAgentId !== currentSessionId
      ? this.ownerAgentId
      : currentSessionId;
    const mountParentId = ownerMeta?.mountedSessionId ?? forestParentId;
    const created: Array<{
      readonly agentId: string;
      readonly sessionId: string;
      readonly identity: TeamIdentity;
    }> = [];
    try {
      for (const identity of members) {
        const child = await this.session.createMountedChild({
          parentSessionId: mountParentId,
          identity,
          teamLeaderAgentId: 'main',
        });
        created.push({
          agentId: child.sessionId,
          sessionId: child.sessionId,
          identity,
        });
      }
    } catch (error) {
      if (created.length > 0) {
        try {
          const byLeader = new Map<string, string[]>();
          for (const { agentId } of created) {
            const leader = this.session.getAgentMetadata(agentId)?.teamLeaderAgentId ?? this.ownerAgentId;
            const list = byLeader.get(leader) ?? [];
            list.push(agentId);
            byLeader.set(leader, list);
          }
          for (const [leaderAgentId, agentIds] of byLeader) {
            await this.session.dismissTeamMembers(
              leaderAgentId,
              agentIds,
              'Rolling back an incomplete TeamCreate operation.',
              true,
            );
          }
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'TeamCreate failed and could not be rolled back.',
            { cause: error },
          );
        }
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

  private assertDepartmentManager(): void {
    this.session.assertTeamManager(this.ownerAgentId);
  }

  async dismissTeam(
    agentIds: readonly string[],
    reason: string,
    confirmActive: boolean,
  ): Promise<void> {
    await this.session.dismissTeamMembers(
      this.ownerAgentId,
      agentIds.map((id) => this.resolveMemberId(id)),
      reason,
      confirmActive,
    );
  }

  async updateTeamIdentity(input: {
    readonly agentId?: string;
    readonly name?: string;
    readonly role?: string;
    readonly mandate?: string;
    readonly tags?: readonly string[];
  }): Promise<void> {
    this.assertDepartmentManager();
    const targetAgentId = input.agentId ?? this.ownerAgentId;
    const sessionId = this.resolveIdentitySessionId(targetAgentId);
    await this.session.updateSessionIdentity({
      sessionId,
      name: input.name,
      role: input.role,
      mandate: input.mandate,
      tags: input.tags,
    });
  }

  private resolveIdentitySessionId(agentId: string): string {
    const currentSessionId = this.session.options.id;
    if (currentSessionId === undefined) {
      throw new Error('Session identity updates require a session id.');
    }
    if (agentId === this.ownerAgentId || agentId === currentSessionId) {
      const self = this.session.getAgentMetadata(agentId);
      return self?.mountedSessionId ?? currentSessionId;
    }
    const resolved = this.resolveMemberId(agentId);
    const member = this.session.teamMemberMetadata(this.ownerAgentId)
      .find(([id]) => id === resolved);
    if (member === undefined) {
      throw new Error(`Team member "${agentId}" is not in your department.`);
    }
    return member[1].mountedSessionId ?? member[0];
  }

  private resolveMemberId(token: string): string {
    const trimmed = token.trim();
    if (trimmed.length === 0) return trimmed;
    const members = this.session.teamMemberMetadata(this.ownerAgentId);
    if (members.some(([id]) => id === trimmed)) return trimmed;
    const byName = members.find(([, meta]) =>
      (meta.name ?? '').localeCompare(trimmed, undefined, { sensitivity: 'accent' }) === 0,
    );
    if (byName !== undefined) return byName[0];
    const byMounted = members.find(([, meta]) => meta.mountedSessionId === trimmed);
    if (byMounted !== undefined) return byMounted[0];
    return trimmed;
  }

  private resolveDirectMessageTarget(
    targetId: string,
  ): { readonly id: string; readonly relation: 'parent' | 'sibling' | 'member' } | undefined {
    const token = targetId.trim();
    const parentId = this.session.parentSessionId();
    const selfId = this.session.options.id;
    const children = this.session.listDepartmentChildIds();
    const siblings = this.session.listDepartmentSiblingIds();
    if (parentId !== undefined && (token === 'parent' || token === parentId)) {
      return { id: parentId, relation: 'parent' };
    }
    const child = this.resolveMemberId(token);
    if (children.includes(child)) return { id: child, relation: 'member' };
    const sibling = siblings.find((id) => {
      if (id === token) return true;
      const meta = this.session.getAgentMetadata(id);
      return (meta?.name ?? '').localeCompare(token, undefined, { sensitivity: 'accent' }) === 0;
    });
    if (sibling !== undefined && sibling !== selfId) return { id: sibling, relation: 'sibling' };
    const sender = this.session.getAgentMetadata(this.ownerAgentId);
    const relation = directMessageRelation(
      { agentId: this.ownerAgentId, node: sender },
      { agentId: token, node: this.session.getAgentMetadata(token) },
    );
    if (relation === undefined) return undefined;
    return { id: token, relation };
  }

  private async resumeReachable(id: string): Promise<Agent> {
    const runtime = this.session.options.departmentRuntime;
    const parentId = this.session.parentSessionId();
    if (runtime !== undefined) {
      if (id === parentId) return runtime.ensureMain(id);
      if (this.session.listDepartmentSiblingIds().includes(id)) return runtime.ensureMain(id);
    }
    return this.session.ensureAgentResumed(id);
  }

  async searchSessions(query: string) {
    return this.session.searchSessions(query);
  }

  async mountSession(childSessionId: string, parentSessionId: string, role?: string, mandate?: string) {
    this.assertDepartmentManager();
    await this.session.mountPeerSession(childSessionId, parentSessionId, role, mandate);
  }

  async remountSession(childSessionId: string, parentSessionId: string, role?: string, mandate?: string) {
    this.assertDepartmentManager();
    await this.session.remountPeerSession(childSessionId, parentSessionId, role, mandate);
  }

  async unmountSession(sessionId: string) {
    this.assertDepartmentManager();
    await this.session.unmountPeerSession(sessionId);
  }

  async sessionGraph() {
    return this.session.readSessionGraph();
  }

  currentSessionId(): string | undefined {
    return this.session.options.id;
  }

  async assignTeam(
    assignments: readonly TeamAssignment[],
    signal: AbortSignal,
  ): Promise<Array<{ readonly agentId: string; readonly task: string | null; readonly turnId?: number }>> {
    const resolvedAssignments = assignments.map((assignment) => ({
      ...assignment,
      agentId: this.resolveMemberId(assignment.agentId),
    }));
    const requested = new Set(
      resolvedAssignments.filter((assignment) => assignment.task !== null).map((assignment) => assignment.agentId),
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

    const assigned = await this.session.assignTeamTasks(this.ownerAgentId, resolvedAssignments);
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
          await this.session.notifyMissingTeamReport(agentId, assignedAt);
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
    const resolved = this.resolveDirectMessageTarget(targetAgentId);
    if (resolved === undefined) {
      throw new Error(
        `TeamDM target "${targetAgentId}" is not reachable from here. You may message your parent, the members you hired, or a peer in the same department.`,
      );
    }
    const { id: resolvedId, relation } = resolved;
    const sender = this.session.getAgentMetadata(this.ownerAgentId);
    const reportToParent = report;
    if (reportToParent !== undefined && relation !== 'parent') {
      throw new Error('Team reports must be sent by a department member to its direct parent.');
    }
    const recipient = await this.resumeReachable(resolvedId);
    // Do not persist a report until the recipient has accepted the message
    // path. Otherwise a failed resume/compaction wait/prompt leaves the parent
    // believing that work was reported even though no TeamDM was delivered.
    const recordReport = async (): Promise<void> => {
      if (reportToParent === undefined) return;
      await this.session.recordTeamReport(this.ownerAgentId, reportToParent.status, reportToParent.summary);
    };
    // TeamDM is an internal prompt transport. Keep it in the recipient's
    // model context, but tag it distinctly so transcript projections can
    // avoid rendering it as a normal user/Discuss message after refresh.
    const origin = this.teamDirectMessagePromptOrigin(
      this.ownerAgentId === 'main' ? { name: this.session.metadata.title } : sender,
      this.session.parentSessionId() !== undefined && this.ownerAgentId === 'main'
        ? (this.session.options.id ?? this.ownerAgentId)
        : this.ownerAgentId,
      relation === 'member' ? 'lead' : 'team',
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
      await recordReport();
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
      await recordReport();
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
    await recordReport();
    await runAgentTurnToCompletion(recipient, signal);
    if (reportToParent !== undefined) {
      await this.session.acknowledgeTeamReport(this.ownerAgentId);
    }
    return { delivered: true, processing: 'completed' };
  }

  /**
   * Posts one message to this agent's own department Chat — the sibling-only
   * channel among the members who share its parent. Chat has no chair and
   * that parent never participates or reads it.
   *
   * Delivery force-injects into every mentioned recipient via `turn.steer`,
   * which the loop now interrupts at the next tool-call boundary rather than
   * waiting for the recipient's turn to end on its own. The send resolves once
   * each recipient has the message queued or a turn launched — it deliberately
   * does not wait for their replies, so chatting stays cheap enough to use
   * mid-task.
   */
  async sendChatMessage(
    message: string,
    mentions: readonly string[],
    signal: AbortSignal,
  ): Promise<TeamChatMessageRecord> {
    signal.throwIfAborted();
    validateTeamChatMentions(message, mentions);
    const parentSessionId = this.session.parentSessionId();
    const selfSessionId = this.session.options.id;
    if (this.ownerAgentId === 'main' && parentSessionId !== undefined && selfSessionId !== undefined) {
      return this.sendMountedMemberChat(
        parentSessionId,
        selfSessionId,
        message,
        mentions,
        signal,
      );
    }
    const sender = this.session.getAgentMetadata(this.ownerAgentId);
    if (sender?.kind !== 'team' || sender.teamLeaderAgentId === undefined) {
      throw new Error('Chat is only available to a member of a department.');
    }
    const leaderAgentId = sender.teamLeaderAgentId;
    const members = this.session.teamMemberMetadata(leaderAgentId);
    const targets = mentions.includes('all')
      ? members.filter(([agentId]) => agentId !== this.ownerAgentId)
      : members.filter(([agentId]) => agentId !== this.ownerAgentId && mentions.includes(agentId));
    const unknown = mentions.filter((id) => id !== 'all' && !members.some(([agentId]) => agentId === id));
    if (unknown.length > 0) {
      const siblings = members.filter(([agentId]) => agentId !== this.ownerAgentId).map(([agentId]) => agentId);
      throw new Error(
        `Chat mention target(s) not in this department: ${unknown.join(', ')}. `
        + `Chat only reaches your siblings (${siblings.length > 0 ? siblings.join(', ') : 'none'}) or "all"; `
        + 'to reach your lead use TeamDM instead.',
      );
    }
    const record = await this.session.postTeamChatMessage(
      leaderAgentId,
      this.ownerAgentId,
      sender.name ?? '团队成员',
      message,
      mentions,
    );
    const origin = this.teamChatPromptOrigin(this.ownerAgentId, sender.name);
    const input = [{ type: 'text' as const, text: wrapTeamChatMessage(sender.name ?? this.ownerAgentId, message) }];
    await Promise.all(targets.map(async ([agentId]) => {
      const agent = await this.session.ensureAgentResumed(agentId);
      await waitForAgentCompaction(agent, signal);
      if (agent.turn.hasActiveTurn) {
        agent.turn.steer(input, origin);
        return;
      }
      const start = await startAgentPrompt(agent, input, origin, signal);
      if (start.kind === 'busy') {
        agent.turn.steer(input, origin);
        return;
      }
      // An idle member with no launched turn has nothing to steer into; Chat
      // is best-effort delivery, so it is skipped rather than failing the send.
      if (start.kind === 'unstarted') return;
      // Delivery ends once the recipient's turn is launched. Awaiting that turn
      // would make the sender pay for every sibling's full reply — a department
      // chatting during work would serialize into a chain of blocked members.
      // The recipient's own lifecycle governs the turn, not the sender's signal.
      void runAgentTurnToCompletion(agent).catch(() => undefined);
    }));
    return record;
  }

  private async sendMountedMemberChat(
    parentSessionId: string,
    selfSessionId: string,
    message: string,
    mentions: readonly string[],
    signal: AbortSignal,
  ): Promise<TeamChatMessageRecord> {
    const runtime = this.session.options.departmentRuntime;
    if (runtime === undefined) {
      throw new Error('Chat is only available to a member of a department.');
    }
    const siblings = this.session.listDepartmentSiblingIds();
    const resolvedMentions = mentions.map((id) => {
      if (id === 'all') return 'all';
      const match = siblings.find((siblingId) => siblingId === id);
      if (match !== undefined) return match;
      return id;
    });
    const unknown = resolvedMentions.filter((id) => id !== 'all' && !siblings.includes(id));
    if (unknown.length > 0) {
      throw new Error(
        `Chat mention target(s) not in this department: ${unknown.join(', ')}. `
        + `Chat only reaches your siblings (${siblings.length > 0 ? siblings.join(', ') : 'none'}) or "all"; `
        + 'to reach your lead use TeamDM instead.',
      );
    }
    const name = this.session.getAgentMetadata('main')?.name
      ?? this.session.metadata.title
      ?? '团队成员';
    const record = await runtime.postChat(
      parentSessionId,
      selfSessionId,
      name,
      message,
      resolvedMentions,
    );
    const targets = resolvedMentions.includes('all')
      ? siblings
      : siblings.filter((id) => resolvedMentions.includes(id));
    const origin = this.teamChatPromptOrigin(selfSessionId, name);
    const input = [{ type: 'text' as const, text: wrapTeamChatMessage(name, message) }];
    await Promise.all(targets.map(async (sessionId) => {
      const agent = await runtime.ensureMain(sessionId);
      await waitForAgentCompaction(agent, signal);
      if (agent.turn.hasActiveTurn) {
        agent.turn.steer(input, origin);
        return;
      }
      const start = await startAgentPrompt(agent, input, origin, signal);
      if (start.kind === 'busy') {
        agent.turn.steer(input, origin);
        return;
      }
      if (start.kind === 'unstarted') return;
      void runAgentTurnToCompletion(agent).catch(() => undefined);
    }));
    return record;
  }

  async getTeamStatus(): Promise<TeamStatusResult> {
    await this.session.refreshDepartmentDirectory();
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
        session_id: meta.mountedSessionId ?? agentId,
      });
      if (agent.turn.hasActiveTurn && meta.assignedAt !== undefined) {
        this.session.notifyRunningTeamMember(agentId, meta.assignedAt);
      }
    }
    const colleagues = this.departmentColleagues();
    return {
      agent_id: this.ownerAgentId === 'main'
        ? (this.session.options.id ?? this.ownerAgentId)
        : this.ownerAgentId,
      ...(colleagues.parentAgentId === undefined ? {} : { parent_agent_id: colleagues.parentAgentId }),
      member_count: members.length,
      message: statusMessage(members.length, colleagues.peers.length),
      members,
      ...(colleagues.peers.length === 0 ? {} : { colleagues: colleagues.peers }),
    };
  }

  /**
   * The caller's own department: the parent that hired it and the peers hired
   * alongside it. Read from metadata and already-resumed agents only — a peer
   * that is running is resumed by definition, so an idle peer never has to be
   * loaded just to be listed.
   */
  private departmentColleagues(): {
    readonly parentAgentId: string | undefined;
    readonly peers: readonly TeamStatusColleague[];
  } {
    const parentSessionId = this.session.parentSessionId();
    if (parentSessionId !== undefined) {
      const selfId = this.session.options.id;
      const peers = this.session.listDepartmentSiblingIds()
        .filter((id) => id !== selfId)
        .map((sessionId): TeamStatusColleague => {
          const meta = this.session.getAgentMetadata(sessionId);
          return {
            agent_id: sessionId,
            name: meta?.name ?? null,
            role: meta?.role ?? null,
            status: 'idle',
            assigned_task: meta?.assignedTask ?? meta?.teamReport?.task ?? null,
            report_status: meta?.teamReport?.status ?? 'unreported',
          };
        });
      return { parentAgentId: parentSessionId, peers };
    }
    const self = this.session.getAgentMetadata(this.ownerAgentId);
    const parentAgentId = self?.kind === 'team' ? self.teamLeaderAgentId : undefined;
    if (parentAgentId === undefined) return { parentAgentId: undefined, peers: [] };
    const peers = this.session.teamMemberMetadata(parentAgentId)
      .filter(([agentId]) => agentId !== this.ownerAgentId)
      .map(([agentId, meta]): TeamStatusColleague => ({
        agent_id: agentId,
        name: meta.name ?? null,
        role: meta.role ?? null,
        status: this.session.getReadyAgent(agentId)?.turn.hasActiveTurn === true ? 'running' : 'idle',
        assigned_task: meta.assignedTask ?? meta.teamReport?.task ?? null,
        report_status: meta.teamReport?.status ?? 'unreported',
      }));
    return { parentAgentId, peers };
  }

  async inviteToDiscussion(agentIds: readonly string[]): Promise<TeamDiscussionMeta> {
    this.assertDepartmentManager();
    await this.session.assertTeamDiscussionMode(this.ownerAgentId);
    const active = this.requireActiveDiscussion();
    const current = new Set(active.meta.discussion!.participantAgentIds);
    const members = new Set(this.session.teamMemberMetadata(this.ownerAgentId).map(([id]) => id));
    const added: string[] = [];
    for (const id of agentIds) {
      const resolved = this.resolveMemberId(id);
      if (!members.has(resolved)) throw new Error(`Discussion participant "${id}" is not in the team.`);
      if (!current.has(resolved)) added.push(resolved);
      current.add(resolved);
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
    this.assertDepartmentManager();
    await this.session.assertTeamDiscussionMode(this.ownerAgentId);
    const active = this.requireActiveDiscussion();
    const current = new Set(active.meta.discussion!.participantAgentIds);
    for (const id of agentIds) {
      const resolved = this.resolveMemberId(id);
      if (!current.delete(resolved)) throw new Error(`Discussion participant "${id}" is not active.`);
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
    await this.session.lockTeamAssignments(this.ownerAgentId);
  }

  /**
   * Whether this department has anyone in it.
   *
   * Discuss is a meeting, and a meeting of one is a deadlock: the read-only
   * guard blocks Write/Edit/Bash, and the only tool that leaves Discuss
   * (TeamAssign) requires at least one member to assign to. `DiscussMode` uses
   * this to keep itself off until a department actually exists.
   */
  hasTeamMembers(): boolean {
    return this.session.teamMemberMetadata(this.ownerAgentId).length > 0;
  }

  async decideTeamDiscussion(
    action: 'start' | 'continue' | 'archive' | 'vote',
    topic: string | undefined,
    participantAgentIds: readonly string[] | undefined,
    signal: AbortSignal,
    statement?: string,
  ): Promise<TeamDiscussionResult> {
    this.assertDepartmentManager();
    let active = this.session.activeTeamDiscussion(this.ownerAgentId);
    if (action === 'start') {
      if (active !== undefined) throw new Error('A team discussion is already active. Use continue or archive it first.');
      const discussionTopic = topic?.trim() ?? '';
      if (discussionTopic.length === 0) throw new Error('A discussion topic is required.');
      const participants = (participantAgentIds ?? this.session.teamMemberMetadata(this.ownerAgentId).map(([id]) => id))
        .map((id) => this.resolveMemberId(id));
      // A discussion with nobody in it still locks team writes and still puts
      // the chair in Discuss, where Write/Edit/Bash are denied and the only way
      // out (TeamAssign) needs a member to assign to. Refuse instead of opening
      // a meeting that cannot be closed.
      if (participants.length === 0) {
        throw new Error('Cannot start a discussion with no participants. Hire members with TeamCreate first, or just do the work yourself.');
      }
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
    if (action === 'continue') {
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
      ? `You have been invited to a team discussion on: ${discussion.topic}. Wait for a scheduled turn before responding; shared updates are injected only when your turn starts. ${DISCUSSION_TURN_INVITE_RULES}`
      : phase === 'joined'
        ? `You joined the active team discussion on: ${discussion.topic}. Wait for a scheduled turn before responding; you will receive only unread shared updates. ${DISCUSSION_TURN_INVITE_RULES}`
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
    const updatedDiscussion = await this.session.updateTeamDiscussion(discussionAgentId, {
      participantAgentIds: discussion.participantAgentIds,
      status: discussion.status,
      topic: discussion.topic,
      round,
    });
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
      await this.session.publishLeadDiscussionStatement(this.ownerAgentId, leadStatement);
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
        // member's behalf. Do not abort the member to reclaim the slot.
        await waitForAgentAvailability(participant, signal);
        historyStart = participant.context?.history.length ?? 0;
        const unread = await this.session.unreadTeamDiscussionStatements(discussionAgentId, agentId);
        this.session.beginTeamDiscussionTurn(discussionAgentId, agentId);
        await startScheduledAgentPrompt(
          participant,
          [{ type: 'text', text: discussionRoundPrompt(unread.statements) }],
          this.teamLeadPromptOrigin(),
          signal,
        );
        // Mark messages as read only after this agent accepted the turn. That
        // prevents a rejected prompt from silently losing an unread update,
        // while keeping accepted messages from being replayed into its cache.
        await this.session.acknowledgeTeamDiscussionStatements(discussionAgentId, agentId, unread.cursor);
        try {
          await runDiscussionMemberTurn(participant, signal);
        } catch (error) {
          sent = this.session.consumeTeamDiscussionSpeak(discussionAgentId, agentId);
          if (sent === undefined) failure = error;
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
          const reason = isAbortError(failure)
            ? 'cancelled'
            : toolErrors.length > 0
              ? 'tool_failed'
              : 'failed';
          const detail = discussionFailureDetail(failure, toolErrors);
          const skipped = {
            agentId,
            skipped: true,
            reason,
            error: detail,
            ...(toolErrors.length > 0 ? { toolErrors } : {}),
          };
          statements.push(skipped);
          await this.session.recordTeamTurnSkip?.(agentId, reason, detail);
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
          await this.session.recordTeamTurnSkip?.(agentId, reason, detail ?? 'Member abstained from this discussion turn.');
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
      let vote: TeamVote['vote'];
      try {
        await waitForAgentAvailability(participant, signal);
        // Voting is a scheduled participant turn too. Deliver only this
        // participant's unread statement suffix, then acknowledge it only after
        // the prompt was accepted so a failed vote can retry without losing
        // discussion context.
        const unread = await this.session.unreadTeamDiscussionStatements(discussionAgentId, agentId);
        await startScheduledAgentPrompt(
          participant,
          [{ type: 'text', text: discussionVotePrompt(unread.statements) }],
          this.teamLeadPromptOrigin(),
          signal,
        );
        await this.session.acknowledgeTeamDiscussionStatements(discussionAgentId, agentId, unread.cursor);
        await runDiscussionChildTurnToCompletion(participant, signal);
        vote = parseTeamVote(lastAssistantText(participant));
      } catch (error) {
        // A session-level cancel must not be laundered into an abstention.
        if (signal.aborted) throw signal.reason;
        void error;
        vote = 'abstain';
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

  /**
   * Chat is tagged `team_chat`, distinct from `team_dm`, so transcript
   * projection and the UI can route it to a separate channel/tab.
   */
  private teamChatPromptOrigin(speakerId: string, speakerName: string | undefined): PromptOrigin {
    return {
      kind: 'system_trigger',
      name: 'team_chat',
      speaker: {
        from: 'team',
        speakerId,
        speakerName: speakerName ?? '团队成员',
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
    DISCUSSION_SCHEDULED_TURN_RULES,
    updates.length === 0
      ? ''
      : [
        'Statements already made in this round, in the order they were made — you speak after them:',
        updates,
        'Answer them: build on what holds, name what you would do differently and why. Repeating a point that was already made is not a contribution.',
      ].join('\n\n'),
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

/** One line naming both halves of the result, so neither list reads as the whole team. */
function statusMessage(memberCount: number, colleagueCount: number): string {
  const own = memberCount === 0
    ? 'No members hired by you'
    : `${String(memberCount)} member(s) hired by you`;
  const department = colleagueCount === 0
    ? 'no peers in your own department'
    : `${String(colleagueCount)} peer(s) in your own department, reachable directly with TeamChat or TeamDM`;
  return `${own}; ${department}.`;
}

/** Chat wraps with the sender's name inline — it is a group channel, not a 1:1 line. */
function wrapTeamChatMessage(senderName: string, message: string): string {
  return `<system-reminder>\n[Chat] ${senderName}: ${message.trim()}\n</system-reminder>`;
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
 * abstention. The wait follows the parent signal only — it does not abort the
 * member to reclaim the slot.
 */
async function startScheduledAgentPrompt(
  agent: Agent,
  input: Parameters<Agent['turn']['requestPrompt']>[0],
  origin: PromptOrigin,
  signal: AbortSignal,
): Promise<number> {
  return startAgentPromptWhenIdle(agent, input, origin, signal);
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

async function runDiscussionMemberTurn(
  child: Agent,
  parentSignal: AbortSignal,
): Promise<void> {
  const controller = new AbortController();
  const unlinkParentSignal = linkAbortSignal(parentSignal, controller);
  try {
    await runDiscussionChildTurnToCompletion(child, controller.signal);
  } finally {
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
