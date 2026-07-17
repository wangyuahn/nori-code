import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { api, type FsEntry, type FsGitStatus } from '../api/client';
import { useFilesystem } from '../hooks/useFilesystem';
import { useI18n } from '../i18n';
import { Icon } from './Icon';
import { referenceProjectFile } from '../projectFileReference';

interface FileTreeProps {
  sessionId: string | null;
  projectPath?: string;
  selectedPath?: string;
  onSelectFile: (entry: FsEntry) => void;
}

const STATUS_LABELS: Partial<Record<FsGitStatus, string>> = {
  modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U', conflicted: '!', ignored: 'I',
};

export function FileTree({ sessionId, projectPath, selectedPath, onSelectFile }: FileTreeProps) {
  const { tr } = useI18n();
  const filesystem = useFilesystem(sessionId, projectPath);
  const [rootEntries, setRootEntries] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ entry: FsEntry; x: number; y: number } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadRoot = useCallback(async () => {
    if (!sessionId) {
      setRootEntries([]);
      return;
    }
    setLoading(true);
    setRootEntries(await filesystem.readDir('.'));
    setLoading(false);
  }, [filesystem.readDir, sessionId]);

  useEffect(() => { void loadRoot(); }, [loadRoot]);
  useEffect(() => { setContextMenu(null); setActionError(null); }, [sessionId]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => { setContextMenu(null); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', close, true);
    };
  }, [contextMenu]);

  const openContextMenu = useCallback((entry: FsEntry, event: ReactMouseEvent) => {
    event.preventDefault();
    setActionError(null);
    setContextMenu({
      entry,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 200)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 52)),
    });
  }, []);

  const revealEntry = async (entry: FsEntry) => {
    setContextMenu(null);
    setActionError(null);
    if (!sessionId) return;
    try {
      const absolutePath = projectPath ? resolveProjectEntryPath(projectPath, entry.path) : undefined;
      if (absolutePath !== undefined && window.noriDesktop?.fsReveal !== undefined) {
        await window.noriDesktop.fsReveal({
          path: absolutePath,
          isDirectory: entry.kind === 'directory',
        });
      } else {
        await api.sessions.fs.reveal(sessionId, entry.path);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  return <section className="file-explorer">
    <header className="file-explorer-header">
      <div><strong>{projectLabel(projectPath) ?? tr('Project files', '项目文件')}</strong><small title={projectPath}>{filesystem.branch ? `${filesystem.branch} · ` : ''}{projectPath ?? tr('No active project', '没有活动项目')}</small></div>
      <button className="btn-icon" onClick={() => void loadRoot()} disabled={loading || !sessionId} title={tr('Refresh files', '刷新文件')}><Icon name="refresh" size={14} /></button>
    </header>
    <div className="file-tree" role="tree">
      {!sessionId ? <div className="file-tree-state">{tr('Select a session to browse its project.', '选择会话以浏览对应项目。')}</div>
        : loading ? <div className="file-tree-state"><span className="spinner spinner-small" /> {tr('Loading files', '正在加载文件')}</div>
        : filesystem.error ? <div className="file-tree-state error">{filesystem.error}</div>
        : rootEntries.map(entry => <FileTreeNode key={entry.path} entry={entry} depth={0} selectedPath={selectedPath} onSelectFile={onSelectFile} onContextMenu={openContextMenu} readDir={filesystem.readDir} referenceLabel={tr('Reference in chat', '引用到对话')} />)}
    </div>
    {actionError && <div className="file-tree-action-error" role="status"><Icon name="alert" size={12}/><span>{actionError}</span></div>}
    {contextMenu && createPortal(<div className="file-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onPointerDown={event => { event.stopPropagation(); }} role="menu">
      <button type="button" role="menuitem" onClick={() => void revealEntry(contextMenu.entry)}><Icon name="files" size={14}/>{tr('Show in file manager', '在文件管理器中显示')}</button>
    </div>, document.body)}
  </section>;
}

function FileTreeNode({ entry, depth, selectedPath, onSelectFile, onContextMenu, readDir, referenceLabel }: {
  entry: FsEntry;
  depth: number;
  selectedPath?: string;
  onSelectFile: (entry: FsEntry) => void;
  onContextMenu: (entry: FsEntry, event: ReactMouseEvent) => void;
  readDir: (path: string) => Promise<FsEntry[]>;
  referenceLabel: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FsEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const isDirectory = entry.kind === 'directory';
  const selected = entry.path === selectedPath;

  const activate = async () => {
    if (!isDirectory) {
      onSelectFile(entry);
      return;
    }
    if (!expanded && children === null) {
      setLoading(true);
      setChildren(await readDir(entry.path));
      setLoading(false);
    }
    setExpanded(previous => !previous);
  };

  return <div role="treeitem" aria-expanded={isDirectory ? expanded : undefined}>
    <div className={`file-tree-row-wrap${selected ? ' selected' : ''}`} onContextMenu={event => { onContextMenu(entry, event); }}>
    <button type="button" className={`file-tree-row${selected ? ' selected' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => void activate()} title={entry.path}>
      <span className="file-tree-chevron">{isDirectory ? <Icon name="chevron-right" size={12} /> : null}</span>
      <Icon name={isDirectory ? 'files' : 'list'} size={14} />
      <span className="file-tree-name">{entry.name}</span>
      {loading && <span className="spinner spinner-small" />}
      {entry.git_status && entry.git_status !== 'clean' && <span className={`git-status git-status-${entry.git_status}`}>{STATUS_LABELS[entry.git_status] ?? '?'}</span>}
    </button>
    {!isDirectory && <button type="button" className="file-tree-reference" onClick={() => { referenceProjectFile(entry.path); }} title={referenceLabel} aria-label={`${referenceLabel}: ${entry.name}`}><Icon name="paperclip" size={12}/></button>}
    </div>
    {isDirectory && expanded && children?.map(child => <FileTreeNode key={child.path} entry={child} depth={depth + 1} selectedPath={selectedPath} onSelectFile={onSelectFile} onContextMenu={onContextMenu} readDir={readDir} referenceLabel={referenceLabel} />)}
  </div>;
}

function projectLabel(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const segments = path.split(/[\\/]/);
  for (let index = segments.length - 1; index >= 0; index--) {
    if (segments[index]) return segments[index];
  }
  return undefined;
}

function resolveProjectEntryPath(projectPath: string, entryPath: string): string | undefined {
  const segments = entryPath.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.some((segment) => segment === '..')) return undefined;
  const separator = projectPath.includes('\\') ? '\\' : '/';
  const root = projectPath.replace(/[\\/]+$/, '');
  if (root.length === 0) return undefined;
  return segments.length === 0 ? root : `${root}${separator}${segments.join(separator)}`;
}
