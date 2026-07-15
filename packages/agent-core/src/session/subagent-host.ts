import {
  APIProviderRateLimitError,
  isProviderRateLimitError,
  type TokenUsage,
} from '@nori-code/kosong';

import type { Agent } from '../agent';
import type { PromptOrigin } from '../agent/context';
import { ErrorCodes, type KimiErrorPayload } from '../errors';
import { DenyAllPermissionPolicy } from '../agent/permission/policies/deny-all';
import { InMemoryAgentRecordPersistence } from '../agent/records';
import { isAbortError } from '../loop/errors';
import {
  DEFAULT_AGENT_PROFILES,
  prepareSystemPromptContext,
  type ResolvedAgentProfile,
} from '../profile';
import {
  linkAbortSignal,
  userCancellationReason,
} from '../utils/abort';
import { collectGitContext } from './git-context';
import type { Session } from './index';
import {
  SubagentBatch,
  resolveSwarmMaxConcurrency,
  type SubagentResult,
  type SubagentSuspendedEvent,
  type QueuedSubagentTask,
} from './subagent-batch';
import {
  extractNoriMemoryKeywords,
  NoriMemoryChainQuerySchema,
  retrieveNoriMemoryChain,
  type NoriMemoryChainQuery,
  type NoriMemoryChainResult,
} from '../tools/builtin/nori/memory-chain';
import type { NoriMemoryProvider } from '../tools/builtin/nori/types';
import SUMMARY_CONTINUATION_PROMPT from './summary-continuation.md?raw';

export const DEFAULT_SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_SUBAGENT_TIMEOUT_DESCRIPTION = '30 minutes';

export type {
  SubagentResult as QueuedSubagentRunResult,
  QueuedSubagentTask,
  ResumeQueuedSubagentTask,
  SpawnQueuedSubagentTask,
} from './subagent-batch';

/**
 * A subagent summary shorter than this many characters triggers one
 * follow-up turn that asks the subagent to expand it, so the parent
 * agent receives a technically complete handoff.
 */
const SUMMARY_MIN_LENGTH = 200;
const SUMMARY_CONTINUATION_ATTEMPTS = 1;
const HOOK_TEXT_PREVIEW_LENGTH = 500;
const SUBAGENT_MAX_TOKENS_ERROR =
  'Subagent turn failed before completing its final summary: reason=max_tokens';
const TOOL_CALL_DISABLED_MESSAGE =
  'Tool calls are disabled for side questions. Answer with text only.';
const SUBAGENT_PROMPT_ORIGIN: PromptOrigin = { kind: 'system_trigger', name: 'subagent' };
const SIDE_QUESTION_SYSTEM_REMINDER = `
This is a side-channel conversation with the user. You should answer user questions directly based on what you already know.

IMPORTANT:
- You are a separate, lightweight instance.
- The main agent continues independently; do not reference being interrupted.
- Do not call any tools. All tool calls are disabled and will be rejected.
  Even though tool definitions are visible in this request, they exist only
  for technical reasons (prompt cache). You must not use them.
- Respond only with text based on what you already know from the conversation
  and this side-channel conversation.
- Follow-up turns may happen in this side-channel conversation.
- If you do not know the answer, say so directly.
`;

const ASK_PARENT_SYSTEM_REMINDER = `
A child agent has asked you a question and is waiting for your guidance.
You are answering as the parent agent, with access to the full task context.

IMPORTANT:
- Answer the child's question directly and concisely.
- Draw on your knowledge of the overall task, the plan, and past decisions.
- Do not call any tools. All tool calls are disabled and will be rejected.
- Answer in a single turn; the child agent is blocked waiting.
- If you do not know the answer, say so directly and suggest next steps.
`;

const ASK_PARENT_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

export interface RunSubagentOptions {
  readonly parentToolCallId: string;
  readonly parentToolCallUuid?: string;
  readonly prompt: string;
  readonly description: string;
  readonly swarmIndex?: number;
  readonly runInBackground: boolean;
  readonly signal: AbortSignal;
  readonly onReady?: () => void;
  readonly suppressRateLimitFailureEvent?: boolean;
}

