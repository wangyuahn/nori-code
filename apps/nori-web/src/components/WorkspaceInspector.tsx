import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type FsDiffResponse, type FsGitStatusResponse, type FsReadResponse } from '../api/client';
import type { ChatMessage, CodeChange } from '../hooks/useChatMessages';
import { useI18n } from '../i18n';
import { FilePreview } from './FilePreview';
import { Icon } from './Icon';

type InspectorTab = 'preview' | 'changes' | 'git';

interface WorkspaceInspectorProps {
  sessionId: string | null;
  projectPath?: string;
  path: string;
  file: FsReadResponse | null;
  loading?: boolean;
  messages: ChatMessage[];
  codeChanges: CodeChange[];
  gitStatus: FsGitStatusResponse | null;
  gitError: string | null;
  gitLoading: boolean;
  refreshGitStatus: () => Promise<FsGitStatusResponse | null>;
  isStreaming: boolean;
}

export function WorkspaceInspector({ sessionId, projectPath, path, file, loading, messages, codeChanges, gitStatus, gitError, gitLoading, refreshGitStatus }: WorkspaceInspectorProps) {
  const { tr } = useI18n();
  const [tab, setTab] = useState<InspectorTab>('changes');
  const [textChangeCount, setTextChangeCount] = useState<number>();

  useEffect(() => {
    if (path) setTab('preview');
  }, [path]);

  useEffect(() => {
    setTextChangeCount(undefined);
  }, [projectPath]);

  const latestCodeChange = codeChanges[0]?.occurredAt;
  useEffect(() => {
    if (!sessionId || !latestCodeChange) return;
    void refreshGitStatus();
  }, [latestCodeChange, refreshGitStatus, sessionId]);

  return <section className="workspace-inspector">
    <div className="inspector-tabs" role="tablist" aria-label={tr('Inspector', '检查器')}>
      <InspectorTabButton active={tab === 'changes'} icon="diff" label={tr('Changes', '更改')} count={textChangeCount} onClick={() => setTab('changes')} />
      <InspectorTabButton active={tab === 'preview'} icon="files" label={tr('Preview', '预览')} onClick={() => setTab('preview')} />
      <InspectorTabButton active={tab === 'git'} icon="git-branch" label="Git" onClick={() => { setTab('git'); void refreshGitStatus(); }} />
    </div>
    <div className="inspector-content">
      {tab === 'preview' && <FilePreview path={path} file={file} loading={loading} />}
      {tab === 'changes' && <ChangesPanel sessionId={sessionId} projectPath={projectPath} status={gitStatus} messages={messages} codeChanges={codeChanges} onRefreshGitStatus={refreshGitStatus} onCountChange={setTextChangeCount} />}
      {tab === 'git' && <GitPanel sessionId={sessionId} projectPath={projectPath} status={gitStatus} error={gitError} loading={gitLoading} onRefresh={refreshGitStatus} />}
    </div>
  </section>;
}

function InspectorTabButton({ active, icon, label, count, onClick }: { active: boolean; icon: 'files' | 'diff' | 'git-branch'; label: string; count?: number; onClick: () => void }) {
  return <button type="button" role="tab" aria-selected={active} className={active ? 'active' : ''} onClick={onClick}><Icon name={icon} size={14}/><span>{label}</span>{count ? <small>{count}</small> : null}</button>;
}

interface Attribution {
  path: string;
  agent: string;
  timestamp: number;
}

interface ProjectDiffCache {
  diffs: Record<string, FsDiffResponse>;
  failedPaths: Set<string>;
}

const PROJECT_DIFF_CACHE_LIMIT = 12;
const projectDiffCaches = new Map<string, ProjectDiffCache>();

export function collectAttributions(messages: ChatMessage[]): Attribution[] {
  const attributions: Attribution[] = [];
  for (const message of messages) {
    const timestamp = Date.parse(message.createdAt ?? '') || 0;
    for (const tool of message.toolCalls ?? []) {
      if (tool.name !== 'Edit' && tool.name !== 'Write') continue;
      const args = tool.args && typeof tool.args === 'object' ? tool.args as Record<string, unknown> : {};
      const path = typeof args['path'] === 'string' ? args['path'].replaceAll('\\', '/') : '';
      if (path) attributions.push({ path, agent: 'Nori', timestamp });
    }
  }
  return attributions.sort((left, right) => right.timestamp - left.timestamp);
}

