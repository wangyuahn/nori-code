import { describe, expect, it, vi } from 'vitest';

import { DiscussMode } from '../../src/agent/discussion';
import type { Agent } from '../../src/agent';

function makeAgent(hasTeamMembers = true) {
  return {
    records: { logRecord: vi.fn() },
    replayBuilder: { push: vi.fn() },
    emitStatusUpdated: vi.fn(),
    subagentHost: { hasTeamMembers: () => hasTeamMembers },
  } as unknown as Agent;
}

describe('DiscussMode', () => {
  it('enters independently and emits a discuss replay event', async () => {
    const agent = makeAgent();
    const mode = new DiscussMode(agent);

    await mode.enter('discussion-1');

    expect(mode.isActive).toBe(true);
    expect(agent.records.logRecord).toHaveBeenCalledWith({
      type: 'discuss_mode.enter',
      id: 'discussion-1',
    });
    expect(agent.replayBuilder.push).toHaveBeenCalledWith({
      type: 'discuss_updated',
      enabled: true,
    });
  });

  it('rejects re-entry and exits without owning an external payload', async () => {
    const agent = makeAgent();
    const mode = new DiscussMode(agent);

    await mode.enter('discussion-1');
    await expect(mode.enter('discussion-2')).rejects.toThrow('Already in Discuss');

    mode.exit('discussion-1');

    expect(mode.isActive).toBe(false);
    expect(agent.records.logRecord).toHaveBeenLastCalledWith({
      type: 'discuss_mode.exit',
      id: 'discussion-1',
    });
  });

  it('refuses to enter without a department', async () => {
    // A meeting of one deadlocks: the read-only guard denies Write/Edit/Bash and
    // the only tool that leaves Discuss (TeamAssign) needs a member to assign to.
    const agent = makeAgent(false);
    const mode = new DiscussMode(agent);

    expect(mode.canEnter()).toBe(false);
    await expect(mode.enter('discussion-1')).rejects.toThrow('Discuss needs a department');
    expect(mode.isActive).toBe(false);
    expect(agent.replayBuilder.push).not.toHaveBeenCalled();
  });

  it('drops a restored discussion whose department is gone', () => {
    const agent = makeAgent(false);
    const mode = new DiscussMode(agent);

    mode.restoreEnter({ id: 'discussion-1' });

    expect(mode.isActive).toBe(false);
    expect(agent.replayBuilder.push).not.toHaveBeenCalled();
  });

  it('deactivates when the last member is dismissed', async () => {
    let members = true;
    const agent = {
      records: { logRecord: vi.fn() },
      replayBuilder: { push: vi.fn() },
      emitStatusUpdated: vi.fn(),
      subagentHost: { hasTeamMembers: () => members },
    } as unknown as Agent;
    const mode = new DiscussMode(agent);

    await mode.enter('discussion-1');
    expect(mode.isActive).toBe(true);

    members = false;
    expect(mode.isActive).toBe(false);
    expect(agent.records.logRecord).toHaveBeenCalledWith({
      type: 'discuss_mode.exit',
      id: undefined,
    });
    expect(agent.replayBuilder.push).toHaveBeenCalledWith({
      type: 'discuss_updated',
      enabled: false,
    });
    expect(agent.emitStatusUpdated).toHaveBeenCalled();
  });

  it('does not emit a second exit when already inactive', async () => {
    const agent = makeAgent();
    const mode = new DiscussMode(agent);
    await mode.enter('discussion-1');
    mode.exit('discussion-1');
    vi.mocked(agent.records.logRecord).mockClear();
    vi.mocked(agent.replayBuilder.push).mockClear();
    vi.mocked(agent.emitStatusUpdated).mockClear();

    mode.exit('discussion-1');
    mode.deactivateIfOrphaned();

    expect(agent.records.logRecord).not.toHaveBeenCalled();
    expect(agent.replayBuilder.push).not.toHaveBeenCalled();
    expect(agent.emitStatusUpdated).not.toHaveBeenCalled();
  });
});
