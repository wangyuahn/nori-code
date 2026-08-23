import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { TeamAssignment, TeamIdentity } from '../../../session';
import type { SessionSubagentHost, TeamDiscussionResult } from '../../../session/subagent-host';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

const TeamIdentitySchema: z.ZodType<TeamIdentity> = z.object({
  name: z.string().trim().min(1).max(120),
  role: z.string().trim().min(1).max(4_000),
  mandate: z.string().trim().min(1).max(4_000),
}).strict();

export const TeamCreateInputSchema = z.object({
  members: z.array(TeamIdentitySchema).min(1).max(16),
}).strict();
export type TeamCreateInput = z.infer<typeof TeamCreateInputSchema>;

export class TeamCreateTool implements BuiltinTool<TeamCreateInput> {
  readonly name = 'TeamCreate' as const;
  readonly description = 'Hire durable members into your own department. Each member requires a unique non-empty name, role, and mandate. Hire only who the work actually needs: every extra member is one more position to reconcile in every discussion. Fails once the configured team depth limit is reached.';
  readonly parameters = toInputJsonSchema(TeamCreateInputSchema);

  constructor(private readonly host: SessionSubagentHost) {}

  resolveExecution(args: TeamCreateInput): ToolExecution {
    return {
      description: `Creating ${String(args.members.length)} team partner(s)`,
      approvalRule: this.name,
      execute: async () => ({ output: JSON.stringify({ members: await this.host.createTeam(args.members) }) }),
    };
  }
}

export const TeamDismissInputSchema = z.object({
  agent_ids: z.array(z.string().trim().min(1)).min(1),
  reason: z.string().trim().min(1).max(2_000),
  confirm_active: z.boolean().default(false),
}).strict();
export type TeamDismissInput = z.infer<typeof TeamDismissInputSchema>;

export class TeamDismissTool implements BuiltinTool<TeamDismissInput> {
  readonly name = 'TeamDismiss' as const;
  readonly description = 'Dismiss members of your own department. When a member is working, first call with confirm_active=false; retry with confirm_active=true only after confirming the interruption.';
  readonly parameters = toInputJsonSchema(TeamDismissInputSchema);

  constructor(private readonly host: SessionSubagentHost) {}

  resolveExecution(args: TeamDismissInput): ToolExecution {
    return {
      description: 'Dismissing team member(s)',
      approvalRule: this.name,
      execute: async () => {
        await this.host.dismissTeam(args.agent_ids, args.reason, args.confirm_active);
        return { output: JSON.stringify({ dismissed: args.agent_ids }) };
      },
    };
  }
}

interface TeamAssignmentInput {
  readonly agent_id: string;
  readonly task: string | null;
}

const TeamAssignmentSchema: z.ZodType<TeamAssignmentInput> = z.object({
  agent_id: z.string().trim().min(1),
  task: z.string().trim().min(1).nullable(),
}).strict();

export const TeamAssignInputSchema = z.object({
  assignments: z.array(TeamAssignmentSchema).min(1),
}).strict();
export type TeamAssignInput = z.infer<typeof TeamAssignInputSchema>;

export class TeamAssignTool implements BuiltinTool<TeamAssignInput> {
  readonly name = 'TeamAssign' as const;
  readonly description = 'Assign execution work to every member of your department. Include every member exactly once; use task=null to leave one idle. At least one task must be non-null. Give two members overlapping files only after they have agreed in Discuss who owns what. Success exits Discuss and enters Code; each member must stay within its non-null assigned task and report progress, blockers, and the final result through TeamDM.';
  readonly parameters = toInputJsonSchema(TeamAssignInputSchema);

  constructor(private readonly host: SessionSubagentHost) {}

  resolveExecution(args: TeamAssignInput): ToolExecution {
    return {
      description: 'Assigning team work',
      approvalRule: this.name,
      execute: async (context) => ({
        output: JSON.stringify({
          assignments: await this.host.assignTeam(
            args.assignments.map((assignment): TeamAssignment => ({
              agentId: assignment.agent_id,
              task: assignment.task,
            })),
            context.signal,
          ),
        }),
      }),
    };
  }
}

export const TeamBroadcastInputSchema = z.object({
  message: z.string().trim().min(1).max(8_000),
}).strict();
export type TeamBroadcastInput = z.infer<typeof TeamBroadcastInputSchema>;

export class TeamBroadcastTool implements BuiltinTool<TeamBroadcastInput> {
  readonly name = 'TeamBroadcast' as const;
  readonly description = 'Wake every member of your department with the same prompt, in parallel. Members actually run a turn; this is not a silent append.';
  readonly parameters = toInputJsonSchema(TeamBroadcastInputSchema);

