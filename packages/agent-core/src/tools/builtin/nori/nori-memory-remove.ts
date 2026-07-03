import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import type { NoriMemoryProvider } from './types';

const DESCRIPTION = `Remove a note from the Obsidian shared memory vault.

Matches the note by exact title. If a note with the given title exists, it is
permanently deleted. Returns whether the note was found and removed.

Use this sparingly — only for notes that are genuinely obsolete or incorrect.
Prefer nori_memory_write with updated content for corrections.`;

const NoriMemoryRemoveInputSchema = z.object({
  title: z.string().min(1).max(200),
});

type NoriMemoryRemoveInput = z.infer<typeof NoriMemoryRemoveInputSchema>;

export class NoriMemoryRemoveTool implements BuiltinTool<NoriMemoryRemoveInput> {
  readonly name = 'nori_memory_remove' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(NoriMemoryRemoveInputSchema);

  constructor(private readonly memory: NoriMemoryProvider) {}

  resolveExecution(args: NoriMemoryRemoveInput): ToolExecution {
    return {
      accesses: ToolAccesses.all(),
      description: `Removing note from Obsidian: ${args.title}`,
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: NoriMemoryRemoveInput,
    _context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const removed = await this.memory.removeNote(args.title);
      if (removed) {
        return { output: `Note removed: "${args.title}"` };
      }
      return { output: `Note not found: "${args.title}". No matching note with that exact title.` };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { output: `Memory remove failed: ${message}`, isError: true };
    }
  }
}
