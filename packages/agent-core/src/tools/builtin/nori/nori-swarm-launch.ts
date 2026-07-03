import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import type { NoriSwarmProvider } from './types';

const NoriSwarmLaunchInputSchema = z.object({
  template_name: z.string().min(1).describe('Swarm template name to launch'),
  params: z.record(z.string(), z.any()).describe('Parameters to pass to the swarm template'),
});

type NoriSwarmLaunchInput = z.infer<typeof NoriSwarmLaunchInputSchema>;

export class NoriSwarmLaunchTool implements BuiltinTool<NoriSwarmLaunchInput> {
  readonly name = 'nori_swarm_launch' as const;
  readonly description: string;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(NoriSwarmLaunchInputSchema);

  constructor(
    private readonly swarmManager: NoriSwarmProvider,
    private readonly maxDepth: number,
    private readonly currentDepth: number,
  ) {
    this.description = `Launch a swarm of parallel sub-agents using a DAG-defined template.
The swarm executes tasks in topological order with parallel layers.
Current depth: ${currentDepth}/${maxDepth}.`;
  }

  resolveExecution(args: NoriSwarmLaunchInput): ToolExecution {
    if (this.currentDepth >= this.maxDepth) {
      return {
        output: `Swarm launch blocked: maximum depth (${this.maxDepth}) reached.`,
        isError: true,
      };
    }
    return {
      accesses: ToolAccesses.none(),
      description: `Launching swarm: ${args.template_name}`,
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: NoriSwarmLaunchInput,
    _context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const result = await this.swarmManager.launchDag(
        args.template_name,
        args.params,
        this.currentDepth + 1,
      );
      return { output: `Swarm launched: ${result.swarm_id}` };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { output: `Swarm launch failed: ${message}`, isError: true };
    }
  }
}
