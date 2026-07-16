import { useEffect, useState, type FormEvent } from 'react';

import type { NoriBrowserTabState } from '../types/nori-desktop';
import { useI18n } from '../i18n';
import { Icon } from './Icon';

interface BrowserToolbarProps {
  tab?: NoriBrowserTabState;
  available: boolean;
  annotationMode: boolean;
  automationPaused: boolean;
  onNavigate: (url: string) => void;
  onGoBack: () => void;
  onGoForward: () => void;
  onReload: () => void;
  onStop: () => void;
  onHome: () => void;
  onOpenExternal: () => void;
  onOpenDevTools: () => void;
  onToggleAnnotation: () => void;
  onToggleAutomation: () => void;
  onChooseUpload: () => void;
}

export function BrowserToolbar(props: BrowserToolbarProps) {
  const { tr } = useI18n();
  const { tab, available } = props;
  const [inputValue, setInputValue] = useState(tab?.url === 'about:blank' ? '' : tab?.url ?? '');

  useEffect(() => setInputValue(tab?.url === 'about:blank' ? '' : tab?.url ?? ''), [tab?.url]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (inputValue.trim()) props.onNavigate(inputValue);
  };
  const hasPage = available && tab !== undefined && tab.url !== 'about:blank';

  return <form className="browser-toolbar" onSubmit={submit}>
    <button type="button" className="browser-icon-button" disabled={!available || !tab?.canGoBack} onClick={props.onGoBack} title={tr('Back', '后退')} aria-label={tr('Back', '后退')}><Icon name="chevron-left" size={15}/></button>
    <button type="button" className="browser-icon-button" disabled={!available || !tab?.canGoForward} onClick={props.onGoForward} title={tr('Forward', '前进')} aria-label={tr('Forward', '前进')}><Icon name="chevron-right" size={15}/></button>
    <button type="button" className="browser-icon-button" disabled={!available} onClick={tab?.loading ? props.onStop : props.onReload} title={tab?.loading ? tr('Stop loading', '停止加载') : tr('Reload', '重新加载')} aria-label={tab?.loading ? tr('Stop loading', '停止加载') : tr('Reload', '重新加载')}><Icon name={tab?.loading ? 'stop' : 'refresh'} size={14}/></button>
    <button type="button" className="browser-icon-button" disabled={!available} onClick={props.onHome} title={tr('Home', '主页')} aria-label={tr('Home', '主页')}><Icon name="home" size={14}/></button>
    <div className={`browser-address-wrap${tab?.loading ? ' loading' : ''}`}>
      <Icon name="globe" size={13}/>
      <input className="browser-address" value={inputValue} onChange={event => setInputValue(event.target.value)} placeholder={tr('Search or enter address', '搜索或输入网址')} aria-label={tr('Browser address', '浏览器地址')} disabled={!available} spellCheck={false}/>
    </div>
    <button type="button" className="browser-icon-button" disabled={!hasPage} onClick={props.onOpenExternal} title={tr('Open in system browser', '在系统浏览器中打开')} aria-label={tr('Open in system browser', '在系统浏览器中打开')}><Icon name="external" size={14}/></button>
    <button type="button" className={`browser-icon-button${props.annotationMode ? ' active' : ''}`} disabled={!hasPage} onClick={props.onToggleAnnotation} title={tr('Annotate page', '标注网页')} aria-label={tr('Annotate page', '标注网页')}><Icon name="target" size={14}/></button>
    <button type="button" className="browser-icon-button" disabled={!hasPage} onClick={props.onChooseUpload} title={tr('Choose files for the page', '为网页选择上传文件')} aria-label={tr('Choose files for the page', '为网页选择上传文件')}><Icon name="upload" size={14}/></button>
    <button type="button" className={`browser-icon-button${props.automationPaused ? ' active warning' : ''}`} disabled={!available} onClick={props.onToggleAutomation} title={props.automationPaused ? tr('Resume Agent browser control', '恢复 Agent 浏览器控制') : tr('Pause for user takeover', '暂停并由用户接管')} aria-label={props.automationPaused ? tr('Resume Agent browser control', '恢复 Agent 浏览器控制') : tr('Pause for user takeover', '暂停并由用户接管')}><Icon name={props.automationPaused ? 'play' : 'pause'} size={14}/></button>
    <button type="button" className="browser-icon-button" disabled={!hasPage} onClick={props.onOpenDevTools} title={tr('Developer tools', '开发者工具')} aria-label={tr('Developer tools', '开发者工具')}><Icon name="terminal" size={14}/></button>
  </form>;
}