function ChangesPanel({ sessionId, projectPath, status, messages, codeChanges, onRefreshGitStatus, onCountChange }: { sessionId: string | null; projectPath?: string; status: FsGitStatusResponse | null; messages: ChatMessage[]; codeChanges: CodeChange[]; onRefreshGitStatus: () => Promise<FsGitStatusResponse | null>; onCountChange: (count: number | undefined) => void }) {
  const { tr } = useI18n();
  const [diffs, setDiffs] = useState<Record<string, FsDiffResponse>>({});
  const [pendingPaths, setPendingPaths] = useState<Set<string>>(new Set());
  const [failedPaths, setFailedPaths] = useState<Set<string>>(new Set());
  const [reloadVersion, setReloadVersion] = useState(0);
  const [recalculating, setRecalculating] = useState(false);
  const projectKey = normalizeProjectKey(projectPath, sessionId);
  const cacheProjectRef = useRef<string | null>(null);
  const diffCacheRef = useRef<Record<string, FsDiffResponse>>({});
  const pendingPathsRef = useRef<Set<string>>(new Set());
  const failedPathsRef = useRef<Set<string>>(new Set());
  const activePathsRef = useRef<Set<string>>(new Set());
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const paths = useMemo(() => Object.keys(status?.entries ?? {}), [status?.entries]);
  const pathsKey = useMemo(() => paths.join('\u0000'), [paths]);
  const attributions = useMemo(() => [
    ...codeChanges.map(change => ({ path: change.path, agent: change.agentId === 'main' ? 'Nori' : change.agentId, timestamp: Date.parse(change.occurredAt) || 0 })),
    ...collectAttributions(messages),
  ].sort((left, right) => right.timestamp - left.timestamp), [codeChanges, messages]);
  const orderedPaths = useMemo(() => [...paths].sort((left, right) => {
    const leftTime = attributions.find(item => item.path === left || item.path.endsWith(`/${left}`))?.timestamp ?? 0;
    const rightTime = attributions.find(item => item.path === right || item.path.endsWith(`/${right}`))?.timestamp ?? 0;
    return rightTime - leftTime || left.localeCompare(right);
  }), [attributions, paths]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const projectChanged = cacheProjectRef.current !== projectKey;
    if (projectChanged) {
      cacheProjectRef.current = projectKey;
      generationRef.current++;
      const cached = projectKey === null ? undefined : projectDiffCaches.get(projectKey);
      diffCacheRef.current = { ...cached?.diffs };
      pendingPathsRef.current = new Set();
      failedPathsRef.current = new Set(cached?.failedPaths ?? []);
      setDiffs({ ...diffCacheRef.current });
      setPendingPaths(new Set());
      setFailedPaths(new Set(failedPathsRef.current));
      onCountChange(undefined);
    }

    const activePaths = new Set(paths);
    activePathsRef.current = activePaths;
    diffCacheRef.current = Object.fromEntries(
      Object.entries(diffCacheRef.current).filter(([path]) => activePaths.has(path)),
    );
    pendingPathsRef.current = new Set([...pendingPathsRef.current].filter(path => activePaths.has(path)));
    failedPathsRef.current = new Set([...failedPathsRef.current].filter(path => activePaths.has(path)));
    rememberProjectDiffCache(projectKey, diffCacheRef.current, failedPathsRef.current);

    const activeSessionId = sessionIdRef.current;
    if (!activeSessionId || paths.length === 0) {
      setDiffs(diffCacheRef.current);
      setPendingPaths(new Set(pendingPathsRef.current));
      setFailedPaths(new Set(failedPathsRef.current));
      onCountChange(0);
      return;
    }

    const missingPaths = diffPathsToLoad(paths, diffCacheRef.current, pendingPathsRef.current, failedPathsRef.current);
    setDiffs({ ...diffCacheRef.current });
    setFailedPaths(new Set(failedPathsRef.current));
    if (missingPaths.length === 0) {
      setPendingPaths(new Set(pendingPathsRef.current));
      return;
    }

    for (const path of missingPaths) pendingPathsRef.current.add(path);
    setPendingPaths(new Set(pendingPathsRef.current));
    const generation = generationRef.current;
    const results = Array.from<{ path: string; result: FsDiffResponse | null }>({ length: missingPaths.length });
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < missingPaths.length) {
        const index = nextIndex++;
        const path = missingPaths[index]!;
        try {
          results[index] = { path, result: await api.sessions.fs.diff(activeSessionId, path) };
        } catch {
          results[index] = { path, result: null };
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, missingPaths.length) }, worker)).then(() => {
      if (!mountedRef.current || cacheProjectRef.current !== projectKey || generationRef.current !== generation) return;
      for (const item of results) {
        pendingPathsRef.current.delete(item.path);
        if (!activePathsRef.current.has(item.path)) continue;
        if (item.result) {
          diffCacheRef.current[item.path] = item.result;
          failedPathsRef.current.delete(item.path);
        } else {
          failedPathsRef.current.add(item.path);
        }
      }
      setDiffs({ ...diffCacheRef.current });
      setFailedPaths(new Set(failedPathsRef.current));
      setPendingPaths(new Set(pendingPathsRef.current));
      rememberProjectDiffCache(projectKey, diffCacheRef.current, failedPathsRef.current);
    });
  }, [onCountChange, pathsKey, projectKey, reloadVersion]);

  const visiblePaths = useMemo(() => orderedPaths.filter(path => {
    const diff = resolvedDiff(path, codeChanges, diffs);
    if (diff === undefined) return false;
    return hasTextChanges(diff);
  }), [codeChanges, diffs, orderedPaths]);

  useEffect(() => {
    if (pendingPaths.size === 0) onCountChange(visiblePaths.length);
  }, [onCountChange, pendingPaths.size, visiblePaths.length]);

  const recalculate = async () => {
    if (!sessionId || recalculating) return;
    setRecalculating(true);
    try {
      await onRefreshGitStatus();
      generationRef.current++;
      diffCacheRef.current = {};
      pendingPathsRef.current = new Set();
      failedPathsRef.current = new Set();
      if (projectKey !== null) projectDiffCaches.delete(projectKey);
      setDiffs({});
      setPendingPaths(new Set());
      setFailedPaths(new Set());
      onCountChange(undefined);
      setReloadVersion(version => version + 1);
    } finally {
      setRecalculating(false);
    }
  };

  return <div className="changes-panel">
    <header className="inspector-section-header"><div><strong>{tr('Project changes', '项目更改')}</strong><span>{tr('Cached by project · newest first', '按项目缓存 · 最新更改优先')}</span></div><span className="diff-stats"><b>+{status?.additions ?? 0}</b><i>-{status?.deletions ?? 0}</i><button type="button" className="change-recalculate" onClick={() => void recalculate()} disabled={!sessionId || recalculating} title={tr('Recalculate project changes', '重新计算项目更改')}><Icon name="refresh" size={12}/></button></span></header>
    {!sessionId ? <InspectorEmpty text={tr('Open a conversation to track changes.', '打开会话后可跟踪更改。')} />
      : orderedPaths.length === 0 ? <InspectorEmpty text={tr('No uncommitted changes.', '没有未提交的更改。')} />
      : pendingPaths.size === orderedPaths.length ? <div className="inspector-empty"><span className="spinner"/><span>{tr('Reading text changes…', '正在读取文本更改…')}</span></div>
      : visiblePaths.length === 0 && pendingPaths.size === 0 && failedPaths.size === 0 ? <InspectorEmpty text={tr('No text changes to display.', '没有可显示的文本行更改。')} />
      : <>{pendingPaths.size > 0 && <div className="change-load-status"><span className="spinner"/>{tr(`Reading ${pendingPaths.size} changes…`, `正在读取 ${pendingPaths.size} 项更改…`)}</div>}
    {failedPaths.size > 0 && <div className="change-load-status error">{tr(`${failedPaths.size} diffs could not be loaded.`, `${failedPaths.size} 项 diff 读取失败。`)}</div>}
    <div className="change-list">{visiblePaths.map((path, index) => {
      const exact = attributions.find(item => item.path === path || item.path.endsWith(`/${path}`));
      const rawDiff = resolvedDiff(path, codeChanges, diffs) ?? '';
      return <ChangeCard
        key={path}
        path={path}
        status={status?.entries[path] ?? 'modified'}
        agent={exact?.agent ?? tr('Unknown', '未知')}
        diff={rawDiff}
        defaultOpen={index === 0}
      />;
    })}</div></>}
  </div>;
}

