/**
 * Output-limit continuation.
 *
 * A `max_tokens` stop is not an answer — the provider cut the message where it
 * ran out of room. The turn resumes the same message instead of handing the
 * reader half a sentence, bounded so a model that never converges cannot spend
 * the whole step budget on one reply.
 */

import { expect, it } from 'vitest';

import { testAgent } from './harness/agent';

function truncated(text: string) {
  return { parts: [{ type: 'text' as const, text }], finishReason: 'truncated' as const };
}

function stepCount(ctx: ReturnType<typeof testAgent>): number {
  return ctx.allEvents.filter(
    (event) => event.type === '[rpc]' && event.event === 'turn.step.started',
  ).length;
}

it('resumes a reply the provider cut at the output token limit', async () => {
  const ctx = testAgent();
  ctx.configure();

  ctx.mockNextProviderResponse(truncated('The first half of the answer'));
  ctx.mockNextResponse({ type: 'text', text: ' and the rest of it.' });
  await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Write a long answer' }] });
  await ctx.untilTurnEnd();

  expect(stepCount(ctx)).toBe(2);
  expect(ctx.allEvents).toContainEqual(expect.objectContaining({
    event: 'turn.ended',
    args: expect.objectContaining({ reason: 'completed' }),
  }));
  // The second step was asked to continue, and it saw the cut text to continue from.
  const inputs = JSON.stringify(ctx.llmInputs());
  expect(inputs).toContain('reached the output token limit');
  expect(inputs).toContain('The first half of the answer');
});

it('stops resuming after the per-turn cap so one reply cannot eat the turn', async () => {
  const ctx = testAgent();
  ctx.configure();

  for (let attempt = 0; attempt < 6; attempt += 1) {
    ctx.mockNextProviderResponse(truncated(`chunk ${String(attempt)}`));
  }
  await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Never stop' }] });
  await ctx.untilTurnEnd();

  // The first step plus three continuations.
  expect(stepCount(ctx)).toBe(4);
});
