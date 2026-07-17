import { useEffect, useRef, useState } from 'react';

import { useBrowser } from '../hooks/useBrowser';
import { useI18n } from '../i18n';
import { BrowserToolbar } from './BrowserToolbar';
import { Icon } from './Icon';
import { dispatchBrowserReference } from '../browserReference';
import type { NoriBrowserState } from '../types/nori-desktop';

export function BrowserPanel() {
  const { tr } = useI18n();
  const browser = useBrowser();
  const viewportRef = useRef<HTMLDivElement>(null);
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const editingAnnotation = browser.activeTab?.annotations.find(item => item.id === editingAnnotationId);
  const activeDialog = browser.dialogs.find(item => item.tabId === browser.activeTabId) ?? browser.dialogs[0];
  const activeDownloads = browser.downloads.filter(item => item.tabId === browser.activeTabId);

  useEffect(() => {
    if (!browser.available) return;
    const viewport = viewportRef.current;
    if (viewport === null) return;
    browser.setVisible(true);
    const syncBounds = () => {
      const rect = viewport.getBoundingClientRect();
      browser.setBounds({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
    };
    const observer = new ResizeObserver(syncBounds);
    observer.observe(viewport);
    window.addEventListener('resize', syncBounds);
    window.addEventListener('scroll', syncBounds, true);
    syncBounds();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', syncBounds);
      window.removeEventListener('scroll', syncBounds, true);
      browser.setVisible(false);
    };
  }, [browser.available, browser.setBounds, browser.setVisible]);

  const blank = !browser.activeTab || browser.activeTab.url === 'about:blank';

  return <section className="browser-panel">
    <div className="browser-tab-strip" role="tablist" aria-label={tr('Browser tabs', '浏览器标签页')}>
      <div className="browser-tabs-scroll">
        {browser.tabs.map(tab => <div key={tab.id} className={`browser-tab${tab.id === browser.activeTabId ? ' active' : ''}`}>
          <button type="button" role="tab" aria-selected={tab.id === browser.activeTabId} onClick={() => browser.activateTab(tab.id)} title={tab.title || tab.url}>
            <Icon name="globe" size={12}/><span>{tab.title || tr('New tab', '新标签页')}</span>{tab.loading && <i/>}
          </button>
          <button type="button" className="browser-tab-close" onClick={() => browser.closeTab(tab.id)} title={tr('Close tab', '关闭标签页')} aria-label={tr('Close tab', '关闭标签页')}><Icon name="close" size={11}/></button>
        </div>)}
      </div>
      <button type="button" className="browser-new-tab" onClick={() => browser.newTab()} disabled={!browser.available} title={tr('New tab', '新标签页')} aria-label={tr('New tab', '新标签页')}><Icon name="plus" size={14}/></button>
    </div>
    <BrowserToolbar
      tab={browser.activeTab}
      available={browser.available}
      onNavigate={browser.navigate}
      onGoBack={browser.goBack}
      onGoForward={browser.goForward}
      onReload={browser.reload}
      onStop={browser.stop}
      onHome={() => browser.navigate('about:blank')}
      onOpenExternal={browser.openExternal}
      onOpenDevTools={browser.openDevTools}
      annotationMode={browser.activeTab?.annotationMode ?? false}
      automationPaused={browser.automation.paused}
      onToggleAnnotation={() => browser.setAnnotationMode(!(browser.activeTab?.annotationMode ?? false))}
      onToggleAutomation={() => browser.setAutomationPaused(!browser.automation.paused)}
      onChooseUpload={browser.chooseUploadFiles}
    />
    {activeDialog && <BrowserDialogPrompt dialog={activeDialog} onResolve={browser.resolveDialog}/>}
    {(browser.automation.active || (browser.activeTab?.annotations.length ?? 0) > 0 || browser.automation.history.length > 0 || activeDownloads.length > 0 || (browser.activeTab?.network.length ?? 0) > 0) && <div className="browser-context-strip">
      {browser.automation.active && <span className="browser-agent-action"><span className="spinner spinner-small"/><strong>{browser.automation.active.agentId}</strong> {browser.automation.active.action}</span>}
      {browser.activeTab && browser.activeTab.annotations.length > 0 && <div className="browser-annotations">
        <span>{tr('Annotations', '网页标注')} {browser.activeTab.annotations.length}</span>
        {browser.activeTab.annotations.map(item => <span className="browser-annotation-pill" key={item.id}>
          <button type="button" title={item.note || item.text} onClick={() => setEditingAnnotationId(item.id)}><Icon name="target" size={11}/>{item.note || item.text || `<${item.tag}>`}</button>
          <button type="button" className="browser-reference-annotation" onClick={() => dispatchBrowserReference(item)} title={tr('Reference in chat', '引用到聊天')} aria-label={tr('Reference in chat', '引用到聊天')}><Icon name="send" size={10}/></button>
        </span>)}
        {editingAnnotation && <input
          className="browser-annotation-note"
          defaultValue={editingAnnotation.note ?? ''}
          autoFocus
          placeholder={tr('Add a note…', '添加批注…')}
          onBlur={event => { browser.updateAnnotation(editingAnnotation.id, event.target.value.trim()); setEditingAnnotationId(null); }}
          onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') setEditingAnnotationId(null); }}
        />}
        <button type="button" className="browser-clear-annotations" onClick={browser.clearAnnotations} title={tr('Clear annotations', '清除标注')} aria-label={tr('Clear annotations', '清除标注')}><Icon name="trash" size={11}/></button>
      </div>}
      {browser.automation.history.length > 0 && <details className="browser-operation-history"><summary>{tr('Agent operations', 'Agent 操作')} {browser.automation.history.length}</summary><div>{browser.automation.history.slice(0, 12).map(item => <span key={item.id} className={item.status}><strong>{item.agentId}</strong><i>{item.action}</i>{item.summary}</span>)}</div></details>}
      {activeDownloads.length > 0 && <details className="browser-status-menu"><summary>{tr('Downloads', '下载')} {activeDownloads.length}</summary><div>{activeDownloads.map(item => <button type="button" key={item.id} onClick={() => browser.openDownload(item.id)} disabled={item.state !== 'completed'}><Icon name="files" size={11}/><span><strong>{item.filename}</strong><small>{item.state} · {formatBytes(item.receivedBytes)}{item.totalBytes > 0 ? ` / ${formatBytes(item.totalBytes)}` : ''}</small></span></button>)}</div></details>}
      {browser.activeTab && browser.activeTab.network.length > 0 && <details className="browser-status-menu network"><summary>{tr('Network', '网络')} {browser.activeTab.network.length}</summary><div><button type="button" className="browser-status-clear" onClick={() => browser.clearNetwork(browser.activeTab?.id)}><Icon name="trash" size={10}/>{tr('Clear', '清空')}</button>{browser.activeTab.network.slice(0, 80).map(item => <span key={item.id} className={item.state}><b>{item.status ?? item.method}</b><code title={item.url}>{item.url}</code><small>{item.durationMs === undefined ? item.resourceType : `${Math.round(item.durationMs)} ms`}</small></span>)}</div></details>}
    </div>}
    {browser.activeTab?.error && <div className="browser-page-error"><Icon name="alert" size={13}/><span>{browser.activeTab.error}</span><button type="button" onClick={browser.reload}>{tr('Retry', '重试')}</button></div>}
    <div className="browser-viewport" ref={viewportRef}>
      {!browser.available ? <div className="browser-unavailable"><Icon name="globe" size={24}/><strong>{tr('Built-in browser requires Nori Work', '内置浏览器需要 Nori Work 桌面版')}</strong></div>
        : blank ? <BrowserStart onNavigate={browser.navigate}/>
          : <div className="browser-native-surface" aria-hidden="true"/>}
    </div>
  </section>;
}

function BrowserDialogPrompt({ dialog, onResolve }: { dialog: NoriBrowserState['dialogs'][number]; onResolve: (id: string, accept: boolean, promptText?: string) => void }) {
  const { tr } = useI18n();
  const [value, setValue] = useState(dialog.defaultPrompt ?? '');
  useEffect(() => setValue(dialog.defaultPrompt ?? ''), [dialog.defaultPrompt, dialog.id]);
  return <div className="browser-native-prompt dialog"><Icon name="chat" size={13}/><span><strong>{dialog.type}</strong><small>{dialog.message}</small></span>{dialog.type === 'prompt' && <input value={value} onChange={event => setValue(event.target.value)} aria-label={tr('Dialog response', '弹窗回答')}/>}<button type="button" onClick={() => onResolve(dialog.id, false)}>{tr('Cancel', '取消')}</button><button type="button" onClick={() => onResolve(dialog.id, true, dialog.type === 'prompt' ? value : undefined)}>{tr('OK', '确定')}</button></div>;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function BrowserStart({ onNavigate }: { onNavigate: (url: string) => void }) {
  const { tr } = useI18n();
  return <div className="browser-start">
    <span className="browser-start-mark">N</span>
    <strong>Nori Browser</strong>
    <div className="browser-start-links">
      <button type="button" onClick={() => onNavigate('https://github.com')}>GitHub</button>
      <button type="button" onClick={() => onNavigate('https://developer.mozilla.org')}>MDN</button>
      <button type="button" onClick={() => onNavigate('http://localhost:5173')}>{tr('Local app', '本地应用')}</button>
    </div>
  </div>;
}
