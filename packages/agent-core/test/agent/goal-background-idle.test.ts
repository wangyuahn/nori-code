import { describe, expect, it, vi, afterEach } from 'vitest';

import {
  DEFAULT_GOAL_BACKGROUND_IDLE_MINUTES,
  GOAL_BACKGROUND_IDLE_WAKE_ORIGIN_NAME,
  resolveGoalBackgroundIdleMinutes,
  shouldSuppressGoalContinuationForBackground,
} from '../../src/agent/turn/goal-background-idle';
import { promiseTask } from './background/helpers';
import { testAgent } from './harness/agent';

describe('goal background idle helpers', () => {
  it('defaults unset minutes to 5 and treats 0 as disable-timeout', () => {
    expect(resolveGoalBackgroundIdleMinutes(undefined)).toBe(DEFAULT_GOAL_BACKGROUND_IDLE_MINUTES);
    expect(resolveGoalBackgroundIdleMinutes(0)).toBe(0);
    expect(resolveGoalBackgroundIdleMinutes(7)).toBe(7);
    expect(resolveGoalBackgroundIdleMinutes(-1)).toBe(DEFAULT_GOAL_BACKGROUND_IDLE_MINUTES);
  });

  it('suppresses continuation only when unfinished background tasks exist', () => {
    expect(shouldSuppressGoalContinuationForBackground([])).toBe(false);
    expect(
      shouldSuppressGoalContinuationForBackground([
        {
          taskId: 'question-1',
          kind: 'question',
          description: 'worker',
          status: 'running',
          startedAt: 1,
          endedAt: null,
          questionCount: 1,
        },
      ]),
    ).toBe(true);
  });
});

