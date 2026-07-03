import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import type { NoriMemoryProvider } from './types';

const DESCRIPTION = `Write a note to the Obsidian shared memory vault.
Use this to record findings, decisions, or analysis results
that other agents or future sessions can retrieve.

Parameters:
- note_type: type of note. 'analysis', 'decision', 'task', or 'review'.
- title: plain text title.
- content: full markdown content. Use [[links]] for bidirectional
  linking to other notes.
- tags (optional): list of tags for categorization.
- links (optional): list of linked note paths (in addition to
  [[wiki-links]] in content).`;

const NoriMemoryWriteInputSchema = z.object({
  note_type: z.enum(['analysis', 'decision', 'task', 'review']),
  title: z.string().min(1).max(200),
  content: z.string().min(1),
  tags: z.array(z.string()).optional(),
  links: z.array(z.string()).optional(),
});

type NoriMemoryWriteInput = z.infer<typeof NoriMemoryWriteInputSchema>;

export class NoriMemoryWriteTool implements BuiltinTool<NoriMemoryWriteInput> {
  readonly name = 'nori_memory_write' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(NoriMemoryWriteInputSchema);

  constructor(private readonly memory: NoriMemoryProvider) {}

  resolveExecution(args: NoriMemoryWriteInput): ToolExecution {
    return {
      accesses: ToolAccesses.none(),
      description: `Writing ${args.note_type} note to Obsidian: ${args.title}`,
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: NoriMemoryWriteInput,
    _context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const result = await this.memory.writeNote({
        note_type: args.note_type,
        title: args.title,
        content: args.content,
        tags: args.tags,
        links: args.links,
      });
      return { output: `Note written: ${result.path}` };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { output: `Memory write failed: ${message}`, isError: true };
    }
  }
}
