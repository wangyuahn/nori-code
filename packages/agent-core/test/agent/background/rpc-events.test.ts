/**
 * Covers BackgroundManager event emission and notification delivery.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';
import { join } from 'pathe';

import type { KaosProcess } from '@nori-code/kaos';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BackgroundTaskPersistence,
  type BackgroundTaskInfo,
} from '../../../src/agent/background';
import {
  createBackgroundManager,
  promiseTask,
  registerProcess,
} from './helpers';

function immediateProcess(exitCode: number, stdoutText = ''): KaosProcess {
  return {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from(stdoutText ? [stdoutText] : []),
    stderr: Readable.from([]),
    pid: 30000 + exitCode,
    exitCode,
    wait: vi.fn().mockResolvedValue(exitCode) as KaosProcess['wait'],
    kill: vi.fn().mockResolvedValue(undefined) as KaosProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as KaosProcess['dispose'],
  };
}

function pendingProcess(): KaosProcess {
  let resolveWait: (code: number) => void = () => {};
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  let currentExitCode: number | null = null;
  return {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 99999,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: () => waitPromise,
    kill: vi.fn(async () => {
      if (currentExitCode !== null) return;
      currentExitCode = 143;
      resolveWait(143);
    }) as unknown as KaosProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as KaosProcess['dispose'],
  };
}

function persistedProcess(
  overrides: Partial<Extract<BackgroundTaskInfo, { kind: 'process' }>> = {},
): Extract<BackgroundTaskInfo, { kind: 'process' }> {
  return {
    taskId: 'bash-done0000',
    kind: 'process',
    command: 'echo done',
    description: 'restored shell task',
    pid: 12345,
    startedAt: 1_700_000_000,
    endedAt: 1_700_000_010,
    exitCode: 0,
    status: 'completed',
    ...overrides,
  };
}

function persistedQuestion(
  overrides: Partial<Extract<BackgroundTaskInfo, { kind: 'question' }>> = {},
): Extract<BackgroundTaskInfo, { kind: 'question' }> {
  return {
    taskId: 'question-done0000',
    kind: 'question',
    description: 'restored task',
    startedAt: 1_700_000_000,
    endedAt: 1_700_000_010,
    status: 'completed',
    questionCount: 1,
    ...overrides,
  };
}

describe('BackgroundManager — event emission', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits background.task.started for process tasks', () => {
    const { agent, manager } = createBackgroundManager();
    const taskId = registerProcess(manager, pendingProcess(), 'sleep 60', 'demo');

    expect(agent.emittedEvents).toContainEqual({
      type: 'background.task.started',
      info: expect.objectContaining({
        taskId,
        kind: 'process',
        status: 'running',
      }),
    });
    expect(agent.telemetry.track).toHaveBeenCalledWith('background_task_created', {
      kind: 'bash',
    });
  });

  it('emits background.task.started for non-process tasks', () => {
    const { agent, manager } = createBackgroundManager();
    const taskId = manager.registerTask(
      promiseTask(new Promise(() => {}), 'question task'),
    );

    expect(agent.emittedEvents).toContainEqual({
      type: 'background.task.started',
      info: expect.objectContaining({
        taskId,
        kind: 'question',
        status: 'running',
      }),
    });
    expect(agent.telemetry.track).toHaveBeenCalledWith('background_task_created', {
      kind: 'question',
    });
  });

  it('emits background.task.terminated and telemetry on natural exit', async () => {
    const { agent, manager } = createBackgroundManager();
    const taskId = registerProcess(manager, immediateProcess(0), 'echo', 'done');
    agent.telemetry.track.mockClear();

    await manager.wait(taskId);

    expect(agent.emittedEvents).toContainEqual({
      type: 'background.task.terminated',
      info: expect.objectContaining({
        taskId,
        status: 'completed',
      }),
    });
    expect(agent.telemetry.track).toHaveBeenCalledWith(
      'background_task_completed',
      expect.objectContaining({
        kind: 'process',
        duration_ms: expect.any(Number),
        status: 'completed',
      }),
    );
  });

  it('sends null duration_ms when a terminal task has no endedAt', () => {
    const { agent, manager } = createBackgroundManager();
    agent.telemetry.track.mockClear();

    const info: BackgroundTaskInfo = {
      taskId: 'task-1',
      description: 'lost task',
      status: 'lost',
      kind: 'process',
      command: 'sleep 60',
      pid: 123,
      exitCode: null,
      startedAt: 100,
      endedAt: null,
    };

    (manager as unknown as { emitTaskTerminated: (info: BackgroundTaskInfo) => void }).emitTaskTerminated(
      info,
    );

    const trackCall = agent.telemetry.track.mock.calls.find(
      (call) => call[0] === 'background_task_completed',
    );
    expect(trackCall?.[1]).toMatchObject({ kind: 'process', status: 'lost' });
    expect(trackCall?.[1]?.duration_ms).toBeNull();
  });

  it('tracks failed and timed-out terminal statuses', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { agent, manager } = createBackgroundManager();
    const failedId = registerProcess(manager, immediateProcess(1), 'false', 'failed');
    const timedOutId = manager.registerTask(
      promiseTask(new Promise(() => {}), 'slow task'),
      { timeoutMs: 1 },
    );
    agent.telemetry.track.mockClear();

    await manager.wait(failedId);
    const timedOut = manager.wait(timedOutId);
    await vi.advanceTimersByTimeAsync(5_010);
    await timedOut;

    expect(agent.telemetry.track).toHaveBeenCalledWith(
      'background_task_completed',
      expect.objectContaining({ kind: 'process', status: 'failed' }),
    );
    expect(agent.telemetry.track).toHaveBeenCalledWith(
      'background_task_completed',
      expect.objectContaining({ kind: 'question', status: 'timed_out' }),
    );
  });

  it('emits background.task.terminated on stop', async () => {
    const { agent, manager } = createBackgroundManager();
    const taskId = registerProcess(manager, pendingProcess(), 'sleep 60', 'long');
    agent.emittedEvents.length = 0;

    await manager.stop(taskId, 'user');

    expect(agent.emittedEvents).toEqual([
      {
        type: 'background.task.terminated',
        info: expect.objectContaining({
          taskId,
          status: 'killed',
        }),
      },
    ]);
  });

  it('emits background.task.terminated when a restored task is marked lost', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-agent-reconcile-'));
    try {
      const persistence = new BackgroundTaskPersistence(sessionDir);
      await persistence.writeTask(
        persistedProcess({
          taskId: 'bash-orphan00',
          command: 'sleep 60',
          description: 'orphan task',
          endedAt: null,
          exitCode: null,
          status: 'running',
        }),
      );
      const { agent, manager } = createBackgroundManager({ sessionDir });

      await manager.loadFromDisk();
      await manager.reconcile();

      expect(agent.emittedEvents).toContainEqual({
        type: 'background.task.terminated',
        info: expect.objectContaining({
          taskId: 'bash-orphan00',
          status: 'lost',
        }),
      });
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });
});

describe('BackgroundManager — notification delivery', () => {
  it('steers completed non-process task notifications into the turn flow', async () => {
    const { agent, manager } = createBackgroundManager();
    const taskId = manager.registerTask(
      promiseTask(
        Promise.resolve({ result: 'final task summary' }),
        'question task',
      ),
    );

    await manager.wait(taskId);

    await vi.waitFor(() => {
      expect(agent.turn.steer).toHaveBeenCalledTimes(1);
    });
    expect(agent.context.appendUserMessage).not.toHaveBeenCalled();
    const [content, origin] = agent.turn.steer.mock.calls[0]!;
    expect(origin).toEqual({
      kind: 'background_task',
      taskId,
      status: 'completed',
      notificationId: `task:${taskId}:completed`,
    });
    const text = (content as Array<{ text: string }>)[0]!.text;
    expect(text).toMatch(/^<system-reminder>\n<notification[\s\S]*<\/notification>\n<\/system-reminder>$/);
    expect(text).toContain('Background question completed');
    expect(text).toContain('final task summary');
    expect(text).toContain('<output-preview');
    expect(text).not.toContain('<output-file');
  });

  it('steers completed process task notifications into the turn flow', async () => {
    const { agent, manager } = createBackgroundManager();
    const taskId = registerProcess(manager, immediateProcess(0), 'echo ok', 'shell task');

    await manager.wait(taskId);

    await vi.waitFor(() => {
      expect(agent.turn.steer).toHaveBeenCalledTimes(1);
    });
    const [content, origin] = agent.turn.steer.mock.calls[0]!;
    expect(origin).toEqual({
      kind: 'background_task',
      taskId,
      status: 'completed',
      notificationId: `task:${taskId}:completed`,
    });
    const text = (content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('Background process completed');
    expect(text).toContain('shell task completed.');
  });

  it('uses a bounded output preview when no persisted task output exists', async () => {
    const { agent, manager } = createBackgroundManager();
    const output = `early-output-marker\n${'x'.repeat(4_000)}\nfinal task line`;
    const taskId = manager.registerTask(promiseTask(Promise.resolve({ result: output }), 'question task'));

    await manager.wait(taskId);

    await vi.waitFor(() => {
      expect(agent.turn.steer).toHaveBeenCalledTimes(1);
    });
    const [content] = agent.turn.steer.mock.calls[0]!;
    const text = (content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('<output-preview');
    expect(text).toContain('truncated="true"');
    expect(text).toContain('final task line');
    expect(text).not.toContain('early-output-marker');
    expect(text).not.toContain('<output-file');
  });

  it('steers stopped process task notifications into the turn flow', async () => {
    const { agent, manager } = createBackgroundManager();
    const taskId = registerProcess(manager, pendingProcess(), 'sleep 60', 'long shell task');

    await manager.stop(taskId);

    await vi.waitFor(() => {
      expect(agent.turn.steer).toHaveBeenCalledTimes(1);
    });
    const [content, origin] = agent.turn.steer.mock.calls[0]!;
    expect(origin).toEqual({
      kind: 'background_task',
      taskId,
      status: 'killed',
      notificationId: `task:${taskId}:killed`,
    });
    expect((content as Array<{ text: string }>)[0]!.text).toContain(
      'Background process killed',
    );
  });

  it('replays restored terminal non-process task notifications when undelivered', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-question-replay-'));
    try {
      const persistence = new BackgroundTaskPersistence(sessionDir);
      await persistence.writeTask(persistedQuestion());
      await persistence.appendTaskOutput('question-done0000', 'restored task summary');
      const { agent, manager } = createBackgroundManager({ sessionDir });

      await manager.loadFromDisk();
      await manager.reconcile();

      await vi.waitFor(() => {
        expect(agent.context.appendUserMessage).toHaveBeenCalledTimes(1);
      });
      expect(agent.turn.steer).not.toHaveBeenCalled();
      const [content, origin] = agent.context.appendUserMessage.mock.calls[0]!;
      expect(origin).toEqual({
        kind: 'background_task',
        taskId: 'question-done0000',
        status: 'completed',
        notificationId: 'task:question-done0000:completed',
      });
      const text = (content as Array<{ text: string }>)[0]!.text;
      expect(text).toContain('Background question completed');
      expect(text).not.toContain('restored task summary');
      expect(text).toContain('<output-file');
      expect(text).toContain(persistence.taskOutputFile('question-done0000'));
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('replays restored terminal process task notifications when undelivered', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-bash-replay-'));
    try {
      const persistence = new BackgroundTaskPersistence(sessionDir);
      await persistence.writeTask(persistedProcess());
      await persistence.appendTaskOutput('bash-done0000', 'restored shell output');
      const { agent, manager } = createBackgroundManager({ sessionDir });

      await manager.loadFromDisk();
      await manager.reconcile();

      await vi.waitFor(() => {
        expect(agent.context.appendUserMessage).toHaveBeenCalledTimes(1);
      });
      expect(agent.turn.steer).not.toHaveBeenCalled();
      const [content, origin] = agent.context.appendUserMessage.mock.calls[0]!;
      expect(origin).toEqual({
        kind: 'background_task',
        taskId: 'bash-done0000',
        status: 'completed',
        notificationId: 'task:bash-done0000:completed',
      });
      const text = (content as Array<{ text: string }>)[0]!.text;
      expect(text).toContain('Background process completed');
      expect(text).not.toContain('restored shell output');
      expect(text).toContain('<output-file');
      expect(text).toContain(persistence.taskOutputFile('bash-done0000'));
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('references persisted output without reading a tail for restored process notifications', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-bash-tail-'));
    try {
      const taskId = 'bash-large000';
      const largeOutput = `early-output-marker\n${'x'.repeat(8_000)}\nfinal output line`;
      const persistence = new BackgroundTaskPersistence(sessionDir);
      await persistence.writeTask(persistedProcess({ taskId }));
      await persistence.appendTaskOutput(taskId, largeOutput);
      const { agent, manager } = createBackgroundManager({ sessionDir });
      const readOutputSpy = vi.spyOn(manager, 'readOutput');
      const snapshotSpy = vi.spyOn(manager, 'getOutputSnapshot');

      await manager.loadFromDisk();
      await manager.reconcile();

      await vi.waitFor(() => {
        expect(agent.context.appendUserMessage).toHaveBeenCalledTimes(1);
      });
      expect(readOutputSpy).not.toHaveBeenCalled();
      expect(snapshotSpy).toHaveBeenCalledWith(taskId, expect.any(Number));
      expect(snapshotSpy.mock.calls[0]![1]).toBe(0);
      const [content] = agent.context.appendUserMessage.mock.calls[0]!;
      const text = (content as Array<{ text: string }>)[0]!.text;
      expect(text).toContain('<output-file');
      expect(text).toContain(persistence.taskOutputFile(taskId));
      expect(text).not.toContain('final output line');
      expect(text).not.toContain('early-output-marker');
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('does not replay restored notifications already marked delivered', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-agent-replay-'));
    try {
      const origin = {
        kind: 'background_task',
        taskId: 'question-seen0000',
        status: 'completed',
        notificationId: 'task:question-seen0000:completed',
      } as const;
      const persistence = new BackgroundTaskPersistence(sessionDir);
      await persistence.writeTask(persistedQuestion({ taskId: 'question-seen0000' }));
      await persistence.appendTaskOutput('question-seen0000', 'already delivered summary');
      const { agent, manager } = createBackgroundManager({ sessionDir });
      manager.markDeliveredNotification(origin);

      await manager.loadFromDisk();
      await manager.reconcile();

      expect(agent.turn.steer).not.toHaveBeenCalled();
      expect(agent.context.appendUserMessage).not.toHaveBeenCalled();
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('does not double-notify newly lost restored non-process tasks', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-question-lost-'));
    try {
      const persistence = new BackgroundTaskPersistence(sessionDir);
      await persistence.writeTask(
        persistedQuestion({
          taskId: 'question-run00000',
          description: 'interrupted task',
          endedAt: null,
          status: 'running',
        }),
      );
      const { agent, manager } = createBackgroundManager({ sessionDir });

      await manager.loadFromDisk();
      await manager.reconcile();
      await manager.reconcile();

      await vi.waitFor(() => {
        expect(agent.turn.steer).toHaveBeenCalledTimes(1);
      });
      expect(agent.context.appendUserMessage).not.toHaveBeenCalled();
      const [content, origin] = agent.turn.steer.mock.calls[0]!;
      expect(origin).toEqual({
        kind: 'background_task',
        taskId: 'question-run00000',
        status: 'lost',
        notificationId: 'task:question-run00000:lost',
      });
      expect((content as Array<{ text: string }>)[0]!.text).toContain(
        'Background question lost',
      );
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('fires a Notification hook when a background task notification is delivered', async () => {
    const fireAndForgetTrigger = vi.fn(() => Promise.resolve([]));
    const { agent, manager } = createBackgroundManager({
      hooks: { fireAndForgetTrigger },
    });
    const taskId = manager.registerTask(
      promiseTask(
        Promise.resolve({ result: 'final task output' }),
        'inspect repository',
      ),
    );

    await manager.wait(taskId);

    await vi.waitFor(() => {
      expect(agent.turn.steer).toHaveBeenCalled();
      expect(fireAndForgetTrigger).toHaveBeenCalled();
    });
    expect(fireAndForgetTrigger).toHaveBeenCalledWith('Notification', {
      matcherValue: 'task.completed',
      inputData: {
        sink: 'context',
        notificationType: 'task.completed',
        title: 'Background question completed',
        body: 'inspect repository completed.',
        severity: 'info',
        sourceKind: 'background_task',
        sourceId: taskId,
      },
    });
  });

  it('does not let Notification hook failures interrupt notification delivery', async () => {
    const fireAndForgetTrigger = vi.fn(() => {
      throw new Error('notification hook failed');
    });
    const { agent, manager } = createBackgroundManager({
      hooks: { fireAndForgetTrigger },
    });
    const taskId = manager.registerTask(
      promiseTask(
        Promise.resolve({ result: 'final task output' }),
        'inspect repository',
      ),
    );

    await manager.wait(taskId);

    await vi.waitFor(() => {
      expect(agent.turn.steer).toHaveBeenCalled();
      expect(fireAndForgetTrigger).toHaveBeenCalled();
    });
  });

  it('fires Notification hooks for process task notifications', async () => {
    const fireAndForgetTrigger = vi.fn(() => Promise.resolve([]));
    const { agent, manager } = createBackgroundManager({
      hooks: { fireAndForgetTrigger },
    });
    const taskId = registerProcess(manager, immediateProcess(0), 'echo', 'done');

    await manager.wait(taskId);

    await vi.waitFor(() => {
      expect(agent.turn.steer).toHaveBeenCalled();
      expect(fireAndForgetTrigger).toHaveBeenCalled();
    });
    expect(fireAndForgetTrigger).toHaveBeenCalledWith('Notification', {
      matcherValue: 'task.completed',
      inputData: {
        sink: 'context',
        notificationType: 'task.completed',
        title: 'Background process completed',
        body: 'done completed.',
        severity: 'info',
        sourceKind: 'background_task',
        sourceId: taskId,
      },
    });
  });
});

describe('BackgroundManager — notification bodies', () => {
  it('process task body never mentions resume', async () => {
    const { agent, manager } = createBackgroundManager();
    const taskId = registerProcess(manager, immediateProcess(1), 'false', 'shell');

    await manager.wait(taskId);

    await vi.waitFor(() => {
      expect(agent.turn.steer).toHaveBeenCalled();
    });
    const [content] = agent.turn.steer.mock.calls[0]!;
    const text = (content as Array<{ text: string }>)[0]!.text;
    expect(text).not.toContain('agent_id=');
    expect(text).not.toMatch(/Agent\(resume=/);
    expect(text).toContain(`source_id="${taskId}"`);
  });
});
