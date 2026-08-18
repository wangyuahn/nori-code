import { describe, expect, it } from 'vitest';
import {
  flattenBackgroundTasks,
  rememberSessionBackgroundTasks,
} from '../src/hooks/useBackgroundTasks';
import type { BackgroundTask } from '../src/api/client';

describe('background task cache', () => {
  it('retains other sessions while the selected session is still loading', () => {
    const task = backgroundTask('agent-a', 'session-a');
    const previous = rememberSessionBackgroundTasks(new Map(), 'session-a', [task]);
    const switched = rememberSessionBackgroundTasks(previous, 'session-b', [], true);

    expect(flattenBackgroundTasks(switched).map(item => item.id)).toEqual(['agent-a']);
  });

  it('replaces a session snapshot after loading completes', () => {
    const previous = rememberSessionBackgroundTasks(
      new Map([['session-a', [backgroundTask('agent-a', 'session-a')]]]),
      'session-b',
      [backgroundTask('agent-b', 'session-b')],
    );

    expect(flattenBackgroundTasks(previous).map(item => item.id).sort()).toEqual(['agent-a', 'agent-b']);
  });
});

function backgroundTask(id: string, sessionId: string): BackgroundTask {
  return {
    id,
    session_id: sessionId,
    kind: 'subagent',
    description: id,
    status: 'running',
    created_at: '2026-07-16T00:00:00.000Z',
  };
}
