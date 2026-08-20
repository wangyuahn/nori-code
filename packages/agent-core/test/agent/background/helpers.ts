import type { KaosProcess } from '@nori-code/kaos';
import { vi } from 'vitest';

import {
  BackgroundManager,
  BackgroundTaskPersistence,
  ProcessBackgroundTask,
  QuestionBackgroundTask,
  type BackgroundTaskInfo,
} from '../../../src/agent/background';
import type { AgentEvent } from '../../../src/rpc/events';

export interface FakeBackgroundAgent {
  emitEvent: ReturnType<typeof vi.fn>;
  emittedEvents: AgentEvent[];
  kimiConfig?: { background?: { maxRunningTasks?: number } };
  telemetry: { track: ReturnType<typeof vi.fn> };
  context: { appendUserMessage: ReturnType<typeof vi.fn> };
  turn: { steer: ReturnType<typeof vi.fn> };
  hooks?: { fireAndForgetTrigger: ReturnType<typeof vi.fn> };
}

export interface BackgroundManagerFixture {
  agent: FakeBackgroundAgent;
  manager: BackgroundManager;
  persistence?: BackgroundTaskPersistence;
}

export function createBackgroundManager(options: {
  sessionDir?: string;
  maxRunningTasks?: number;
  hooks?: FakeBackgroundAgent['hooks'];
} = {}): BackgroundManagerFixture {
  const emittedEvents: AgentEvent[] = [];
  const agent: FakeBackgroundAgent = {
    emittedEvents,
    emitEvent: vi.fn((event: AgentEvent) => {
      emittedEvents.push(event);
    }),
    kimiConfig:
      options.maxRunningTasks === undefined
        ? undefined
        : { background: { maxRunningTasks: options.maxRunningTasks } },
    telemetry: { track: vi.fn() },
    context: { appendUserMessage: vi.fn() },
    turn: { steer: vi.fn() },
    hooks: options.hooks,
  };
  const persistence =
    options.sessionDir === undefined
      ? undefined
      : new BackgroundTaskPersistence(options.sessionDir);
  return {
    agent,
    manager: new BackgroundManager(agent as never, persistence),
    persistence,
  };
}

export function registerProcess(
  manager: BackgroundManager,
  proc: KaosProcess,
  command: string,
  description: string,
): string {
  return manager.registerTask(new ProcessBackgroundTask(proc, command, description));
}

export interface PromiseTaskOptions {
  /**
   * Called with the abort reason once the manager cancels the task's own
   * signal. This is the single cancellation channel every task kind sees, so
   * a test can both observe that cancellation arrived and model a runner that
   * rejects as soon as it does.
   */
  readonly onAbort?: (reason: unknown) => void;
}

/**
 * A background task whose lifetime is a plain promise.
 *
 * Manager-level behavior — deadlines, kill propagation, foreground release,
 * concurrency limits — is identical for every task kind, so these tests drive
 * it through the simplest task there is instead of a real workload.
 */
export function promiseTask(
  completion: Promise<{ result: string }>,
  description: string,
  options: PromiseTaskOptions = {},
): QuestionBackgroundTask {
  return new QuestionBackgroundTask(
    async (signal) => {
      const onAbort = options.onAbort;
      if (onAbort !== undefined) {
        // `stop()` can abort before the lifecycle ever reaches `start`, so the
        // already-aborted case must fire too — an `abort` listener attached
        // after the fact never runs.
        if (signal.aborted) onAbort(signal.reason);
        else signal.addEventListener('abort', () => onAbort(signal.reason), { once: true });
      }
      const { result } = await completion;
      return { output: result };
    },
    description,
    { questionCount: 1 },
  );
}

export async function waitForTerminal(
  manager: BackgroundManager,
  taskId: string,
  timeoutMs = 30_000,
): Promise<BackgroundTaskInfo | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const info = await manager.wait(taskId, 5);
    if (
      info?.status === 'completed' ||
      info?.status === 'failed' ||
      info?.status === 'timed_out' ||
      info?.status === 'killed' ||
      info?.status === 'lost'
    ) {
      return info;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return manager.getTask(taskId);
}

export async function waitForOutput(
  manager: BackgroundManager,
  taskId: string,
  expected: string,
): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const output = await manager.readOutput(taskId);
    if (output.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for output: ${expected}`);
}
