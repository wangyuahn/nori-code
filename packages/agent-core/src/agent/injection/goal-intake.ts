import type { ContextMessage } from '../context';
import { DynamicInjector } from './injector';
import REMINDER from './goal-intake.md?raw';

export const GOAL_INTAKE_REMINDER_VARIANT = 'goal_intake';

/** Injects the opt-in Loop instruction once for the latest user prompt. */
export class GoalIntakeInjector extends DynamicInjector {
  protected override readonly injectionVariant = GOAL_INTAKE_REMINDER_VARIANT;

  protected override getInjection(): string | undefined {
    if (this.agent.type !== 'main' || this.agent.goal.getGoal().goal !== null) return undefined;
    if (!this.agent.tools.data().some((tool) => tool.name === 'CreateGoal' && tool.active)) {
      return undefined;
    }

    const history = this.agent.context.history;
    const promptIndex = history.findLastIndex(isUserPrompt);
    if (promptIndex < 0) return undefined;
    const promptOrigin = history[promptIndex]?.origin;
    if (promptOrigin?.kind !== 'user' || promptOrigin.goalIntake !== true) return undefined;

    const alreadyInjected = history
      .slice(promptIndex + 1)
      .some((message) => isGoalIntakeReminder(message));
    return alreadyInjected ? undefined : REMINDER;
  }
}

function isUserPrompt(message: ContextMessage): boolean {
  return message.origin?.kind === 'user';
}

function isGoalIntakeReminder(message: ContextMessage): boolean {
  return (
    message.origin?.kind === 'injection' &&
    message.origin.variant === GOAL_INTAKE_REMINDER_VARIANT
  );
}
