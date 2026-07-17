import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { countActiveAgents, PrimaryNavigation } from '../src/App';
import type { BackgroundTask, SwarmStatus } from '../src/api/client';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.replaceChildren();
});

describe('PrimaryNavigation', () => {
  it('shows a yellow count on Cron Job when the current session has schedules', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(PrimaryNavigation, {
        activeView: 'chat',
        labels: {
          chat: 'Chat', dashboard: 'Dashboard', swarm: 'Swarm', cron: 'Cron Job',
          vault: 'Vault', settings: 'Settings',
        },
        activeAgentCount: 0,
        cronJobCount: 3,
        onSelect: () => undefined,
      }));
    });

    const cronButton = container.querySelector<HTMLButtonElement>('button[title="Cron Job"]');
    expect(cronButton?.classList.contains('activity-pending')).toBe(true);
    expect(cronButton?.querySelector('.sidebar-activity-count')?.textContent).toBe('3');

    await act(async () => { root.unmount(); });
  });

  it('keeps Cron Job neutral when there are no schedules', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(PrimaryNavigation, {
        activeView: 'chat',
        labels: {
          chat: 'Chat', dashboard: 'Dashboard', swarm: 'Swarm', cron: 'Cron Job',
          vault: 'Vault', settings: 'Settings',
        },
        activeAgentCount: 0,
        cronJobCount: 0,
        onSelect: () => undefined,
      }));
    });

    const cronButton = container.querySelector<HTMLButtonElement>('button[title="Cron Job"]');
    expect(cronButton?.classList.contains('activity-pending')).toBe(false);
    expect(cronButton?.querySelector('.sidebar-activity-count')).toBeNull();

    await act(async () => { root.unmount(); });
  });

  it('keeps Swarm yellow while an agent is active, including on the Swarm page', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(PrimaryNavigation, {
        activeView: 'swarm',
        labels: {
          chat: 'Chat', dashboard: 'Dashboard', swarm: 'Swarm', cron: 'Cron Job',
          vault: 'Vault', settings: 'Settings',
        },
        activeAgentCount: 2,
        cronJobCount: 0,
        onSelect: () => undefined,
      }));
    });

    const swarmButton = container.querySelector<HTMLButtonElement>('button[title="Swarm"]');
    expect(swarmButton?.classList.contains('activity-pending')).toBe(true);
    expect(swarmButton?.querySelector('.sidebar-activity-count')?.textContent).toBe('2');

    await act(async () => { root.unmount(); });
  });

  it('recovers custom background-agent activity without double-counting swarm tasks', () => {
    const run: SwarmStatus = {
      swarm_id: 'swarm-custom',
      status: 'running',
      task_count: 1,
      completed_count: 0,
      tasks: [{
        id: 'swarm-task',
        agent_id: 'custom-agent-id',
        profile: 'deepseek-reviewer',
        label: 'Review changes',
        status: 'running',
      }],
    };
    const tasks: BackgroundTask[] = [{
      id: 'swarm-task',
      session_id: 'session-a',
      kind: 'subagent',
      description: 'Swarm projection',
      status: 'running',
      created_at: '2026-07-17T00:00:00.000Z',
    }, {
      id: 'custom-background-task',
      session_id: 'session-a',
      kind: 'subagent',
      description: 'Custom background reviewer',
      status: 'running',
      created_at: '2026-07-17T00:00:01.000Z',
    }];

    expect(countActiveAgents(['custom-agent-id'], [run], tasks)).toBe(2);
    expect(countActiveAgents([], [], tasks.slice(1))).toBe(1);
  });

  it('does not resurrect a terminated swarm agent from a stale live event id', () => {
    const stopped: SwarmStatus = {
      swarm_id: 'swarm-stopped',
      status: 'stopped',
      task_count: 1,
      completed_count: 0,
      tasks: [{
        id: 'swarm-task',
        agent_id: 'agent-stopped',
        profile: 'reviewer',
        label: 'Review changes',
        status: 'stopped',
      }],
    };

    expect(countActiveAgents(['agent-stopped'], [stopped], [])).toBe(0);
  });
});
