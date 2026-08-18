import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { TeamAssignment, TeamIdentity } from '../../../session';
import type { SessionSubagentHost, TeamDiscussionResult } from '../../../session/subagent-host';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

const TeamIdentitySchema: z.ZodType<TeamIdentity> = z.object({
  name: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(200),
  intro: z.string().trim().min(1).max(2_000),
  mandate: z.string().trim().min(1).max(4_000),
  role: z.string().trim().min(1).max(4_000),
}).strict();

export const TeamCreateInputSchema = z.object({
  members: z.array(TeamIdentitySchema).min(1).max(16),
}).strict();
export type TeamCreateInput = z.infer<typeof TeamCreateInputSchema>;

export class TeamCreateTool implements BuiltinTool<TeamCreateInput> {
  readonly name = 'TeamCreate' as const;
  readonly description = 'Create durable team partners in this parent session. Every member requires name, title, intro, mandate, and role. Use SubAgent instead for temporary parallel work.';
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
  readonly description = 'Dismiss durable team members. When a member is working, first call with confirm_active=false; retry with confirm_active=true only after confirming the interruption.';
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
  readonly description = 'Assign execution work to every current team member. Include every member exactly once; use task=null to explicitly leave one idle. At least one task must be non-null. A successful assignment leaves Discuss and enters Code. Write access lasts for the whole execution phase until the next Assign, Discuss, or discussion archive.';
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
  readonly description = 'Wake every durable team member with a parallel prompt from the lead. Members actually run a turn; this is not a silent append.';
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
}).strict();
export type TeamDMInput = z.infer<typeof TeamDMInputSchema>;

export class TeamDMTool implements BuiltinTool<TeamDMInput> {
  readonly name = 'TeamDM' as const;
  readonly description = 'Send a private prompt between the lead and one team member so the recipient actually runs a turn.';
  readonly parameters = toInputJsonSchema(TeamDMInputSchema);

  constructor(private readonly host: SessionSubagentHost) {}

  resolveExecution(args: TeamDMInput): ToolExecution {
    return {
      description: 'Sending a team direct message',
      approvalRule: this.name,
      execute: async (context) => {
        await this.host.directMessage(args.agent_id, args.message, context.signal);
        return { output: JSON.stringify({ recipient: args.agent_id }) };
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
  readonly description = 'Invite existing team members to the active discussion without creating a new discussion transcript.';
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
  readonly description = 'Remove team members from the active discussion only. This does not dismiss them from the durable team.';
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
        then: { required: ['topic', 'statement'] },
      },
      {
        if: {
          type: 'object',
          properties: { action: { const: 'continue' } },
          required: ['action'],
        },
        then: { required: ['statement'] },
      },
    ],
  };
}

export class TeamDecideTool implements BuiltinTool<TeamDecideInput> {
  readonly name = 'TeamDecide' as const;
  readonly description = 'Run one serial discussion round, collect a vote, or archive the active discussion. Start/continue require the lead statement first, then members may TeamSpeak. Vote runs after Assign in Code and does not require Discuss. Use continue for later rounds so the same transcript is retained.';
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
  readonly description = 'Publish your concise final position to the active team discussion. This is available only during your scheduled discussion turn; no call records the turn as skipped (abstention).';
  readonly parameters = toInputJsonSchema(TeamSpeakInputSchema);

  constructor(private readonly host: SessionSubagentHost) {}

  resolveExecution(args: TeamSpeakInput): ToolExecution {
    return {
      description: 'Publishing a team discussion statement',
      approvalRule: this.name,
      execute: async () => {
        await this.host.speakInDiscussion(args.message);
        return { output: 'Statement published.' };
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
