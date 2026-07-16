import { z } from 'zod';
import { grandTotal, inputTotal, type TokenUsage } from '@nori-code/kosong';

import { SwarmBackgroundTask, type BackgroundManager, type SwarmTaskControl } from '../../../agent/background';
import type { SwarmMode } from '../../../agent/swarm';
import type { BuiltinTool } from '../../../agent/tool';
import type { QueuedSubagentTask, SessionSubagentHost } from '../../../session/subagent-host';
import {
  SubagentBatch,
  type SubagentResult,
} from '../../../session/subagent-batch';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import AGENT_SWARM_DESCRIPTION from './agent-swarm.md?raw';
import type { ResolvedAgentProfile } from '../../../profile';

const DEFAULT_SUBAGENT_TYPE = 'orchestrator';
const PROMPT_TEMPLATE_PLACEHOLDER = '{{item}}';
const MAX_AGENT_SWARM_SUBAGENTS = 128;

const AgentSwarmTaskInputSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Stable task id. Required when other tasks depend on this task.'),
    description: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Short task description for UI and result summaries.'),
    subagent_type: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Subagent type for this task. Defaults to the swarm subagent_type.'),
    prompt: z
      .string()
      .trim()
      .min(1)
      .describe(
        'Concrete prompt for this task. Include known file paths, symbols, errors, and memory keywords. The spawned subagent receives its profile tools, phase-0 memory retrieval, and may call available APIs again as needed.',
      ),
    depends_on: z
      .array(z.string().trim().min(1))
      .max(MAX_AGENT_SWARM_SUBAGENTS)
      .optional()
      .describe('Task ids that must complete before this task starts.'),
  })
  .strict();

export const AgentSwarmToolInputSchema = z
  .object({
    description: z
      .string()
      .trim()
      .min(1)
      .describe('Short description for the whole swarm.'),
    subagent_type: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Subagent type used for every spawned subagent. Defaults to orchestrator when omitted.',
      ),
    prompt_template: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        `Prompt template for each subagent. The ${PROMPT_TEMPLATE_PLACEHOLDER} placeholder is replaced with each item value.`,
      ),
    items: z
      .array(z.string().trim().min(1))
      .max(MAX_AGENT_SWARM_SUBAGENTS)
      .optional()
      .describe(
        `Values used to fill ${PROMPT_TEMPLATE_PLACEHOLDER}. Each item launches one new subagent.`,
      ),
    tasks: z
      .array(AgentSwarmTaskInputSchema)
      .max(MAX_AGENT_SWARM_SUBAGENTS)
      .optional()
      .describe(
        'Concrete swarm tasks. Use this for heterogeneous coding loops, DAG dependencies, and single delegated tasks without prompt_template/items. Each task is a model-callable subagent API invocation and can be followed by another AgentSwarm call if more work is needed.',
      ),
    resume_agent_ids: z
      .record(z.string().trim().min(1), z.string().trim().min(1))
      .optional()
      .describe(
        'Map of existing subagent agent_id to the prompt used to resume that subagent. These resumed subagents are launched before new item-based subagents.',
      ),
  })
  .strict();

export type AgentSwarmToolInput = z.infer<typeof AgentSwarmToolInputSchema>;

interface AgentSwarmSpawnSpec {
  readonly kind: 'spawn';
  readonly index: number;
  readonly id?: string;
  readonly item?: string;
  readonly description?: string;
  readonly subagentType?: string;
  readonly dependsOn?: readonly string[];
  readonly prompt: string;
}

interface AgentSwarmResumeSpec {
  readonly kind: 'resume';
  readonly index: number;
  readonly agentId: string;
  readonly item?: string;
  readonly prompt: string;
}

type AgentSwarmSpec = AgentSwarmSpawnSpec | AgentSwarmResumeSpec;

interface SwarmRunResult {
  readonly spec: AgentSwarmSpec;
  readonly agentId?: string;
  readonly status: 'completed' | 'failed' | 'aborted';
  readonly state?: 'started' | 'not_started';
  readonly result?: string;
  readonly error?: string;
  readonly usage?: TokenUsage;
}

export class AgentSwarmTool implements BuiltinTool<AgentSwarmToolInput> {
  readonly name = 'AgentSwarm' as const;
  readonly description: string;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(AgentSwarmToolInputSchema);