  constructor(private readonly host: SessionSubagentHost) {}

  resolveExecution(args: TeamBroadcastInput): ToolExecution {
    return {
      description: 'Broadcasting to the team',
      approvalRule: this.name,
      execute: async (context) => ({ output: JSON.stringify({ recipients: await this.host.broadcastTeam(args.message, context.signal) }) }),
    };
  }
}

export const TeamDMInputSchema = z.object({
  agent_id: z.string().trim().min(1),
  message: z.string().trim().min(1).max(8_000),
  report_status: z.enum(['completed', 'blocked', 'needs_decision']).optional(),
  report_summary: z.string().trim().min(1).max(8_000).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.report_status !== undefined && value.report_summary === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'report_summary is required when report_status is set.',
      path: ['report_summary'],
    });
  }
});
export type TeamDMInput = z.infer<typeof TeamDMInputSchema>;

export class TeamDMTool implements BuiltinTool<TeamDMInput> {
  readonly name = 'TeamDM' as const;
  readonly description = 'Send a private message at any time, in Discuss or Code, for coordination or progress. Reach a member of your own department, or your direct parent. For a task report, set report_status to completed, blocked, or needs_decision and provide report_summary; ordinary messages without report_status are never classified as reports. TeamSpeak is only for formal Discuss turns.';
  readonly parameters = toInputJsonSchema(TeamDMInputSchema);

  constructor(private readonly host: SessionSubagentHost) {}

  resolveExecution(args: TeamDMInput): ToolExecution {
    return {
      description: 'Sending a team direct message',
      approvalRule: this.name,
      execute: async (context) => {
        const delivery = await this.host.directMessage(args.agent_id, args.message, context.signal, args.report_status === undefined
          ? undefined
          : { status: args.report_status, summary: args.report_summary! });
        return { output: JSON.stringify({ recipient: args.agent_id, delivery }) };
      },
    };
  }
}

export const TeamChatInputSchema = z.object({
  message: z.string().trim().min(1).max(4_000),
  mentions: z.array(z.string().trim().min(1)).min(1).max(16),
}).strict();
export type TeamChatInput = z.infer<typeof TeamChatInputSchema>;

export class TeamChatTool implements BuiltinTool<TeamChatInput> {
  readonly name = 'TeamChat' as const;
  readonly description = 'Post to your department\'s persistent group chat — siblings only, your parent never sees it. Every message MUST start with @: begin the message text with @all or @agent-id1 @agent-id2 (also pass them in mentions); only mentioned members are interrupted. Chat is for staying aligned while working, not for review — use TeamDM/reports for that. Keep it short; finish your current step before replying if that\'s more useful than dropping it.';
  readonly parameters = toInputJsonSchema(TeamChatInputSchema);

  constructor(private readonly host: SessionSubagentHost) {}

  resolveExecution(args: TeamChatInput): ToolExecution {
    return {
      description: 'Posting to department chat',
      approvalRule: this.name,
      execute: async (context) => {
        const record = await this.host.sendChatMessage(args.message, args.mentions, context.signal);
        return { output: JSON.stringify({ posted: record }) };
      },
    };
  }
}

const DiscussionMembersSchema = z.object({
  agent_ids: z.array(z.string().trim().min(1)).min(1),
}).strict();
export type DiscussionMembersInput = z.infer<typeof DiscussionMembersSchema>;

export class TeamDiscussInviteTool implements BuiltinTool<DiscussionMembersInput> {
  readonly name = 'TeamDiscussInvite' as const;
  readonly description = 'Invite members of your department into its active discussion.';
  readonly parameters = toInputJsonSchema(DiscussionMembersSchema);

  constructor(private readonly host: SessionSubagentHost) {}

  resolveExecution(args: DiscussionMembersInput): ToolExecution {
    return {
      description: 'Inviting team discussion participants',
      approvalRule: this.name,
      execute: async () => ({ output: JSON.stringify(discussionSummary(await this.host.inviteToDiscussion(args.agent_ids))) }),
    };
  }
}

export class TeamDiscussKickTool implements BuiltinTool<DiscussionMembersInput> {
  readonly name = 'TeamDiscussKick' as const;
  readonly description = 'Remove participants from your department\'s active discussion without dismissing them.';
  readonly parameters = toInputJsonSchema(DiscussionMembersSchema);

  constructor(private readonly host: SessionSubagentHost) {}

  resolveExecution(args: DiscussionMembersInput): ToolExecution {
    return {
      description: 'Removing team discussion participants',
      approvalRule: this.name,
      execute: async () => ({ output: JSON.stringify(discussionSummary(await this.host.kickFromDiscussion(args.agent_ids))) }),
    };
  }
}

