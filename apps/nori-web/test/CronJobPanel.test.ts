import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api, type CronJob, type Session } from '../src/api/client';
import { CronJobPanel } from '../src/components/CronJobPanel';
import { I18nProvider } from '../src/i18n';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => vi.restoreAllMocks());

describe('CronJobPanel', () => {
  it('loads the selected session and creates a job in place', async () => {
    vi.spyOn(api.sessions.cron, 'list').mockResolvedValue({ items: [job('deadbeef')] });
    vi.spyOn(api.sessions.cron, 'create').mockResolvedValue(job('cafebabe', 'Run tests'));
    const onCountChange = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(CronJobPanel, {
          sessions: [session()],
          sessionId: 'session-a',
          onCountChange,
        })));
      });
      await vi.waitFor(() => { expect(container.textContent).toContain('Review changes'); });
      expect(api.sessions.cron.list).toHaveBeenCalledWith('session-a');
      expect(onCountChange).toHaveBeenCalledWith('session-a', 1);

      const prompt = container.querySelector<HTMLTextAreaElement>('.cron-field textarea')!;
      await act(async () => {
        setInputValue(prompt, 'Run tests');
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('.cron-create-button')!.click();
      });

      expect(api.sessions.cron.create).toHaveBeenCalledWith('session-a', {
        cron: '0 9 * * 1-5',
        prompt: 'Run tests',
        recurring: true,
      });
      expect(container.textContent).toContain('Run tests');
      expect(container.querySelectorAll('.cron-job-card')).toHaveLength(2);
      expect(onCountChange).toHaveBeenLastCalledWith('session-a', 2);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('shows a real empty state when there are no sessions', async () => {
    const list = vi.spyOn(api.sessions.cron, 'list');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(CronJobPanel, {
          sessions: [],
          sessionId: null,
        })));
      });
      expect(container.textContent).toContain('No session selected');
      expect(list).not.toHaveBeenCalled();
      expect(container.querySelector<HTMLButtonElement>('.cron-create-button')?.disabled).toBe(true);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('does not present a failed request as an empty job list', async () => {
    vi.spyOn(api.sessions.cron, 'list').mockRejectedValue(
      new Error('API GET /sessions/session-a/cron failed: 404'),
    );
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(CronJobPanel, {
          sessions: [session()],
          sessionId: 'session-a',
        })));
      });
      await vi.waitFor(() => {
        expect(container.querySelector('[role="alert"]')?.textContent).toContain('does not support Cron Jobs');
      });
      expect(container.textContent).not.toContain('No Cron Jobs');
      expect(container.querySelector('.cron-empty')).toBeNull();
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('ignores a stale list response after the selected session changes', async () => {
    let resolveFirst!: (value: { items: CronJob[] }) => void;
    let resolveSecond!: (value: { items: CronJob[] }) => void;
    vi.spyOn(api.sessions.cron, 'list').mockImplementation((sessionId) => new Promise(resolve => {
      if (sessionId === 'session-a') resolveFirst = resolve;
      else resolveSecond = resolve;
    }));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(CronJobPanel, {
          sessions: [session(), session('session-b', 'Second session')],
          sessionId: 'session-a',
        })));
      });
      const select = container.querySelector<HTMLSelectElement>('.cron-session-select select')!;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
        setter?.call(select, 'session-b');
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });

      await act(async () => { resolveSecond({ items: [job('bbbbbbbb', 'Second result')] }); });
      expect(container.textContent).toContain('Second result');

      await act(async () => { resolveFirst({ items: [job('aaaaaaaa', 'Stale first result')] }); });
      expect(container.textContent).toContain('Second result');
      expect(container.textContent).not.toContain('Stale first result');
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });
});

function setInputValue(element: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function job(id: string, prompt = 'Review changes'): CronJob {
  return {
    id,
    cron: '0 9 * * 1-5',
    prompt,
    createdAt: Date.now(),
    recurring: true,
    humanSchedule: 'at 09:00 on weekdays',
    nextFireAt: Date.now() + 60_000,
    ageDays: 0,
    stale: false,
  };
}

function session(id = 'session-a', title = 'Release work'): Session {
  return {
    id,
    title,
    status: 'idle',
    created_at: '2026-07-16T00:00:00.000Z',
    updated_at: '2026-07-16T00:00:00.000Z',
    metadata: { cwd: 'C:\\work\\nori' },
  };
}