function normalizeProjectKey(projectPath: string | undefined, sessionId: string | null): string | null {
  const normalized = projectPath?.trim().replaceAll('\\', '/').replace(/\/+$/, '').toLocaleLowerCase();
  return normalized || (sessionId ? `session:${sessionId}` : null);
}

function rememberProjectDiffCache(
  projectKey: string | null,
  diffs: Record<string, FsDiffResponse>,
  failedPaths: Set<string>,
): void {
  if (projectKey === null) return;
  projectDiffCaches.delete(projectKey);
  projectDiffCaches.set(projectKey, { diffs: { ...diffs }, failedPaths: new Set(failedPaths) });
  while (projectDiffCaches.size > PROJECT_DIFF_CACHE_LIMIT) {
    const oldest = projectDiffCaches.keys().next().value;
    if (oldest === undefined) break;
    projectDiffCaches.delete(oldest);
  }
}

export function diffPathsToLoad(
  paths: string[],
  diffs: Record<string, FsDiffResponse>,
  pending: Set<string>,
  failed: Set<string>,
): string[] {
  return paths.filter(path => diffs[path] === undefined && !pending.has(path) && !failed.has(path));
}

function resolvedDiff(path: string, codeChanges: CodeChange[], diffs: Record<string, FsDiffResponse>): string | undefined {
  const live = codeChanges.find(item => item.path === path || item.path.endsWith(`/${path}`));
  if (live?.diff && compactChangedLines(live.diff).length > 0) return live.diff;
  return diffs[path]?.diff;
}

