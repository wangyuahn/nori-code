import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileTree, fileTypeKind } from '../src/components/FileTree';
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

describe('file type icons', () => {
  it('distinguishes folders and common file types', () => {
    expect(fileTypeKind('src', true)).toBe('folder');
    expect(fileTypeKind('package.json', false)).toBe('json');
    expect(fileTypeKind('readme.md', false)).toBe('markdown');
    expect(fileTypeKind('flake.nix', false)).toBe('nix');
    expect(fileTypeKind('logo.png', false)).toBe('image');
    expect(fileTypeKind('App.tsx', false)).toBe('code');
    expect(fileTypeKind('notes.txt', false)).toBe('file');
  });
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

  it('renders a distinct icon for each file type', async () => {
    mocks.readDir.mockResolvedValue([
      { name: 'src', path: 'src', kind: 'directory' },
      { name: 'App.tsx', path: 'App.tsx', kind: 'file' },
      { name: 'package.json', path: 'package.json', kind: 'file' },
      { name: 'README.md', path: 'README.md', kind: 'file' },
      { name: 'theme.css', path: 'theme.css', kind: 'file' },
      { name: 'index.html', path: 'index.html', kind: 'file' },
      { name: 'logo.png', path: 'logo.png', kind: 'file' },
      { name: 'flake.nix', path: 'flake.nix', kind: 'file' },
      { name: 'config.toml', path: 'config.toml', kind: 'file' },
      { name: 'build.sh', path: 'build.sh', kind: 'file' },
    ]);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(FileTree, {
        sessionId: 'session-1',
        projectPath: '/work/nori-code',
        onSelectFile: vi.fn(),
      })));
      await Promise.resolve();
    });

    const kind = (name: string) => container.querySelector(`[title="${name}"] .file-type-icon, .file-tree-row[title="${name}"] .file-type-icon`)?.className;
    expect(container.querySelector('.file-type-icon.is-folder')).not.toBeNull();
    expect(container.querySelector('.file-type-icon.is-code')).not.toBeNull();
    expect(container.querySelector('.file-type-icon.is-json')).not.toBeNull();
    expect(container.querySelector('.file-type-icon.is-markdown')).not.toBeNull();
    expect(container.querySelector('.file-type-icon.is-style')).not.toBeNull();
    expect(container.querySelector('.file-type-icon.is-html')).not.toBeNull();
    expect(container.querySelector('.file-type-icon.is-image')).not.toBeNull();
    expect(container.querySelector('.file-type-icon.is-nix')).not.toBeNull();
    expect(container.querySelector('.file-type-icon.is-config')).not.toBeNull();
    expect(container.querySelector('.file-type-icon.is-shell')).not.toBeNull();
    expect(kind('src')).toContain('is-folder');
    expect(container.querySelectorAll('.file-tree-name').length).toBe(10);

    await act(async () => { root.unmount(); });
  });
});
