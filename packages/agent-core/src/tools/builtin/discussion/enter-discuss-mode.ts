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
            output: 'Discuss is already active. Use TeamAssign to enter Code, or continue the meeting with TeamDecide.',
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
            'Discuss is now active. This is a read-only team meeting.',
            '',
            '1. Use Read, Grep, and Glob for context. Do not Write, Edit, Bash, or launch SubAgent.',
            '2. Create partners with TeamCreate when needed.',
            '3. Call TeamDecide action=start with a topic and your opening statement.',
            '4. Members publish only with TeamSpeak; not calling it records abstention.',
            '5. Call TeamAssign when ready to execute. That leaves Discuss and enters Code.',
            '',
            'Do not write a session file or ask the user to approve a document.',
          ].join('\n'),
        };
      },
    };
  }
}
