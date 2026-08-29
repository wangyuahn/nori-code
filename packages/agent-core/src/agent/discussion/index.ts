import { randomUUID } from 'node:crypto';

import type { Agent } from '..';

/**
 * Independent Discuss state.
 *
 * Discuss is a transient, read-only team meeting. It deliberately owns no
 * document, path, approval flow, or session file.
 *
 * Discuss requires a department. With no members it is a meeting of one, and
 * that is a deadlock rather than a meeting: the read-only guard denies
 * Write/Edit/Bash, and the single tool that leaves Discuss — TeamAssign —
 * requires at least one member to assign work to, so the agent can neither work
 * nor get out. Every entry point therefore goes through `canEnter()`, and
 * `isActive` re-checks it on read so a Discuss that outlives its last member
 * (dismissal, restore from an older session) reports itself as off instead of
 * silently holding the agent hostage.
 */
export class DiscussMode {
  private _isActive = false;

  constructor(private readonly agent: Agent) {}

  createDiscussionId(): string {
    return randomUUID();
  }

  /** False when this agent has no department to meet with. */
  canEnter(): boolean {
    return this.agent.subagentHost?.hasTeamMembers() ?? false;
  }

  async enter(id = this.createDiscussionId(), emitStatus = true): Promise<void> {
    if (this._isActive) {
      throw new Error('Already in Discuss');
    }
    if (!this.canEnter()) {
      throw new Error('Discuss needs a department: hire members with TeamCreate first, or just do the work yourself.');
    }

    this._isActive = true;
    this.agent.records.logRecord({ type: 'discuss_mode.enter', id });
    this.agent.replayBuilder.push({
      type: 'discuss_updated',
      enabled: true,
    });
    if (emitStatus) this.agent.emitStatusUpdated();
  }

  restoreEnter({ id }: { readonly id: string }): void {
    void id;
    // A restored session can carry a Discuss whose department is gone. Entering
    // it would revive the deadlock on resume, so drop it the same way a live
    // dismissal does.
    if (!this.canEnter()) return;
    this._isActive = true;
    this.agent.replayBuilder.push({
      type: 'discuss_updated',
      enabled: true,
    });
  }

  cancel(id?: string): void {
    if (!this._isActive) return;
    this.agent.records.logRecord({ type: 'discuss_mode.cancel', id });
    this.agent.replayBuilder.push({
      type: 'discuss_updated',
      enabled: false,
    });
    this._isActive = false;
    this.agent.emitStatusUpdated();
  }

  exit(id?: string): void {
    if (!this._isActive) return;
    this.agent.records.logRecord({ type: 'discuss_mode.exit', id });
    this.agent.replayBuilder.push({
      type: 'discuss_updated',
      enabled: false,
    });
    this._isActive = false;
    this.agent.emitStatusUpdated();
  }

  /**
   * End Discuss as soon as the department is gone.
   *
   * TeamDismiss is the live path. Waiting for the next `isActive` read is not
   * enough: TeamAssign / TeamDecide throw on an empty department *before*
   * they consult Discuss, so the chair stays write-locked and told to assign
   * work to nobody. Call this from dismissal; `isActive` still re-checks as a
   * safety net for restore and any other metadata mutation.
   */
  deactivateIfOrphaned(): void {
    if (this._isActive && !this.canEnter()) this.exit();
  }

  get isActive(): boolean {
    this.deactivateIfOrphaned();
    return this._isActive;
  }
}
