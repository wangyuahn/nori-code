import { randomUUID } from 'node:crypto';

import type { Agent } from '..';

/**
 * Independent Discuss state.
 *
 * Discuss is a transient, read-only team meeting. It deliberately owns no
 * document, path, approval flow, or session file.
 */
export class DiscussMode {
  private _isActive = false;

  constructor(private readonly agent: Agent) {}

  createDiscussionId(): string {
    return randomUUID();
  }

  async enter(id = this.createDiscussionId(), emitStatus = true): Promise<void> {
    if (this._isActive) {
      throw new Error('Already in Discuss');
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
    this._isActive = true;
    this.agent.replayBuilder.push({
      type: 'discuss_updated',
      enabled: true,
    });
  }

  cancel(id?: string): void {
    this.agent.records.logRecord({ type: 'discuss_mode.cancel', id });
    this.agent.replayBuilder.push({
      type: 'discuss_updated',
      enabled: false,
    });
    this._isActive = false;
    this.agent.emitStatusUpdated();
  }

  exit(id?: string): void {
    this.agent.records.logRecord({ type: 'discuss_mode.exit', id });
    this.agent.replayBuilder.push({
      type: 'discuss_updated',
      enabled: false,
    });
    this._isActive = false;
    this.agent.emitStatusUpdated();
  }

  get isActive(): boolean {
    return this._isActive;
  }
}
