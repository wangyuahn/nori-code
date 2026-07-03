import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import type { NoriSwarmProvider } from './types';

const DESCRIPTION =
  'Retrieve the results of a completed (or running) swarm. Returns per-task outputs and status.';

const NoriSwarmResultInputSchema = z.object({
  swarm_id: z.string().min(1).describe('Swarm ID to retrieve results for'),
});

type NoriSwarmResultInput = z.infer<typeof NoriSwarmResultInputSchema>;

export class NoriSwarmResultTool implements BuiltinTool<NoriSwarmResultInput> {
  readonly name = 'nori_swarm_result' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(NoriSwarmResultInputSchema);

  constructor(private readonly swarmManager: NoriSwarmProvider) {}

  resolveExecution(args: NoriSwarmResultInput): ToolExecution {
    return {
      accesses: ToolAccesses.none(),
      description: `Retrieving swarm results: ${args.swarm_id}`,
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: NoriSwarmResultInput,
    _context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const result = await this.swarmManager.getResult(args.swarm_id);
      if (result.status === 'not_found') {
        return { output: `Swarm "${args.swarm_id}" not found.` };
      }
      const taskResults = Object.entries(result.task_results)
        .map(
          ([id, r]) =>
            `- ${id}: ${r.status}${r.output?.analysis_summary ? ` — ${r.output.analysis_summary}` : ''}`,
        )
        .join('\n');
      return {
        output: `Swarm "${args.swarm_id}" [${result.status}]:\n${taskResults || 'No task results yet.'}`,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { output: `Swarm result retrieval failed: ${message}`, isError: true };
    }
  }
}
