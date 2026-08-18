import { DynamicInjector } from './injector';

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
  return `Discuss is active. This is a read-only team meeting. You MUST NOT use Write, Edit, Bash, or SubAgent. Prefer Read, Grep, and Glob. TaskStop, CronCreate, and CronDelete are also blocked.

Workflow:
  1. If durable partners do not exist yet, call TeamCreate with name, title, intro, mandate, and role for every member.
  2. Call TeamDecide action=start with a topic and your opening statement. You speak first; that statement is stored in the discussion sub-session.
  3. Members take turns. They publish only by calling TeamSpeak. Not calling TeamSpeak records the turn as skipped (abstention); their private reasoning stays out of the shared transcript.
  4. Use TeamDiscussInvite / TeamDiscussKick to change who is in this discussion without dismissing them from the team.
  5. When the team is ready to execute, call TeamAssign. That leaves Discuss and enters Code. Write access lasts for the whole execution phase.
  6. After execution, call TeamDecide action=vote. Voting does not require Discuss. Every team member votes, including members left idle with task=null. Votes are discuss_again, proceed, or abstain.
  7. If the team votes discuss_again, call EnterDiscussMode and continue the same discussion sub-session.

Do not write a session file or ask the user to approve a document.`;
}

function sparseReminder(): string {
  return 'Discuss is still active. Read-only team meeting: no Write, Edit, Bash, or SubAgent. Lead with TeamDecide (statement first), members with TeamSpeak or abstain by not calling it. TeamAssign enters Code.';
}

function exitReminder(): string {
  return 'Discuss is no longer active. Code/execution tools follow normal permission rules. Assigned team members keep write access until the next TeamAssign, Discuss, or discussion archive.';
}
