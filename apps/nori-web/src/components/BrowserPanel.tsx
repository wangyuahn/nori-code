import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useBrowser } from '../hooks/useBrowser';
import { useI18n } from '../i18n';
import { BrowserToolbar } from './BrowserToolbar';
import { Icon } from './Icon';
import { dispatchBrowserReference } from '../browserReference';
import type { NoriBrowserState } from '../types/nori-desktop';

interface BrowserPanelProps {
  browserTabId?: string;
  claimedTabIds?: readonly string[];
  occluded?: boolean;
  onBrowserTabIdChange?: (tabId: string) => void;
}

export function BrowserPanel({ browserTabId, claimedTabIds = [], occluded = false, onBrowserTabIdChange }: BrowserPanelProps = {}) {
  const { tr } = useI18n();
  const browser = useBrowser();
  const managedBinding = onBrowserTabIdChange !== undefined;
  const viewportRef = useRef<HTMLDivElement>(null);
  const bindingInFlightRef = useRef(false);
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const boundTab = useMemo(
    () => browserTabId === undefined
      ? managedBinding ? undefined : browser.activeTab
      : browser.tabs.find(tab => tab.id === browserTabId),
    [browser.activeTab, browser.tabs, browserTabId, managedBinding],
  );
  const boundTabIsActive = boundTab !== undefined && browser.activeTabId === boundTab.id;
  const editingAnnotation = boundTab?.annotations.find(item => item.id === editingAnnotationId);
  const activeDialog = browser.dialogs.find(item => item.tabId === boundTab?.id);
  const activeDownloads = browser.downloads.filter(item => item.tabId === boundTab?.id);

  useEffect(() => {
    if (!browser.available || !browser.ready || onBrowserTabIdChange === undefined) return;
    if (browserTabId !== undefined) {
      if (browser.tabs.some(tab => tab.id === browserTabId)) {
        bindingInFlightRef.current = false;
        if (browser.activeTabId !== browserTabId) void browser.activateTab(browserTabId);
        return;
      }
      if (browser.tabs.length === 0 || bindingInFlightRef.current) return;
    }

    const reusableTabId = browser.activeTabId !== null && !claimedTabIds.includes(browser.activeTabId)
      ? browser.activeTabId
      : undefined;
    if (reusableTabId !== undefined) {
      bindingInFlightRef.current = false;
      onBrowserTabIdChange(reusableTabId);
      return;
    }
    if (bindingInFlightRef.current) return;
    bindingInFlightRef.current = true;
    void browser.newTab().then(next => {
      bindingInFlightRef.current = false;
      if (next?.activeTabId !== null && next?.activeTabId !== undefined) {
        onBrowserTabIdChange(next.activeTabId);
      }
    });
  }, [browser.activateTab, browser.activeTabId, browser.available, browser.newTab, browser.ready, browser.tabs, browserTabId, claimedTabIds, onBrowserTabIdChange]);

  const shouldShow = !managedBinding || (browserTabId !== undefined && boundTabIsActive);

  useLayoutEffect(() => {
    if (!browser.available) return;
    browser.setVisible(shouldShow);
    return () => { if (shouldShow) browser.setVisible(false); };
  }, [browser.available, browser.setVisible, shouldShow]);

  useLayoutEffect(() => {
    if (!browser.available || !shouldShow) return;
    browser.setOccluded(occluded);
    return () => { if (occluded) browser.setOccluded(false); };
  }, [browser.available, browser.setOccluded, occluded, shouldShow]);

  useLayoutEffect(() => {
    if (!browser.available || !shouldShow) return;
    const viewport = viewportRef.current;
    if (viewport === null) return;
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
    };
  }, [browser.available, browser.setBounds, shouldShow]);

  const blank = !boundTab || boundTab.url === 'about:blank';

  return <section className="browser-panel">
    <BrowserToolbar
      tab={boundTab}
      available={browser.available}
      onNavigate={browser.navigate}
      onGoBack={browser.goBack}
      onGoForward={browser.goForward}
      onReload={browser.reload}
      onStop={browser.stop}
      onHome={() => browser.navigate('about:blank')}
      onOpenExternal={browser.openExternal}
      onOpenDevTools={browser.openDevTools}
      annotationMode={boundTab?.annotationMode ?? false}
      automationPaused={browser.automation.paused}
      onToggleAnnotation={() => browser.setAnnotationMode(!(boundTab?.annotationMode ?? false))}
      onToggleAutomation={() => browser.setAutomationPaused(!browser.automation.paused)}
      onChooseUpload={browser.chooseUploadFiles}
    />
    {activeDialog && <BrowserDialogPrompt dialog={activeDialog} onResolve={browser.resolveDialog}/>}
    {(browser.automation.active || (boundTab?.annotations.length ?? 0) > 0 || browser.automation.history.length > 0 || activeDownloads.length > 0 || (boundTab?.network.length ?? 0) > 0) && <div className="browser-context-strip">
      {browser.automation.active && <span className="browser-agent-action"><span className="spinner spinner-small"/><strong>{browser.automation.active.agentId}</strong> {browser.automation.active.action}</span>}
      {boundTab && boundTab.annotations.length > 0 && <div className="browser-annotations">
        <span>{tr('Annotations', '网页标注')} {boundTab.annotations.length}</span>
        {boundTab.annotations.map(item => <span className="browser-annotation-pill" key={item.id}>
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
      {boundTab && boundTab.network.length > 0 && <details className="browser-status-menu network"><summary>{tr('Network', '网络')} {boundTab.network.length}</summary><div><button type="button" className="browser-status-clear" onClick={() => browser.clearNetwork(boundTab.id)}><Icon name="trash" size={10}/>{tr('Clear', '清空')}</button>{boundTab.network.slice(0, 80).map(item => <span key={item.id} className={item.state}><b>{item.status ?? item.method}</b><code title={item.url}>{item.url}</code><small>{item.durationMs === undefined ? item.resourceType : `${Math.round(item.durationMs)} ms`}</small></span>)}</div></details>}
    </div>}
    {boundTab?.error && <div className="browser-page-error"><Icon name="alert" size={13}/><span>{boundTab.error}</span><button type="button" onClick={browser.reload}>{tr('Retry', '重试')}</button></div>}
    <div className="browser-viewport" ref={viewportRef}>
      {!browser.available ? <div className="browser-unavailable"><Icon name="globe" size={24}/><strong>{tr('Built-in browser requires Nori Work', '内置浏览器需要 Nori Work 桌面版')}</strong></div>
        : blank ? <BrowserStart onNavigate={browser.navigate}/>
          : <div className="browser-native-surface" aria-hidden="true"/>}
      {browser.occluded && browser.occlusionPreviewDataUrl !== null && <img
        className="browser-occlusion-preview"
        src={browser.occlusionPreviewDataUrl}
        alt=""
        aria-hidden="true"
      />}
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