export const TeamDecideInputSchema = z.object({
  action: z.enum(['start', 'continue', 'archive', 'vote']),
  topic: z.string().trim().min(1).max(4_000).optional(),
  statement: z.string().trim().min(1).max(8_000).optional(),
  participant_agent_ids: z.array(z.string().trim().min(1)).min(1).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.action === 'start' && (value.topic === undefined || value.topic.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'topic is required when starting a discussion.',
      path: ['topic'],
    });
  }
  if ((value.action === 'start' || value.action === 'continue')
    && (value.statement === undefined || value.statement.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'statement is required so the lead speaks first.',
      path: ['statement'],
    });
  }
});
export type TeamDecideInput = z.infer<typeof TeamDecideInputSchema>;

function teamDecideJsonSchema(): Record<string, unknown> {
  const schema = toInputJsonSchema(TeamDecideInputSchema);
  return {
    ...schema,
    allOf: [
      {
        if: {
          type: 'object',
          properties: { action: { const: 'start' } },
          required: ['action'],
        },
        // JSON Schema conditional keyword; intentionally not a Promise handler.
        // oxlint-disable-next-line unicorn/no-thenable
        then: { required: ['topic', 'statement'] },
      },
      {
        if: {
          type: 'object',
          properties: { action: { const: 'continue' } },
          required: ['action'],
        },
        // JSON Schema conditional keyword; intentionally not a Promise handler.
        // oxlint-disable-next-line unicorn/no-thenable
        then: { required: ['statement'] },
      },
    ],
  };
}

export class TeamDecideTool implements BuiltinTool<TeamDecideInput> {
  readonly name = 'TeamDecide' as const;
  readonly description = 'Chair a discussion in your own department: run a round, collect a vote, or archive. start requires topic + your own opening statement; continue requires a new statement and keeps the same discussion. Members then speak one at a time in order, and each one is given every statement published before its turn — starting with yours — so write the opening as a request for objections and alternatives rather than a plan to endorse. Your members answer with TeamSpeak, or abstain by skipping it. Open a round whenever the plan changes, two members need the same files, or someone reports a blocker — not only before the first assignment. vote may be used when all assigned results are received and no active work, unresolved block, or pending decision remains; archive only formally ends that Discuss.';
  readonly parameters = teamDecideJsonSchema();

  constructor(private readonly host: SessionSubagentHost) {}

  resolveExecution(args: TeamDecideInput): ToolExecution {
    return {
      description: `Team discussion: ${args.action}`,
      approvalRule: this.name,
      execute: async (context) => teamDiscussionResult(this.host.decideTeamDiscussion(
        args.action,
        args.topic,
        args.participant_agent_ids,
        context.signal,
        args.statement,
      )),
    };
  }
}

export const TeamSpeakInputSchema = z.object({
  message: z.string().trim().min(1).max(8_000),
}).strict();
export type TeamSpeakInput = z.infer<typeof TeamSpeakInputSchema>;

/** Publishes a single intentional contribution from the scheduled team member. */
export class TeamSpeakTool implements BuiltinTool<TeamSpeakInput> {
  readonly name = 'TeamSpeak' as const;
  readonly description = 'Publish your concise formal position during your scheduled turn in your parent department\'s discussion. The statements handed to you are what earlier speakers already said this round: answer them — build on what holds, say where you disagree and why — rather than repeating them. Only TeamSpeak is a formal statement; other tool calls do not count. No call records the turn as skipped (abstention).';
  readonly parameters = toInputJsonSchema(TeamSpeakInputSchema);

  constructor(private readonly host: SessionSubagentHost) {}

  resolveExecution(args: TeamSpeakInput): ToolExecution {
    return {
      description: 'Publishing a team discussion statement',
      approvalRule: this.name,
      execute: async () => {
        await this.host.speakInDiscussion(args.message);
        // TeamSpeak is the member's terminal action for this scheduled turn.
        // Ending the turn here prevents a provider follow-up generation from
        // consuming or invalidating the discussion lease.
        return { output: 'Statement published.', stopTurn: true };
      },
    };
  }
}

async function teamDiscussionResult(
  result: Promise<TeamDiscussionResult>,
): Promise<ExecutableToolResult> {
  const value = await result;
  return {
    output: JSON.stringify({
      discussion_agent_id: value.discussionAgentId,
      discussion: discussionSummary(value.discussion),
      statements: value.statements,
      votes: value.votes,
    }),
  };
}

function discussionSummary(discussion: {
  readonly participantAgentIds: readonly string[];
  readonly status: 'active' | 'archived';
  readonly topic: string;
}) {
  return {
    participant_agent_ids: discussion.participantAgentIds,
    status: discussion.status,
    topic: discussion.topic,
  };
}
