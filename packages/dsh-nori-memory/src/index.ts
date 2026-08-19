/**
 * @nori-code/dsh-nori-memory — host plugin.
 *
 * Obsidian-style shared memory vault for DeepSeek Harness:
 * - `nori_memory_write` (two-phase link resolution),
 * - `nori_memory_search` (chained multi-hop retrieval),
 * - `nori_memory_remove` (moves the note into `.trash`),
 * - every continuable child receives the memory tools through
 *   `subagents.registerContinuableSetup`,
 * - publishes `nori-core.memory` for the sibling nori plugins.
 *
 * Runtime contract: plain JSON-shaped tool definitions registered through
 * `ctx.tools` (compatible with `@deepseek-ai/dsh-tools`); the Cordis context
 * is consumed through the narrow structural interface in `types.dsh.ts`.
 */

import type {
  DshCordisContext,
  DshFs,
  DshSandboxPolicy,
  DshSubagents,
  DshToolDefinition,
  DshToolExec,
  DshToolParameters,
  DshToolResult,
  DshToolsRegistry,
  NoriCore,
} from './types.dsh.js';
import { NoriVault, renderChainResult } from './vault.js';

export const name = 'nori-memory';

export const inject: string[] = ['tools'];

interface MemoryConfig {
  vaultPath?: string;
  topK?: number;
  maxChainDepth?: number;
}

interface HarnessConfig {
  memory?: MemoryConfig;
}

function workspaceFor(exec: DshToolExec | undefined, fallback: string): string {
  try {
    const agent = exec?.agent;
    const cwd = agent?.session?.header?.cwd;
    if (typeof cwd === 'string' && cwd.length > 0) return cwd;
  } catch {
    /* fall through */
  }
  return fallback;
}

function textOutput(value: string): DshToolResult {
  return value;
}