export interface SpawnSubagentOptions extends RunSubagentOptions {
  readonly profileName: string;
  readonly swarmItem?: string;
}

type SubagentCompletion = {
  readonly result: string;
  readonly usage?: TokenUsage;
};

export type SubagentHandle = {
  readonly agentId: string;
  readonly profileName: string;
  readonly resumed: boolean;
  readonly completion: Promise<SubagentCompletion>;
};

export class SessionSubagentHost {
  private readonly activeChildren = new Map<
    string,
    {
      readonly controller: AbortController;
      runInBackground: boolean;
    }
  >();

  // Nori runtime settings propagated through nested subagents.
  private _noriSwarmDepth: number = 0;
  private _noriMaxSwarmDepth: number = 2;
  private _noriMemory?: NoriMemoryProvider;
  private _noriRetrievalGate?: { triggerMode: string; maxResults: number };

  setNoriConfig(config: {
    depth: number;
    maxDepth: number;
    memory?: NoriMemoryProvider;
    retrievalGate?: { triggerMode: string; maxResults: number };
  }): void {
    this._noriSwarmDepth = config.depth;
    this._noriMaxSwarmDepth = config.maxDepth;
    this._noriMemory = config.memory;
    this._noriRetrievalGate = config.retrievalGate;
  }

  constructor(
    private readonly session: Session,
    private readonly ownerAgentId: string,
  ) {}

  async spawn(options: SpawnSubagentOptions): Promise<SubagentHandle> {
    options.signal.throwIfAborted();

    const parent = await this.session.ensureAgentResumed(this.ownerAgentId);
    const profile = this.resolveProfile(parent, options.profileName);
    const { id, agent } = await this.session.createAgent(
      { type: 'sub', generate: parent.rawGenerate },
      { parentAgentId: this.ownerAgentId, swarmItem: options.swarmItem },
    );

    // Propagate Nori depth, memory, and retrieval settings to the child host.
    const childHost = agent.subagentHost as SessionSubagentHost;
    childHost?.setNoriConfig({
      depth: this._noriSwarmDepth + 1,
      maxDepth: this._noriMaxSwarmDepth,
      memory: this._noriMemory,
      retrievalGate: this._noriRetrievalGate,
    });

    const completion = this.runWithActiveChild(id, options, async (runOptions) => {
      this.emitSubagentSpawned(parent, id, profile.name, runOptions);
      try {
        await this.configureChild(parent, agent, profile);
        return await this.runPromptTurn(parent, id, agent, profile.name, runOptions);
      } catch (error) {
        this.emitSubagentFailed(parent, id, runOptions, error);
        throw error;
      }
    });
    return {
      agentId: id,
      profileName: profile.name,
      resumed: false,
      completion,
    };
  }

  async resume(agentId: string, options: RunSubagentOptions): Promise<SubagentHandle> {
    options.signal.throwIfAborted();
    const { parent, child, profileName } = await this.ensureIdleSubagent(agentId);
    const completion = this.runWithActiveChild(agentId, options, async (runOptions) => {
      this.emitSubagentSpawned(parent, agentId, profileName, runOptions);
      try {
        child.config.update({ modelAlias: parent.config.modelAlias });
        return await this.runPromptTurn(parent, agentId, child, profileName, runOptions);
      } catch (error) {
        this.emitSubagentFailed(parent, agentId, runOptions, error);
        throw error;
      }
    });
    return { agentId, profileName, resumed: true, completion };
  }

  async retry(agentId: string, options: RunSubagentOptions): Promise<SubagentHandle> {
    options.signal.throwIfAborted();
    const { parent, child, profileName } = await this.ensureIdleSubagent(agentId);
    const completion = this.runWithActiveChild(agentId, options, async (runOptions) => {
      try {
        runOptions.signal.throwIfAborted();
        child.config.update({ modelAlias: parent.config.modelAlias });
        this.emitSubagentStarted(parent, agentId);
        const turnId = child.turn.retry('agent-host');
        if (turnId === null) {
          throw new Error(`Agent instance "${agentId}" could not start a retry turn`);
        }
        this.observeFirstRequest(child, runOptions);
        return await this.waitForChildCompletion(parent, agentId, child, profileName, runOptions);
      } catch (error) {
        this.emitSubagentFailed(parent, agentId, runOptions, error);
        throw error;
      }
    });
    return { agentId, profileName, resumed: true, completion };
  }

