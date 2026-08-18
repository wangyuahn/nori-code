import { z } from 'zod';
import { grandTotal, inputTotal, type TokenUsage } from '@nori-code/kosong';

import { SubagentBackgroundTask, type BackgroundManager, type SubagentTaskControl } from '../../../agent/background';
import type { BuiltinTool } from '../../../agent/tool';
import type { QueuedSubagentTask, SessionSubagentHost } from '../../../session/subagent-host';
import {
  SubagentBatch,
  type SubagentResult,
} from '../../../session/subagent-batch';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import SUBAGENT_DESCRIPTION from './subagent.md?raw';
import type { ResolvedAgentProfile } from '../../../profile';

const DEFAULT_SUBAGENT_TYPE = 'orchestrator';
const PROMPT_TEMPLATE_PLACEHOLDER = '{{item}}';
const MAX_SUBAGENTS = 128;

const SubAgentTaskInputSchema = z
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
      .describe('Optional execution profile for this temporary task. Defaults to the tool profile.'),
    prompt: z
      .string()
      .trim()
      .min(1)
      .describe(
        'Concrete prompt for this task. Include known file paths, symbols, errors, and memory keywords. The spawned subagent receives its profile tools, phase-0 memory retrieval, and may call available APIs again as needed.',
      ),
    depends_on: z
      .array(z.string().trim().min(1))
      .max(MAX_SUBAGENTS)
      .optional()
      .describe('Task ids that must complete before this task starts.'),
  })
  .strict();

export const SubAgentToolInputSchema = z
  .object({
    description: z
      .string()
      .trim()
      .min(1)
      .describe('Short description for this temporary task batch.'),
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
      .max(MAX_SUBAGENTS)
      .optional()
      .describe(
        `Values used to fill ${PROMPT_TEMPLATE_PLACEHOLDER}. Each item launches one new subagent.`,
      ),
    tasks: z
      .array(SubAgentTaskInputSchema)
      .max(MAX_SUBAGENTS)
      .optional()
      .describe(
        'Concrete temporary subagent tasks. Use this for parallel work, dependency DAGs, and a single delegated task without prompt_template/items. Tasks with no dependency run concurrently.',
      ),
  })
  .strict();

export type SubAgentToolInput = z.infer<typeof SubAgentToolInputSchema>;

interface SubAgentSpawnSpec {
  readonly kind: 'spawn';
  readonly index: number;
  readonly id?: string;
  readonly item?: string;
  readonly description?: string;
  readonly subagentType?: string;
  readonly dependsOn?: readonly string[];
  readonly prompt: string;
}

type SubAgentSpec = SubAgentSpawnSpec;

interface SubAgentRunResult {
  readonly spec: SubAgentSpec;
  readonly agentId?: string;
  readonly status: 'completed' | 'failed' | 'aborted';
  readonly state?: 'started' | 'not_started';
  readonly result?: string;
  readonly error?: string;
  readonly usage?: TokenUsage;
}

