import { useEffect, useState } from 'react';
import { api, type WorkspaceFolderBrowseResponse, type WorkspaceFolderHomeResponse } from '../api/client';
import { useI18n } from '../i18n';
import { Icon } from './Icon';

interface ProjectFolderPickerProps {
  open: boolean;
  onSelect: (path: string) => void;
  onClose: () => void;
}

export function ProjectFolderPicker({ open, onSelect, onClose }: ProjectFolderPickerProps) {
  const { tr } = useI18n();
  const [home, setHome] = useState<WorkspaceFolderHomeResponse | null>(null);
  const [browse, setBrowse] = useState<WorkspaceFolderBrowseResponse | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openPath = async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.workspaceFolders.browse(path);
      setBrowse(result);
      setPathInput(result.path);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr('Unable to open this folder.', '无法打开此文件夹。'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api.workspaceFolders.home().then(result => {
      if (cancelled) return;
      setHome(result);
      return openPath(result.home);
    }).catch(cause => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : tr('Unable to load folders.', '无法加载文件夹。'));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  if (!open) return null;

  return <div className="folder-picker-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="folder-picker" role="dialog" aria-modal="true" aria-labelledby="folder-picker-title">
      <header className="folder-picker-header">
        <div><span className="eyebrow">{tr('New conversation', '新建对话')}</span><h2 id="folder-picker-title">{tr('Choose a project folder', '选择项目文件夹')}</h2></div>
        <button className="folder-picker-icon-btn" onClick={onClose} aria-label={tr('Close', '关闭')}>×</button>
      </header>

      <form className="folder-picker-path" onSubmit={event => { event.preventDefault(); void openPath(pathInput.trim()); }}>
        <button type="button" className="folder-picker-icon-btn" onClick={() => browse?.parent && void openPath(browse.parent)} disabled={!browse?.parent} aria-label={tr('Parent folder', '上级文件夹')}><Icon name="chevron-left" size={16}/></button>
        <input value={pathInput} onChange={event => setPathInput(event.target.value)} aria-label={tr('Folder path', '文件夹路径')} />
        <button type="submit" disabled={!pathInput.trim() || loading}>{tr('Go', '前往')}</button>
      </form>

      {home?.recent_roots.length ? <div className="folder-picker-recents">
        <span>{tr('Recent projects', '最近项目')}</span>
        <div>{home.recent_roots.slice(0, 5).map(path => <button key={path} onClick={() => void openPath(path)} title={path}>{projectName(path)}</button>)}</div>
      </div> : null}

      <div className="folder-picker-list">
        {loading && <div className="folder-picker-state"><span className="spinner spinner-small" />{tr('Loading folders…', '正在加载文件夹…')}</div>}
        {!loading && error && <div className="folder-picker-state error"><Icon name="alert" size={16}/>{error}</div>}
        {!loading && !error && browse?.entries.map(entry => <button key={entry.path} className="folder-picker-row" onDoubleClick={() => void openPath(entry.path)} onClick={() => void openPath(entry.path)} title={entry.path}>
          <Icon name="files" size={16}/><span><strong>{entry.name}</strong><small>{entry.is_git_repo ? tr(entry.branch ? `Git · ${entry.branch}` : 'Git repository', entry.branch ? `Git · ${entry.branch}` : 'Git 仓库') : tr('Folder', '文件夹')}</small></span><Icon name="chevron-right" size={14}/>
        </button>)}
      </div>

      <footer className="folder-picker-footer">
        <span title={browse?.path}>{browse?.path}</span>
        <div><button onClick={onClose}>{tr('Cancel', '取消')}</button><button className="primary" onClick={() => browse?.path && onSelect(browse.path)} disabled={!browse?.path || loading}>{tr('Use this folder', '选择此文件夹')}</button></div>
      </footer>
    </section>
  </div>;
}

function projectName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path;
}