  constructor(
    private readonly subagentHost: SessionSubagentHost,
    private readonly swarmMode: SwarmMode,
    private readonly backgroundManager?: BackgroundManager,
    subagents?: ResolvedAgentProfile['subagents'],
  ) {
    const available = Object.entries(subagents ?? {}).map(([name, profile]) => `- ${name}: ${profile.description ?? profile.whenToUse ?? 'Custom agent'}`).join('\n');
    this.description = available ? `${AGENT_SWARM_DESCRIPTION}\n\nAvailable subagent types:\n${available}` : AGENT_SWARM_DESCRIPTION;
  }

  resolveExecution(args: AgentSwarmToolInput): ToolExecution {
    const agentCount =
      (args.items?.length ?? 0) +
      (args.tasks?.length ?? 0) +
      Object.keys(args.resume_agent_ids ?? {}).length;
    return {
      accesses: ToolAccesses.all(),
      description: `Launching agent swarm: ${args.description}`,
      display: {
        kind: 'agent_call',
        agent_name: `swarm (${agentCount} subagents)`,
        prompt: args.description,
      },
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: AgentSwarmToolInput,
    context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      context.signal.throwIfAborted();
      const profileName = normalizeOptionalString(args.subagent_type) ?? DEFAULT_SUBAGENT_TYPE;
      const specs = createAgentSwarmSpecs(args, (agentId) => this.subagentHost.getSwarmItem(agentId));
      if (this.backgroundManager === undefined) {
        throw new Error('AgentSwarm background manager is unavailable.');
      }
      this.swarmMode.enter('tool');
      const control = new AgentSwarmExecutionControl(this.subagentHost);
      const taskId = this.backgroundManager.registerTask(
        new SwarmBackgroundTask(`Agent swarm: ${args.description}`, async (signal, appendOutput) => {
          appendOutput([
            '<agent_swarm_progress status="running">',
            `Launching ${String(specs.length)} background subagent(s): ${args.description}`,
            '</agent_swarm_progress>',
            '',
          ].join('\n'));
          return this.runSwarm(
            args,
            profileName,
            specs,
            signal,
            context.toolCallId,
            appendOutput,
            control,
          );
        }, specs.length, control),
        { detached: true },
      );
      return {
        output: [
          `task_id: ${taskId}`,
          'status: running',
          `subagent_count: ${String(specs.length)}`,
          'automatic_notification: true',
          '',
          `description: ${args.description}`,
          '',
          'next_step: The swarm runs in the background without a deadline. Continue other work or stop and wait; completion will be injected automatically.',
        ].join('\n'),
      };
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }

  private async runSwarm(
    args: AgentSwarmToolInput,
    profileName: string,
    specs: readonly AgentSwarmSpec[],
    signal: AbortSignal,
    toolCallId: string,
    appendOutput: (chunk: string) => void,
    control: AgentSwarmExecutionControl,
  ): Promise<{ output: string; status: 'completed' | 'failed' }> {
    const results = hasDependencyEdges(specs)
      ? await this.runDagSwarm(args, profileName, specs, signal, toolCallId, appendOutput, control)
      : await this.runSpecBatch(
          args,
          profileName,
          specs,
          signal,
          toolCallId,
          new Map(),
          appendOutput,
          control,
        );
    return {
      output: renderSwarmResults(results),
      status: results.every(result => result.status === 'completed') ? 'completed' : 'failed',
    };
  }

  private async runDagSwarm(
    args: AgentSwarmToolInput,
    defaultProfileName: string,
    specs: readonly AgentSwarmSpec[],
    signal: AbortSignal,
    toolCallId: string,
    appendOutput: (chunk: string) => void,
    control: AgentSwarmExecutionControl,
  ): Promise<SwarmRunResult[]> {
    const remaining = [...specs];
    const results: SwarmRunResult[] = [];
    const finishedById = new Map<string, SwarmRunResult>();

    while (remaining.length > 0) {
      const blocked = removeMatching(remaining, (spec) =>
        spec.kind === 'spawn' &&
        (spec.dependsOn ?? []).some((dep) => {
          const dependency = finishedById.get(dep);
          return dependency !== undefined && dependency.status !== 'completed';
        }),
      );
      for (const spec of blocked) {
        const failedDependency = spec.kind === 'spawn'
          ? (spec.dependsOn ?? []).find((dep) => {
              const dependency = finishedById.get(dep);
              return dependency !== undefined && dependency.status !== 'completed';
            })
          : undefined;
        const result: SwarmRunResult = {
          spec,
          status: 'failed',
          state: 'not_started',
          error: `Dependency "${failedDependency ?? 'unknown'}" did not complete successfully.`,
        };
        results.push(result);
        if (spec.kind === 'spawn' && spec.id !== undefined) {
          finishedById.set(spec.id, result);
        }
      }

      if (remaining.length === 0) {
        break;
      }

      const ready = removeMatching(remaining, (spec) =>
        spec.kind === 'resume' ||
        (spec.dependsOn ?? []).every((dep) => finishedById.get(dep)?.status === 'completed'),
      );
      if (ready.length === 0) {
        throw new Error('AgentSwarm dependency graph has a cycle or unresolved dependency.');
      }

      const layerResults = await this.runSpecBatch(
        args,
        defaultProfileName,
        ready,
        signal,
        toolCallId,
        finishedById,
        appendOutput,
        control,
      );
      results.push(...layerResults);
      for (const result of layerResults) {
        if (result.spec.kind === 'spawn' && result.spec.id !== undefined) {
          finishedById.set(result.spec.id, result);
        }
      }
    }

    return results;
  }

  private async runSpecBatch(
    args: AgentSwarmToolInput,
    defaultProfileName: string,
    specs: readonly AgentSwarmSpec[],
    signal: AbortSignal,
    toolCallId: string,
    dependencyResults: ReadonlyMap<string, SwarmRunResult>,
    appendOutput: (chunk: string) => void,
    control: AgentSwarmExecutionControl,
  ): Promise<SwarmRunResult[]> {
    if (specs.length === 0) return [];
    const tasks = specs.map((spec): QueuedSubagentTask<AgentSwarmSpec> => {
      const profileName = spec.kind === 'resume'
        ? 'subagent'
        : (normalizeOptionalString(spec.subagentType) ?? defaultProfileName);
      const prompt = spec.kind === 'spawn'
        ? promptWithDependencyResults(spec, dependencyResults)
        : spec.prompt;
      const common = {
        data: spec,
        profileName,
        parentToolCallId: toolCallId,
        prompt,
        description: childDescription(
          args.description,
          spec.index,
          spec.kind === 'resume' ? 'resume' : profileName,
          spec.kind === 'spawn' ? spec.description : undefined,
        ),
        swarmIndex: spec.index,
        runInBackground: true,
        swarmItem: spec.item ?? (spec.kind === 'spawn' ? spec.id : undefined),
        signal,
      };
      if (spec.kind === 'resume') {
        return {
          ...common,
          kind: 'resume',
          resumeAgentId: spec.agentId,
        };
      }
      return {
        ...common,
        kind: 'spawn',
      };
    });
    const results = await control.run(tasks);
    const mapped = results.map(({ task, ...result }) => ({ spec: task.data, ...result }));
    appendOutput(`${renderSwarmResults(mapped)}\n`);
    return mapped;
  }
}

class AgentSwarmExecutionControl implements SwarmTaskControl {
  private activeBatch?: SubagentBatch<AgentSwarmSpec>;
  private readonly guidance: string[] = [];
  private _paused = false;

