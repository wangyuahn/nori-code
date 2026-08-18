/**
 * UpdateGoalTool — the model's single lever over the goal lifecycle. It updates
 * the goal's status directly; the turn driver reads the status at each turn
 * boundary and stops (`complete` / `blocked` / `paused`) or keeps going
 * (`active`).
 *
 * The argument is intentionally just a status enum — no reason or evidence. The
 * model explains itself in its own reply; the status is the machine-readable
 * signal. The tool is only offered to the model while a goal exists (see the
 * `loopTools` filter in the tool manager).
 */

import type { Agent } from '#/agent';
import { z } from 'zod';

import {
  GOAL_BLOCKED_REMINDER_NAME,
  GOAL_COMPLETION_REMINDER_NAME,
} from '../../../agent/turn';
import {
  buildGoalBlockedReasonPrompt,
  buildGoalCompletionSummaryPrompt,
} from './outcome-prompts';
import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import DESCRIPTION from './update-goal.md?raw';

export const UpdateGoalToolInputSchema = z
  .object({
    status: z
      .enum(['active', 'complete', 'paused', 'blocked'])
      .describe('The lifecycle status to set for the current goal.'),
  })
  .strict();

export type UpdateGoalToolInput = z.infer<typeof UpdateGoalToolInputSchema>;

export class UpdateGoalTool implements BuiltinTool<UpdateGoalToolInput> {
  readonly name = 'UpdateGoal' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(UpdateGoalToolInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: UpdateGoalToolInput): ToolExecution {
    const goal = this.agent.goal;

    return {
      description: `Setting goal status: ${args.status}`,
      stopBatchAfterThis: args.status !== 'active',
      approvalRule: this.name,
      execute: async () => {
        if (args.status === 'active') {
          await goal.resumeGoal({}, 'model');
          return { output: 'Goal resumed.' };
        }
        if (args.status === 'complete') {
          const completed = await goal.markComplete({}, 'model');
          // `complete` is transient: markComplete announces then clears the
          // record. Store the summary request as a system reminder, so the next
          // provider request ends with a user message after the UpdateGoal tool
          // result. Anthropic-compatible providers reject trailing assistant
          // messages as unsupported prefill.
          // When memory tools are active, the same goal_completion reminder also
          // asks the model whether optional vault cleanup is warranted (never auto-deletes).
          if (completed === null) {
            return {
              output:
                'No active goal to mark complete (missing, already finished, or not active).',
              isError: true,
            };
          }
          this.agent.context.appendSystemReminder(
            buildGoalCompletionSummaryPrompt(completed, {
              includeMemoryCleanup: memoryCleanupReminderEnabled(this.agent),
            }),
            {
              kind: 'system_trigger',
              name: GOAL_COMPLETION_REMINDER_NAME,
            },
          );
          this.agent.turn.notePendingGoalOutcomeContinuation();
          return { output: 'Goal marked complete.', stopTurn: true };
        }
        if (args.status === 'blocked') {
          const blocked = await goal.markBlocked({}, 'model');
          if (blocked === null) {
            return {
              output:
                'No active goal to mark blocked (missing, already finished, or not active).',
              isError: true,
            };
          }
          this.agent.context.appendSystemReminder(buildGoalBlockedReasonPrompt(blocked), {
            kind: 'system_trigger',
            name: GOAL_BLOCKED_REMINDER_NAME,
          });
          this.agent.turn.notePendingGoalOutcomeContinuation();
          return { output: 'Goal marked blocked.', stopTurn: true };
        }
        await goal.pauseGoal({}, 'model');
        return { output: 'Goal paused.', stopTurn: true };
      },
    };
  }
}

/**
 * Memory cleanup guidance must only appear when `nori_memory_remove` is actually
 * callable. Prefer the live tool list; fall back to the provider when tools are
 * unavailable (e.g. unit stubs that only inject `obsidianMemory`).
 */
function memoryCleanupReminderEnabled(agent: Agent): boolean {
  if (agent.obsidianMemory === undefined) return false;
  const tools = agent.tools?.data();
  if (tools === undefined) return true;
  return tools.some((tool) => tool.name === 'nori_memory_remove' && tool.active);
}
