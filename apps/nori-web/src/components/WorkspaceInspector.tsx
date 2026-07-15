import { useEffect, useMemo, useState } from 'react';
import { api, type FsDiffResponse, type FsGitStatusResponse, type FsReadResponse } from '../api/client';
import type { ChatMessage, CodeChange } from '../hooks/useChatMessages';
import { useI18n } from '../i18n';
import { FilePreview } from './FilePreview';
import { Icon } from './Icon';

type InspectorTab = 'preview' | 'changes' | 'git';

interface WorkspaceInspectorProps {
  sessionId: string | null;
  path: string;
  file: FsReadResponse | null;
  loading?: boolean;
  messages: ChatMessage[];
  codeChanges: CodeChange[];
  gitStatus: FsGitStatusResponse | null;
  refreshGitStatus: () => Promise<FsGitStatusResponse | null>;
  isStreaming: boolean;
}

export function WorkspaceInspector({ sessionId, path, file, loading, messages, codeChanges, gitStatus, refreshGitStatus, isStreaming }: WorkspaceInspectorProps) {
  const { tr } = useI18n();
  const [tab, setTab] = useState<InspectorTab>('preview');

  useEffect(() => {
    if (path) setTab('preview');
  }, [path]);

  useEffect(() => {
    if (!sessionId) return;
    void refreshGitStatus();
    if (!isStreaming) return;
    const timer = setInterval(() => void refreshGitStatus(), 1_500);
    return () => clearInterval(timer);
  }, [isStreaming, refreshGitStatus, sessionId]);

  return <section className="workspace-inspector">
    <div className="inspector-tabs" role="tablist" aria-label={tr('Inspector', '检查器')}>
      <InspectorTabButton active={tab === 'preview'} icon="files" label={tr('Preview', '预览')} onClick={() => setTab('preview')} />
      <InspectorTabButton active={tab === 'changes'} icon="diff" label={tr('Changes', '更改')} count={Object.keys(gitStatus?.entries ?? {}).length} onClick={() => setTab('changes')} />
      <InspectorTabButton active={tab === 'git'} icon="git-branch" label="Git" onClick={() => setTab('git')} />
    </div>
    <div className="inspector-content">
      {tab === 'preview' && <FilePreview path={path} file={file} loading={loading} />}
      {tab === 'changes' && <ChangesPanel sessionId={sessionId} status={gitStatus} messages={messages} codeChanges={codeChanges} />}
      {tab === 'git' && <GitPanel sessionId={sessionId} status={gitStatus} onRefresh={refreshGitStatus} />}
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

function collectAttributions(messages: ChatMessage[]): Attribution[] {
  const attributions: Attribution[] = [];
  for (const message of messages) {
    const timestamp = Date.parse(message.createdAt ?? '') || 0;
    const hasSwarm = message.toolCalls?.some(tool => tool.name === 'AgentSwarm' || tool.name === 'Agent') ?? false;
    for (const tool of message.toolCalls ?? []) {
      if (tool.name !== 'Edit' && tool.name !== 'Write') continue;
      const args = tool.args && typeof tool.args === 'object' ? tool.args as Record<string, unknown> : {};
      const path = typeof args['path'] === 'string' ? args['path'].replaceAll('\\', '/') : '';
      if (path) attributions.push({ path, agent: 'Nori', timestamp });
    }
    if (hasSwarm) attributions.push({ path: '*', agent: 'Swarm agent', timestamp });
  }
  return attributions.sort((left, right) => right.timestamp - left.timestamp);
}

function ChangesPanel({ sessionId, status, messages, codeChanges }: { sessionId: string | null; status: FsGitStatusResponse | null; messages: ChatMessage[]; codeChanges: CodeChange[] }) {
  const { tr } = useI18n();
  const [diffs, setDiffs] = useState<Record<string, FsDiffResponse>>({});
  const paths = useMemo(() => Object.keys(status?.entries ?? {}), [status?.entries]);
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
    if (!sessionId || orderedPaths.length === 0) { setDiffs({}); return; }
    let cancelled = false;
    void Promise.all(orderedPaths.slice(0, 30).map(async path => {
      try { return [path, await api.sessions.fs.diff(sessionId, path)] as const; }
      catch { return null; }
    })).then(results => {
      if (cancelled) return;
      setDiffs(Object.fromEntries(results.filter((item): item is readonly [string, FsDiffResponse] => item !== null)));
    });
    return () => { cancelled = true; };
  }, [orderedPaths, sessionId]);

  if (!sessionId) return <InspectorEmpty text={tr('Open a conversation to track changes.', '打开会话后可跟踪更改。')} />;
  if (orderedPaths.length === 0) return <InspectorEmpty text={tr('No uncommitted changes.', '没有未提交的更改。')} />;

  return <div className="changes-panel">
    <header className="inspector-section-header"><div><strong>{tr('Agent changes', '智能体更改')}</strong><span>{tr('Newest first', '最新更改优先')}</span></div><span className="diff-stats"><b>+{status?.additions ?? 0}</b><i>-{status?.deletions ?? 0}</i></span></header>
    <div className="change-list">{orderedPaths.map(path => {
      const exact = attributions.find(item => item.path === path || item.path.endsWith(`/${path}`));
      const fallback = attributions.find(item => item.path === '*');
      const attribution = exact ?? fallback;
      const live = codeChanges.find(item => item.path === path || item.path.endsWith(`/${path}`));
      const changedLines = compactChangedLines(live?.diff ?? diffs[path]?.diff ?? '');
      return <article className="change-entry" key={path}>
        <header><span className={`git-status-mark status-${status?.entries[path] ?? 'modified'}`}/><strong title={path}>{path}</strong><small>{attribution?.agent ?? tr('Workspace', '工作区')}</small></header>
        {changedLines.length > 0 ? <pre className="compact-diff">{changedLines.map((line, index) => <span key={`${index}-${line}`} className={line.startsWith('+') ? 'added' : 'removed'}>{line}</span>)}</pre> : <p>{tr('Binary, renamed, or metadata-only change.', '二进制、重命名或仅元数据更改。')}</p>}
      </article>;
    })}</div>
  </div>;
}