function ChangeCard({ path, status, agent, diff, defaultOpen }: { path: string; status: string; agent: string; diff: string; defaultOpen: boolean }) {
  const { tr } = useI18n();
  const [open, setOpen] = useState(defaultOpen);
  const changedLines = compactChangedLines(diff);
  const stats = changedLineStats(diff);
  const displayPath = splitDisplayPath(path);
  return <article className={`change-entry${open ? ' open' : ''}`}>
    <button type="button" className="change-entry-toggle" onClick={() => setOpen(value => !value)} aria-expanded={open}>
      <Icon name="chevron-right" size={12}/>
      <span className={`git-status-mark status-${status}`}/>
      <span className="change-entry-title" title={path}><strong className="change-entry-path">{displayPath.directory && <><span className="change-entry-directory">{displayPath.directory}</span><span className="change-entry-separator">/</span></>}<span className="change-entry-file">{displayPath.fileName}</span></strong><small>{agent}</small></span>
      <span className="change-entry-stats"><b>+{stats.additions}</b><i>-{stats.deletions}</i></span>
    </button>
    {open && (changedLines.length > 0
      ? <pre className="compact-diff">{changedLines.map((line, index) => <span key={`${index}-${line}`} className={line.startsWith('+') ? 'added' : 'removed'}>{line}</span>)}</pre>
      : <p>{tr('Binary, renamed, or metadata-only change.', '二进制、重命名或仅元数据更改。')}</p>)}
  </article>;
}

export function splitDisplayPath(path: string): { directory: string; fileName: string } {
  const normalized = path.replaceAll('\\', '/');
  const separator = normalized.lastIndexOf('/');
  if (separator < 0) return { directory: '', fileName: normalized };
  return {
    directory: normalized.slice(0, separator),
    fileName: normalized.slice(separator + 1),
  };
}