  private async ensureIdleSubagent(
    agentId: string,
  ): Promise<{ readonly parent: Agent; readonly child: Agent; readonly profileName: string }> {
    const parent = await this.session.ensureAgentResumed(this.ownerAgentId);
    const metadata = this.session.metadata.agents[agentId];
    if (metadata?.type !== 'sub') {
      throw new Error(`Agent instance "${agentId}" is not a subagent`);
    }
    if (metadata.parentAgentId !== this.ownerAgentId) {
      throw new Error(`Agent instance "${agentId}" does not belong to this parent agent`);
    }
    const child = await this.session.ensureAgentResumed(agentId);
    if (this.activeChildren.has(agentId) || child.turn.hasActiveTurn) {
      throw new Error(`Agent instance "${agentId}" is already running and cannot run concurrently`);
    }

    const profileName = child.config.profileName ?? 'subagent';
    return { parent, child, profileName };
  }

  async runQueued<T>(tasks: readonly QueuedSubagentTask<T>[]): Promise<Array<SubagentResult<T>>> {
    const maxConcurrency = resolveSwarmMaxConcurrency();
    return new SubagentBatch(this, tasks, { maxConcurrency }).run();
  }

  suspended(event: SubagentSuspendedEvent): void {
    const parent = this.session.getReadyAgent?.(this.ownerAgentId);
    parent?.emitEvent({
      type: 'subagent.suspended',
      subagentId: event.agentId,
      reason: event.reason,
    });
  }

  async startBtw(): Promise<string> {
    const parent = await this.session.ensureAgentResumed(this.ownerAgentId);
    const { id, agent: child } = await this.session.createAgent(
      {
        type: 'sub',
        generate: parent.rawGenerate,
        persistence: new InMemoryAgentRecordPersistence(),
      },
      { parentAgentId: this.ownerAgentId, persistMetadata: false },
    );

    child.config.update({
      modelAlias: parent.config.modelAlias,
      thinkingEffort: parent.config.thinkingEffort,
      systemPrompt: parent.config.systemPrompt,
    });
    child.tools.copyLoopToolsFrom(parent.tools);
    child.context.useProjectedHistoryFrom(parent.context);
    child.context.appendSystemReminder(SIDE_QUESTION_SYSTEM_REMINDER.trim(), {
      kind: 'system_trigger',
      name: 'btw',
    });
    child.permission.policies.unshift(new DenyAllPermissionPolicy(TOOL_CALL_DISABLED_MESSAGE));
    return id;
  }

  async askOwnerParent(question: string): Promise<string> {
    const metadata = this.session.metadata.agents[this.ownerAgentId];
    if (metadata?.type !== 'sub' || metadata.parentAgentId === null) {
      throw new Error('nori_ask_parent is only available from a subagent with a parent agent');
    }
    const parent = await this.session.ensureAgentResumed(metadata.parentAgentId);
    const parentHost = parent.subagentHost as SessionSubagentHost | undefined;
    if (parentHost === undefined) {
      throw new Error('Parent agent does not have a subagent host');
    }
    return parentHost.askParent(question, this.ownerAgentId);
  }

