import { z } from 'zod';

import type { Agent } from '../../../agent';
import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

export const NoriAskParentInputSchema = z
  .object({
    question: z.string().trim().min(1).describe('Question to ask the parent agent.'),
    context: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Optional context that helps the parent answer accurately.'),
  })
  .strict();

type NoriAskParentInput = z.infer<typeof NoriAskParentInputSchema>;

const DESCRIPTION = `Ask the parent agent for guidance, clarification, or a decision.

This is a model-callable API for subagents. Call it whenever you are blocked by
requirements, priority, or scope ambiguity. The parent has the broader task
context. Do not use this to ask the end user directly.`;

export class NoriAskParentTool implements BuiltinTool<NoriAskParentInput> {
  readonly name = 'nori_ask_parent' as const;
  readonly description = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(NoriAskParentInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: NoriAskParentInput): ToolExecution {
    if (this.agent.type !== 'sub') {
      return {
        output: 'nori_ask_parent is only available from a subagent. Ask the user directly or continue with available context.',
        isError: true,
      };
    }
    return {
      accesses: ToolAccesses.none(),
      description: 'Asking parent agent',
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: NoriAskParentInput,
    _context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    const prompt = args.context === undefined
      ? args.question
      : `[Context]\n${args.context}\n\n[Question]\n${args.question}`;
    try {
      const answer = await this.agent.subagentHost?.askOwnerParent(prompt);
      if (answer === undefined) {
        return { output: 'Parent agent channel is not configured.', isError: true };
      }
      return { output: answer };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { output: `Failed to ask parent: ${message}`, isError: true };
    }
  }
}
