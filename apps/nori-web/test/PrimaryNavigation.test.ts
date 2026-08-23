import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { countActiveAgents, PrimaryNavigation, WindowControls } from '../src/App';
import type { SessionActivity } from '../src/api/client';
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
          chat: 'Chat', team: 'Team', cron: 'Cron Job',
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
          chat: 'Chat', team: 'Team', cron: 'Cron Job',
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
          chat: 'Chat', team: 'Team', cron: 'Cron Job',
          account: 'My profile',
        },
        cronJobCount: 0,
        onSelect: () => undefined,
      }));
    });

    expect(container.querySelector('button[title="Collaboration"]')).toBeNull();
    // 仪表盘已被删掉：导航里只剩对话、团队、定时任务。
    expect([...container.querySelectorAll('button')].map(node => node.title))
      .toEqual(['Chat', 'Team', 'Cron Job']);

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