  async askParent(question: string, childId: string): Promise<string> {
    const parent = await this.session.ensureAgentResumed(this.ownerAgentId);

    const { agent: answerer } = await this.session.createAgent(
      {
        type: 'sub',
        generate: parent.rawGenerate,
        persistence: new InMemoryAgentRecordPersistence(),
      },
      { parentAgentId: this.ownerAgentId, persistMetadata: false },
    );

    answerer.config.update({
      modelAlias: parent.config.modelAlias,
      thinkingEffort: parent.config.thinkingEffort,
      systemPrompt: parent.config.systemPrompt,
    });
    answerer.tools.copyLoopToolsFrom(parent.tools);
    answerer.context.useProjectedHistoryFrom(parent.context);
    answerer.context.appendSystemReminder(ASK_PARENT_SYSTEM_REMINDER.trim(), {
      kind: 'system_trigger',
      name: 'ask_parent',
    });
    answerer.permission.policies.unshift(new DenyAllPermissionPolicy(TOOL_CALL_DISABLED_MESSAGE));

    const turnId = answerer.turn.prompt(
      [{ type: 'text', text: `[Child agent ${childId} asks]\n${question}` }],
      { kind: 'system_trigger', name: 'ask_parent' },
    );

    if (turnId === null) {
      throw new Error('Could not start ask-parent turn for the parent agent');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('askParent timed out')), ASK_PARENT_TIMEOUT_MS);

