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
}

export interface TeamStatusResult {
  readonly agent_id: string;
  readonly member_count: number;
  readonly message: string;
  readonly members: readonly TeamStatusMember[];
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
