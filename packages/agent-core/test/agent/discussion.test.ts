import { describe, expect, it, vi } from 'vitest';

import { DiscussMode } from '../../src/agent/discussion';
import type { Agent } from '../../src/agent';

function makeAgent() {
  return {
    records: { logRecord: vi.fn() },
    replayBuilder: { push: vi.fn() },
    emitStatusUpdated: vi.fn(),
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

  it('rejects re-entry and exits without owning a file or plan payload', async () => {
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
});
