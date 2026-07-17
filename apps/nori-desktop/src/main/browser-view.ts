import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  webContents as electronWebContents,
  WebContentsView,
  type DownloadItem,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';

import { BROWSER_HOME_URL, isAllowedBrowserUrl, localHtmlPath, normalizeBrowserInput } from './browser-url';
import {
  captureScreenshot,
  clearPageAnnotations,
  clickPage,
  firstVisibleFileInputRef,
  listPageAnnotations,
  pressKey,
  scrollPage,
  setPageAnnotationMode,
  snapshotPage,
  type BrowserAnnotation,
  type NativeBrowserActionRequest,
  type NativeBrowserActionResult,
  typePage,
  unavailablePageResult,
  updatePageAnnotation,
  waitForPage,
} from './browser-automation';
import {
  BrowserDebuggerController,
  type BrowserJavaScriptDialog,
  type BrowserNetworkEvent,
} from './browser-debugger';
import { restoreBrowserAutomationFocus } from './browser-focus';

export interface BrowserTabState {
  id: string;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  error?: string;
  annotationMode: boolean;
  annotations: BrowserAnnotation[];
  network: BrowserNetworkEntry[];
}

export interface BrowserNetworkEntry {
  readonly id: string;
  readonly method: string;
  url: string;
  readonly resourceType: string;
  readonly startedAt: string;
  status?: number;
  mimeType?: string;
  durationMs?: number;
  error?: string;
  state: 'pending' | 'completed' | 'failed';
}

export interface BrowserDownloadState {
  readonly id: string;
  readonly tabId: string;
  readonly filename: string;
  readonly url: string;
  readonly savePath: string;
  readonly createdAt: string;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  receivedBytes: number;
  totalBytes: number;
  speed: number;
}

export interface BrowserPermissionState {
  readonly id: string;
  readonly tabId: string;
  readonly permission: string;
  readonly origin: string;
  readonly createdAt: string;
}

export interface BrowserPermissionRule {
  readonly permission: string;
  readonly origin: string;
  readonly decision: 'allow' | 'deny';
}

export interface BrowserDialogState extends BrowserJavaScriptDialog {
  readonly id: string;
  readonly tabId: string;
  readonly createdAt: string;
}

export interface BrowserOperationState {
  readonly id: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly action: NativeBrowserActionRequest['action'];
  readonly summary: string;
  readonly status: 'completed' | 'failed';
  readonly createdAt: string;
}

export interface BrowserAutomationState {
  readonly paused: boolean;
  readonly active: {
    readonly id: string;
    readonly agentId: string;
    readonly sessionId: string;
    readonly action: NativeBrowserActionRequest['action'];
  } | null;
  readonly history: BrowserOperationState[];
}

export interface BrowserState {
  activeTabId: string | null;
  tabs: BrowserTabState[];
  visible: boolean;
  automation: BrowserAutomationState;
  downloads: BrowserDownloadState[];
  permissions: { pending: BrowserPermissionState[]; rules: BrowserPermissionRule[] };
  dialogs: BrowserDialogState[];
}

interface ManagedTab {
  readonly view: WebContentsView;
  state: BrowserTabState;
  attached: boolean;
  consoleMessages: string[];
  readonly debuggerController: BrowserDebuggerController;
  recoveryAttempts: number;
}

export interface BrowserAutomationCommand {
  readonly id: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly request: NativeBrowserActionRequest;
}

interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const managers = new WeakMap<BrowserWindow, BrowserViewManager>();
const managersByWebContents = new Map<number, BrowserViewManager>();
const configuredSessions = new WeakSet<Electron.Session>();
let browserIpcRegistered = false;

