import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileTree } from '../src/components/FileTree';
import { I18nProvider } from '../src/i18n';

const mocks = vi.hoisted(() => ({
  readDir: vi.fn(),
  reveal: vi.fn(),
}));

vi.mock('../src/api/client', () => ({
  api: { sessions: { fs: { reveal: mocks.reveal } } },
}));

vi.mock('../src/hooks/useFilesystem', () => ({
  useFilesystem: () => ({
    branch: 'main',
    error: null,
    readDir: mocks.readDir,
  }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.clearAllMocks();
  delete window.noriDesktop;
  document.body.replaceChildren();
});

describe('FileTree', () => {
  it('reveals a file from its context menu without changing the selected file', async () => {
    mocks.readDir.mockResolvedValue([{ name: 'App.tsx', path: 'src/App.tsx', kind: 'file' }]);
    mocks.reveal.mockResolvedValue({ revealed: true });
    const onSelectFile = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(FileTree, {
        sessionId: 'session-1',
        projectPath: 'C:/repo',
        onSelectFile,
      })));
      await Promise.resolve();
    });

    const row = container.querySelector<HTMLButtonElement>('.file-tree-row');
    expect(row).not.toBeNull();
    await act(async () => {
      row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 80, clientY: 90 }));
    });
    const menuItem = document.body.querySelector<HTMLButtonElement>('[role="menuitem"]');
    expect(menuItem?.textContent).toContain('Show in file manager');

    await act(async () => menuItem?.click());
    expect(mocks.reveal).toHaveBeenCalledWith('session-1', 'src/App.tsx');
    expect(onSelectFile).not.toHaveBeenCalled();

    await act(async () => { root.unmount(); });
  });

  it('uses the desktop bridge to reveal a file in the foreground', async () => {
    mocks.readDir.mockResolvedValue([{ name: 'App.tsx', path: 'src/App.tsx', kind: 'file' }]);
    const fsReveal = vi.fn().mockResolvedValue(undefined);
    window.noriDesktop = { fsReveal };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(FileTree, {
        sessionId: 'session-1',
        projectPath: 'C:\\repo',
        onSelectFile: vi.fn(),
      })));
      await Promise.resolve();
    });

    const row = container.querySelector<HTMLButtonElement>('.file-tree-row');
    await act(async () => {
      row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 80, clientY: 90 }));
    });
    await act(async () => document.body.querySelector<HTMLButtonElement>('[role="menuitem"]')?.click());

    expect(fsReveal).toHaveBeenCalledWith({ path: 'C:\\repo\\src\\App.tsx', isDirectory: false });
    expect(mocks.reveal).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
  });
});