  constructor(private readonly launcher: SessionSubagentHost) {}

  get paused(): boolean {
    return this._paused;
  }

  pause(guidance?: string): void {
    this.rememberGuidance(guidance);
    this._paused = true;
    this.activeBatch?.pause(guidance);
  }

  addGuidance(guidance: string): void {
    if (!this._paused) throw new Error('Pause the swarm before adding guidance.');
    this.rememberGuidance(guidance);
    this.activeBatch?.addGuidance(guidance);
  }

  resume(guidance?: string): void {
    this.rememberGuidance(guidance);
    this._paused = false;
    this.activeBatch?.resume(guidance);
  }

  async run(
    tasks: readonly QueuedSubagentTask<AgentSwarmSpec>[],
  ): Promise<Array<SubagentResult<AgentSwarmSpec>>> {
    if (typeof this.launcher.runQueuedControlled !== 'function') {
      return this.launcher.runQueued(tasks);
    }
    return this.launcher.runQueuedControlled(tasks, (batch) => this.observeBatch(batch));
  }

  private rememberGuidance(guidance?: string): void {
    const normalized = guidance?.trim();
    if (normalized) this.guidance.push(normalized);
  }

  private observeBatch(batch: SubagentBatch<AgentSwarmSpec> | undefined): void {
    this.activeBatch = batch;
    if (batch === undefined) return;
    for (const guidance of this.guidance) batch.addGuidance(guidance);
    if (this._paused) batch.pause();
  }
}

function createAgentSwarmSpecs(
  args: AgentSwarmToolInput,
  getResumeItem: (agentId: string) => string | undefined,
): AgentSwarmSpec[] {
  const resumeEntries = Object.entries(args.resume_agent_ids ?? {}).map(([agentId, prompt]) => ({
    agentId: agentId.trim(),
    prompt: prompt.trim(),
  }));
  const items = (args.items ?? []).map((item) => item.trim());
  const taskInputs = args.tasks ?? [];
  const itemCount = items.length;
  const taskCount = taskInputs.length;
  const resumeCount = resumeEntries.length;
  const totalCount = resumeCount + itemCount + taskCount;
  if (totalCount < 1) {
    throw new Error('AgentSwarm requires at least 1 item, task, or resume_agent_ids entry.');
  }
  if (totalCount > MAX_AGENT_SWARM_SUBAGENTS) {
    throw new Error(`AgentSwarm supports at most ${String(MAX_AGENT_SWARM_SUBAGENTS)} subagents.`);
  }
  const promptTemplate = normalizeOptionalString(args.prompt_template);
  if (items.length > 0 && promptTemplate === undefined) {
    throw new Error('prompt_template is required when items are provided.');
  }
  if (promptTemplate !== undefined && !promptTemplate.includes(PROMPT_TEMPLATE_PLACEHOLDER)) {
    throw new Error(
      `prompt_template must include the ${PROMPT_TEMPLATE_PLACEHOLDER} placeholder.`,
    );
  }

  const seenPrompts = new Map<string, number>();
  const specs: AgentSwarmSpec[] = [];
  for (const entry of resumeEntries) {
    specs.push({
      kind: 'resume',
      index: specs.length + 1,
      agentId: entry.agentId,
      item: getResumeItem(entry.agentId),
      prompt: entry.prompt,
    });
  }
  if (items.length > 0) {
    const itemPromptTemplate = promptTemplate!;
    items.forEach((item, index) => {
      const prompt = itemPromptTemplate.split(PROMPT_TEMPLATE_PLACEHOLDER).join(item);
      const previousIndex = seenPrompts.get(prompt);
      if (previousIndex !== undefined) {
        throw new Error(
          `Duplicate subagent prompts from items ${String(previousIndex)} and ${String(index + 1)}. AgentSwarm requires distinct subagents.`,
        );
      }
      seenPrompts.set(prompt, index + 1);
      specs.push({
        kind: 'spawn',
        index: specs.length + 1,
        item,
        prompt,
      });
    });
  }
  for (const task of taskInputs) {
    specs.push({
      kind: 'spawn',
      index: specs.length + 1,
      ...(task.id === undefined ? {} : { id: task.id }),
      ...(task.description === undefined ? {} : { description: task.description }),
      ...(task.subagent_type === undefined ? {} : { subagentType: task.subagent_type }),
      ...(task.depends_on === undefined ? {} : { dependsOn: task.depends_on }),
      prompt: task.prompt,
    });
  }
  validateAgentSwarmDependencies(specs);
  return specs;
}

function validateAgentSwarmDependencies(specs: readonly AgentSwarmSpec[]): void {
  const ids = new Map<string, number>();
  for (const spec of specs) {
    if (spec.kind !== 'spawn' || spec.id === undefined) continue;
    const previous = ids.get(spec.id);
    if (previous !== undefined) {
      throw new Error(
        `AgentSwarm task id "${spec.id}" is duplicated by tasks ${String(previous)} and ${String(spec.index)}.`,
      );
    }
    ids.set(spec.id, spec.index);
  }
  for (const spec of specs) {
    if (spec.kind !== 'spawn') continue;
    for (const dep of spec.dependsOn ?? []) {
      if (!ids.has(dep)) {
        throw new Error(`AgentSwarm task "${taskLabel(spec)}" depends on unknown task "${dep}".`);
      }
      if (dep === spec.id) {
        throw new Error(`AgentSwarm task "${taskLabel(spec)}" cannot depend on itself.`);
      }
    }
  }
}

function hasDependencyEdges(specs: readonly AgentSwarmSpec[]): boolean {
  return specs.some((spec) => spec.kind === 'spawn' && (spec.dependsOn?.length ?? 0) > 0);
}

function promptWithDependencyResults(
  spec: AgentSwarmSpawnSpec,
  dependencyResults: ReadonlyMap<string, SwarmRunResult>,
): string {
  const dependsOn = spec.dependsOn ?? [];
  if (dependsOn.length === 0) return spec.prompt;
  const lines = ['<dependency_results>'];
  for (const dep of dependsOn) {
    const result = dependencyResults.get(dep);
    const outcome = result?.status ?? 'unknown';
    const body = result?.status === 'completed'
      ? (result.result ?? '')
      : (result?.error ?? 'missing dependency result');
    lines.push(
      `<dependency task_id="${escapeXmlAttribute(dep)}" outcome="${outcome}">${body}</dependency>`,
    );
  }
  lines.push('</dependency_results>', '', spec.prompt);
  return lines.join('\n');
}

function removeMatching<T>(items: T[], predicate: (item: T) => boolean): T[] {
  const removed: T[] = [];
  for (let index = 0; index < items.length;) {
    if (predicate(items[index]!)) {
      removed.push(items.splice(index, 1)[0]!);
      continue;
    }
    index += 1;
  }
  return removed;
}

function childDescription(
  swarmDescription: string,
  index: number,
  profileName: string,
  taskDescription: string | undefined,
): string {
  const prefix = `${swarmDescription} #${String(index)} (${profileName})`;
  return taskDescription === undefined ? prefix : `${prefix}: ${taskDescription}`;
}

function renderSwarmResults(results: readonly SwarmRunResult[]): string {
  const completed = results.filter((result) => result.status === 'completed').length;
  const failed = results.filter((result) => result.status === 'failed').length;
  const aborted = results.filter((result) => result.status === 'aborted').length;
  const shouldRenderResumeHint =
    results.some((result) => result.status !== 'completed') &&
    results.some((result) => result.agentId !== undefined);
  const lines = [
    '<agent_swarm_result>',
    `<summary>${renderSwarmSummary(completed, failed, aborted)}</summary>`,
  ];
  const usage = sumSwarmUsage(results);
  if (usage !== undefined) {
    lines.push(`<usage input="${String(inputTotal(usage))}" output="${String(usage.output)}" cache_read="${String(usage.inputCacheRead)}" cache_write="${String(usage.inputCacheCreation)}" total="${String(grandTotal(usage))}" />`);
  }

  if (shouldRenderResumeHint) {
    lines.push(
      '<resume_hint>Call AgentSwarm with resume_agent_ids using the agent_id values in this result to continue unfinished work.</resume_hint>',
    );
  }

  for (const result of results) {
    const agentId = result.agentId === undefined ? '' : ` agent_id="${result.agentId}"`;
    const mode = result.spec.kind === 'resume' ? ' mode="resume"' : '';
    const taskId = result.spec.kind === 'spawn' && result.spec.id !== undefined
      ? ` task_id="${escapeXmlAttribute(result.spec.id)}"`
      : '';
    const item = result.spec.item === undefined ? '' : ` item="${escapeXmlAttribute(result.spec.item)}"`;
    const state = result.state === undefined ? '' : ` state="${result.state}"`;
    const body = result.status === 'completed' ? (result.result ?? '') : (result.error ?? 'unknown error');
    lines.push(
      `<subagent${mode}${agentId}${taskId}${item}${state} outcome="${result.status}">${body}</subagent>`,
    );
  }

  lines.push('</agent_swarm_result>');
  return lines.join('\n');
}

function sumSwarmUsage(results: readonly SwarmRunResult[]): TokenUsage | undefined {
  let total: TokenUsage | undefined;
  for (const result of results) {
    if (result.usage === undefined) continue;
    total = total === undefined ? { ...result.usage } : {
      inputOther: total.inputOther + result.usage.inputOther,
      output: total.output + result.usage.output,
      inputCacheRead: total.inputCacheRead + result.usage.inputCacheRead,
      inputCacheCreation: total.inputCacheCreation + result.usage.inputCacheCreation,
    };
  }
  return total;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function renderSwarmSummary(completed: number, failed: number, aborted = 0): string {
  const parts: string[] = [];
  if (completed > 0) parts.push(`completed: ${String(completed)}`);
  if (failed > 0) parts.push(`failed: ${String(failed)}`);
  if (aborted > 0) parts.push(`aborted: ${String(aborted)}`);
  return parts.join(', ');
}

function taskLabel(spec: AgentSwarmSpawnSpec): string {
  return spec.id ?? `#${String(spec.index)}`;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
