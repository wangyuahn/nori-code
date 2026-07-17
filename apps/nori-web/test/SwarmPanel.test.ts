import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { api, type SwarmStatus } from '../src/api/client';
import {
  collectSwarmTreeRuns,
  aggregateSwarmStatus,
  groupSwarmRuns,
  groupSwarmRunsByProject,
  runningSwarmAgents,
  swarmRunProgress,
  swarmRunTokens,
  swarmTaskIdsForRuns,
  SwarmPanel,
} from '../src/components/SwarmPanel';
import { I18nProvider } from '../src/i18n';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('SwarmPanel projections', () => {
  it('shows a regular background agent when there is no swarm run', async () => {
    vi.spyOn(api, 'getConfig').mockResolvedValue({ custom_agents: {} });
    vi.spyOn(api.sessions.tasks, 'list').mockResolvedValue({
      items: [{
        id: 'agent-task-1',
        session_id: 'session-a',
        kind: 'subagent',
        description: 'Inspect browser integration',
        status: 'running',
        created_at: '2026-07-16T00:00:00.000Z',
      }],
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SwarmPanel, {
          swarm: { swarmStatuses: new Map(), connected: true, error: null },
          sessionId: 'session-a',
          sessions: [session('session-a', 'Browser repair', 'C:\\work\\alpha')],
        })));
      });
      await vi.waitFor(() => expect(container.textContent).toContain('Inspect browser integration'));

      expect(container.textContent).toContain('Agents and background tasks');
      expect(container.textContent).not.toContain('No agent activity');
      expect(container.querySelector('.swarm-project-group')).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.restoreAllMocks();
    }
  });

  it('renders agents and nested swarm output from a main-model AgentSwarm call', async () => {
    vi.spyOn(api, 'getConfig').mockResolvedValue({ custom_agents: {} });
    vi.spyOn(api.sessions.tasks, 'list').mockResolvedValue({ items: [] });
    const rootRun: SwarmStatus = {
      swarm_id: 'swarm-root',
      status: 'done',
      task_count: 1,
      completed_count: 1,
      session_id: 'session-a',
      task_id: 'swarm-task-root',
      description: 'Agent swarm: Inspect the project',
      owner_agent_id: 'main',
      round: 1,
      started_at: '2026-07-16T00:00:00.000Z',
      tasks: [{
        id: 'agent-reviewer',
        agent_id: 'agent-reviewer',
        parent_agent_id: 'main',
        profile: 'deepseek-reviewer',
        label: 'Inspect streaming',
        status: 'completed',
        output: 'Finished **stream audit**.',
        output_bytes: 26,
      }],
    };
    const childRun: SwarmStatus = {
      swarm_id: 'swarm-child',
      status: 'done',
      task_count: 1,
      completed_count: 1,
      session_id: 'session-a',
      task_id: 'swarm-task-child',
      description: 'Agent swarm: Verify the fix',
      owner_agent_id: 'agent-reviewer',
      parent_swarm_id: 'swarm-root',
      round: 1,
      started_at: '2026-07-16T00:00:01.000Z',
      tasks: [{
        id: 'agent-verifier',
        agent_id: 'agent-verifier',
        parent_agent_id: 'agent-reviewer',
        profile: 'explore',
        label: 'Verify rendering',
        status: 'completed',
        output: 'Nested result',
      }],
    };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SwarmPanel, {
          swarm: {
            swarmStatuses: new Map([
              [rootRun.swarm_id, rootRun],
              [childRun.swarm_id, childRun],
            ]),
            connected: true,
            error: null,
          },
          sessionId: 'session-a',
          sessions: [session('session-a', 'Streaming repair', 'C:\\work\\alpha')],
        })));
        await Promise.resolve();
      });

      expect(container.textContent).toContain('alpha');
      expect(container.textContent).toContain('Streaming repair');
      expect(container.textContent).toContain('Round 1');
      expect(container.textContent).toContain('Inspect streaming');
      expect(container.textContent).toContain('deepseek-reviewer · agent-reviewer');
      expect(container.textContent).toContain('Verify rendering');
      expect(container.querySelector('.swarm-task-output-markdown strong')?.textContent).toBe('stream audit');
      expect(container.querySelectorAll('.swarm-run-done')).toHaveLength(2);
      expect(container.querySelector('.swarm-task-branch .swarm-child-runs .swarm-run-done')).not.toBeNull();
      expect(container.querySelector('.swarm-run-running')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.restoreAllMocks();
    }
  });

  it('renders a compact custom-agent editor with explicit permission controls', async () => {
    vi.spyOn(api, 'getConfig').mockResolvedValue({
      custom_agents: {
        reviewer: {
          description: 'Review risky changes',
          role: 'Find correctness bugs.',
          baseProfile: 'explore',
          model: 'deepseek-review',
          enabled: true,
          permissions: { read: true, write: false, shell: false, web: true, delegate: false },
        },
      },
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SwarmPanel, {
          swarm: { swarmStatuses: new Map(), connected: true, error: null },
          sessions: [],
          models: [{
            provider: 'deepseek',
            model: 'deepseek-review',
            display_name: 'DeepSeek Review',
            max_context_size: 128_000,
          }],
        })));
        await Promise.resolve();
      });
      await vi.waitFor(() => expect(container.textContent).toContain('DeepSeek Review · deepseek'));
      const form = container.querySelector('.custom-agent-form');
      expect(form?.querySelector<HTMLSelectElement>('[aria-label="Base profile"]')?.title).toContain('implementation worker');
      expect([...form?.querySelectorAll<HTMLSelectElement>('[aria-label="Agent model"] option') ?? []].map(item => item.textContent)).toEqual([
        'Inherit parent model', 'DeepSeek Review · deepseek',
      ]);
      expect([...form?.querySelectorAll('.custom-agent-permissions label') ?? []].map(item => item.textContent)).toEqual([
        'Read', 'Write', 'Terminal', 'Web', 'Delegate',
      ]);
      expect(form?.querySelector('button')?.textContent).toBe('Add agent');
      expect([...form?.querySelectorAll('option') ?? []].map(item => item.textContent)).toContain('orchestrator');
      expect(container.textContent).not.toContain('nori-coder');
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.restoreAllMocks();
    }
  });

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

    const stopped = runningSwarmAgents([{
      ...run('swarm-stopped', 1),
      status: 'stopped',
      completed_count: 2,
      task_count: 2,
      tasks: [
        { id: 'stopped-1', label: 'One', status: 'cancelled' },
        { id: 'stopped-2', label: 'Two', status: 'cancelled' },
      ],
    }]);
    expect(stopped.ids.size).toBe(0);
    expect(stopped.untracked).toBe(0);
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

  it('keeps stopped and failed runs distinct from completed runs', () => {
    expect(swarmRunProgress({
      ...run('swarm-stopped', 1),
      status: 'stopped',
      tasks: [{ id: 'agent-1', label: 'One', status: 'cancelled' }],
    }).status).toBe('stopped');
    expect(swarmRunProgress({
      ...run('swarm-failed', 1),
      status: 'failed',
      tasks: [{ id: 'agent-1', label: 'One', status: 'failed' }],
    }).status).toBe('failed');
    expect(aggregateSwarmStatus(['done', 'stopped'])).toBe('stopped');
    expect(aggregateSwarmStatus(['done', 'failed'])).toBe('failed');
    expect(aggregateSwarmStatus(['paused', 'done'])).toBe('paused');
    expect(aggregateSwarmStatus(['running', 'failed'])).toBe('running');
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
