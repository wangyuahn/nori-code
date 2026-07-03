import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import type { NoriMemoryProvider } from './types';

const DESCRIPTION = `Write a note to the Obsidian shared memory vault.

TWO-PHASE WRITE:
1. First call with links=[] — the system searches the vault using your
   tags+title as keywords, returns matching note titles for you to review.
2. Retry with the correct titles in links — system auto-generates [[wiki-links]].

Parameters:
- note_type: 'analysis', 'decision', 'task', or 'review'.
- title: plain text title.
- content: full markdown content. DO NOT manually write [[wiki-links]].
- links (required): [] to trigger auto-search, or list of note titles to link.
- tags (optional): used as search keywords when links is empty.`;

const NoriMemoryWriteInputSchema = z.object({
  note_type: z.enum(['analysis', 'decision', 'task', 'review']),
  title: z.string().min(1).max(200),
  content: z.string().min(1),
  tags: z.array(z.string()).optional(),
  links: z.array(z.string()),
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
      // Phase 1: if links is empty, force the model to provide search keywords
      // instead of writing with no links. Return the keywords and results so
      // the model can pick the right note titles and retry with proper links.
      if (args.links.length === 0) {
        const keywords = args.tags ?? [args.title];
        const results = await this.memory.multiRetrieve(keywords, { top_k: 5 });
        const titles = results.map(r => r.title);
        return {
          output: [
            'No links provided. Search the vault first, then retry with the correct note titles in the links parameter.',
            '',
            `Suggested search: pass links: [${titles.slice(0, 5).map(t => `"${t}"`).join(', ')}]`,
            '',
            'Recent matching notes:',
            ...titles.map(t => `  - ${t}`),
          ].join('\n'),
        };
      }

      // Phase 2: links provided, write the note with auto-generated [[wiki-links]]
      const relatedSection = args.links.length > 0
        ? args.links.map(l => `- [[${l}]]`).join('\n')
        : '_None_';
      const fullContent = args.content + '\n\n## Related\n\n' + relatedSection;

      const result = await this.memory.writeNote({
        note_type: args.note_type,
        title: args.title,
        content: fullContent,
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