describe('driveGoal + unfinished background', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not immediately continue the goal while a background agent is unfinished', async () => {
    const ctx = testAgent({
      initialConfig: {
        providers: {},
        loopControl: { goalBackgroundIdleMinutes: 5 },
      },
    });
    ctx.configure({ tools: [] });

    await ctx.agent.goal.createGoal({ objective: 'wait for workers' }, 'model');

    // Hang forever so the task stays non-terminal.
    const never = new Promise<{ result: string }>(() => {});
    ctx.agent.background.registerTask(promiseTask(never, 'hanging collaborator'));

    ctx.mockNextResponse({ type: 'text', text: 'Launched workers; waiting.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'pursue the goal' }] });
    await ctx.agent.turn.waitForCurrentTurn();

    expect(ctx.llmCalls.length).toBe(1);
    expect(JSON.stringify(ctx.llmCalls[0]?.history ?? [])).not.toContain(
      'Continue working toward the active goal',
    );
    expect(ctx.agent.goal.getGoal().goal?.status).toBe('active');
    expect(ctx.agent.background.list(true).length).toBe(1);
    expect(ctx.agent.turn.hasActiveTurn).toBe(false);
  });

  it('force-wakes after the configured idle minutes with no background reaction', async () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      initialConfig: {
        providers: {},
        loopControl: { goalBackgroundIdleMinutes: 5 },
      },
    });
    ctx.configure({ tools: [] });
    await ctx.agent.goal.createGoal({ objective: 'wait for workers' }, 'model');

    const never = new Promise<{ result: string }>(() => {});
    ctx.agent.background.registerTask(promiseTask(never, 'hanging collaborator'));

    ctx.mockNextResponse({ type: 'text', text: 'Waiting on background.' });
    ctx.mockNextResponse({ type: 'text', text: 'Idle wake ack.' });

    ctx.agent.turn.prompt([{ type: 'text', text: 'pursue the goal' }]);
    await ctx.agent.turn.waitForCurrentTurn();
    expect(ctx.llmCalls.length).toBe(1);
    expect(ctx.agent.turn.hasActiveTurn).toBe(false);

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    await vi.waitFor(() => {
      expect(ctx.llmCalls.length).toBeGreaterThanOrEqual(2);
    });

    const wakeCall = ctx.llmCalls[1]!;
    const flat = JSON.stringify(wakeCall.history);
    expect(flat).toContain('Background agents or tasks are still running');
  });

  it('resets the idle timer after a force-wake when the model keeps waiting', async () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      initialConfig: {
        providers: {},
        loopControl: { goalBackgroundIdleMinutes: 5 },
      },
    });
    ctx.configure({ tools: [] });
    await ctx.agent.goal.createGoal({ objective: 'wait for workers' }, 'model');

    const never = new Promise<{ result: string }>(() => {});
    ctx.agent.background.registerTask(promiseTask(never, 'hanging collaborator'));

    ctx.mockNextResponse({ type: 'text', text: 'Waiting first.' });
    ctx.mockNextResponse({ type: 'text', text: 'Still waiting after wake.' });
    ctx.mockNextResponse({ type: 'text', text: 'Second idle wake.' });

    ctx.agent.turn.prompt([{ type: 'text', text: 'pursue the goal' }]);
    await ctx.agent.turn.waitForCurrentTurn();
    expect(ctx.llmCalls.length).toBe(1);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await vi.waitFor(() => {
      expect(ctx.llmCalls.length).toBe(2);
    });
    // Wait until the force-wake turn settles and re-arms the idle timer.
    await vi.waitFor(() => {
      expect(ctx.agent.turn.hasActiveTurn).toBe(false);
    });

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(ctx.llmCalls.length).toBe(2);

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => {
      expect(ctx.llmCalls.length).toBe(3);
    });
  });

  it('resets the idle countdown when background activity is noted', async () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      initialConfig: {
        providers: {},
        loopControl: { goalBackgroundIdleMinutes: 5 },
      },
    });
    ctx.configure({ tools: [] });
    await ctx.agent.goal.createGoal({ objective: 'wait for workers' }, 'model');

    const never = new Promise<{ result: string }>(() => {});
    ctx.agent.background.registerTask(promiseTask(never, 'hanging collaborator'));

    ctx.mockNextResponse({ type: 'text', text: 'Waiting.' });
    ctx.mockNextResponse({ type: 'text', text: 'Wake after activity reset.' });

    ctx.agent.turn.prompt([{ type: 'text', text: 'pursue the goal' }]);
    await ctx.agent.turn.waitForCurrentTurn();
    expect(ctx.llmCalls.length).toBe(1);

    // Almost at timeout, then a background reaction resets the countdown.
    await vi.advanceTimersByTimeAsync(4 * 60_000 + 30_000);
    ctx.agent.turn.noteBackgroundActivity();
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(ctx.llmCalls.length).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => {
      expect(ctx.llmCalls.length).toBe(2);
    });
  });

  it('with idle minutes 0 suppresses continuation but never force-wakes', async () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      initialConfig: {
        providers: {},
        loopControl: { goalBackgroundIdleMinutes: 0 },
      },
    });
    ctx.configure({ tools: [] });
    await ctx.agent.goal.createGoal({ objective: 'wait for workers' }, 'model');

    const never = new Promise<{ result: string }>(() => {});
    ctx.agent.background.registerTask(promiseTask(never, 'hanging collaborator'));

    ctx.mockNextResponse({ type: 'text', text: 'Waiting forever without timeout wake.' });

    ctx.agent.turn.prompt([{ type: 'text', text: 'pursue the goal' }]);
    await ctx.agent.turn.waitForCurrentTurn();
    expect(ctx.llmCalls.length).toBe(1);

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(ctx.llmCalls.length).toBe(1);
    expect(GOAL_BACKGROUND_IDLE_WAKE_ORIGIN_NAME).toBe('goal_background_idle_wake');
  });

  it('still continues the goal when no background tasks are unfinished', async () => {
    const ctx = testAgent({
      initialConfig: {
        providers: {},
        loopControl: { goalBackgroundIdleMinutes: 5 },
      },
    });
    ctx.configure({ tools: ['UpdateGoal'] });
    await ctx.agent.goal.createGoal({ objective: 'finish soon' }, 'model');

    ctx.mockNextResponse({ type: 'text', text: 'working' });
    ctx.mockNextResponse({
      type: 'function',
      id: 'done',
      name: 'UpdateGoal',
      arguments: JSON.stringify({ status: 'complete' }),
    });
    ctx.mockNextResponse({ type: 'text', text: 'Done.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'pursue the goal' }] });
    await ctx.agent.turn.waitForCurrentTurn();

    expect(ctx.llmCalls.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(ctx.llmCalls[1]?.history ?? [])).toContain(
      'Continue working toward the active goal',
    );
    expect(ctx.agent.goal.getGoal().goal).toBeNull();
  });
});