export class BrowserViewManager {
  private readonly tabs = new Map<string, ManagedTab>();
  private activeTabId: string | null = null;
  private visible = false;
  private destroying = false;
  private bounds: BrowserBounds = { x: 0, y: 0, width: 0, height: 0 };
  private automationPaused = false;
  private activeOperation: BrowserAutomationState['active'] = null;
  private readonly operationHistory: BrowserOperationState[] = [];
  private readonly downloads: BrowserDownloadState[] = [];
  private readonly downloadItems = new Map<string, DownloadItem>();
  private readonly pendingPermissions = new Map<string, { state: BrowserPermissionState; callback: (allowed: boolean) => void; timeout: ReturnType<typeof setTimeout> }>();
  private readonly permissionRules = new Map<string, BrowserPermissionRule>();
  private readonly pendingDialogs = new Map<string, BrowserDialogState>();
  private stateEmitTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly window: BrowserWindow) {}

  getState(): BrowserState {
    return {
      activeTabId: this.activeTabId,
      tabs: [...this.tabs.values()].map(tab => ({
        ...tab.state,
        annotations: tab.state.annotations.map(item => ({ ...item })),
        network: tab.state.network.map(item => ({ ...item })),
      })),
      visible: this.visible,
      automation: {
        paused: this.automationPaused,
        active: this.activeOperation,
        history: [...this.operationHistory],
      },
      downloads: this.downloads.map(item => ({ ...item })),
      permissions: {
        pending: [...this.pendingPermissions.values()].map(item => ({ ...item.state })),
        rules: [...this.permissionRules.values()].map(item => ({ ...item })),
      },
      dialogs: [...this.pendingDialogs.values()].map(item => ({ ...item })),
    };
  }

  createTab(input = BROWSER_HOME_URL): BrowserState {
    const id = randomUUID();
    const target = normalizeBrowserInput(input);
    const partition = 'persist:nori-browser';
    const browserSession = session.fromPartition(partition);
    installBrowserSessionPolicy(browserSession);

    const view = new WebContentsView({
      webPreferences: {
        session: browserSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    view.setBackgroundColor('#ffffff');
    const debuggerController = new BrowserDebuggerController(
      view.webContents,
      event => this.recordNetworkEvent(id, event),
      nextDialog => this.recordDialog(id, nextDialog),
      error => {
        const current = this.tabs.get(id);
        if (current === undefined) return;
        current.state = { ...current.state, error: `Browser diagnostics unavailable: ${formatError(error)}` };
        this.emitState();
      },
    );
    const tab: ManagedTab = {
      view,
      attached: false,
      consoleMessages: [],
      debuggerController,
      recoveryAttempts: 0,
      state: {
        id,
        url: target,
        title: target === BROWSER_HOME_URL ? 'New tab' : target,
        canGoBack: false,
        canGoForward: false,
        loading: target !== BROWSER_HOME_URL,
        annotationMode: false,
        annotations: [],
        network: [],
      },
    };
    this.tabs.set(id, tab);
    managersByWebContents.set(view.webContents.id, this);
    this.bindTab(tab);
    void debuggerController.start().catch(error => {
      tab.state = { ...tab.state, error: `Browser diagnostics unavailable: ${formatError(error)}` };
      this.emitState();
    });
    this.activeTabId = id;
    this.syncViews();
    this.emitState();
    if (target !== BROWSER_HOME_URL) void this.load(tab, target);
    return this.getState();
  }

  closeTab(tabId: string): BrowserState {
    const tab = this.tabs.get(tabId);
    if (tab === undefined) return this.getState();
    this.clearTabPendingState(tabId);
    this.detach(tab);
    tab.debuggerController.dispose();
    managersByWebContents.delete(tab.view.webContents.id);
    tab.view.webContents.close();
    this.tabs.delete(tabId);
    if (this.activeTabId === tabId) {
      this.activeTabId = [...this.tabs.keys()].at(-1) ?? null;
    }
    if (!this.destroying && this.tabs.size === 0) return this.createTab();
    this.syncViews();
    this.emitState();
    return this.getState();
  }

  activateTab(tabId: string): BrowserState {
    if (!this.tabs.has(tabId)) return this.getState();
    this.activeTabId = tabId;
    this.syncViews();
    this.emitState();
    return this.getState();
  }

  navigate(input: string): BrowserState {
    const tab = this.ensureActiveTab();
    const target = normalizeBrowserInput(input);
    tab.state = {
      ...tab.state,
      url: target,
      title: target === BROWSER_HOME_URL ? 'New tab' : tab.state.title,
      error: undefined,
      loading: target !== BROWSER_HOME_URL,
    };
    if (target === BROWSER_HOME_URL) {
      tab.view.webContents.stop();
      void tab.view.webContents.loadURL(BROWSER_HOME_URL);
    } else {
      void this.load(tab, target);
    }
    this.syncViews();
    this.emitState();
    return this.getState();
  }

  goBack(): void {
    const wc = this.activeTab()?.view.webContents;
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  }

  goForward(): void {
    const wc = this.activeTab()?.view.webContents;
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  }

  reload(): void {
    const tab = this.activeTab();
    if (tab === undefined || tab.state.url === BROWSER_HOME_URL) return;
    tab.view.webContents.reload();
  }

  stop(): void {
    this.activeTab()?.view.webContents.stop();
  }

  openDevTools(): void {
    this.activeTab()?.view.webContents.openDevTools({ mode: 'detach' });
  }

  async openExternal(): Promise<void> {
    const url = this.activeTab()?.state.url;
    if (url !== undefined && isAllowedBrowserUrl(url) && url !== BROWSER_HOME_URL) {
      const filePath = localHtmlPath(url);
      if (filePath !== undefined) await shell.openPath(filePath);
      else await shell.openExternal(url);
    }
  }

  setAutomationPaused(paused: boolean): BrowserState {
    this.automationPaused = paused;
    this.emitState();
    return this.getState();
  }

  async setAnnotationMode(enabled: boolean): Promise<BrowserState> {
    const tab = this.activeTab();
    if (tab === undefined || tab.state.url === BROWSER_HOME_URL) return this.getState();
    const annotations = await setPageAnnotationMode(tab.view.webContents, enabled);
    tab.state = { ...tab.state, annotationMode: enabled, annotations };
    this.emitState();
    return this.getState();
  }

  async clearAnnotations(): Promise<BrowserState> {
    const tab = this.activeTab();
    if (tab === undefined || tab.state.url === BROWSER_HOME_URL) return this.getState();
    await clearPageAnnotations(tab.view.webContents);
    tab.state = { ...tab.state, annotations: [] };
    this.emitState();
    return this.getState();
  }

  async updateAnnotation(id: string, note: string): Promise<BrowserState> {
    const tab = this.activeTab();
    if (tab === undefined || tab.state.url === BROWSER_HOME_URL) return this.getState();
    const annotations = await updatePageAnnotation(tab.view.webContents, id, note);
    tab.state = { ...tab.state, annotations };
    this.emitState();
    return this.getState();
  }

  async chooseUploadFiles(): Promise<BrowserState> {
    const tab = this.activeTab();
    if (tab === undefined || tab.state.url === BROWSER_HOME_URL) return this.getState();
    const ref = await firstVisibleFileInputRef(tab.view.webContents);
    if (ref === null) {
      tab.state = { ...tab.state, error: 'No visible file input is available on this page.' };
      this.emitState();
      return this.getState();
    }
    const selected = await dialog.showOpenDialog(this.window, {
      properties: ['openFile', 'multiSelections'],
      title: 'Select files to upload',
    });
    if (selected.canceled || selected.filePaths.length === 0) return this.getState();
    const result = await this.uploadFiles(tab, ref, selected.filePaths);
    if (!result.ok) tab.state = { ...tab.state, error: result.output };
    this.emitState();
    return this.getState();
  }

  resolvePermission(
    id: string,
    decision: 'allow_once' | 'allow_always' | 'deny' | 'deny_always',
  ): BrowserState {
    const pending = this.pendingPermissions.get(id);
    if (pending === undefined) return this.getState();
    clearTimeout(pending.timeout);
    this.pendingPermissions.delete(id);
    const allowed = decision === 'allow_once' || decision === 'allow_always';
    if (decision === 'allow_always' || decision === 'deny_always') {
      const rule: BrowserPermissionRule = {
        permission: pending.state.permission,
        origin: pending.state.origin,
        decision: allowed ? 'allow' : 'deny',
      };
      this.permissionRules.set(permissionRuleKey(rule.origin, rule.permission), rule);
    }
    pending.callback(allowed);
    this.emitState();
    return this.getState();
  }

  async resolveDialog(id: string, accept: boolean, promptText?: string): Promise<BrowserState> {
    const pending = this.pendingDialogs.get(id);
    if (pending === undefined) return this.getState();
    const tab = this.tabs.get(pending.tabId);
    if (tab === undefined) {
      this.pendingDialogs.delete(id);
      return this.getState();
    }
    await tab.debuggerController.respondToDialog(accept, promptText);
    this.pendingDialogs.delete(id);
    this.emitState();
    return this.getState();
  }

  async openDownload(id: string): Promise<void> {
    const download = this.downloads.find(item => item.id === id);
    if (download === undefined) return;
    if (download.state === 'completed') shell.showItemInFolder(download.savePath);
  }

  clearNetwork(tabId = this.activeTabId): BrowserState {
    if (tabId === null) return this.getState();
    const tab = this.tabs.get(tabId);
    if (tab === undefined) return this.getState();
    tab.state = { ...tab.state, network: [] };
    this.emitState();
    return this.getState();
  }

  handlePermissionRequest(
    webContentsId: number,
    permission: string,
    origin: string,
    callback: (allowed: boolean) => void,
  ): void {
    const tab = [...this.tabs.values()].find(candidate => candidate.view.webContents.id === webContentsId);
    if (tab === undefined) {
      callback(false);
      return;
    }
    const rule = this.permissionRules.get(permissionRuleKey(origin, permission));
    if (rule !== undefined) {
      callback(rule.decision === 'allow');
      return;
    }
    const id = randomUUID();
    const state: BrowserPermissionState = {
      id,
      tabId: tab.state.id,
      permission,
      origin,
      createdAt: new Date().toISOString(),
    };
    const timeout = setTimeout(() => this.resolvePermission(id, 'deny'), 30_000);
    timeout.unref?.();
    this.pendingPermissions.set(id, { state, callback, timeout });
    this.emitState();
  }

  checkPermission(webContentsId: number, permission: string, origin: string): boolean {
    const tabExists = [...this.tabs.values()].some(candidate => candidate.view.webContents.id === webContentsId);
    if (!tabExists) return false;
    return this.permissionRules.get(permissionRuleKey(origin, permission))?.decision === 'allow';
  }

  trackDownload(item: DownloadItem, webContentsId: number): void {
    const tab = [...this.tabs.values()].find(candidate => candidate.view.webContents.id === webContentsId);
    if (tab === undefined) {
      item.cancel();
      return;
    }
    const id = randomUUID();
    const filename = basename(item.getFilename()) || 'download';
    const savePath = uniqueDownloadPath(filename);
    item.setSavePath(savePath);
    const state: BrowserDownloadState = {
      id,
      tabId: tab.state.id,
      filename,
      url: item.getURL(),
      savePath,
      createdAt: new Date().toISOString(),
      state: 'progressing',
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
      speed: 0,
    };
    this.downloads.unshift(state);
    this.downloadItems.set(id, item);
    item.on('updated', (_event, nextState) => {
      state.state = nextState;
      state.receivedBytes = item.getReceivedBytes();
      state.totalBytes = item.getTotalBytes();
      state.speed = item.getCurrentBytesPerSecond();
      this.scheduleStateEmit();
    });
    item.once('done', (_event, nextState) => {
      state.state = nextState;
      state.receivedBytes = item.getReceivedBytes();
      state.totalBytes = item.getTotalBytes();
      state.speed = 0;
      this.downloadItems.delete(id);
      this.emitState();
    });
    if (this.downloads.length > 50) this.downloads.length = 50;
    this.emitState();
  }

  async executeAction(command: BrowserAutomationCommand): Promise<NativeBrowserActionResult> {
    if (this.automationPaused) return { ok: false, output: 'Browser automation is paused for user takeover.' };
    const previousFocus = electronWebContents.getFocusedWebContents();
    if (command.request.tabId !== undefined) {
      if (!this.tabs.has(command.request.tabId)) {
        return { ok: false, output: `Browser tab ${command.request.tabId} was not found.` };
      }
      this.activateTab(command.request.tabId);
    }
    const pageUnavailable = unavailablePageResult(command.request, this.activeTab()?.state.url);
    if (pageUnavailable !== undefined) return pageUnavailable;
    const tab = this.ensureActiveTab();
    const wc = tab.view.webContents;
    this.restoreFocusAfterAutomation(previousFocus, wc);
    this.activeOperation = {
      id: command.id,
      agentId: command.agentId,
      sessionId: command.sessionId,
      action: command.request.action,
    };
    this.emitState();
    let result: NativeBrowserActionResult;
    try {
      result = await this.runAction(tab, command.request);
    } catch (error) {
      result = { ok: false, output: error instanceof Error ? error.message : String(error) };
    } finally {
      this.restoreFocusAfterAutomation(previousFocus, wc);
    }
    this.operationHistory.unshift({
      ...this.activeOperation,
      summary: result.output,
      status: result.ok ? 'completed' : 'failed',
      createdAt: new Date().toISOString(),
    });
    if (this.operationHistory.length > 50) this.operationHistory.length = 50;
    this.activeOperation = null;
    this.emitState();
    return { ...result, tabId: tab.state.id, url: result.url ?? wc.getURL(), title: result.title ?? wc.getTitle() };
  }

  private restoreFocusAfterAutomation(
    previousFocus: WebContents | null,
    browserPage: WebContents,
  ): void {
    restoreBrowserAutomationFocus(
      previousFocus,
      electronWebContents.getFocusedWebContents(),
      browserPage,
    );
  }

  setBounds(input: BrowserBounds): void {
    this.bounds = sanitizeBounds(input);
    this.syncViews();
  }

  setVisible(visible: boolean): BrowserState {
    this.visible = visible;
    if (visible) this.ensureActiveTab();
    this.syncViews();
    this.emitState();
    return this.getState();
  }

  destroy(): void {
    this.destroying = true;
    for (const pending of this.pendingPermissions.values()) {
      clearTimeout(pending.timeout);
      pending.callback(false);
    }
    this.pendingPermissions.clear();
    this.pendingDialogs.clear();
    if (this.stateEmitTimer !== undefined) clearTimeout(this.stateEmitTimer);
    for (const tab of this.tabs.values()) {
      this.detach(tab);
      tab.debuggerController.dispose();
      managersByWebContents.delete(tab.view.webContents.id);
      tab.view.webContents.close();
    }
    this.tabs.clear();
    this.activeTabId = null;
  }

  private ensureActiveTab(): ManagedTab {
    const active = this.activeTab();
    if (active !== undefined) return active;
    this.createTab();
    return this.activeTab()!;
  }

  private activeTab(): ManagedTab | undefined {
    return this.activeTabId === null ? undefined : this.tabs.get(this.activeTabId);
  }

  private async load(tab: ManagedTab, target: string, timeoutMs = 30_000): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const loading = tab.view.webContents.loadURL(target);
      await Promise.race([
        loading,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            tab.view.webContents.stop();
            reject(new Error(`Navigation timed out after ${String(timeoutMs)}ms.`));
          }, timeoutMs);
          timeout.unref?.();
        }),
      ]);
      return true;
    } catch (error) {
      if (tab.view.webContents.isDestroyed()) return false;
      tab.state = {
        ...tab.state,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      };
      this.emitState();
      return false;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private async runAction(tab: ManagedTab, request: NativeBrowserActionRequest): Promise<NativeBrowserActionResult> {
    const wc = tab.view.webContents;
    switch (request.action) {
      case 'snapshot':
        return { ...this.pageResult(tab, 'Page snapshot captured.'), output: await snapshotPage(wc) };
      case 'navigate': {
        if (request.url === undefined) return { ok: false, output: 'navigate requires url.' };
        const target = normalizeBrowserInput(request.url);
        if (!isAllowedBrowserUrl(target)) return { ok: false, output: `Blocked unsupported URL: ${target}` };
        tab.state = { ...tab.state, url: target, error: undefined, loading: true };
        this.emitState();
        const loaded = await this.load(tab, target, request.timeoutMs ?? 30_000);
        return loaded
          ? this.pageResult(tab, `Navigated to ${target}.`)
          : { ...this.pageResult(tab, tab.state.error ?? `Failed to navigate to ${target}.`), ok: false };
      }
      case 'click': return clickPage(wc, request);
      case 'type':
        return request.ref === undefined || request.text === undefined
          ? { ok: false, output: 'type requires ref and text.' }
          : typePage(wc, request.ref, request.text, request.clear ?? true);
      case 'upload':
        return request.ref === undefined || request.paths === undefined || request.paths.length === 0
          ? { ok: false, output: 'upload requires ref and at least one path.' }
          : this.uploadFiles(tab, request.ref, request.paths);
      case 'keypress':
        return request.key === undefined ? { ok: false, output: 'keypress requires key.' } : pressKey(wc, request.key);
      case 'scroll': return scrollPage(wc, request.deltaX, request.deltaY);
      case 'wait': return waitForPage(wc, request);
      case 'screenshot': return captureScreenshot(wc);
      case 'back':
        if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
        return this.pageResult(tab, 'Navigated back.');
      case 'forward':
        if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
        return this.pageResult(tab, 'Navigated forward.');
      case 'reload':
        wc.reload();
        return this.pageResult(tab, 'Reloaded the page.');
      case 'retry':
        tab.recoveryAttempts = 0;
        tab.state = { ...tab.state, error: undefined, loading: true };
        const loaded = await this.load(tab, tab.state.url, request.timeoutMs ?? 30_000);
        return loaded && tab.state.error === undefined
          ? this.pageResult(tab, 'Retried the failed page successfully.')
          : { ...this.pageResult(tab, tab.state.error ?? 'Failed to reload the page.'), ok: false };
      case 'get_console':
        return this.pageResult(tab, tab.consoleMessages.length === 0 ? 'No console messages.' : tab.consoleMessages.join('\n'));
      case 'get_network': {
        const filter = request.filter?.toLowerCase();
        const entries = tab.state.network.filter(item => filter === undefined
          || item.url.toLowerCase().includes(filter)
          || item.method.toLowerCase().includes(filter));
        return this.pageResult(tab, entries.length === 0
          ? 'No matching network requests.'
          : `<browser_network untrusted="true">\n${entries.slice(0, 100).map(formatNetworkEntry).join('\n')}\n</browser_network>`);
      }
      case 'download_list':
        return this.pageResult(tab, this.downloads.length === 0
          ? 'No browser downloads.'
          : `<browser_downloads>\n${this.downloads.map(item => `[${item.id}] ${item.state} ${item.filename} ${String(item.receivedBytes)}/${String(item.totalBytes)} bytes -> ${item.savePath}`).join('\n')}\n</browser_downloads>`);
      case 'permission_list': {
        const pending = [...this.pendingPermissions.values()].map(item => item.state);
        return this.pageResult(tab, pending.length === 0
          ? 'No pending browser permission requests.'
          : `<browser_permissions>\n${pending.map(item => `[${item.id}] ${item.permission} from ${item.origin}`).join('\n')}\n</browser_permissions>`);
      }
      case 'dialog_list': {
        const dialogs = [...this.pendingDialogs.values()];
        return this.pageResult(tab, dialogs.length === 0
          ? 'No pending JavaScript dialogs.'
          : `<browser_dialogs untrusted="true">\n${dialogs.map(item => `[${item.id}] ${item.type} ${JSON.stringify(item.message)} at ${item.url}`).join('\n')}\n</browser_dialogs>`);
      }
      case 'dialog_respond':
        if (request.dialogId === undefined || request.accept === undefined) {
          return { ok: false, output: 'dialog_respond requires dialogId and accept.' };
        }
        if (!this.pendingDialogs.has(request.dialogId)) {
          return { ok: false, output: `Dialog ${request.dialogId} is no longer pending.` };
        }
        await this.resolveDialog(request.dialogId, request.accept, request.promptText);
        return this.pageResult(tab, `${request.accept ? 'Accepted' : 'Dismissed'} dialog ${request.dialogId}.`);
      case 'annotation_list': {
        const annotations = await listPageAnnotations(wc);
        tab.state = { ...tab.state, annotations };
        return this.pageResult(tab, annotations.length === 0
          ? 'No page annotations.'
          : `<browser_annotations untrusted="true">\n${annotations.map(item => `[${item.id}] ref=${item.ref} <${item.tag}> ${item.text}${item.note ? `\n  User note: ${item.note}` : ''}`).join('\n')}\n</browser_annotations>`);
      }
    }
  }

  private async uploadFiles(tab: ManagedTab, ref: string, paths: readonly string[]): Promise<NativeBrowserActionResult> {
    if (paths.length > 20) return { ok: false, output: 'A browser upload is limited to 20 files.' };
    for (const filePath of paths) {
      try {
        const info = await stat(filePath);
        if (!info.isFile()) return { ok: false, output: `Upload path is not a file: ${filePath}` };
      } catch {
        return { ok: false, output: `Upload file does not exist or cannot be read: ${filePath}` };
      }
    }
    const applied = await tab.debuggerController.setFileInputFiles(ref, paths);
    if (!applied) return { ok: false, staleRef: true, output: `Reference ${ref} is stale or is not a file input. Take a new snapshot and retry.` };
    return this.pageResult(tab, `Selected ${String(paths.length)} file${paths.length === 1 ? '' : 's'} for upload in ${ref}.`);
  }

  private pageResult(tab: ManagedTab, output: string): NativeBrowserActionResult {
    return { ok: true, output, url: tab.view.webContents.getURL(), title: tab.view.webContents.getTitle(), tabId: tab.state.id };
  }

  private recordNetworkEvent(tabId: string, event: BrowserNetworkEvent): void {
    const tab = this.tabs.get(tabId);
    if (tab === undefined || event.requestId === '') return;
    if (event.phase === 'request') {
      const entry: BrowserNetworkEntry = {
        id: event.requestId,
        method: event.method ?? 'GET',
        url: event.url ?? '',
        resourceType: event.resourceType ?? 'Other',
        startedAt: new Date(event.timestamp).toISOString(),
        state: 'pending',
      };
      tab.state.network.unshift(entry);
      if (tab.state.network.length > 200) tab.state.network.length = 200;
      this.scheduleStateEmit();
      return;
    }
    const entry = tab.state.network.find(candidate => candidate.id === event.requestId);
    if (entry === undefined) return;
    if (event.phase === 'response') {
      entry.status = event.status;
      entry.mimeType = event.mimeType;
      if (event.url !== undefined) entry.url = event.url;
    } else {
      entry.durationMs = Math.max(0, event.timestamp - Date.parse(entry.startedAt));
      entry.state = event.phase === 'failed' ? 'failed' : 'completed';
      entry.error = event.error;
    }
    this.scheduleStateEmit();
  }

  private recordDialog(tabId: string, dialog: BrowserJavaScriptDialog): void {
    const state: BrowserDialogState = {
      ...dialog,
      id: randomUUID(),
      tabId,
      createdAt: new Date().toISOString(),
    };
    this.pendingDialogs.set(state.id, state);
    this.emitState();
  }

  private clearTabPendingState(tabId: string): void {
    for (const [id, pending] of this.pendingPermissions) {
      if (pending.state.tabId !== tabId) continue;
      clearTimeout(pending.timeout);
      pending.callback(false);
      this.pendingPermissions.delete(id);
    }
    for (const [id, pending] of this.pendingDialogs) {
      if (pending.tabId === tabId) this.pendingDialogs.delete(id);
    }
  }

  private scheduleStateEmit(): void {
    if (this.stateEmitTimer !== undefined) return;
    this.stateEmitTimer = setTimeout(() => {
      this.stateEmitTimer = undefined;
      this.emitState();
    }, 150);
    this.stateEmitTimer.unref?.();
  }

  private bindTab(tab: ManagedTab): void {
    const wc = tab.view.webContents;
    const refresh = (partial: Partial<BrowserTabState> = {}) => {
      if (wc.isDestroyed()) return;
      tab.state = {
        ...tab.state,
        url: wc.getURL() || tab.state.url,
        title: wc.getTitle() || tab.state.title,
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        loading: wc.isLoading(),
        ...partial,
      };
      this.syncViews();
      this.emitState();
    };

    wc.on('page-title-updated', (_event, title) => refresh({ title }));
    wc.on('did-navigate', (_event, url) => {
      this.clearTabPendingState(tab.state.id);
      refresh({ url, error: undefined, annotationMode: false, annotations: [] });
    });
    wc.on('did-navigate-in-page', (_event, url) => refresh({ url, error: undefined }));
    wc.on('did-start-loading', () => refresh({ loading: true, error: undefined }));
    wc.on('did-stop-loading', () => refresh({ loading: false }));
    wc.on('did-finish-load', () => { tab.recoveryAttempts = 0; });
    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      refresh({ url: validatedUrl || tab.state.url, loading: false, error: errorDescription });
    });
    wc.on('console-message', (_event, level, message, line, sourceId) => {
      if (message.startsWith('__NORI_ANNOTATION__')) {
        try {
          const annotations = JSON.parse(message.slice('__NORI_ANNOTATION__'.length)) as BrowserAnnotation[];
          tab.state = { ...tab.state, annotations };
          this.emitState();
        } catch {}
        return;
      }
      tab.consoleMessages.push(`[${String(level)}] ${message} (${sourceId}:${String(line)})`);
      if (tab.consoleMessages.length > 100) tab.consoleMessages.splice(0, tab.consoleMessages.length - 100);
    });
    wc.on('render-process-gone', (_event, details) => {
      if (this.destroying || wc.isDestroyed()) return;
      const reason = `Page renderer stopped (${details.reason}, exit ${String(details.exitCode)}).`;
      refresh({ loading: false, error: reason });
      if (tab.recoveryAttempts >= 2 || tab.state.url === BROWSER_HOME_URL) return;
      tab.recoveryAttempts += 1;
      const timer = setTimeout(() => {
        if (!wc.isDestroyed()) void this.load(tab, tab.state.url);
      }, 500 * tab.recoveryAttempts);
      timer.unref?.();
    });
    wc.on('unresponsive', () => refresh({ error: 'Page is unresponsive. Use Retry or reload the tab.' }));
    wc.on('responsive', () => refresh({ error: undefined }));
    const guardNavigation = (event: Electron.Event, url: string) => {
      if (isAllowedBrowserUrl(url)) return;
      event.preventDefault();
      refresh({ loading: false, error: `Blocked navigation to unsupported URL: ${url}` });
    };
    wc.on('will-navigate', guardNavigation);
    wc.on('will-redirect', guardNavigation);
    wc.setWindowOpenHandler(({ url }) => {
      if (isAllowedBrowserUrl(url)) this.createTab(url);
      return { action: 'deny' };
    });
    wc.on('context-menu', (_event, params) => {
      const menu = Menu.buildFromTemplate([
        { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { type: 'separator' },
        { label: 'Reload', click: () => wc.reload() },
        { label: 'Inspect element', click: () => wc.inspectElement(params.x, params.y) },
      ]);
      menu.popup({ window: this.window });
    });
  }

  private syncViews(): void {
    const active = this.activeTab();
    for (const tab of this.tabs.values()) {
      const shouldAttach = tab === active
        && this.visible
        && tab.state.url !== BROWSER_HOME_URL
        && this.bounds.width > 0
        && this.bounds.height > 0;
      if (shouldAttach) {
        if (!tab.attached) {
          this.window.contentView.addChildView(tab.view);
          tab.attached = true;
        }
        tab.view.setBounds(this.bounds);
        tab.view.setVisible(true);
      } else {
        this.detach(tab);
      }
    }
  }

  private detach(tab: ManagedTab): void {
    if (!tab.attached) return;
    tab.view.setVisible(false);
    this.window.contentView.removeChildView(tab.view);
    tab.attached = false;
  }

  private emitState(): void {
    if (this.window.isDestroyed()) return;
    this.window.webContents.send('nori:browser:state', this.getState());
  }
}

