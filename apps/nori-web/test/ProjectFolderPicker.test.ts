import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectFolderPicker } from '../src/components/ProjectFolderPicker';
import { I18nProvider } from '../src/i18n';

const mocks = vi.hoisted(() => ({
  home: vi.fn(),
  browse: vi.fn(),
}));

vi.mock('../src/api/client', () => ({
  api: { workspaceFolders: { home: mocks.home, browse: mocks.browse } },
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  localStorage.setItem('nori-ui-language', 'zh-CN');
  mocks.home.mockResolvedValue({
    home: '/home/dev',
    recent_roots: ['/Work/Nori/', 'C:\\work\\other'],
  });
  mocks.browse.mockImplementation(async (path?: string) => ({
    path: path ?? '/home/dev',
    parent: '/home',
    entries: [{
      name: 'docs',
      path: `${path ?? '/home/dev'}/docs`,
      is_dir: true,
      is_git_repo: false,
    }],
  }));
});

afterEach(() => {
  vi.clearAllMocks();
  delete window.noriDesktop;
  document.body.replaceChildren();
  localStorage.clear();
});

describe('ProjectFolderPicker', () => {
  it('does not load folders while it is closed', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(ProjectFolderPicker, {
        open: false,
        projects: ['/work/nori'],
        onSelect: vi.fn(),
        onClose: vi.fn(),
      })));
    });
    expect(container.querySelector('.folder-picker')).toBeNull();
    expect(mocks.home).not.toHaveBeenCalled();
    expect(mocks.browse).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
  });

  it('creates a session from an existing project and keeps duplicate paths as one choice', async () => {
    const onSelect = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(ProjectFolderPicker, {
        open: true,
        projects: ['/work/nori'],
        onSelect,
        onClose: vi.fn(),
      })));
    });
    await act(async () => {
      await vi.waitFor(() => {
        if (container.querySelectorAll('.folder-picker-recents button').length < 2) {
          throw new Error('shortcuts not ready');
        }
      });
    });

    const shortcuts = [...container.querySelectorAll<HTMLButtonElement>('.folder-picker-recents button')];
    expect(shortcuts.map(button => button.textContent)).toEqual(['nori', 'other']);
    const browseCalls = mocks.browse.mock.calls.length;
    shortcuts[0]?.click();
    expect(onSelect).toHaveBeenCalledWith('/work/nori');
    expect(mocks.browse).toHaveBeenCalledTimes(browseCalls);

    const row = container.querySelector<HTMLButtonElement>('.folder-picker-row');
    await act(async () => { row?.click(); });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(mocks.browse).toHaveBeenCalledWith('/home/dev/docs');

    await act(async () => { root.unmount(); });
  });

  it('uses the browsed folder and the desktop dialog as explicit choices', async () => {
    const onSelect = vi.fn();
    const selectProjectDirectory = vi.fn().mockResolvedValue('/picked/from/dialog');
    window.noriDesktop = { selectProjectDirectory };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(ProjectFolderPicker, {
        open: true,
        projects: [],
        onSelect,
        onClose: vi.fn(),
      })));
    });
    await act(async () => {
      await vi.waitFor(() => {
        const button = container.querySelector<HTMLButtonElement>('.folder-picker-footer .primary');
        if (!button || button.disabled) throw new Error('picker not ready');
      });
    });

    container.querySelector<HTMLButtonElement>('.folder-picker-footer .primary')?.click();
    expect(onSelect).toHaveBeenCalledWith('/home/dev');

    const browse = [...container.querySelectorAll<HTMLButtonElement>('.folder-picker-footer button')]
      .find(button => button.textContent === '浏览…');
    await act(async () => { browse?.click(); });
    expect(selectProjectDirectory).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith('/picked/from/dialog');
    await act(async () => { root.unmount(); });
  });
});

describe('new session entry', () => {
  it('opens the in-app folder picker before any session exists', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/App.tsx'), 'utf8');
    const start = source.indexOf('const startNewConversation = () => {');
    const end = source.indexOf('const handleSendMessage', start);
    const body = source.slice(start, end);
    expect(body).toContain('setPendingCreateSession(true)');
    expect(body).toContain('setFolderPickerOpen(true)');
    expect(body).not.toContain('createTopLevelSession');
    expect(body).not.toContain('selectProjectDirectory');
    expect(source).toContain('projects={projectFolders(sessions)}');
  });
});
