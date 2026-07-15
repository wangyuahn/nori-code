import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type FsGitStatusResponse } from '../src/api/client';
import type { ChatMessage } from '../src/hooks/useChatMessages';
import { useFilesystem } from '../src/hooks/useFilesystem';
import { WorkspaceInspector, changedLineStats, collectAttributions, diffPathsToLoad, hasTextChanges, splitDisplayPath } from '../src/components/WorkspaceInspector';
import { I18nProvider } from '../src/i18n';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('workspace change presentation', () => {
  it('does not attribute unrelated workspace changes to a swarm invocation', () => {
    const messages: ChatMessage[] = [{
      id: 'assistant-1',
      role: 'assistant',
      text: '',
      createdAt: '2026-07-15T05:00:00.000Z',
      toolCalls: [{ name: 'AgentSwarm', args: { tasks: ['review'] } }],
    }];

    expect(collectAttributions(messages)).toEqual([]);
  });

  it('attributes explicit main-agent edits to Nori', () => {
    const messages: ChatMessage[] = [{
      id: 'assistant-2',
      role: 'assistant',
      text: '',
      createdAt: '2026-07-15T05:00:00.000Z',
      toolCalls: [{ name: 'Edit', args: { path: 'src/app.ts' } }],
    }];

    expect(collectAttributions(messages)).toEqual([{
      path: 'src/app.ts',
      agent: 'Nori',
      timestamp: Date.parse('2026-07-15T05:00:00.000Z'),
    }]);
  });

  it('excludes binary, rename-only, and metadata-only diffs with no changed lines', () => {
    expect(changedLineStats('diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new')).toEqual({ additions: 0, deletions: 0 });
    expect(hasTextChanges('diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new')).toBe(false);
    expect(hasTextChanges('--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new')).toBe(true);
  });

  it('separates the file name so long directories can collapse independently', () => {
    expect(splitDisplayPath('nori-workspace/apps/nori-web/src/api/client.ts')).toEqual({
      directory: 'nori-workspace/apps/nori-web/src/api',
      fileName: 'client.ts',
    });
    expect(splitDisplayPath('README.md')).toEqual({ directory: '', fileName: 'README.md' });
  });

  it('loads only paths missing from the current project cache', () => {
    const cached = { 'src/a.ts': { path: 'src/a.ts', diff: '+cached', truncated: false } };
    expect(diffPathsToLoad(
      ['src/b.ts', 'src/a.ts', 'src/c.ts', 'src/d.ts'],
      cached,
      new Set(['src/c.ts']),
      new Set(['src/d.ts']),
    )).toEqual(['src/b.ts']);
    expect(diffPathsToLoad(['src/a.ts'], cached, new Set(), new Set())).toEqual([]);
  });

  it('keeps cached diffs across new messages and same-path Git updates', async () => {
    const diff = vi.spyOn(api.sessions.fs, 'diff').mockImplementation(async (_sessionId, path) => ({
      path,
      diff: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new`,
      truncated: false,
    }));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const refreshGitStatus = vi.fn(async () => null);
    const status = (entries: FsGitStatusResponse['entries'], additions = 1): FsGitStatusResponse => ({
      branch: 'main',
      ahead: 0,
      behind: 0,
      entries,
      additions,
      deletions: 1,
    });
    const render = async (
      messages: ChatMessage[],
      gitStatus: FsGitStatusResponse,
      sessionId = 'session-a',
      projectPath = '/project',
    ) => {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(WorkspaceInspector, {
          sessionId,
          projectPath,
          path: '',
          file: null,
          messages,
          codeChanges: [],
          gitStatus,
          gitError: null,
          gitLoading: false,
          refreshGitStatus,
          isStreaming: false,
        })));
      });
    };

    try {
      await render([], status({ 'src/a.ts': 'modified' }));
      const inspectorTabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
      const changesTab = inspectorTabs
        .find(button => button.textContent?.includes('更改') || button.textContent?.includes('Changes'));
      expect(changesTab).toBeDefined();
      expect(inspectorTabs[0]).toBe(changesTab);
      expect(changesTab!.getAttribute('aria-selected')).toBe('true');
      await act(async () => {
        changesTab!.click();
        await new Promise(resolve => setTimeout(resolve, 0));
      });
      expect(diff).toHaveBeenCalledTimes(1);

      await render([{ id: 'user-2', role: 'user', text: 'next question' }], status({ 'src/a.ts': 'modified' }, 2));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
      expect(diff).toHaveBeenCalledTimes(1);

      await render([], status({ 'src/a.ts': 'modified' }, 2), 'session-b', '/project/');
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
      expect(diff).toHaveBeenCalledTimes(1);

      await render([], status({ 'src/a.ts': 'modified', 'src/b.ts': 'untracked' }, 3));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
      expect(diff).toHaveBeenCalledTimes(2);
      expect(diff.mock.calls[1]?.[1]).toBe('src/b.ts');

      await render([], status({ 'src/a.ts': 'modified' }), 'session-c', '/another-project');
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
      expect(diff).toHaveBeenCalledTimes(3);
      expect(diff.mock.calls[2]?.[0]).toBe('session-c');
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('reuses Git status when switching sessions inside the same project', async () => {
    const status: FsGitStatusResponse = {
      branch: 'main',
      ahead: 0,
      behind: 0,
      entries: { 'src/a.ts': 'modified' },
      additions: 1,
      deletions: 1,
    };
    const gitStatus = vi.spyOn(api.sessions.fs, 'gitStatus').mockResolvedValue(status);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let observed: ReturnType<typeof useFilesystem> | undefined;

    function Probe({ sessionId }: { sessionId: string }) {
      observed = useFilesystem(sessionId, '/same-project-cache-test');
      return null;
    }

    try {
      await act(async () => {
        root.render(createElement(Probe, { sessionId: 'session-a' }));
        await new Promise(resolve => setTimeout(resolve, 0));
      });
      expect(gitStatus).toHaveBeenCalledTimes(1);
      expect(observed?.gitStatus).toEqual(status);

      await act(async () => {
        root.render(createElement(Probe, { sessionId: 'session-b' }));
        await new Promise(resolve => setTimeout(resolve, 0));
      });
      expect(gitStatus).toHaveBeenCalledTimes(1);
      expect(observed?.gitStatus).toEqual(status);
      expect(observed?.gitLoading).toBe(false);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('shares an in-flight Git status request across project consumers', async () => {
    const status: FsGitStatusResponse = {
      branch: 'main',
      ahead: 0,
      behind: 0,
      entries: { 'src/shared.ts': 'modified' },
      additions: 2,
      deletions: 1,
    };
    let resolveStatus!: (value: FsGitStatusResponse) => void;
    const pendingStatus = new Promise<FsGitStatusResponse>(resolve => { resolveStatus = resolve; });
    const gitStatus = vi.spyOn(api.sessions.fs, 'gitStatus').mockReturnValue(pendingStatus);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const observed: Array<ReturnType<typeof useFilesystem> | undefined> = [];

    function Probe({ index }: { index: number }) {
      observed[index] = useFilesystem(`session-${index}`, '/shared-inflight-cache-test');
      return null;
    }

    try {
      await act(async () => {
        root.render(createElement('div', null,
          createElement(Probe, { index: 0 }),
          createElement(Probe, { index: 1 }),
        ));
        await Promise.resolve();
      });
      expect(gitStatus).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveStatus(status);
        await pendingStatus;
      });
      expect(observed[0]?.gitStatus).toEqual(status);
      expect(observed[1]?.gitStatus).toEqual(status);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });
});
