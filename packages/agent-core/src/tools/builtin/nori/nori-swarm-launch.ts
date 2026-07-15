import { z } from 'zod';

import { SwarmBackgroundTask, type BackgroundManager } from '../../../agent/background';
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
    private readonly backgroundManager: BackgroundManager,
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
      const taskId = this.backgroundManager.registerTask(
        new SwarmBackgroundTask(`Nori swarm: ${args.template_name}`, async (signal, appendOutput) => {
          appendOutput(`Nori swarm ${result.swarm_id} is running.\n`);
          for (;;) {
            signal.throwIfAborted();
            const snapshot = await this.swarmManager.getResult(result.swarm_id);
            if (snapshot.status === 'not_found') {
              throw new Error(`Swarm ${result.swarm_id} disappeared before completion.`);
            }
            if (snapshot.status === 'completed' || snapshot.status === 'failed') {
              return [
                `<nori_swarm_result swarm_id="${result.swarm_id}" status="${snapshot.status}">`,
                JSON.stringify(snapshot.task_results, null, 2),
                '</nori_swarm_result>',
              ].join('\n');
            }
            await waitForPoll(signal);
          }
        }),
        { detached: true },
      );
      return {
        output: [
          `swarm_id: ${result.swarm_id}`,
          `task_id: ${taskId}`,
          'status: running',
          'automatic_notification: true',
          'next_step: Continue other work or stop and wait; completion is injected automatically.',
        ].join('\n'),
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { output: `Swarm launch failed: ${message}`, isError: true };
    }
  }
}

function waitForPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }
    const timer = setTimeout(finish, 500);
    function finish(): void {
      signal.removeEventListener('abort', abort);
      resolve();
    }
    function abort(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new Error('Aborted'));
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}
