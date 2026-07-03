import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import type { NoriSwarmProvider } from './types';

const DESCRIPTION =
  'Check the status of a running swarm. Returns the current execution status and partial results.';

const NoriSwarmStatusInputSchema = z.object({
  swarm_id: z.string().min(1).describe('Swarm ID to check status for'),
});

type NoriSwarmStatusInput = z.infer<typeof NoriSwarmStatusInputSchema>;

export class NoriSwarmStatusTool implements BuiltinTool<NoriSwarmStatusInput> {
  readonly name = 'nori_swarm_status' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(NoriSwarmStatusInputSchema);

  constructor(private readonly swarmManager: NoriSwarmProvider) {}

  resolveExecution(args: NoriSwarmStatusInput): ToolExecution {
    return {
      accesses: ToolAccesses.none(),
      description: `Checking swarm status: ${args.swarm_id}`,
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: NoriSwarmStatusInput,
    _context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const result = await this.swarmManager.getStatus(args.swarm_id);
      if (result.status === 'not_found') {
        return { output: `Swarm "${args.swarm_id}" not found.` };
      }
      const taskCount = result.results ? Object.keys(result.results).length : 0;
      return { output: `Swarm "${args.swarm_id}" status: ${result.status}. Tasks: ${taskCount}.` };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { output: `Swarm status check failed: ${message}`, isError: true };
    }
  }
}
