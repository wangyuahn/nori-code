import { describe, expect, it } from 'vitest';

import type { Agent } from '../../../src/agent';
import type { ContextMessage, PromptOrigin } from '../../../src/agent/context';
import {
  GOAL_INTAKE_REMINDER_VARIANT,
  GoalIntakeInjector,
} from '../../../src/agent/injection/goal-intake';

function makeAgent(options: {
  type?: 'main' | 'sub';
  hasGoal?: boolean;
  createGoalActive?: boolean;
} = {}): Agent {
  const history: ContextMessage[] = [];
  return {
    type: options.type ?? 'main',
    goal: { getGoal: () => ({ goal: options.hasGoal === true ? { status: 'active' } : null }) },
    tools: {
      data: () => [{ name: 'CreateGoal', active: options.createGoalActive !== false }],
    },
    context: {
      history,
      appendSystemReminder: (content: string, origin: PromptOrigin) => {
        history.push({
          role: 'user',
          content: [{ type: 'text', text: `<system-reminder>\n${content}\n</system-reminder>` }],
          toolCalls: [],
          origin,
        });
      },
    },
  } as unknown as Agent;
}

function appendPrompt(agent: Agent, loop: boolean): void {
  (agent.context.history as ContextMessage[]).push({
    role: 'user',
    content: [{ type: 'text', text: 'Implement the feature' }],
    toolCalls: [],
    origin: loop ? { kind: 'user', goalIntake: true } : { kind: 'user' },
  });
}

describe('GoalIntakeInjector', () => {
  it('injects the CreateGoal instruction once for an opted-in user prompt', async () => {
    const agent = makeAgent();
    appendPrompt(agent, true);
    const injector = new GoalIntakeInjector(agent);

    await injector.inject();
    await injector.inject();

    const reminders = agent.context.history.filter(
      (message) =>
        message.origin?.kind === 'injection' &&
        message.origin.variant === GOAL_INTAKE_REMINDER_VARIANT,
    );
    expect(reminders).toHaveLength(1);
    expect(JSON.stringify(reminders[0]?.content)).toContain('call `CreateGoal`');
  });

  it('does not carry Loop mode into a later normal prompt', async () => {
    const agent = makeAgent();
    const injector = new GoalIntakeInjector(agent);
    appendPrompt(agent, true);
    await injector.inject();
    appendPrompt(agent, false);
    await injector.inject();

    expect(agent.context.history.filter(
      (message) => message.origin?.kind === 'injection' && message.origin.variant === GOAL_INTAKE_REMINDER_VARIANT,
    )).toHaveLength(1);
  });

  it('skips subagents, existing goals, and profiles without CreateGoal', async () => {
    for (const agent of [
      makeAgent({ type: 'sub' }),
      makeAgent({ hasGoal: true }),
      makeAgent({ createGoalActive: false }),
    ]) {
      appendPrompt(agent, true);
      await new GoalIntakeInjector(agent).inject();
      expect(agent.context.history).toHaveLength(1);
    }
  });
});
