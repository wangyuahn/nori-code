import { useEffect, useState, type KeyboardEvent } from 'react';
import { useI18n } from '../i18n';

interface BrowserToolbarProps {
  url: string;
  onNavigate: (url: string) => void;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  onReload: () => void;
  onOpenDevTools: () => void;
  onToggleVisible: () => void;
  visible: boolean;
}

export function BrowserToolbar({
  url, onNavigate, canGoBack, canGoForward, loading, onGoBack, onGoForward,
  onReload, onOpenDevTools, onToggleVisible, visible,
}: BrowserToolbarProps) {
  const { tr } = useI18n();
  const [inputValue, setInputValue] = useState(url);

  useEffect(() => setInputValue(url), [url]);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') onNavigate(inputValue);
  };

  return (
    <div className="browser-toolbar">
      <button className="btn-icon" disabled={!canGoBack} onClick={onGoBack} title={tr('Back', '后退')}>&larr;</button>
      <button className="btn-icon" disabled={!canGoForward} onClick={onGoForward} title={tr('Forward', '前进')}>&rarr;</button>
      <button className={loading ? 'btn-icon spinner' : 'btn-icon'} onClick={onReload} title={tr('Reload', '重新加载')}>
        {loading ? null : '↻'}
      </button>
      <input
        className="input browser-address"
        value={inputValue}
        onChange={event => setInputValue(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={tr('Enter URL or search...', '输入网址或搜索...')}
      />
      <button className="btn-icon" onClick={onOpenDevTools} title={tr('Developer tools', '开发者工具')}>&lt;/&gt;</button>
      <button className="btn-icon" onClick={onToggleVisible} title={tr('Toggle browser', '切换浏览器显示')}>
        {visible ? '▾' : '▴'}
      </button>
    </div>
  );
}
