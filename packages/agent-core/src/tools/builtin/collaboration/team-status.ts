import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { z } from 'zod';
import DESCRIPTION from './team-status.md?raw';
import type { SessionSubagentHost } from '../../../session/subagent-host';

export const TeamStatusInputSchema = z.object({
}).strict();
export type TeamStatusInput = z.infer<typeof TeamStatusInputSchema>;

export interface TeamStatusMember {
  readonly agent_id: string;
  readonly name: string | null;
  readonly role: string | null;
  readonly mandate: string | null;
  readonly status: 'idle' | 'running';
  readonly assigned_task: string | null;
  readonly report_status?: 'unreported' | 'completed' | 'blocked' | 'needs_decision' | null;
  readonly report_summary?: string | null;
  readonly report_received?: boolean;
  /** Mounted child session id when TeamCreate created a real session. */
  readonly session_id?: string;
}

/**
 * A peer in the caller's own department: hired by the same parent, reachable
 * directly with TeamChat or TeamDM. Its report to the shared parent is that
 * parent's to read, so only the status travels here — enough to see whether a
 * peer has already handed its part over.
 */
export interface TeamStatusColleague {
  readonly agent_id: string;
  readonly name: string | null;
  readonly role: string | null;
  readonly status: 'idle' | 'running';
  readonly assigned_task: string | null;
  readonly report_status: 'unreported' | 'completed' | 'blocked' | 'needs_decision';
}

export interface TeamStatusResult {
  readonly agent_id: string;
  readonly member_count: number;
  readonly message: string;
  readonly members: readonly TeamStatusMember[];
  /** The parent that hired the caller; absent for the main Agent. */
  readonly parent_agent_id?: string;
  /** Peers in the caller's own department, excluding the caller. */
  readonly colleagues?: readonly TeamStatusColleague[];
}

export class TeamStatusTool implements BuiltinTool<TeamStatusInput> {
  readonly name = 'TeamStatus' as const;
  readonly description: string = DESCRIPTION.trim();
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TeamStatusInputSchema);

  constructor(private readonly host: SessionSubagentHost) {}

  resolveExecution(_args: TeamStatusInput): ToolExecution {
    return {
      description: 'Reading direct team status',
      approvalRule: this.name,
      execute: async () => ({
        output: JSON.stringify(await this.host.getTeamStatus()),
      }),
    };
  }
}
