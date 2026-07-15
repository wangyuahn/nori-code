import { describe, expect, it } from 'vitest';
import type { SwarmStatus } from '../src/api/client';
import {
  collectSwarmTreeRuns,
  groupSwarmRuns,
  groupSwarmRunsByProject,
  runningSwarmAgents,
  swarmRunProgress,
  swarmRunTokens,
  swarmTaskIdsForRuns,
} from '../src/components/SwarmPanel';

describe('SwarmPanel projections', () => {
  it('groups runs by their session round', () => {
    const rounds = groupSwarmRuns([
      run('swarm-2', 2),
      run('swarm-1b', 1),
      run('swarm-1a', 1),
    ]);
    expect([...rounds.keys()]).toEqual([2, 1]);
    expect(rounds.get(1)?.map(item => item.swarm_id)).toEqual(['swarm-1b', 'swarm-1a']);
  });

  it('keeps nested swarms in the parent tree instead of creating extra round roots', () => {
    const root = run('swarm-root', 1);
    const child = { ...run('swarm-child', 1), parent_swarm_id: root.swarm_id, owner_agent_id: 'agent-1' };
    const grandchild = { ...run('swarm-grandchild', 1), parent_swarm_id: child.swarm_id, owner_agent_id: 'agent-2' };
    const secondRound = run('swarm-round-2', 2);
    const allRuns = [secondRound, grandchild, child, root];
    const rounds = groupSwarmRuns(allRuns);

    expect([...rounds.keys()]).toEqual([2, 1]);
    expect(rounds.get(1)?.map(item => item.swarm_id)).toEqual(['swarm-root']);
    expect(collectSwarmTreeRuns(rounds.get(1) ?? [], allRuns).map(item => item.swarm_id)).toEqual([
      'swarm-root',
      'swarm-child',
      'swarm-grandchild',
    ]);
  });

  it('excludes aggregate and child agent tasks from the background list', () => {
    const ids = swarmTaskIdsForRuns([{
      ...run('swarm-1', 1),
      task_id: 'aggregate-task',
      tasks: [{ id: 'child-task', agent_id: 'agent-1', label: 'Inspect', status: 'running' }],
    }]);
    expect([...ids].sort()).toEqual(['agent-1', 'aggregate-task', 'child-task']);
  });

  it('adds the current live estimate to exact agent usage', () => {
    expect(swarmRunTokens({
      ...run('swarm-1', 1),
      usage: { input: 10, output: 5, cache_read: 0, cache_write: 0, total: 15 },
      tasks: [{ id: 'agent-1', label: 'Inspect', status: 'running', live_output_tokens: 4 }],
    })).toBe(19);
  });

  it('counts running agents without inflating the badge with queued work', () => {
    const activity = runningSwarmAgents([{
      ...run('swarm-1', 1),
      task_count: 20,
      tasks: [
        { id: 'running-1', label: 'One', status: 'running' },
        { id: 'running-2', label: 'Two', status: 'running' },
        { id: 'queued-1', label: 'Queued', status: 'pending' },
      ],
    }]);
    expect([...activity.ids].sort()).toEqual(['running-1', 'running-2']);
    expect(activity.untracked).toBe(0);
  });

  it('derives completed progress from task snapshots when aggregate fields are stale', () => {
    expect(swarmRunProgress({
      ...run('swarm-stale', 1),
      task_count: 0,
      completed_count: 0,
      tasks: [
        { id: 'agent-1', label: 'One', status: 'completed' },
        { id: 'agent-2', label: 'Two', status: 'completed' },
      ],
    })).toEqual({ total: 2, completed: 2, running: false, status: 'done' });
  });

  it('groups swarm runs by project and conversation', () => {
    const groups = groupSwarmRunsByProject([
      { ...run('swarm-a', 1), session_id: 'session-a' },
      { ...run('swarm-b', 1), session_id: 'session-b' },
      { ...run('swarm-c', 2), session_id: 'session-a' },
    ], [
      session('session-a', 'Project A', 'C:\\work\\alpha'),
      session('session-b', 'Project B', 'C:\\work\\beta'),
    ]);

    expect(groups.map(group => ({
      key: group.key,
      sessions: group.sessions.map(item => ({ title: item.title, runs: item.runs.map(run => run.swarm_id) })),
    }))).toEqual([
      { key: 'C:/work/alpha', sessions: [{ title: 'Project A', runs: ['swarm-a', 'swarm-c'] }] },
      { key: 'C:/work/beta', sessions: [{ title: 'Project B', runs: ['swarm-b'] }] },
    ]);
  });
});

function run(id: string, round: number): SwarmStatus {
  return {
    swarm_id: id,
    status: 'running',
    task_count: 1,
    completed_count: 0,
    round,
  };
}

function session(id: string, title: string, cwd: string) {
  return {
    id,
    title,
    status: 'ready',
    created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:00:00.000Z',
    metadata: { cwd },
  };
}
