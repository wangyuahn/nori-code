import { DynamicInjector } from './injector';
import DISCUSS_MODE_PROMPT from './discuss-mode.md?raw';

const DISCUSS_MODE_DEDUP_MIN_TURNS = 2;
const DISCUSS_MODE_FULL_REFRESH_TURNS = 5;

export type DiscussModeVariant = 'full' | 'sparse' | 'reentry';

export class DiscussModeInjector extends DynamicInjector {
  protected override readonly injectionVariant = 'discuss_mode';
  private wasActive = false;

  override onContextClear(): void {
    super.onContextClear();
    this.wasActive = this.agent.discussMode.isActive;
  }

  override async getInjection(): Promise<string | undefined> {
    const { isActive } = this.agent.discussMode;
    if (!isActive) {
      if (!this.wasActive) return undefined;
      this.wasActive = false;
      this.injectedAt = null;
      return exitReminder();
    }
    if (!this.wasActive) {
      this.injectedAt = null;
      this.wasActive = true;
    }
    const variant = this.getVariant();
    if (variant === null) return undefined;
    return variant === 'sparse' ? sparseReminder() : fullReminder();
  }

  protected getVariant(): DiscussModeVariant | null {
    if (this.injectedAt === null) return 'full';
    const history = this.agent.context.history;
    let assistantTurnsSince = 0;
    for (let i = this.injectedAt + 1; i < history.length; i++) {
      const msg = history[i];
      if (msg === undefined) continue;
      if (msg.role === 'assistant') {
        assistantTurnsSince += 1;
        continue;
      }
      if (msg.role === 'user') return 'full';
    }
    if (assistantTurnsSince >= DISCUSS_MODE_FULL_REFRESH_TURNS) return 'full';
    if (assistantTurnsSince >= DISCUSS_MODE_DEDUP_MIN_TURNS) return 'sparse';
    return null;
  }
}

function fullReminder(): string {
  return DISCUSS_MODE_PROMPT.trim();
}

function sparseReminder(): string {
  return 'Discuss is active for the main lead: read-only coordination. Use TeamDecide start for the first round or continue for later rounds, with your statement first. Members use TeamSpeak or abstain by skipping it. TeamAssign exits Discuss and starts Code.';
}

function exitReminder(): string {
  return 'Discuss ended. TeamAssign starts Code for assigned members; re-enter Discuss when more coordination is needed.';
}
