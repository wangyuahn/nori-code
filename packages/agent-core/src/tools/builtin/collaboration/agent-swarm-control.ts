import { z } from 'zod';

import type { BackgroundManager, BackgroundTaskInfo } from '../../../agent/background';
import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import type { SessionSubagentHost } from '../../../session/subagent-host';
import { toInputJsonSchema } from '../../support/input-schema';
import DESCRIPTION from './agent-swarm-control.md?raw';

const AgentSwarmControlInputSchema = z.object({
  action: z.enum(['list', 'status', 'stop', 'pause', 'guide', 'resume']),
  task_id: z.string().trim().min(1).optional(),
  prompt: z.string().trim().min(1).optional(),
}).strict().superRefine((value, context) => {
  if (value.action !== 'list' && value.task_id === undefined) {
    context.addIssue({ code: 'custom', path: ['task_id'], message: 'task_id is required for this action' });
  }
  if (value.action === 'guide' && value.prompt === undefined) {
    context.addIssue({ code: 'custom', path: ['prompt'], message: 'prompt is required when adding guidance' });
  }
});

type AgentSwarmControlInput = z.infer<typeof AgentSwarmControlInputSchema>;

export class AgentSwarmControlTool implements BuiltinTool<AgentSwarmControlInput> {
  readonly name = 'AgentSwarmControl' as const;
  readonly description = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(AgentSwarmControlInputSchema);

  constructor(private readonly background: BackgroundManager) {}

  resolveExecution(args: AgentSwarmControlInput): ToolExecution {
    return {
      accesses: ToolAccesses.none(),
      description: args.action === 'list'
        ? 'Listing AgentSwarm runs'
        : `${args.action} AgentSwarm ${args.task_id ?? ''}`,
      approvalRule: this.name,
      execute: (context) => this.execution(args, context),
    };
  }

  private async execution(
    args: AgentSwarmControlInput,
    _context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const sessionHost = sessionHostFor(this.background);
      if (args.action === 'list') {
        const swarms = sessionHost === undefined
          ? this.background.list(false).filter(isSwarmTask)
          : (await sessionHost.listAgentSwarms()).map(({ task }) => task);
        return { output: swarms.length === 0 ? 'No AgentSwarm runs in this session.' : swarms.map(formatSwarm).join('\n') };
      }

      const taskId = args.task_id!;
      if (args.action === 'status') {
        const current = sessionHost === undefined
          ? this.background.getTask(taskId)
          : (await sessionHost.listAgentSwarms()).find(({ task }) => task.taskId === taskId)?.task;
        if (current === undefined || !isSwarmTask(current)) return notFound(taskId);
        return { output: formatSwarm(current) };
      }

      const prompt = args.action === 'stop'
        ? args.prompt ?? 'Stopped by the main agent.'
        : args.prompt;
      const result = sessionHost === undefined
        ? await controlLocalSwarm(this.background, taskId, args.action, prompt)
        : await sessionHost.controlAgentSwarm(taskId, args.action, prompt);
      return result === undefined ? notFound(taskId) : { output: formatSwarm(result) };
    } catch (error) {
      return { output: error instanceof Error ? error.message : String(error), isError: true };
    }
  }
}

function sessionHostFor(
  background: BackgroundManager,
): Pick<SessionSubagentHost, 'listAgentSwarms' | 'controlAgentSwarm'> | undefined {
  return (background as unknown as {
    readonly agent?: {
      readonly subagentHost?: Pick<SessionSubagentHost, 'listAgentSwarms' | 'controlAgentSwarm'>;
    };
  }).agent?.subagentHost;
}

async function controlLocalSwarm(
  background: BackgroundManager,
  taskId: string,
  action: Exclude<AgentSwarmControlInput['action'], 'list' | 'status'>,
  prompt?: string,
): Promise<BackgroundTaskInfo | undefined> {
  const current = background.getTask(taskId);
  if (current === undefined || !isSwarmTask(current)) return undefined;
  if (action === 'stop') return background.stop(taskId, prompt);
  if (action === 'pause') return background.pause(taskId, prompt);
  if (action === 'guide') {
    if (prompt === undefined) throw new Error('Guidance prompt is required.');
    return background.addGuidance(taskId, prompt);
  }
  return background.resume(taskId, prompt);
}

function notFound(taskId: string): ExecutableToolResult {
  return { output: `AgentSwarm task "${taskId}" was not found.`, isError: true };
}

function isSwarmTask(task: BackgroundTaskInfo): boolean {
  return task.kind === 'agent' && task.subagentType?.startsWith('swarm') === true;
}

function formatSwarm(task: BackgroundTaskInfo): string {
  const paused = task.kind === 'agent' && task.paused === true;
  const status = paused ? 'paused' : task.status;
  return `- task_id=${task.taskId} status=${status} description=${JSON.stringify(task.description)}`;
}
