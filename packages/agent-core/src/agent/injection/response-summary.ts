import { DynamicInjector } from './injector';
import REMINDER from './response-summary.md?raw';

export const RESPONSE_SUMMARY_REMINDER_VARIANT = 'response_summary';

/** Keeps tool work in the activity transcript and guarantees a visible outcome. */
export class ResponseSummaryInjector extends DynamicInjector {
  protected override readonly injectionVariant = RESPONSE_SUMMARY_REMINDER_VARIANT;

  override async inject(): Promise<void> {
    const injection = this.getInjection();
    if (injection === undefined) {
      this.agent.context.clearTransientSystemReminder();
      return;
    }
    this.injectedAt = this.agent.context.history.length;
    this.agent.context.setTransientSystemReminder(injection, {
      kind: 'injection',
      variant: this.injectionVariant,
    });
  }

  protected override getInjection(): string | undefined {
    if (this.agent.type !== 'main') return undefined;
    return this.agent.context.history.some(isUserPrompt) ? REMINDER.trim() : undefined;
  }
}

function isUserPrompt(message: { readonly origin?: { readonly kind: string } }): boolean {
  return message.origin?.kind === 'user';
}