export function browserManagerFor(window: BrowserWindow): BrowserViewManager {
  const current = managers.get(window);
  if (current !== undefined) return current;
  const manager = new BrowserViewManager(window);
  managers.set(window, manager);
  window.once('close', () => manager.destroy());
  return manager;
}

export function registerBrowserIpc(): void {
  if (browserIpcRegistered) return;
  browserIpcRegistered = true;

  ipcMain.handle('nori:browser:get-state', event => managerFor(event).getState());
  ipcMain.handle('nori:browser:navigate', (event, url: string) => managerFor(event).navigate(url));
  ipcMain.handle('nori:browser:new-tab', (event, url?: string) => managerFor(event).createTab(url));
  ipcMain.handle('nori:browser:close-tab', (event, tabId: string) => managerFor(event).closeTab(tabId));
  ipcMain.handle('nori:browser:activate-tab', (event, tabId: string) => managerFor(event).activateTab(tabId));
  ipcMain.handle('nori:browser:set-visible', (event, visible: boolean) => managerFor(event).setVisible(visible));
  ipcMain.handle('nori:browser:open-external', event => managerFor(event).openExternal());
  ipcMain.handle('nori:browser:annotation-mode', (event, enabled: boolean) => managerFor(event).setAnnotationMode(enabled));
  ipcMain.handle('nori:browser:clear-annotations', event => managerFor(event).clearAnnotations());
  ipcMain.handle('nori:browser:update-annotation', (event, id: string, note: string) => managerFor(event).updateAnnotation(id, note));
  ipcMain.handle('nori:browser:set-automation-paused', (event, paused: boolean) => managerFor(event).setAutomationPaused(paused));
  ipcMain.handle('nori:browser:choose-upload', event => managerFor(event).chooseUploadFiles());
  ipcMain.handle('nori:browser:resolve-permission', (event, id: string, decision: string) =>
    managerFor(event).resolvePermission(id, normalizePermissionDecision(decision)));
  ipcMain.handle('nori:browser:resolve-dialog', (event, id: string, accept: boolean, promptText?: string) =>
    managerFor(event).resolveDialog(id, accept === true, promptText));
  ipcMain.handle('nori:browser:open-download', (event, id: string) => managerFor(event).openDownload(id));
  ipcMain.handle('nori:browser:clear-network', (event, tabId?: string) => managerFor(event).clearNetwork(tabId));
  if (!app.isPackaged && process.env['NORI_BROWSER_SMOKE'] === '1') {
    ipcMain.handle('nori:browser:execute-action-smoke', (event, request: NativeBrowserActionRequest) =>
      managerFor(event).executeAction({
        id: randomUUID(),
        sessionId: 'browser-smoke-session',
        agentId: 'browser-smoke-agent',
        request,
      }));
  }
  ipcMain.on('nori:browser:back', event => managerFor(event).goBack());
  ipcMain.on('nori:browser:forward', event => managerFor(event).goForward());
  ipcMain.on('nori:browser:reload', event => managerFor(event).reload());
  ipcMain.on('nori:browser:stop', event => managerFor(event).stop());
  ipcMain.on('nori:browser:devtools', event => managerFor(event).openDevTools());
  ipcMain.on('nori:browser:resize', (event, bounds: BrowserBounds) => managerFor(event).setBounds(bounds));
}

