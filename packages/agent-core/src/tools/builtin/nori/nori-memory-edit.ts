import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import type { NoriMemoryProvider } from './types';

const DESCRIPTION = `Edit an existing note in the Obsidian shared memory vault.

Matches the note by exact title and updates that file in place. Does not create
a new note — use nori_memory_write to add a note.

Parameters:
- title: exact title of the note to edit.
- content: replacement markdown body. Do not manually write [[wiki-links]];
  pass titles in links instead when you want to change related notes.
- tags (optional): replace tags. Omit to keep the existing tags.
- links (optional): replace related wiki-links. Omit to keep existing links.
  Pass ["None"] or [] to clear links.`;

const NoriMemoryEditInputSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1),
  tags: z.array(z.string()).optional(),
  links: z.array(z.string()).optional(),
});

type NoriMemoryEditInput = z.infer<typeof NoriMemoryEditInputSchema>;

export class NoriMemoryEditTool implements BuiltinTool<NoriMemoryEditInput> {
  readonly name = 'nori_memory_edit' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(NoriMemoryEditInputSchema);

  constructor(private readonly memory: NoriMemoryProvider) {}

  resolveExecution(args: NoriMemoryEditInput): ToolExecution {
    return {
      accesses: ToolAccesses.none(),
      description: `Editing Obsidian note: ${args.title}`,
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: NoriMemoryEditInput,
    _context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const isExplicitNone = args.links?.length === 1 && args.links[0] === 'None';
      const links = args.links === undefined
        ? undefined
        : isExplicitNone || args.links.length === 0
          ? []
          : args.links;
      const relatedSection = links === undefined
        ? undefined
        : links.length === 0
          ? '_None_'
          : links.map(l => `- [[${l}]]`).join('\n');
      const fullContent = relatedSection === undefined
        ? args.content
        : `${args.content}\n\n## Related\n\n${relatedSection}`;

      const result = await this.memory.editNote({
        title: args.title,
        content: fullContent,
        tags: args.tags,
        links,
      });
      if (result === undefined) {
        return { output: `Note not found: "${args.title}". No matching note with that exact title.` };
      }
      return { output: `Note edited: ${result.path}` };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { output: `Memory edit failed: ${message}`, isError: true };
    }
  }
}
