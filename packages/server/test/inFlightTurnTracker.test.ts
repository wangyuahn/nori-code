/**
 * `InFlightTurnTracker` — what a client can safely render mid-turn.
 *
 * The turn-wide text is what a delta's `offset` is measured against, so it must
 * stay whole. The step-scoped text is what may be *rendered*: every completed
 * step of the turn is already durable and reaches the client through history,
 * interleaved with the tool calls that ran between the narrations. Rendering the
 * turn-wide text instead repeats all of it as one block below those tools.
 */

import { describe, expect, it } from 'vitest';

import { InFlightTurnTracker } from '#/services/gateway/inFlightTurnTracker';
import type { Event } from '@nori-code/protocol';

const SID = 'session-tracker';

function event(input: Record<string, unknown>): Event {
  return { agentId: 'main', ...input } as unknown as Event;
}

function feed(tracker: InFlightTurnTracker, ...events: Array<Record<string, unknown>>): void {
  for (const input of events) tracker.apply(SID, event(input));
}

describe('InFlightTurnTracker step scoping', () => {
  it('keeps the turn-wide text for offsets and resets the step text at each step', () => {
    const tracker = new InFlightTurnTracker();
    feed(tracker,
      { type: 'turn.started', turnId: 4 },
      { type: 'turn.step.started', turnId: 4, step: 1 },
      { type: 'thinking.delta', turnId: 4, delta: 'first thought' },
      { type: 'assistant.delta', turnId: 4, delta: 'First narration.' },
      { type: 'tool.call.started', turnId: 4, toolCallId: 'call-1', name: 'Write' },
      { type: 'tool.result', turnId: 4, toolCallId: 'call-1' },
      { type: 'turn.step.started', turnId: 4, step: 2 },
      { type: 'assistant.delta', turnId: 4, delta: 'Second narration.' },
      { type: 'tool.call.started', turnId: 4, toolCallId: 'call-2', name: 'Read' },
    );

    const turn = tracker.get(SID, 'main');
    expect(turn).toMatchObject({
      turn_id: 4,
      assistant_text: 'First narration.Second narration.',
      thinking_text: 'first thought',
      step_assistant_text: 'Second narration.',
      step_thinking_text: '',
      running_tools: [{ tool_call_id: 'call-2', name: 'Read' }],
    });
  });

  it('reports the offset against the whole turn so a live delta still aligns', () => {
    const tracker = new InFlightTurnTracker();
    feed(tracker, { type: 'turn.started', turnId: 5 }, { type: 'turn.step.started', turnId: 5, step: 1 });

    expect(tracker.apply(SID, event({ type: 'assistant.delta', turnId: 5, delta: 'abc' }))).toEqual({ offset: 0 });
    tracker.apply(SID, event({ type: 'turn.step.started', turnId: 5, step: 2 }));
    // A new step restarts the rendered text, never the offset baseline.
    expect(tracker.apply(SID, event({ type: 'assistant.delta', turnId: 5, delta: 'de' }))).toEqual({ offset: 3 });
    expect(tracker.get(SID, 'main')).toMatchObject({
      assistant_text: 'abcde',
      step_assistant_text: 'de',
    });
  });

  it('ignores step boundaries from a turn it is not tracking', () => {
    const tracker = new InFlightTurnTracker();
    feed(tracker,
      { type: 'turn.started', turnId: 6 },
      { type: 'assistant.delta', turnId: 6, delta: 'kept' },
      { type: 'turn.step.started', turnId: 99, step: 1 },
    );

    expect(tracker.get(SID, 'main')).toMatchObject({
      assistant_text: 'kept',
      step_assistant_text: 'kept',
    });
  });

  it('forgets the turn when it ends', () => {
    const tracker = new InFlightTurnTracker();
    feed(tracker,
      { type: 'turn.started', turnId: 7 },
      { type: 'assistant.delta', turnId: 7, delta: 'gone' },
      { type: 'turn.ended', turnId: 7 },
    );

    expect(tracker.get(SID, 'main')).toBeNull();
  });
});
