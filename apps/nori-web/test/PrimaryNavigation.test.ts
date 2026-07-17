import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { PrimaryNavigation } from '../src/App';

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
});