function GitPanel({ sessionId, projectPath, status, error, loading, onRefresh }: { sessionId: string | null; projectPath?: string; status: FsGitStatusResponse | null; error: string | null; loading: boolean; onRefresh: () => Promise<FsGitStatusResponse | null> }) {
  const { tr } = useI18n();
  const [selectedPath, setSelectedPath] = useState('');
  const [diff, setDiff] = useState<FsDiffResponse | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<'commit' | 'push' | null>(null);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const paths = Object.keys(status?.entries ?? {});

  useEffect(() => {
    if (!selectedPath || !sessionId) { setDiff(null); return; }
    let cancelled = false;
    void api.sessions.fs.diff(sessionId, selectedPath).then(result => { if (!cancelled) setDiff(result); }).catch(error => {
      if (!cancelled) setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    });
    return () => { cancelled = true; };
  }, [selectedPath, sessionId, status]);

  const commit = async () => {
    if (!sessionId || !message.trim() || paths.length === 0) return;
    setBusy('commit'); setNotice(null);
    try {
      const result = await api.sessions.fs.commit(sessionId, message.trim());
      setMessage('');
      setSelectedPath('');
      setNotice({ kind: 'success', text: tr(`Committed ${result.commit}`, `已提交 ${result.commit}`) });
      await onRefresh();
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally { setBusy(null); }
  };

  const push = async () => {
    if (!sessionId || busy) return;
    if (!window.confirm(tr('Push the current branch to its remote?', '将当前分支推送到远程吗？'))) return;
    setBusy('push'); setNotice(null);
    try {
      const result = await api.sessions.fs.push(sessionId);
      setNotice({ kind: 'success', text: tr(`Pushed ${result.branch} to ${result.remote}`, `已将 ${result.branch} 推送到 ${result.remote}`) });
      await onRefresh();
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally { setBusy(null); }
  };

  if (!sessionId) return <InspectorEmpty text={tr('Open a conversation to use Git controls.', '打开会话后可使用 Git 控制。')} />;
  if (!status && loading) return <div className="inspector-empty"><span className="spinner"/><span>{tr('Loading Git status…', '正在加载 Git 状态…')}</span></div>;
  if (!status) return <div className="inspector-empty git-unavailable"><Icon name="git-branch" size={24}/><strong>{tr('Git status is unavailable', '无法读取 Git 状态')}</strong><span title={error ?? projectPath}>{error ?? tr('The selected project folder is not a Git repository.', '所选项目文件夹不是 Git 仓库。')}</span>{projectPath && <small>{projectPath}</small>}<button type="button" onClick={() => void onRefresh()}>{tr('Try again', '重试')}</button></div>;

  return <div className="git-panel">
    <header className="git-summary"><div><Icon name="git-branch" size={16}/><strong>{status.branch || tr('Detached HEAD', '游离 HEAD')}</strong><span>{status.ahead > 0 ? `↑${status.ahead}` : ''}{status.behind > 0 ? ` ↓${status.behind}` : ''}</span></div><button type="button" onClick={() => void onRefresh()} title={tr('Refresh Git status', '刷新 Git 状态')}><Icon name="refresh" size={14}/></button></header>
    <div className="git-file-list">{paths.length === 0 ? <p>{tr('Working tree clean', '工作树干净')}</p> : paths.map(path => <button type="button" key={path} className={selectedPath === path ? 'active' : ''} onClick={() => setSelectedPath(path)}><span className={`git-status-mark status-${status.entries[path]}`}/><span>{path}</span><small>{status.entries[path]}</small></button>)}</div>
    {diff && <div className="git-diff-view"><header><strong>{diff.path}</strong>{diff.truncated && <span>{tr('Truncated', '已截断')}</span>}</header><pre>{diff.diff.split('\n').map((line, index) => <span key={`${index}-${line}`} className={diffLineClass(line)}>{line || ' '}</span>)}</pre></div>}
    <div className="git-actions"><input value={message} onChange={event => setMessage(event.target.value)} placeholder={tr('Commit message', '提交说明')} disabled={busy !== null}/><button type="button" className="git-commit-button" disabled={!message.trim() || paths.length === 0 || busy !== null} onClick={() => void commit()}>{busy === 'commit' ? tr('Committing…', '正在提交…') : tr('Commit all', '提交全部')}</button><button type="button" className="git-push-button" disabled={busy !== null} onClick={() => void push()}><Icon name="upload" size={14}/>{busy === 'push' ? tr('Pushing…', '正在推送…') : tr('Push', '发布')}</button></div>
    {(notice || error) && <div className={`git-notice ${notice?.kind ?? 'error'}`}>{notice?.text ?? error}</div>}
  </div>;
}

function compactChangedLines(diff: string): string[] {
  return diff.split('\n').filter(line => (line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---'))).slice(0, 40);
}

export function changedLineStats(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

export function hasTextChanges(diff: string): boolean {
  const stats = changedLineStats(diff);
  return stats.additions > 0 || stats.deletions > 0;
}

function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'header';
  if (line.startsWith('+')) return 'added';
  if (line.startsWith('-')) return 'removed';
  if (line.startsWith('@@')) return 'hunk';
  return '';
}

function InspectorEmpty({ text }: { text: string }) {
  return <div className="inspector-empty"><Icon name="diff" size={24}/><span>{text}</span></div>;
}
