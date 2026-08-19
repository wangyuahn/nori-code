/**
 * Minimal, self-declared DeepSeek Harness contract surface for the loop
 * plugin. Runtime objects come from the DSH deployment; only the narrow
 * structural faces used here are declared.
 */

export interface DshSessionEvent {
  type: string;
  seq: number;
  time: number;
  data: Record<string, unknown>;
  ignorable?: true;
}

export interface DshSessionHeader {
  cwd?: string;
  origin?: string;
}

export interface DshSession {
  header: DshSessionHeader;
  events: readonly DshSessionEvent[];
}

export interface DshAgent {
  id: string;
  session: DshSession;
}

export interface DshToolExec {
  agent: DshAgent;
  signal: AbortSignal | undefined;
}

export type DshToolParameters = Record<string, unknown>;

export interface DshToolDefinition {
  name: string;
  description: string;
  parameters: DshToolParameters;
  output?: unknown;
  execute(args: DshToolParameters, exec?: DshToolExec): Promise<unknown> | unknown;
}

export interface DshToolsRegistry {
  register(definition: DshToolDefinition): () => void;
  get(name: string): unknown;
}

export interface DshPromptSection {
  name: string;
  order: number;
  text: string | ((context: { scope?: unknown; signal?: unknown }) => string);
}

export interface DshSystemPrompt {
  section(section: DshPromptSection): () => void;
}

/** Message injected into the step by the loop plugin. */
export interface InjectedMessage {
  id: string;
  role: 'user';
  content: { type: 'text'; text: string }[];
  source: { kind: 'plugin'; plugin: string; form: 'notice'; summary: string };
}

export interface PreStepPayload {
  agent: DshAgent;
  messages: unknown[];
  turn: number;
  step: number;
}

export interface PreStepDecision {
  kind: 'enter' | 'reject';
  messages: unknown[];
}

/** Shared in-process bridge between the three nori dsh-* plugins. */
export interface NoriCore {
  memory?: unknown;
  loop?: {
    pauseAgent(id: string): boolean;
    resumeAgent(id: string): boolean;
    pauseRule(name: string): boolean;
    resumeRule(name: string): boolean;
    pausedAgents(): string[];
    pausedRules(): string[];
    getPhases(): Record<string, string>;
  };
  subagent?: {
    typeOf(agentId: string): string | undefined;
  };
}

/** Minimal Cordis context face used by the plugin bodies. */
export interface DshCordisContext {
  get<T = unknown>(name: string): T | undefined;
  on(name: string, listener: (...args: unknown[]) => unknown): () => void;
  provide(name: string, value: unknown): () => void;
  effect(callback: () => unknown, label?: string): () => void;
}
