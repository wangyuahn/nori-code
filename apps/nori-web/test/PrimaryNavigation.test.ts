import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { countActiveAgents, departmentAgentsFromSessions, PrimaryNavigation, WindowControls } from '../src/App';
import type { Session, SessionActivity } from '../src/api/client';
import { I18nProvider } from '../src/i18n';
import type { NoriDesktopAPI } from '../src/types/nori-desktop';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.replaceChildren();
  delete window.noriDesktop;
  vi.restoreAllMocks();
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
          chat: 'Chat', team: 'Map', cron: 'Cron Job',
          account: 'My profile',
        },
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
          chat: 'Chat', team: 'Map', cron: 'Cron Job',
          account: 'My profile',
        },
        cronJobCount: 0,
        onSelect: () => undefined,
      }));
    });

    const cronButton = container.querySelector<HTMLButtonElement>('button[title="Cron Job"]');
    expect(cronButton?.classList.contains('activity-pending')).toBe(false);
    expect(cronButton?.querySelector('.sidebar-activity-count')).toBeNull();

    await act(async () => { root.unmount(); });
  });

  it('does not render the deprecated collaboration navigation item', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(PrimaryNavigation, {
        activeView: 'chat',
        labels: {
          chat: 'Chat', team: 'Map', cron: 'Cron Job',
          account: 'My profile',
        },
        cronJobCount: 0,
        onSelect: () => undefined,
      }));
    });

    expect(container.querySelector('button[title="Collaboration"]')).toBeNull();
    // 仪表盘已被删掉：导航里只剩对话、团队、定时任务。
    expect([...container.querySelectorAll('button')].map(node => node.title))
      .toEqual(['Chat', 'Map', 'Cron Job']);

    await act(async () => { root.unmount(); });
  });

  it('counts every activity entry globally and only the current session when scoped', () => {
    const activity: SessionActivity[] = [
      { session_id: 'session-a', agent_id: 'main', kind: 'agent', status: 'running' },
      { session_id: 'session-a', agent_id: 'agent_reviewer', kind: 'agent', status: 'awaiting_approval' },
      { session_id: 'session-b', agent_id: 'main', kind: 'background', task_id: 'process-1', status: 'running' },
    ];

    expect(countActiveAgents(activity)).toBe(3);
    expect(countActiveAgents(activity, 'session-a')).toBe(2);
    expect(countActiveAgents(activity, 'session-b')).toBe(1);
    expect(countActiveAgents(activity, 'session-missing')).toBe(0);
    expect(countActiveAgents([])).toBe(0);
  });
});

describe('departmentAgentsFromSessions', () => {
  const parent: Session = {
    id: 'sess_parent',
    title: 'Lead',
    status: 'idle',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    metadata: { cwd: '/work/demo' },
  };
  const child: Session = {
    id: 'sess_child',
    title: 'Fallback title',
    status: 'running',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-03T00:00:00.000Z',
    metadata: {
      parent_session_id: 'sess_parent',
      mount_name: 'Reviewer',
      mount_role: 'reviewer',
      mount_mandate: 'Review diffs',
      department_assigned_task: 'Ship the parser',
    },
  };

  it('reads mounted children from the session forest, not a shadow agent tree', () => {
    expect(departmentAgentsFromSessions([parent, child], parent)).toEqual([
      expect.objectContaining({
        agent_id: 'sess_child',
        kind: 'team',
        parent_agent_id: 'sess_parent',
        name: 'Reviewer',
        role: 'reviewer',
        mandate: 'Review diffs',
        assigned_task: 'Ship the parser',
        status: 'running',
        last_active: '2026-01-03T00:00:00.000Z',
        mounted_session_id: 'sess_child',
      }),
    ]);
  });

  it('uses the same siblings when the viewer is a child session', () => {
    const sibling: Session = {
      ...child,
      id: 'sess_sibling',
      title: 'Writer',
      metadata: { parent_session_id: 'sess_parent', mount_name: 'Writer' },
    };
    const members = departmentAgentsFromSessions([parent, child, sibling], child);
    expect(members.map(member => member.agent_id).sort()).toEqual(['sess_child', 'sess_sibling']);
    expect(members.every(member => member.parent_agent_id === 'sess_parent')).toBe(true);
  });

  it('includes a nested lead\'s own children alongside its sibling department', () => {
    const nested: Session = {
      id: 'sess_nested',
      title: 'Intern',
      status: 'idle',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-04T00:00:00.000Z',
      metadata: { parent_session_id: 'sess_child', mount_name: 'Intern' },
    };
    const members = departmentAgentsFromSessions([parent, child, nested], child);
    expect(members).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent_id: 'sess_child', parent_agent_id: 'sess_parent' }),
      expect.objectContaining({ agent_id: 'sess_nested', parent_agent_id: 'sess_child', name: 'Intern' }),
    ]));
  });
});

describe('WindowControls', () => {
  it('routes frameless window actions through the desktop bridge', async () => {
    localStorage.setItem('nori-ui-language', 'en');
    const minimize = vi.fn();
    const toggleMaximize = vi.fn(async () => true);
    const close = vi.fn();
    const unsubscribe = vi.fn();
    window.noriDesktop = {
      usesCustomWindowControls: true,
      windowMinimize: minimize,
      windowToggleMaximize: toggleMaximize,
      windowIsMaximized: vi.fn(async () => false),
      windowClose: close,
      onWindowMaximizedChange: vi.fn(() => unsubscribe),
    } satisfies NoriDesktopAPI;

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(WindowControls)));
      await Promise.resolve();
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Minimize"]')?.click();
      container.querySelector<HTMLButtonElement>('button[aria-label="Maximize"]')?.click();
      container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click();
      await Promise.resolve();
    });

    expect(minimize).toHaveBeenCalledOnce();
    expect(toggleMaximize).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(container.querySelector('button[aria-label="Restore"]')).not.toBeNull();

    await act(async () => { root.unmount(); });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
