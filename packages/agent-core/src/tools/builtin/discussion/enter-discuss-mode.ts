import type { Agent } from '#/agent';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import DESCRIPTION from './enter-discuss-mode.md?raw';

export const EnterDiscussModeInputSchema = z.object({}).strict();
export type EnterDiscussModeInput = z.infer<typeof EnterDiscussModeInputSchema>;

export class EnterDiscussModeTool implements BuiltinTool<EnterDiscussModeInput> {
  readonly name = 'EnterDiscussMode' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(EnterDiscussModeInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(_args: EnterDiscussModeInput): ToolExecution {
    return {
      description: 'Entering Discuss',
      approvalRule: this.name,
      execute: async () => {
        if (this.agent.discussMode.isActive) {
          return {
            isError: true,
            output: 'Discuss is already active. Continue with TeamDecide, or call TeamAssign when ready for Code.',
          };
        }

        try {
          await this.agent.discussMode.enter();
          await this.agent.subagentHost?.lockTeamWritesForDiscuss?.();
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to enter Discuss.';
          return { isError: true, output: `Failed to enter Discuss: ${message}` };
        }

        this.agent.telemetry.track('discuss_enter_resolved', { outcome: 'auto_approved' });
        return {
          output: [
            'Discuss is active for main-lead team coordination.',
            'Use TeamDecide action=start with a topic and opening statement for the first round.',
            'Use TeamDecide action=continue with a new statement for later rounds.',
            'Members use TeamSpeak or abstain by skipping it.',
            'Use TeamAssign when ready: it exits Discuss and enters Code.',
            'Re-enter Discuss whenever more confirmation, review, or coordination is needed.',
          ].join('\n'),
        };
      },
    };
  }
}
