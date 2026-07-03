import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import {
  formatNoriMemoryChainResult,
  NoriMemoryChainQuerySchema,
  retrieveNoriMemoryChain,
  type NoriMemoryChainQueryInput,
} from './memory-chain';
import type { NoriMemoryProvider } from './types';

const DESCRIPTION = `Search the Obsidian shared memory vault for relevant context.
Use this before making design decisions or writing code that affects
shared modules, to find past architecture decisions, code analyses,
and review records. This is a model-callable API and can be called
again whenever new keywords, errors, or follow-up questions appear.

Parameters:
- keywords: array of search terms. Use concrete technical terms,
  function names, error messages, or concept labels. NOT generic words.
- note_types (optional): filter by note type. 'tasks', 'analysis',
  'reviews', 'decisions'. Empty = search all.
- top_k (optional): max results to return. Default 10, max 20.
- include_linked (optional): whether to expand results with
  [[bidirectional link]] neighbors. Default false.
- link_depth (optional): link graph traversal depth. 1 = direct
  neighbors. Default 0.
- chain_depth (optional): extra retrieval hops after the first search.
  Use 1-2 when you need linked or related memory.
- follow_up_keywords (optional): explicit keyword sets for chained hops.`;

export const NoriMemorySearchInputSchema = NoriMemoryChainQuerySchema;
type NoriMemorySearchInput = NoriMemoryChainQueryInput;

export class NoriMemorySearchTool implements BuiltinTool<NoriMemorySearchInput> {
  readonly name = 'nori_memory_search' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(NoriMemorySearchInputSchema);

  constructor(private readonly memory: NoriMemoryProvider) {}

  resolveExecution(args: NoriMemorySearchInput): ToolExecution {
    return {
      accesses: ToolAccesses.none(),
      description: `Searching Obsidian memory for: ${args.keywords.join(', ')}`,
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: NoriMemorySearchInput,
    _context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const result = await retrieveNoriMemoryChain(this.memory, args);
      return { output: formatNoriMemoryChainResult(result) };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { output: `Memory search failed: ${message}`, isError: true };
    }
  }
}
