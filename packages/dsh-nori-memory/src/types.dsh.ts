/**
 * Minimal, self-declared DeepSeek Harness contract surface.
 *
 * The nori dsh-* packages deliberately avoid importing `@deepseek-ai/*`
 * runtime modules: tool definitions are plain JSON-shaped objects that
 * satisfy the `@deepseek-ai/dsh-tools` contract, and the Cordis context is
 * consumed through this narrow structural interface. The real runtime is
 * supplied by the DSH deployment that installs these packages.
 */

/** Opaque filesystem target returned by `ctx.fs.resolve`. */
export interface DshFsTarget {
  targetKey: unknown;
  displayPath: string;
}

export interface DshFsDirEntry {
  name: string;
  type: 'file' | 'directory' | 'other';
  target: DshFsTarget;
}

export interface DshFsWriteOutcome {
  operation: 'create' | 'update';
}

/** Structural subset of the DSH `fs` service. */
export interface DshFs {
  resolve(path: string, opts?: { cwd?: string }): Promise<DshFsTarget | undefined>;
  readText(target: DshFsTarget): Promise<string>;
  writeText(target: DshFsTarget, content: string, ...rest: unknown[]): Promise<DshFsWriteOutcome>;
  listDir(target: DshFsTarget): Promise<DshFsDirEntry[]>;
}

/** Structural subset of the DSH `sandboxPolicy` service. */
export interface DshSandboxPolicy {
  workspaceRoot?: string;
  resolve(request: { session?: unknown; mode?: string }): unknown;
}

export interface DshSessionHeader {
  cwd?: string;
  origin?: string;
}

export interface DshSession {
  header: DshSessionHeader;
}

export interface DshAgent {
  id: string;
  session: DshSession;
}

/** Tool execution context (second `execute` argument). */
export interface DshToolExec {
  agent: DshAgent;
  signal: AbortSignal | undefined;
}

/** Lossless-JSON tool parameter/result shapes. */
export type DshToolParameters = Record<string, unknown>;
export type DshToolResult = string | { output?: string; isError?: boolean } | unknown;

export interface DshToolDefinition {
  name: string;
  description: string;
  parameters: DshToolParameters;
  output?: unknown;
  execute(args: DshToolParameters, exec?: DshToolExec): Promise<DshToolResult> | DshToolResult;
}

/** Structural subset of the DSH `tools` registry. */
export interface DshToolsRegistry {
  register(definition: DshToolDefinition): () => void;
  get(name: string): unknown;
}

/** Structural subset of the DSH `subagents` service. */
export interface DshSubagents {
  registerContinuableSetup(contribution: (childCtx: DshCordisContext) => () => void): () => void;
}

/** Minimal Cordis context face used by the plugin bodies. */
export interface DshCordisContext {
  get<T = unknown>(name: string): T | undefined;
  on(name: string, listener: (...args: unknown[]) => unknown): () => void;
  provide(name: string, value: unknown): () => void;
  effect(callback: () => unknown, label?: string): () => void;
}

/** Shared in-process bridge between the three nori dsh-* plugins. */
export interface NoriCore {
  memory?: {
    multiRetrieve(keywords: string[], options?: unknown, root?: string): Promise<unknown[]>;
    retrieveChain(input: unknown, root?: string): Promise<unknown>;
    writeNote(params: unknown, root?: string, policy?: unknown, signal?: unknown): Promise<unknown>;
    removeNote(title: string, root?: string, policy?: unknown, signal?: unknown): Promise<unknown>;
    preRetrieve(prompt: string, root?: string): Promise<{ rendered?: string; count: number }>;
  };
  loop?: unknown;
  subagent?: unknown;
}