function managerFor(event: IpcMainEvent | IpcMainInvokeEvent): BrowserViewManager {
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (owner === null) throw new Error('Browser IPC sender is not attached to a Nori window.');
  return browserManagerFor(owner);
}

function installBrowserSessionPolicy(browserSession: Electron.Session): void {
  if (configuredSessions.has(browserSession)) return;
  configuredSessions.add(browserSession);
  browserSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const manager = managersByWebContents.get(webContents.id);
    if (manager === undefined) {
      callback(false);
      return;
    }
    manager.handlePermissionRequest(webContents.id, permission, permissionOrigin(webContents.getURL(), details), callback);
  });
  browserSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    if (webContents === null) return false;
    return managersByWebContents.get(webContents.id)?.checkPermission(webContents.id, permission, requestingOrigin) ?? false;
  });
  browserSession.on('will-download', (_event, item, webContents) => {
    const manager = managersByWebContents.get(webContents.id);
    if (manager === undefined) {
      item.cancel();
      return;
    }
    manager.trackDownload(item, webContents.id);
  });
}

function sanitizeBounds(bounds: BrowserBounds): BrowserBounds {
  const number = (value: number) => Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  return { x: number(bounds.x), y: number(bounds.y), width: number(bounds.width), height: number(bounds.height) };
}