    try {
      await runChildTurnToCompletion(answerer, controller.signal);
      return lastAssistantText(answerer);
    } finally {
      clearTimeout(timeout);
    }
  }

  cancelAll(reason: unknown = userCancellationReason()): void {
    const foregroundChildren = Array.from(this.activeChildren).filter(
      ([, child]) => !child.runInBackground,
    );
    for (const [childId, child] of foregroundChildren) {
      this.session.getReadyAgent(childId)?.subagentHost?.cancelAll(reason);
      // Abort with the cancel reason (a user interruption by default) so the
      // subagent's in-flight tools report the cause accurately to the model.
      child.controller.abort(reason);
    }
  }

  markActiveChildDetached(agentId: string): void {
    const child = this.activeChildren.get(agentId);
    if (child !== undefined) child.runInBackground = true;
  }

  async getProfileName(agentId: string): Promise<string | undefined> {
    const metadata = this.session.metadata.agents[agentId];
    if (metadata?.type !== 'sub' || metadata.parentAgentId !== this.ownerAgentId) {
      return undefined;
    }
    return (await this.session.ensureAgentResumed(agentId)).config.profileName;
  }

  getSwarmItem(agentId: string): string | undefined {
    const metadata = this.session.metadata.agents[agentId];
    if (metadata?.type !== 'sub' || metadata.parentAgentId !== this.ownerAgentId) {
      return undefined;
    }
    return metadata.swarmItem;
  }

  private resolveProfile(parent: Agent, profileName: string): ResolvedAgentProfile {
    const profile =
      DEFAULT_AGENT_PROFILES[parent.config.profileName ?? 'agent']?.subagents?.[profileName] ??
      DEFAULT_AGENT_PROFILES['agent']?.subagents?.[profileName];
    if (profile === undefined) {
      throw new Error(`Subagent profile "${profileName}" was not found`);
    }
    return profile;
  }

  private runWithActiveChild(
    childId: string,
    options: RunSubagentOptions,
    run: (options: RunSubagentOptions) => Promise<SubagentCompletion>,
  ): Promise<SubagentCompletion> {
    const controller = new AbortController();
    const unlinkAbortSignal = linkAbortSignal(options.signal, controller);
    this.activeChildren.set(childId, {
      controller,
      runInBackground: options.runInBackground,
    });

    return run({ ...options, signal: controller.signal }).finally(() => {
      unlinkAbortSignal();
      this.activeChildren.delete(childId);
    });
  }

  private async runPromptTurn(
    parent: Agent,
    childId: string,
    child: Agent,
    profileName: string,
    options: RunSubagentOptions,
  ): Promise<SubagentCompletion> {
    options.signal.throwIfAborted();
    await this.triggerSubagentStart(parent, profileName, options.prompt, options.signal);
    options.signal.throwIfAborted();

    let childPrompt = options.prompt;
    if (profileName === 'explore') {
      const gitContext = await collectGitContext(child.kaos, child.config.cwd);
      if (gitContext) childPrompt = `${gitContext}\n\n${childPrompt}`;
    }

    const retrievedContext = await this.tryBuildNoriRetrievedContext(child, childPrompt, options.signal);
    if (retrievedContext !== undefined) childPrompt = `${retrievedContext}\n\n${childPrompt}`;

    this.emitSubagentStarted(parent, childId);
    const turnId = child.turn.prompt([{ type: 'text', text: childPrompt }], SUBAGENT_PROMPT_ORIGIN);
    if (turnId === null) {
      throw new Error(`Agent instance "${childId}" could not start a turn`);
    }
    this.observeFirstRequest(child, options);
    return this.waitForChildCompletion(parent, childId, child, profileName, options);
  }

  private async tryBuildNoriRetrievedContext(
    child: Agent,
    childPrompt: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const memory = this._noriMemory;
    if (memory === undefined || !this.shouldRunNoriRetrieval(childPrompt)) return undefined;

    try {
      const maxResults = clampInteger(this._noriRetrievalGate?.maxResults, 10, 1, 20);
      const query =
        (await this.requestNoriRetrievalQuery(child, maxResults, signal)) ??
        fallbackNoriMemoryQuery(childPrompt, maxResults);
      if (query === undefined) return undefined;
      const result = await retrieveNoriMemoryChain(memory, query);
      if (result.uniqueResults.length === 0) return undefined;
      return renderNoriRetrievedContext(result);
    } catch {
      // Retrieval failure should not block the subagent's primary task.
      return undefined;
    }
  }

  private shouldRunNoriRetrieval(childPrompt: string): boolean {
    const triggerMode = this._noriRetrievalGate?.triggerMode ?? 'always';
    if (['never', 'disabled', 'off', 'none'].includes(triggerMode)) return false;
    if (triggerMode === 'on_keywords') {
      return extractNoriMemoryKeywords(childPrompt, 1).length > 0;
    }
    return true;
  }

  private async requestNoriRetrievalQuery(
    child: Agent,
    maxResults: number,
    signal: AbortSignal,
  ): Promise<NoriMemoryChainQuery | undefined> {
    const retrievalPrompt = [
      'Output ONLY one <retrieval_query> block for shared memory search.',
      'Use concrete keywords from the task: file paths, symbols, errors, settings, feature names.',
      'Use chain_depth 1 or 2 when linked context may matter. Add follow_up_keywords if you can predict second-hop terms.',
      'Do not include markdown, explanation, or any text outside the XML block.',
      '',
      '<retrieval_query>',
      JSON.stringify(
        {
          keywords: ['specific', 'technical', 'terms'],
          note_types: ['analysis', 'decisions', 'reviews'],
          include_linked: true,
          link_depth: 1,
          chain_depth: 1,
          follow_up_keywords: [['related', 'second-hop', 'terms']],
          max_results: maxResults,
        },
        null,
        2,
      ),
      '</retrieval_query>',
    ].join('\n');
    const retrievalTurnId = child.turn.prompt(
      [{ type: 'text', text: retrievalPrompt }],
      SUBAGENT_PROMPT_ORIGIN,
    );
    if (retrievalTurnId === null) return undefined;
    await runChildTurnToCompletion(child, signal);
    return parseNoriRetrievalQuery(lastAssistantText(child), maxResults);
  }

  private async waitForChildCompletion(
    parent: Agent,
    childId: string,
    child: Agent,
    profileName: string,
    options: RunSubagentOptions,
  ): Promise<SubagentCompletion> {
    await runChildTurnToCompletion(child, options.signal);

    // A subagent that returns an overly terse summary leaves the parent
    // agent under-informed. Give it a bounded number of chances to expand
    // the handoff; if it is still short after that, accept it as-is rather
    // than retrying indefinitely.
    let result = lastAssistantText(child);
    let remainingContinuations = SUMMARY_CONTINUATION_ATTEMPTS;
    while (remainingContinuations > 0 && result.length < SUMMARY_MIN_LENGTH) {
      remainingContinuations -= 1;
      options.signal.throwIfAborted();
      child.turn.prompt([{ type: 'text', text: SUMMARY_CONTINUATION_PROMPT }], SUBAGENT_PROMPT_ORIGIN);
      await runChildTurnToCompletion(child, options.signal);
      result = lastAssistantText(child);
    }
    const usage = child.usage.data().total;
    parent.emitEvent({
      type: 'subagent.completed',
      subagentId: childId,
      resultSummary: result,
      usage,
      contextTokens: child.context.tokenCount,
    });
    this.triggerSubagentStop(parent, profileName, result);
    return { result, usage };
  }

  private async configureChild(
    parent: Agent,
    child: Agent,
    profile: ResolvedAgentProfile,
  ): Promise<void> {
    // A subagent always inherits the parent agent's model.
    child.config.update({
      cwd: parent.config.cwd,
      modelAlias: parent.config.modelAlias,
      thinkingEffort: parent.config.thinkingEffort,
    });

    // Inherit coderWriteEnabled so the ReadonlyPermissionPolicy honors it.
    child.coderWriteEnabled = parent.coderWriteEnabled;

    const context = await prepareSystemPromptContext(
      this.session.systemContextKaos(child.kaos.getcwd()),
      this.session.options.kimiHomeDir,
      { additionalDirs: child.getAdditionalDirs() },
    );
    child.useProfile(profile, context, this.session.options.kimiHomeDir);
    child.tools.inheritUserTools(parent.tools);

    // When coderWriteEnabled is true, grant the child agent auto permission
    // mode so swarm coding agents don't require manual approval for every
    // tool call. Without this, FallbackAskPolicy blocks Write/Edit/Bash in
    // manual mode even when coderWriteEnabled bypasses ReadonlyPermissionPolicy.
    if (child.coderWriteEnabled) {
      child.permission.setMode('auto');
    }

    // Nori swarm depth gate.
    const depth = this._noriSwarmDepth;
    const maxDepth = this._noriMaxSwarmDepth;

    // Remove nested swarm APIs at the configured max depth.
    if (depth >= maxDepth) {
      child.tools.setActiveTools(
        child.tools.loopTools
          .map((tool) => tool.name)
          .filter((name) => name !== 'AgentSwarm' && name !== 'nori_swarm_launch'),
      );
    }

    // Nori retrieval gate prompt, driven by runtime settings.
    const gate = this._noriRetrievalGate;
    const triggerMode = gate?.triggerMode ?? 'always';
    const maxResults = gate?.maxResults ?? 10;

    const triggerInstruction =
      triggerMode === 'always'
        ? 'This step is MANDATORY. You MUST output the retrieval query before any other work.'
        : triggerMode === 'on_keywords'
          ? 'Perform this step if the task contains technical keywords that may match existing notes.'
          : 'Perform this step to ensure you have the latest context from shared memory.';

    const retrievalGatePrompt = this._noriMemory === undefined
      ? ''
      : `
## Phase 0: Knowledge Retrieval

Before you begin, output a retrieval query to search the shared memory:

<retrieval_query>
{
  "keywords": ["specific", "technical", "terms"],
  "note_types": ["analysis", "decisions", "reviews"],
  "include_linked": true,
  "link_depth": 1,
  "chain_depth": 1,
  "follow_up_keywords": [["related", "second-hop", "terms"]],
  "max_results": ${maxResults}
}
</retrieval_query>

${triggerInstruction}

Wait for the system to inject <retrieved_context>, then continue with your task. If the injected
memory is incomplete, call nori_memory_search again with better keywords.
`;

    const depthInfo = `
## Swarm Context
Swarm depth: ${depth}/${maxDepth}.
${
  depth >= maxDepth
    ? 'AgentSwarm and nori_swarm_launch are NOT available at this depth.'
    : `You may spawn up to ${maxDepth - depth} more level(s) of sub-agents.`
}
`;

    // Append Nori runtime context to the child system prompt.
    const currentPrompt = child.config.systemPrompt;
    const noriPrompt = [retrievalGatePrompt, depthInfo].filter((block) => block.trim().length > 0).join('\n\n');
    child.config.update({
      systemPrompt: currentPrompt + '\n\n' + noriPrompt,
    });
  }

  private async triggerSubagentStart(
    parent: Agent,
    profileName: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<void> {
    await parent.hooks?.trigger('SubagentStart', {
      matcherValue: profileName,
      signal,
      inputData: {
        agentName: profileName,
        prompt: prompt.slice(0, HOOK_TEXT_PREVIEW_LENGTH),
      },
    });
  }

  private triggerSubagentStop(parent: Agent, profileName: string, result: string): void {
    void parent.hooks?.fireAndForgetTrigger('SubagentStop', {
      matcherValue: profileName,
      inputData: {
        agentName: profileName,
        response: result.slice(0, HOOK_TEXT_PREVIEW_LENGTH),
      },
    });
  }

  private observeFirstRequest(
    child: Agent,
    options: RunSubagentOptions,
  ): void {
    if (options.onReady === undefined) return;
    void child.turn
      .waitForTurnFirstRequest()
      .then(() => {
        options.onReady?.();
      })
      .catch(() => {});
  }

  private emitSubagentSpawned(
    parent: Agent,
    childId: string,
    profileName: string,
    options: RunSubagentOptions,
  ): void {
    parent.emitEvent({
      type: 'subagent.spawned',
      subagentId: childId,
      subagentName: profileName,
      parentToolCallId: options.parentToolCallId,
      parentToolCallUuid: options.parentToolCallUuid,
      parentAgentId: this.ownerAgentId,
      description: options.description,
      swarmIndex: options.swarmIndex,
      runInBackground: options.runInBackground,
    });
    parent.telemetry.track('subagent_created', {
      subagent_name: profileName,
      run_in_background: options.runInBackground,
    });
  }

  private emitSubagentStarted(
    parent: Agent,
    childId: string,
  ): void {
    parent.emitEvent({
      type: 'subagent.started',
      subagentId: childId,
    });
  }

  private emitSubagentFailed(
    parent: Agent,
    childId: string,
    options: RunSubagentOptions,
    error: unknown,
  ): void {
    if (shouldSuppressQueuedAttemptFailureEvent(options, error)) return;
    parent.emitEvent({
      type: 'subagent.failed',
      subagentId: childId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseNoriRetrievalQuery(
  text: string,
  maxResults: number,
): NoriMemoryChainQuery | undefined {
  const queryText = extractRetrievalQueryText(text);
  if (queryText === undefined) return undefined;
  try {
    const raw = JSON.parse(stripJsonFence(queryText)) as unknown;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
    const parsed = NoriMemoryChainQuerySchema.safeParse(
      normalizeNoriRetrievalQuery(raw as Record<string, unknown>, maxResults),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function extractRetrievalQueryText(text: string): string | undefined {
  const match = text.match(/<retrieval_query>([\s\S]*?)<\/retrieval_query>/i);
  if (match?.[1] !== undefined) return match[1];
  const trimmed = text.trim();
  return trimmed.startsWith('{') && trimmed.endsWith('}') ? trimmed : undefined;
}

function normalizeNoriRetrievalQuery(
  raw: Record<string, unknown>,
  maxResults: number,
): Record<string, unknown> {
  const linkDepth = clampInteger(raw['link_depth'] ?? raw['link_traverse_depth'], 1, 0, 2);
  return {
    keywords: toStringArray(raw['keywords']),
    note_types: toStringArray(raw['note_types']),
    top_k: clampInteger(raw['top_k'] ?? raw['max_results'], maxResults, 1, 20),
    include_linked: booleanFromUnknown(raw['include_linked'], linkDepth > 0),
    link_depth: linkDepth,
    chain_depth: clampInteger(raw['chain_depth'] ?? raw['memory_chain_depth'], 1, 0, 3),
    follow_up_keywords: normalizeFollowUpKeywords(raw['follow_up_keywords']),
  };
}

function fallbackNoriMemoryQuery(
  prompt: string,
  maxResults: number,
): NoriMemoryChainQuery | undefined {
  const keywords = extractNoriMemoryKeywords(prompt, 8);
  if (keywords.length === 0) return undefined;
  const parsed = NoriMemoryChainQuerySchema.safeParse({
    keywords,
    note_types: ['analysis', 'decisions', 'reviews'],
    top_k: maxResults,
    include_linked: true,
    link_depth: 1,
    chain_depth: 1,
  });
  return parsed.success ? parsed.data : undefined;
}

function renderNoriRetrievedContext(result: NoriMemoryChainResult): string {
  const lines = [
    `<retrieved_context unique_count="${String(result.uniqueResults.length)}" hops="${String(result.hops.length)}">`,
    '<instruction>Use this shared memory as prior context. You may call nori_memory_search again with new keywords if needed.</instruction>',
  ];
  const renderedPaths = new Set<string>();
  for (const hop of result.hops) {
    lines.push(
      `<memory_hop index="${String(hop.index)}" source="${hop.source}" keywords="${escapeXmlAttribute(hop.keywords.join(', '))}">`,
    );
    for (const note of hop.results) {
      if (renderedPaths.has(note.path)) continue;
      renderedPaths.add(note.path);
      const score = note.score === undefined ? '' : ` score="${escapeXmlAttribute(note.score.toFixed(3))}"`;
      lines.push(
        `<note path="${escapeXmlAttribute(note.path)}"${score}>`,
        `<title>${escapeXmlText(note.title)}</title>`,
        `<content>${escapeXmlText(truncateForRetrievedContext(note.excerpt ?? note.content ?? ''))}</content>`,
        '</note>',
      );
    }
    lines.push('</memory_hop>');
  }
  lines.push('</retrieved_context>');
  return lines.join('\n');
}

function normalizeFollowUpKeywords(value: unknown): string[][] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.every((entry) => typeof entry === 'string')) {
    const keywords = toStringArray(value);
    if (keywords === undefined) return undefined;
    return keywords.length === 0 ? undefined : [keywords];
  }
  const normalized = value
    .filter((entry): entry is unknown[] => Array.isArray(entry))
    .map((entry) => toStringArray(entry))
    .filter((entry): entry is string[] => entry !== undefined && entry.length > 0);
  return normalized.length === 0 ? undefined : normalized;
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return strings.length === 0 ? undefined : strings;
}

function stripJsonFence(text: string): string {
  return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
}

function clampInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : Number.NaN;
  const integer = Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
  return Math.min(max, Math.max(min, integer));
}

function booleanFromUnknown(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
  }
  return fallback;
}

function truncateForRetrievedContext(text: string): string {
  const normalized = text.replaceAll(/\s+/g, ' ').trim();
  if (normalized.length <= 1200) return normalized;
  return `${normalized.slice(0, 1197)}...`;
}

function escapeXmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replaceAll('"', '&quot;');
}

async function runChildTurnToCompletion(child: Agent, signal: AbortSignal): Promise<void> {
  const completion = await child.turn.waitForCurrentTurn(signal);
  const turnEnded = completion.event;
  if (turnEnded.reason !== 'completed') {
    if (turnEnded.reason === 'filtered') {
      throw new Error('Subagent turn blocked by provider safety policy');
    }
    if (turnEnded.error?.code === ErrorCodes.PROVIDER_RATE_LIMIT) {
      throw providerRateLimitErrorFromPayload(turnEnded.error);
    }
    throw new Error(
      turnEnded.error === undefined
        ? `Subagent turn ${turnEnded.reason}`
        : `[${turnEnded.error.code}] ${turnEnded.error.message}`,
    );
  }
  if (completion.stopReason === 'max_tokens') {
    throw new Error(`${SUBAGENT_MAX_TOKENS_ERROR}.`);
  }
}

function providerRateLimitErrorFromPayload(error: KimiErrorPayload): APIProviderRateLimitError {
  const requestId =
    typeof error.details?.['requestId'] === 'string' ? error.details['requestId'] : null;
  return new APIProviderRateLimitError(error.message, requestId);
}

function lastAssistantText(agent: Agent): string {
  for (const message of [...agent.context.history].toReversed()) {
    if (message.role !== 'assistant') continue;
    const text = message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('');
    if (text.trim().length > 0) return text.trim();
  }
  return '';
}

function shouldSuppressQueuedAttemptFailureEvent(
  options: RunSubagentOptions,
  error: unknown,
): boolean {
  if (options.suppressRateLimitFailureEvent !== true) return false;
  if (isProviderRateLimitError(error)) return true;
  return isAbortError(error) || options.signal.aborted;
}
