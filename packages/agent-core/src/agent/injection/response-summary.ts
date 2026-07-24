import type { ContextMessage } from '../context';
import { DynamicInjector } from './injector';
import REMINDER from './response-summary.md?raw';

export const RESPONSE_SUMMARY_REMINDER_VARIANT = 'response_summary';

/** Keeps tool work in the activity transcript and guarantees a visible outcome. */
export class ResponseSummaryInjector extends DynamicInjector {
  protected override readonly injectionVariant = RESPONSE_SUMMARY_REMINDER_VARIANT;

  protected override getInjection(): string | undefined {
    if (this.agent.type !== 'main') return undefined;

    const history = this.agent.context.history;
    const promptIndex = history.findLastIndex(isUserPrompt);
    if (promptIndex < 0) return undefined;

    const alreadyInjected = history
      .slice(promptIndex + 1)
      .some(message => isResponseSummaryReminder(message));
    return alreadyInjected ? undefined : REMINDER.trim();
  }
}

function isUserPrompt(message: ContextMessage): boolean {
  return message.origin?.kind === 'user';
}

function isResponseSummaryReminder(message: ContextMessage): boolean {
  return message.origin?.kind === 'injection'
    && message.origin.variant === RESPONSE_SUMMARY_REMINDER_VARIANT;
}
