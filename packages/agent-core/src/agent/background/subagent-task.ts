import { errorMessage, isAbortError } from '../../loop/errors';
import type { AgentBackgroundTaskInfo } from './agent-task';
import type {
  BackgroundTask,
  BackgroundTaskInfoBase,
  BackgroundTaskSink,
} from './task';

export type SubagentTaskRunner = (
  signal: AbortSignal,
  appendOutput: (chunk: string) => void,
) => Promise<string | { output: string; status: 'completed' | 'failed' }>;

export interface SubagentTaskControl {
  readonly paused: boolean;
  pause(guidance?: string): void | Promise<void>;
  addGuidance(guidance: string): void | Promise<void>;
  resume(guidance?: string): void | Promise<void>;
}

/** A detached aggregate task that owns one complete SubAgent batch. */
export class SubagentBackgroundTask implements BackgroundTask {
  readonly kind = 'agent' as const;
  readonly idPrefix = 'subagent';

  constructor(
    readonly description: string,
    private readonly runner: SubagentTaskRunner,
    private readonly taskCount?: number,
    private readonly control?: SubagentTaskControl,
  ) {}

  pause(guidance?: string): void | Promise<void> {
    if (this.control === undefined) throw new Error('This SubAgent batch does not support pausing.');
    return this.control.pause(guidance);
  }

  addGuidance(guidance: string): void | Promise<void> {
    if (this.control === undefined) throw new Error('This SubAgent batch does not support guidance.');
    return this.control.addGuidance(guidance);
  }

  resume(guidance?: string): void | Promise<void> {
    if (this.control === undefined) throw new Error('This SubAgent batch does not support resuming.');
    return this.control.resume(guidance);
  }

  isPaused(): boolean {
    return this.control?.paused ?? false;
  }

  async start(sink: BackgroundTaskSink): Promise<void> {
    try {
      const result = await this.runner(sink.signal, (chunk) => sink.appendOutput(chunk));
      const output = typeof result === 'string' ? result : result.output;
      sink.appendOutput(output);
      await sink.settle({
        status: sink.signal.aborted
          ? 'killed'
          : typeof result === 'string'
            ? 'completed'
            : result.status,
      });
    } catch (error: unknown) {
      if (sink.signal.aborted && (isAbortError(error) || error === sink.signal.reason)) {
        await sink.settle({ status: 'killed' });
        return;
      }
      await sink.settle({ status: 'failed', stopReason: errorMessage(error) });
    }
  }

  toInfo(base: BackgroundTaskInfoBase): AgentBackgroundTaskInfo {
    return {
      ...base,
      kind: 'agent',
      subagentType: this.taskCount === undefined ? 'subagent' : `subagent:${String(this.taskCount)}`,
      paused: this.control?.paused,
    };
  }
}
