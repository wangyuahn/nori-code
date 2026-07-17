import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type FsGitStatusResponse, type FsReadResponse } from '../src/api/client';
import type { ChatMessage, CodeChange } from '../src/hooks/useChatMessages';
import { useFilesystem } from '../src/hooks/useFilesystem';
import { WorkspaceInspector, changedLineStats, collectAttributions, collectToolCodeChanges, combinedCodeChangeDiff, diffPathsToLoad, hasTextChanges, mergeCodeChanges, splitDisplayPath } from '../src/components/WorkspaceInspector';
import { I18nProvider } from '../src/i18n';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('workspace change presentation', () => {
  it('opens a changed file in the Preview tab from its file card', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onSelectFilePath = vi.fn();
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(WorkspaceInspector, {
          sessionId: 'session-preview-card',
          projectPath: '/project',
          path: '',
          file: null,
          messages: [],
          codeChanges: [codeChange('change-card', 'src/app.ts', '2026-07-17T01:00:00.000Z')],
          gitStatus: null,
          gitError: null,
          gitLoading: false,
          refreshGitStatus: vi.fn(async () => null),
          isStreaming: false,
          onSelectFilePath,
        })));
        await Promise.resolve();
      });

      const previewButton = container.querySelector<HTMLButtonElement>('.change-entry-preview');
      expect(previewButton?.getAttribute('aria-label')).toContain('app.ts');
      await act(async () => previewButton?.click());

      expect(onSelectFilePath).toHaveBeenCalledWith('src/app.ts');
      const previewTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
        .find(button => button.textContent?.includes('Preview') || button.textContent?.includes('预览'));
      expect(previewTab?.getAttribute('aria-selected')).toBe('true');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('refreshes the current preview manually and after the same file changes', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const refreshFile = vi.fn(async () => undefined);
    const file = previewFile('src/app.md');
    const render = async (codeChanges: CodeChange[]) => {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(WorkspaceInspector, {
          sessionId: 'session-preview-refresh',
          projectPath: '/project',
          path: 'src/app.md',
          file,
          messages: [],
          codeChanges,
          gitStatus: null,
          gitError: null,
          gitLoading: false,
          refreshGitStatus: vi.fn(async () => null),
          refreshFile,
          isStreaming: false,
          initialTab: 'preview',
        })));
        await Promise.resolve();
      });
    };
    try {
      await render([codeChange('change-1', 'src/app.md', '2026-07-17T01:00:00.000Z')]);
      expect(refreshFile).not.toHaveBeenCalled();

      await act(async () => container.querySelector<HTMLButtonElement>('.file-preview-refresh')?.click());
      expect(refreshFile).toHaveBeenCalledTimes(1);

      await render([
        codeChange('change-2', '/project/src/app.md', '2026-07-17T01:01:00.000Z'),
        codeChange('change-1', 'src/app.md', '2026-07-17T01:00:00.000Z'),
      ]);
      expect(refreshFile).toHaveBeenCalledTimes(2);

      await render([
        codeChange('unrelated-change', 'src/other.md', '2026-07-17T01:02:00.000Z'),
        codeChange('change-2', '/project/src/app.md', '2026-07-17T01:01:00.000Z'),
      ]);
      expect(refreshFile).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

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

  it('reconstructs successful Edit changes from history for non-Git projects', () => {
    const messages: ChatMessage[] = [{
      id: 'assistant-edit',
      role: 'assistant',
      text: '',
      createdAt: '2026-07-15T10:43:43.244Z',
      toolCalls: [{
        id: 'edit-1',
        name: 'Edit',
        args: {
          path: 'C:/Users/sudden/Desktop/games/stardrift.html',
          old_string: 'background:#ff0000;',
          new_string: 'background:#050510;',
        },
        result: 'Replaced 1 occurrence',
      }],
    }];

    expect(collectToolCodeChanges(messages, 'C:/Users/sudden/Desktop/games')).toEqual([{
      operationId: 'edit-1',
      agentId: 'main',
      operation: 'edit',
      path: 'stardrift.html',
      diff: '-background:#ff0000;\n+background:#050510;',
      occurredAt: '2026-07-15T10:43:43.244Z',
    }]);
  });

  it('accumulates repeated changes to the same file instead of replacing the older diff', () => {
    const changes = [
      {
        agentId: 'main',
        operation: 'edit' as const,
        path: 'src/app.ts',
        diff: '-second\n+third',
        occurredAt: '2026-07-15T11:01:00.000Z',
      },
      {
        agentId: 'main',
        operation: 'edit' as const,
        path: 'src/app.ts',
        diff: '-first\n+second',
        occurredAt: '2026-07-15T11:00:00.000Z',
      },
    ];

    const diff = combinedCodeChangeDiff('src/app.ts', changes);
    expect(diff).toBe('-second\n+third\n-first\n+second');
    expect(changedLineStats(diff ?? '')).toEqual({ additions: 2, deletions: 2 });
  });

  it('deduplicates one tool mutation reported by realtime, live turn, and history', () => {
    const realtime = {
      operationId: 'edit-1',
      agentId: 'main',
      operation: 'edit' as const,
      path: 'probe.txt',
      diff: '-before\n+after',
      occurredAt: '2026-07-15T11:00:00.000Z',
    };
    const liveTurn = { ...realtime, occurredAt: '2026-07-15T11:00:02.000Z' };
    const history = { ...realtime, occurredAt: '2026-07-15T11:00:03.000Z' };

    expect(mergeCodeChanges([realtime], [liveTurn, history])).toHaveLength(1);
    expect(mergeCodeChanges([realtime], [{
      ...liveTurn,
      operationId: 'edit-2',
      diff: '-after\n+done',
    }])).toHaveLength(2);
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

  it('keeps the recalculate button available when the project has no changes', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const refreshGitStatus = vi.fn(async () => ({
      branch: 'main',
      ahead: 0,
      behind: 0,
      entries: {},
      additions: 0,
      deletions: 0,
    }));

    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(WorkspaceInspector, {
          sessionId: 'session-empty',
          projectPath: '/empty-project',
          path: '',
          file: null,
          messages: [],
          codeChanges: [],
          gitStatus: await refreshGitStatus(),
          gitError: null,
          gitLoading: false,
          refreshGitStatus,
          isStreaming: false,
        })));
      });
      refreshGitStatus.mockClear();

      const button = container.querySelector<HTMLButtonElement>('.change-recalculate');
      expect(button).not.toBeNull();
      expect(button?.disabled).toBe(false);
      await act(async () => {
        button?.click();
        await Promise.resolve();
      });
      expect(refreshGitStatus).toHaveBeenCalledTimes(1);
      expect(refreshGitStatus).toHaveBeenCalledWith({ force: true });
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('refreshes Git status and loads a changed file when an agent code-change event arrives', async () => {
    const cleanStatus: FsGitStatusResponse = {
      branch: 'main', ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0,
    };
    const changedStatus: FsGitStatusResponse = {
      branch: 'main', ahead: 0, behind: 0, entries: { 'src/agent.ts': 'modified' }, additions: 1, deletions: 1,
    };
    const gitStatus = vi.spyOn(api.sessions.fs, 'gitStatus')
      .mockResolvedValueOnce(cleanStatus)
      .mockResolvedValueOnce(changedStatus);
    const diff = vi.spyOn(api.sessions.fs, 'diff').mockResolvedValue({
      path: 'src/agent.ts',
      diff: '--- a/src/agent.ts\n+++ b/src/agent.ts\n@@ -1 +1 @@\n-old\n+new',
      truncated: false,
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    function Probe({ changed }: { changed: boolean }) {
      const filesystem = useFilesystem('session-agent-change', '/agent-change-refresh-test');
      return createElement(I18nProvider, null, createElement(WorkspaceInspector, {
        sessionId: 'session-agent-change',
        projectPath: '/agent-change-refresh-test',
        path: '',
        file: null,
        messages: [],
        codeChanges: changed ? [{
          agentId: 'agent-worker',
          operation: 'edit' as const,
          path: 'src/agent.ts',
          diff: '-old\n+new',
          occurredAt: '2026-07-15T10:00:00.000Z',
        }] : [],
        gitStatus: filesystem.gitStatus,
        gitError: filesystem.gitError,
        gitLoading: filesystem.gitLoading,
        refreshGitStatus: filesystem.refreshGitStatus,
        isStreaming: changed,
      }));
    }

    try {
      await act(async () => {
        root.render(createElement(Probe, { changed: false }));
        await new Promise(resolve => setTimeout(resolve, 0));
      });
      expect(gitStatus).toHaveBeenCalledTimes(1);

      await act(async () => {
        root.render(createElement(Probe, { changed: true }));
        await new Promise(resolve => setTimeout(resolve, 0));
        await new Promise(resolve => setTimeout(resolve, 0));
      });

      expect(gitStatus).toHaveBeenCalledTimes(2);
      expect(diff).not.toHaveBeenCalled();
      expect(container.textContent).toContain('agent.ts');
      expect(container.textContent).toContain('agent-worker');
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('uses completed Edit and Write messages as a refresh fallback after realtime events', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const refreshGitStatus = vi.fn(async () => null);
    const codeChanges = [{
      agentId: 'main',
      operation: 'edit' as const,
      path: 'src/first.ts',
      diff: '-old\n+new',
      occurredAt: '2026-07-15T10:00:00.000Z',
    }];
    const firstMessage: ChatMessage = {
      id: 'assistant-first',
      role: 'assistant',
      text: '',
      toolCalls: [{ id: 'edit-first', name: 'Edit', args: { path: 'src/first.ts' }, result: 'done' }],
    };
    const render = async (messages: ChatMessage[]) => {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(WorkspaceInspector, {
          sessionId: 'session-message-fallback',
          projectPath: '/message-fallback-test',
          path: '',
          file: null,
          messages,
          codeChanges,
          gitStatus: null,
          gitError: null,
          gitLoading: false,
          refreshGitStatus,
          isStreaming: false,
        })));
        await Promise.resolve();
      });
    };

    try {
      await render([firstMessage]);
      expect(refreshGitStatus).toHaveBeenCalledTimes(1);

      await render([firstMessage, {
        id: 'assistant-second',
        role: 'assistant',
        text: '',
        toolCalls: [{ id: 'write-second', name: 'Write', args: { path: 'src/second.ts' }, result: 'done' }],
      }]);
      expect(refreshGitStatus).toHaveBeenCalledTimes(2);
      expect(refreshGitStatus).toHaveBeenLastCalledWith({ force: true });
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('shows completed Edit history and keeps it after refresh when Git is unavailable', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const refreshGitStatus = vi.fn(async () => null);
    const refreshMessages = vi.fn(async () => undefined);
    const diff = vi.spyOn(api.sessions.fs, 'diff');
    const messages: ChatMessage[] = [{
      id: 'assistant-non-git-edit',
      role: 'assistant',
      text: '',
      createdAt: '2026-07-15T10:43:43.244Z',
      toolCalls: [{
        id: 'edit-non-git',
        name: 'Edit',
        args: { path: 'C:/projects/game/index.html', old_string: 'red', new_string: 'black' },
        result: 'Replaced 1 occurrence',
      }],
    }];

    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(WorkspaceInspector, {
          sessionId: 'session-non-git',
          projectPath: 'C:/projects/game',
          path: '',
          file: null,
          messages,
          codeChanges: [],
          gitStatus: null,
          gitError: 'not a Git repository',
          gitLoading: false,
          refreshGitStatus,
          refreshMessages,
          isStreaming: false,
        })));
        await Promise.resolve();
      });

      expect(container.textContent).toContain('index.html');
      expect(container.textContent).toContain('+1');
      expect(container.textContent).toContain('-1');
      expect(diff).not.toHaveBeenCalled();

      const button = container.querySelector<HTMLButtonElement>('.change-recalculate');
      await act(async () => {
        button?.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(refreshGitStatus).toHaveBeenCalledWith({ force: true });
      expect(refreshMessages).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain('index.html');
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
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
      const browserTab = inspectorTabs
        .find(button => button.textContent?.includes('浏览器') || button.textContent?.includes('Browser'));
      expect(changesTab).toBeDefined();
      expect(browserTab).toBeDefined();
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

  it('forces a fresh Git status request and ignores an older in-flight result', async () => {
    const staleStatus: FsGitStatusResponse = {
      branch: 'main', ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0,
    };
    const freshStatus: FsGitStatusResponse = {
      branch: 'main', ahead: 0, behind: 0, entries: { 'src/fresh.ts': 'modified' }, additions: 2, deletions: 1,
    };
    let resolveStale!: (value: FsGitStatusResponse) => void;
    let resolveFresh!: (value: FsGitStatusResponse) => void;
    const staleRequest = new Promise<FsGitStatusResponse>(resolve => { resolveStale = resolve; });
    const freshRequest = new Promise<FsGitStatusResponse>(resolve => { resolveFresh = resolve; });
    const gitStatus = vi.spyOn(api.sessions.fs, 'gitStatus')
      .mockReturnValueOnce(staleRequest)
      .mockReturnValueOnce(freshRequest);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let observed: ReturnType<typeof useFilesystem> | undefined;

    function Probe() {
      observed = useFilesystem('session-force-refresh', '/force-refresh-test');
      return null;
    }

    try {
      await act(async () => {
        root.render(createElement(Probe));
        await Promise.resolve();
      });
      expect(gitStatus).toHaveBeenCalledTimes(1);

      let forced!: Promise<FsGitStatusResponse | null>;
      await act(async () => {
        forced = observed!.refreshGitStatus({ force: true });
        await Promise.resolve();
      });
      expect(gitStatus).toHaveBeenCalledTimes(2);

      await act(async () => {
        resolveFresh(freshStatus);
        await forced;
      });
      expect(observed?.gitStatus).toEqual(freshStatus);

      await act(async () => {
        resolveStale(staleStatus);
        await staleRequest;
        await Promise.resolve();
      });
      expect(observed?.gitStatus).toEqual(freshStatus);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });
});

function codeChange(operationId: string, path: string, occurredAt: string): CodeChange {
  return {
    operationId,
    agentId: 'main',
    operation: 'edit',
    path,
    diff: '-old\n+new',
    occurredAt,
  };
}

function previewFile(path: string): FsReadResponse {
  return {
    path,
    content: '# Preview',
    encoding: 'utf-8',
    size: 9,
    truncated: false,
    mime: 'text/markdown',
    language_id: 'markdown',
    is_binary: false,
  };
}
