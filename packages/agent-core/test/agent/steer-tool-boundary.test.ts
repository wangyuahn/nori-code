import { describe, expect, it } from 'vitest';

import { createFakeKaos } from '../tools/fixtures/fake-kaos';
import { testAgent } from './harness/agent';

const FILE_STAT = {
  stMode: 0o100644,
  stIno: 0,
  stDev: 0,
  stNlink: 1,
  stUid: 0,
  stGid: 0,
  stSize: 9,
  stAtime: 0,
  stMtime: 0,
  stCtime: 0,
};

describe('steered message delivery at the tool boundary', () => {
  it('shows a message steered mid-turn to the very next LLM call, without ending the turn', async () => {
    const ctx = testAgent({
      kaos: createFakeKaos({
        stat: async () => FILE_STAT,
        readText: async () => 'file body',
      }),
    });
    ctx.configure({ tools: ['Read'] });

    // Step 1 calls Read; step 2 answers. The steer arrives while step 1's
    // tool executes. TeamDM, team Chat, and background notifications all
    // depend on this: the message must reach the model at the next tool
    // boundary — not after the agent finishes its whole turn on its own.
    ctx.mockNextResponse(
      { type: 'text', text: 'reading the file' },
      { type: 'function', id: 'call_read_1', name: 'Read', arguments: '{"path":"notes.txt"}' },
    );
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    ctx.emitter.once('tool.result', () => {
      ctx.agent.turn.steer(
        [{ type: 'text', text: '<system-reminder>\n[Chat] Peer: cache key changed\n</system-reminder>' }],
        {
          kind: 'system_trigger',
          name: 'team_chat',
          speaker: { from: 'team', speakerId: 'peer', speakerName: 'Peer' },
        },
      );
    });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start work' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls.length).toBe(2);
    const secondCallHistory = JSON.stringify(ctx.llmCalls[1]?.history);
    expect(secondCallHistory).toContain('[Chat] Peer: cache key changed');
  });
});
