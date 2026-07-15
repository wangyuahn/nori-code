import { describe, expect, it } from 'vitest';
import type { Session } from '../src/api/client';
import { summarizeUsage } from '../src/components/UsageOverview';

describe('usage overview aggregation', () => {
  it('aggregates persistent session usage without opening sessions', () => {
    const now = new Date(2026, 6, 15, 12);
    const sessions = [
      session('a', new Date(2026, 6, 13, 16), 8, 'model-a', [100, 20, 30, 10]),
      session('b', new Date(2026, 6, 14, 16), 12, 'model-a', [200, 40, 60, 20]),
      session('c', new Date(2026, 6, 15, 9), 5, 'model-b', [50, 10, 0, 0]),
    ];

    const summary = summarizeUsage(sessions, 'all', now);
    expect(summary).toMatchObject({
      sessions: 3,
      messages: 25,
      tokens: 540,
      activeDays: 3,
      currentStreak: 3,
      longestStreak: 3,
      peakHour: 16,
      favoriteModel: 'model-a',
    });
    expect(summary.models[0]).toMatchObject({ model: 'model-a', sessions: 2, messages: 20, tokens: 480 });
  });

  it('applies the selected time range', () => {
    const now = new Date(2026, 6, 15, 12);
    const sessions = [
      session('recent', new Date(2026, 6, 14, 9), 3, 'model-a', [10, 5, 0, 0]),
      session('old', new Date(2026, 5, 1, 9), 20, 'model-b', [500, 100, 0, 0]),
    ];
    expect(summarizeUsage(sessions, '7d', now)).toMatchObject({ sessions: 1, messages: 3, tokens: 15 });
  });
});

function session(
  id: string,
  updatedAt: Date,
  messages: number,
  model: string,
  tokens: [number, number, number, number],
): Session {
  return {
    id,
    title: id,
    status: 'idle',
    created_at: updatedAt.toISOString(),
    updated_at: updatedAt.toISOString(),
    message_count: messages,
    agent_config: { model },
    usage: {
      input_tokens: tokens[0],
      output_tokens: tokens[1],
      cache_read_tokens: tokens[2],
      cache_creation_tokens: tokens[3],
      total_cost_usd: 0,
      context_tokens: 0,
      context_limit: 0,
      turn_count: 0,
    },
  };
}
