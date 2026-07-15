import { errorMessage, isAbortError } from '../../loop/errors';
import type { AgentBackgroundTaskInfo } from './agent-task';
import type {
  BackgroundTask,
  BackgroundTaskInfoBase,
  BackgroundTaskSink,
} from './task';

export type SwarmTaskRunner = (
  signal: AbortSignal,
  appendOutput: (chunk: string) => void,
) => Promise<string>;

/** A detached aggregate task that owns one complete swarm run. */
export class SwarmBackgroundTask implements BackgroundTask {
  readonly kind = 'agent' as const;
  readonly idPrefix = 'swarm';

  constructor(
    readonly description: string,
    private readonly runner: SwarmTaskRunner,
    private readonly taskCount?: number,
  ) {}

  async start(sink: BackgroundTaskSink): Promise<void> {
    try {
      const result = await this.runner(sink.signal, (chunk) => sink.appendOutput(chunk));
      sink.appendOutput(result);
      await sink.settle({ status: 'completed' });
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
      subagentType: this.taskCount === undefined ? 'swarm' : `swarm:${String(this.taskCount)}`,
    };
  }
}