export class SubAgentTool implements BuiltinTool<SubAgentToolInput> {
  readonly name = 'SubAgent' as const;
  readonly description: string;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SubAgentToolInputSchema);

  constructor(
    private readonly subagentHost: SessionSubagentHost,
    private readonly backgroundManager?: BackgroundManager,
    subagents?: ResolvedAgentProfile['subagents'],
  ) {
    const available = Object.entries(subagents ?? {}).map(([name, profile]) => `- ${name}: ${profile.description ?? profile.whenToUse ?? 'Custom agent'}`).join('\n');
    this.description = available ? `${SUBAGENT_DESCRIPTION}\n\nAvailable execution profiles:\n${available}` : SUBAGENT_DESCRIPTION;
  }

  resolveExecution(args: SubAgentToolInput): ToolExecution {
    const agentCount =
      (args.items?.length ?? 0) +
      (args.tasks?.length ?? 0) +
      0;
    return {
      accesses: ToolAccesses.all(),
      description: `Launching temporary subagents: ${args.description}`,
      display: {
        kind: 'agent_call',
        agent_name: `${String(agentCount)} temporary subagents`,
        prompt: args.description,
      },
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: SubAgentToolInput,
    context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      context.signal.throwIfAborted();
      const profileName = normalizeOptionalString(args.subagent_type) ?? DEFAULT_SUBAGENT_TYPE;
      const specs = createSubAgentSpecs(args);
      if (this.backgroundManager === undefined) {
        throw new Error('SubAgent background manager is unavailable.');
      }
      const control = new SubAgentExecutionControl(this.subagentHost);
      const taskId = this.backgroundManager.registerTask(
        new SubagentBackgroundTask(`SubAgent tasks: ${args.description}`, async (signal, appendOutput) => {
          appendOutput([
            '<subagent_progress status="running">',
            `Launching ${String(specs.length)} temporary subagent(s): ${args.description}`,
            '</subagent_progress>',
            '',
          ].join('\n'));
          return this.runSubAgents(
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
          'next_step: The temporary subagents run in the background without a deadline. Continue other work or stop and wait; completion will be injected automatically.',
        ].join('\n'),
      };
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }

  private async runSubAgents(
    args: SubAgentToolInput,
    profileName: string,
    specs: readonly SubAgentSpec[],
    signal: AbortSignal,
    toolCallId: string,
    appendOutput: (chunk: string) => void,
    control: SubAgentExecutionControl,
  ): Promise<{ output: string; status: 'completed' | 'failed' }> {
    const results = hasDependencyEdges(specs)
      ? await this.runDependencyBatches(args, profileName, specs, signal, toolCallId, appendOutput, control)
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
      output: renderSubAgentResults(results),
      status: results.every(result => result.status === 'completed') ? 'completed' : 'failed',
    };
  }

  private async runDependencyBatches(
    args: SubAgentToolInput,
    defaultProfileName: string,
    specs: readonly SubAgentSpec[],
    signal: AbortSignal,
    toolCallId: string,
    appendOutput: (chunk: string) => void,
    control: SubAgentExecutionControl,
  ): Promise<SubAgentRunResult[]> {
    const remaining = [...specs];
    const results: SubAgentRunResult[] = [];
    const finishedById = new Map<string, SubAgentRunResult>();

    while (remaining.length > 0) {
      const blocked = removeMatching(remaining, (spec) =>
        (spec.dependsOn ?? []).some((dep) => {
          const dependency = finishedById.get(dep);
          return dependency !== undefined && dependency.status !== 'completed';
        }),
      );
      for (const spec of blocked) {
        const failedDependency = (spec.dependsOn ?? []).find((dep) => {
          const dependency = finishedById.get(dep);
          return dependency !== undefined && dependency.status !== 'completed';
        });
        const result: SubAgentRunResult = {
          spec,
          status: 'failed',
          state: 'not_started',
          error: `Dependency "${failedDependency ?? 'unknown'}" did not complete successfully.`,
        };
        results.push(result);
        if (spec.id !== undefined) {
          finishedById.set(spec.id, result);
        }
      }

      if (remaining.length === 0) {
        break;
      }

      const ready = removeMatching(remaining, (spec) =>
        (spec.dependsOn ?? []).every((dep) => finishedById.get(dep)?.status === 'completed'),
      );
      if (ready.length === 0) {
        throw new Error('SubAgent dependency graph has a cycle or unresolved dependency.');
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
        if (result.spec.id !== undefined) {
          finishedById.set(result.spec.id, result);
        }
      }
    }

    return results;
  }

  private async runSpecBatch(
    args: SubAgentToolInput,
    defaultProfileName: string,
    specs: readonly SubAgentSpec[],
    signal: AbortSignal,
    toolCallId: string,
    dependencyResults: ReadonlyMap<string, SubAgentRunResult>,
    appendOutput: (chunk: string) => void,
    control: SubAgentExecutionControl,
  ): Promise<SubAgentRunResult[]> {
    if (specs.length === 0) return [];
    const tasks = specs.map((spec): QueuedSubagentTask<SubAgentSpec> => {
      const profileName = normalizeOptionalString(spec.subagentType) ?? defaultProfileName;
      const prompt = promptWithDependencyResults(spec, dependencyResults);
      const common = {
        data: spec,
        profileName,
        parentToolCallId: toolCallId,
        prompt,
        description: childDescription(
          args.description,
          spec.index,
          profileName,
          spec.description,
        ),
        subagentIndex: spec.index,
        runInBackground: true,
        subagentItem: spec.item ?? spec.id,
        signal,
      };
      return {
        ...common,
        kind: 'spawn',
      };
    });
    const results = await control.run(tasks);
    const mapped = results.map(({ task, ...result }) => ({ spec: task.data, ...result }));
    appendOutput(`${renderSubAgentResults(mapped)}\n`);
    return mapped;
  }
}

class SubAgentExecutionControl implements SubagentTaskControl {
  private activeBatch?: SubagentBatch<SubAgentSpec>;
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
    if (!this._paused) throw new Error('Pause the SubAgent batch before adding guidance.');
    this.rememberGuidance(guidance);
    this.activeBatch?.addGuidance(guidance);
  }

  resume(guidance?: string): void {
    this.rememberGuidance(guidance);
    this._paused = false;
    this.activeBatch?.resume(guidance);
  }

  async run(
    tasks: readonly QueuedSubagentTask<SubAgentSpec>[],
  ): Promise<Array<SubagentResult<SubAgentSpec>>> {
    if (typeof this.launcher.runQueuedControlled !== 'function') {
      return this.launcher.runQueued(tasks);
    }
    return this.launcher.runQueuedControlled(
      tasks,
      (batch) => this.observeBatch(batch),
      { discardTerminalAgents: false },
    );
  }

  private rememberGuidance(guidance?: string): void {
    const normalized = guidance?.trim();
    if (normalized) this.guidance.push(normalized);
  }

  private observeBatch(batch: SubagentBatch<SubAgentSpec> | undefined): void {
    this.activeBatch = batch;
    if (batch === undefined) return;
    for (const guidance of this.guidance) batch.addGuidance(guidance);
    if (this._paused) batch.pause();
  }
}