function permissionOrigin(currentUrl: string, details: object): string {
  const request = details as { requestingUrl?: string; requestingOrigin?: string };
  const source = request.requestingOrigin || request.requestingUrl || currentUrl;
  try { return new URL(source).origin; } catch { return source || 'unknown'; }
}

function permissionRuleKey(origin: string, permission: string): string {
  return `${origin}\0${permission}`;
}

function uniqueDownloadPath(filename: string): string {
  const directory = app.getPath('downloads');
  const extensionIndex = filename.lastIndexOf('.');
  const stem = extensionIndex > 0 ? filename.slice(0, extensionIndex) : filename;
  const extension = extensionIndex > 0 ? filename.slice(extensionIndex) : '';
  let candidate = join(directory, filename);
  for (let suffix = 1; existsSync(candidate); suffix++) {
    candidate = join(directory, `${stem} (${String(suffix)})${extension}`);
  }
  return candidate;
}

function formatNetworkEntry(item: BrowserNetworkEntry): string {
  const status = item.status === undefined ? '' : ` ${String(item.status)}`;
  const duration = item.durationMs === undefined ? '' : ` ${String(Math.round(item.durationMs))}ms`;
  const error = item.error === undefined ? '' : ` error=${JSON.stringify(item.error)}`;
  return `[${item.state}] ${item.method}${status} ${item.url}${duration}${error}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizePermissionDecision(value: string): 'allow_once' | 'allow_always' | 'deny' | 'deny_always' {
  return value === 'allow_once' || value === 'allow_always' || value === 'deny_always' ? value : 'deny';
}