function GitPanel({ sessionId, status, onRefresh }: { sessionId: string | null; status: FsGitStatusResponse | null; onRefresh: () => Promise<FsGitStatusResponse | null> }) {
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
  if (!status) return <InspectorEmpty text={tr('This project is not a Git repository.', '当前项目不是 Git 仓库。')} />;

  return <div className="git-panel">
    <header className="git-summary"><div><Icon name="git-branch" size={16}/><strong>{status.branch || tr('Detached HEAD', '游离 HEAD')}</strong><span>{status.ahead > 0 ? `↑${status.ahead}` : ''}{status.behind > 0 ? ` ↓${status.behind}` : ''}</span></div><button type="button" onClick={() => void onRefresh()} title={tr('Refresh Git status', '刷新 Git 状态')}><Icon name="refresh" size={14}/></button></header>
    <div className="git-file-list">{paths.length === 0 ? <p>{tr('Working tree clean', '工作树干净')}</p> : paths.map(path => <button type="button" key={path} className={selectedPath === path ? 'active' : ''} onClick={() => setSelectedPath(path)}><span className={`git-status-mark status-${status.entries[path]}`}/><span>{path}</span><small>{status.entries[path]}</small></button>)}</div>
    {diff && <div className="git-diff-view"><header><strong>{diff.path}</strong>{diff.truncated && <span>{tr('Truncated', '已截断')}</span>}</header><pre>{diff.diff.split('\n').map((line, index) => <span key={`${index}-${line}`} className={diffLineClass(line)}>{line || ' '}</span>)}</pre></div>}
    <div className="git-actions"><input value={message} onChange={event => setMessage(event.target.value)} placeholder={tr('Commit message', '提交说明')} disabled={busy !== null}/><button type="button" className="git-commit-button" disabled={!message.trim() || paths.length === 0 || busy !== null} onClick={() => void commit()}>{busy === 'commit' ? tr('Committing…', '正在提交…') : tr('Commit all', '提交全部')}</button><button type="button" className="git-push-button" disabled={busy !== null} onClick={() => void push()}><Icon name="upload" size={14}/>{busy === 'push' ? tr('Pushing…', '正在推送…') : tr('Push', '发布')}</button></div>
    {notice && <div className={`git-notice ${notice.kind}`}>{notice.text}</div>}
  </div>;
}

function compactChangedLines(diff: string): string[] {
  return diff.split('\n').filter(line => (line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---'))).slice(0, 40);
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
