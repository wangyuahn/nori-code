import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('noriDesktop', {
  usesCustomWindowControls: process.platform !== 'darwin',
  getServerToken: () => ipcRenderer.invoke('nori:getServerToken') as Promise<string | undefined>,
  windowMinimize: () => {
    ipcRenderer.send('nori:window:minimize');
  },
  windowToggleMaximize: () => ipcRenderer.invoke('nori:window:toggle-maximize') as Promise<boolean>,
  windowIsMaximized: () => ipcRenderer.invoke('nori:window:is-maximized') as Promise<boolean>,
  windowClose: () => {
    ipcRenderer.send('nori:window:close');
  },
  onWindowMaximizedChange: (callback: (maximized: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, maximized: boolean) => {
      callback(maximized);
    };
    ipcRenderer.on('nori:window:maximized-change', handler);
    return () => ipcRenderer.removeListener('nori:window:maximized-change', handler);
  },
  selectProjectDirectory: () => ipcRenderer.invoke('nori:selectProjectDirectory') as Promise<string | undefined>,
  saveMarkdown: (input: { suggestedName: string; content: string }) => ipcRenderer.invoke('nori:saveMarkdown', input) as Promise<string | undefined>,
  onToggleMode: (callback: (mode: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, mode: string) => callback(mode);
    ipcRenderer.on('nori:toggleMode', handler);
    return () => ipcRenderer.removeListener('nori:toggleMode', handler);
  },
  browserGetState: () => ipcRenderer.invoke('nori:browser:get-state'),
  browserNavigate: (url: string) => ipcRenderer.invoke('nori:browser:navigate', url),
  browserNewTab: (url?: string) => ipcRenderer.invoke('nori:browser:new-tab', url),
  browserCloseTab: (tabId: string) => ipcRenderer.invoke('nori:browser:close-tab', tabId),
  browserActivateTab: (tabId: string) => ipcRenderer.invoke('nori:browser:activate-tab', tabId),
  browserGoBack: () => ipcRenderer.send('nori:browser:back'),
  browserGoForward: () => ipcRenderer.send('nori:browser:forward'),
  browserReload: () => ipcRenderer.send('nori:browser:reload'),
  browserStop: () => ipcRenderer.send('nori:browser:stop'),
  browserOpenDevTools: () => ipcRenderer.send('nori:browser:devtools'),
  browserOpenExternal: () => ipcRenderer.invoke('nori:browser:open-external'),
  browserSetAnnotationMode: (enabled: boolean) => ipcRenderer.invoke('nori:browser:annotation-mode', enabled),
  browserClearAnnotations: () => ipcRenderer.invoke('nori:browser:clear-annotations'),
  browserUpdateAnnotation: (id: string, note: string) => ipcRenderer.invoke('nori:browser:update-annotation', id, note),
  browserSetAutomationPaused: (paused: boolean) => ipcRenderer.invoke('nori:browser:set-automation-paused', paused),
  browserChooseUploadFiles: () => ipcRenderer.invoke('nori:browser:choose-upload'),
  browserResolvePermission: (id: string, decision: string) => ipcRenderer.invoke('nori:browser:resolve-permission', id, decision),
  browserResolveDialog: (id: string, accept: boolean, promptText?: string) => ipcRenderer.invoke('nori:browser:resolve-dialog', id, accept, promptText),
  browserOpenDownload: (id: string) => ipcRenderer.invoke('nori:browser:open-download', id),
  browserClearNetwork: (tabId?: string) => ipcRenderer.invoke('nori:browser:clear-network', tabId),
  ...(process.env['NORI_BROWSER_SMOKE'] === '1'
    ? { browserExecuteActionForSmoke: (request: Record<string, unknown>) => ipcRenderer.invoke('nori:browser:execute-action-smoke', request) }
    : {}),
  browserSetVisible: (visible: boolean) => ipcRenderer.invoke('nori:browser:set-visible', visible),
  browserResize: (bounds: { x: number; y: number; width: number; height: number }) => ipcRenderer.send('nori:browser:resize', bounds),
  onBrowserState: (callback: (state: Record<string, unknown>) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: Record<string, unknown>) => callback(state);
    ipcRenderer.on('nori:browser:state', handler);
    return () => {
      ipcRenderer.removeListener('nori:browser:state', handler);
    };
  },
  fsReadDir: (dirPath: string) => ipcRenderer.invoke('nori:fs:readDir', dirPath),
  fsReadFile: (filePath: string) => ipcRenderer.invoke('nori:fs:readFile', filePath),
  fsReveal: (input: { path: string; isDirectory: boolean }) => ipcRenderer.invoke('nori:fs:reveal', input),
  openInspectorWindow: (input: { tab: string; sessionId?: string; path?: string }) => ipcRenderer.invoke('nori:openInspectorWindow', input),
});