function createSubAgentSpecs(
  args: SubAgentToolInput,
): SubAgentSpec[] {
  const items = (args.items ?? []).map((item) => item.trim());
  const taskInputs = args.tasks ?? [];
  const itemCount = items.length;
  const taskCount = taskInputs.length;
  const totalCount = itemCount + taskCount;
  if (totalCount < 1) {
    throw new Error('SubAgent requires at least one item or task.');
  }
  if (totalCount > MAX_SUBAGENTS) {
    throw new Error(`SubAgent supports at most ${String(MAX_SUBAGENTS)} subagents.`);
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
  const specs: SubAgentSpec[] = [];
  if (items.length > 0) {
    const itemPromptTemplate = promptTemplate!;
    items.forEach((item, index) => {
      const prompt = itemPromptTemplate.split(PROMPT_TEMPLATE_PLACEHOLDER).join(item);
      const previousIndex = seenPrompts.get(prompt);
      if (previousIndex !== undefined) {
        throw new Error(
          `Duplicate subagent prompts from items ${String(previousIndex)} and ${String(index + 1)}. SubAgent requires distinct tasks.`,
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
  validateSubAgentDependencies(specs);
  return specs;
}

function validateSubAgentDependencies(specs: readonly SubAgentSpec[]): void {
  const ids = new Map<string, number>();
  for (const spec of specs) {
    if (spec.id === undefined) continue;
    const previous = ids.get(spec.id);
    if (previous !== undefined) {
      throw new Error(
        `SubAgent task id "${spec.id}" is duplicated by tasks ${String(previous)} and ${String(spec.index)}.`,
      );
    }
    ids.set(spec.id, spec.index);
  }
  for (const spec of specs) {
    for (const dep of spec.dependsOn ?? []) {
      if (!ids.has(dep)) {
        throw new Error(`SubAgent task "${taskLabel(spec)}" depends on unknown task "${dep}".`);
      }
      if (dep === spec.id) {
        throw new Error(`SubAgent task "${taskLabel(spec)}" cannot depend on itself.`);
      }
    }
  }
}

function hasDependencyEdges(specs: readonly SubAgentSpec[]): boolean {
  return specs.some((spec) => (spec.dependsOn?.length ?? 0) > 0);
}

function promptWithDependencyResults(
  spec: SubAgentSpawnSpec,
  dependencyResults: ReadonlyMap<string, SubAgentRunResult>,
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
  subagentDescription: string,
  index: number,
  profileName: string,
  taskDescription: string | undefined,
): string {
  const prefix = `${subagentDescription} #${String(index)} (${profileName})`;
  return taskDescription === undefined ? prefix : `${prefix}: ${taskDescription}`;
}

function renderSubAgentResults(results: readonly SubAgentRunResult[]): string {
  const completed = results.filter((result) => result.status === 'completed').length;
  const failed = results.filter((result) => result.status === 'failed').length;
  const aborted = results.filter((result) => result.status === 'aborted').length;
  const lines = [
    '<subagent_result>',
    `<summary>${renderSubAgentSummary(completed, failed, aborted)}</summary>`,
  ];
  const usage = sumSubAgentUsage(results);
  if (usage !== undefined) {
    lines.push(`<usage input="${String(inputTotal(usage))}" output="${String(usage.output)}" cache_read="${String(usage.inputCacheRead)}" cache_write="${String(usage.inputCacheCreation)}" total="${String(grandTotal(usage))}" />`);
  }

  for (const result of results) {
    const taskId = result.spec.id !== undefined
      ? ` task_id="${escapeXmlAttribute(result.spec.id)}"`
      : '';
    const item = result.spec.item === undefined ? '' : ` item="${escapeXmlAttribute(result.spec.item)}"`;
    const state = result.state === undefined ? '' : ` state="${result.state}"`;
    const body = summarizeResult(result.status === 'completed' ? result.result : result.error);
    lines.push(
      `<subagent${taskId}${item}${state} outcome="${result.status}">${body}</subagent>`,
    );
  }

  lines.push('</subagent_result>');
  return lines.join('\n');
}

const SUBAGENT_RESULT_MAX_LENGTH = 1_500;

function summarizeResult(value: string | undefined): string {
  const text = value?.trim() ?? 'unknown error';
  return text.length <= SUBAGENT_RESULT_MAX_LENGTH
    ? text
    : `${text.slice(0, SUBAGENT_RESULT_MAX_LENGTH)}\n[summary truncated]`;
}

function sumSubAgentUsage(results: readonly SubAgentRunResult[]): TokenUsage | undefined {
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

function renderSubAgentSummary(completed: number, failed: number, aborted = 0): string {
  const parts: string[] = [];
  if (completed > 0) parts.push(`completed: ${String(completed)}`);
  if (failed > 0) parts.push(`failed: ${String(failed)}`);
  if (aborted > 0) parts.push(`aborted: ${String(aborted)}`);
  return parts.join(', ');
}

function taskLabel(spec: SubAgentSpawnSpec): string {
  return spec.id ?? `#${String(spec.index)}`;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