export function apply(ctx: DshCordisContext): void {
  const tools = ctx.get<DshToolsRegistry>('tools');
  if (tools === undefined) return;
  // Services resolved lazily at call time: the plugin must mount (and
  // publish `nori-core`) even when host services are not visible during
  // preset mount-validation.
  const fsNow = (): DshFs | undefined => ctx.get<DshFs>('fs');
  const sandboxNow = (): DshSandboxPolicy | undefined => ctx.get<DshSandboxPolicy>('sandboxPolicy');
  const toolsSvc: DshToolsRegistry = tools;

  let lastKnownRoot = '';
  const configCache = new Map<string, HarnessConfig>();
  const vaultCache = new Map<string, NoriVault>();

  function requireFs(): DshFs {
    const f = fsNow();
    if (f === undefined) throw new Error('nori-memory: fs service unavailable');
    return f;
  }

  async function configFor(root: string): Promise<HarnessConfig> {
    const cached = configCache.get(root);
    if (cached !== undefined) return cached;
    let cfg: HarnessConfig = {};
    try {
      const target = await requireFs().resolve(`${root.replace(/[\\/]+$/, '')}/nori-harness.json`, { cwd: root });
      if (target !== undefined) {
        const text = await requireFs().readText(target);
        const parsed = JSON.parse(text) as HarnessConfig;
        if (parsed !== null && typeof parsed === 'object') cfg = parsed;
      }
    } catch {
      /* config is optional */
    }
    configCache.set(root, cfg);
    return cfg;
  }

  async function vaultFor(root: string): Promise<NoriVault> {
    const cached = vaultCache.get(root);
    if (cached !== undefined) return cached;
    const cfg = await configFor(root);
    const relative = (cfg.memory?.vaultPath || 'nori-vault').replace(/^\.\//, '').replace(/^[\\/]+/, '');
    const vault = new NoriVault(requireFs(), root, relative, cfg.memory?.topK ?? 10, cfg.memory?.maxChainDepth ?? 3);
    vaultCache.set(root, vault);
    return vault;
  }

  function policyFor(exec: DshToolExec | undefined): unknown {
    const sandboxPolicy = sandboxNow();
    try {
      const session = exec?.agent?.session;
      if (session !== undefined) return sandboxPolicy?.resolve({ session });
    } catch {
      /* fall through */
    }
    try {
      return sandboxPolicy?.resolve({});
    } catch {
      return undefined;
    }
  }

  const memoryApi = {
    async multiRetrieve(keywords: string[], options?: unknown, root?: string): Promise<unknown[]> {
      const r = root ?? lastKnownRoot;
      return (await vaultFor(r)).multiRetrieve(keywords, options as never);
    },
    async retrieveChain(input: unknown, root?: string): Promise<unknown> {
      const r = root ?? lastKnownRoot;
      return (await vaultFor(r)).retrieveChain(input as never);
    },
    async writeNote(params: unknown, root?: string): Promise<unknown> {
      const r = root ?? lastKnownRoot;
      return (await vaultFor(r)).writeNote(params as never);
    },
    async removeNote(title: string, root?: string): Promise<unknown> {
      const r = root ?? lastKnownRoot;
      return (await vaultFor(r)).removeNote(title);
    },
    async preRetrieve(prompt: string, root?: string): Promise<{ rendered?: string; count: number }> {
      const r = root ?? lastKnownRoot;
      return (await vaultFor(r)).preRetrieve(prompt);
    },
  };

  const noriCore: NoriCore = (ctx.get('nori-core') as NoriCore | undefined) ?? {};
  noriCore.memory = memoryApi;
  if (ctx.get('nori-core') === undefined) ctx.provide('nori-core', noriCore);

  const memTool = (tool: DshToolDefinition): DshToolDefinition => ({
    ...tool,
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: DshToolParameters, exec?: DshToolExec): Promise<DshToolResult> {
      try {
        const root = workspaceFor(exec, lastKnownRoot);
        lastKnownRoot = root;
        await vaultFor(root);
        void policyFor(exec);
        const r = await tool.execute(args, exec);
        if (r !== null && typeof r === 'object' && (r as { output?: unknown }).output !== undefined) {
          const record = r as { output?: unknown; isError?: boolean };
          return record.isError === true ? `Error: ${String(record.output)}` : String(record.output);
        }
        return typeof r === 'string' ? r : JSON.stringify(r);
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  const writeTool: DshToolDefinition = memTool({
    name: 'nori_memory_write',
    description:
      'Write a note to the Obsidian shared memory vault.\n\nTWO-PHASE WRITE:\n1. First call with links=[] - the system searches the vault using your tags+title as keywords, returns matching note titles for you to review.\n2. Retry with the correct titles in links - system auto-generates [[wiki-links]].\n\nParameters:\n- note_type: \'analysis\', \'decision\', \'task\', or \'review\'.\n- title: plain text title.\n- content: full markdown content. DO NOT manually write [[wiki-links]].\n- links (required): [] to trigger auto-search, ["None"] to explicitly skip linking, or list of note titles to link.\n- tags (optional): used as search keywords when links is empty.',
    parameters: {
      type: 'object',
      properties: {
        note_type: { type: 'string', enum: ['analysis', 'decision', 'task', 'review'] },
        title: { type: 'string' },
        content: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        links: { type: 'array', items: { type: 'string' } },
      },
      required: ['note_type', 'title', 'content', 'links'],
    },
    async execute(args, exec) {
      const root = workspaceFor(exec, lastKnownRoot);
      lastKnownRoot = root;
      return (await vaultFor(root)).writeNote(args as never);
    },
  });

  const searchTool: DshToolDefinition = memTool({
    name: 'nori_memory_search',
    description:
      'Search the Obsidian shared memory vault with chained multi-hop retrieval. Returns notes with fulltext + graph-link scoring. Use concrete technical keywords (symbols, file names, errors, concept labels). Set chain_depth 1-2 and follow_up_keywords for linked memory discovery.',
    parameters: {
      type: 'object',
      properties: {
        keywords: { type: 'array', items: { type: 'string' } },
        note_types: { type: 'array', items: { type: 'string' } },
        top_k: { type: 'number' },
        include_linked: { type: 'boolean' },
        link_depth: { type: 'number' },
        chain_depth: { type: 'number' },
        follow_up_keywords: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
      },
      required: ['keywords'],
    },
    async execute(args, exec) {
      const root = workspaceFor(exec, lastKnownRoot);
      lastKnownRoot = root;
      return renderChainResult(await (await vaultFor(root)).retrieveChain(args as never));
    },
  });

  const removeTool: DshToolDefinition = memTool({
    name: 'nori_memory_remove',
    description:
      'Remove a note from the Obsidian shared memory vault by exact title. The note moves to the vault .trash folder.',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    },
    async execute(args, exec) {
      const root = workspaceFor(exec, lastKnownRoot);
      lastKnownRoot = root;
      const r = await (await vaultFor(root)).removeNote(String(args['title'] ?? ''));
      return r.ok ? textOutput(`Note removed: ${r.path} (moved to .trash)`) : textOutput(`Error: ${r.error}`);
    },
  });

  toolsSvc.register(writeTool);
  toolsSvc.register(searchTool);
  toolsSvc.register(removeTool);

  const subagents = ctx.get<DshSubagents>('subagents');
  if (subagents !== undefined && typeof subagents.registerContinuableSetup === 'function') {
    subagents.registerContinuableSetup((childCtx: DshCordisContext) => {
      const childTools = childCtx.get<DshToolsRegistry>('tools');
      if (childTools === undefined) return () => undefined;
      const disposers = [
        childTools.register(writeTool),
        childTools.register(searchTool),
        childTools.register(removeTool),
      ];
      return () => {
        for (const d of disposers) d();
      };
    });
  }
}
