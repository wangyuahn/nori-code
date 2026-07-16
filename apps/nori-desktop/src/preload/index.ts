import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('noriDesktop', {
  getServerToken: () => ipcRenderer.invoke('nori:getServerToken') as Promise<string | undefined>,
  selectProjectDirectory: () => ipcRenderer.invoke('nori:selectProjectDirectory') as Promise<string | undefined>,
  saveMarkdown: (input: { suggestedName: string; content: string }) => ipcRenderer.invoke('nori:saveMarkdown', input) as Promise<string | undefined>,
  onToggleMode: (callback: (mode: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, mode: string) => callback(mode);
    ipcRenderer.on('nori:toggleMode', handler);
    return () => ipcRenderer.removeListener('nori:toggleMode', handler);
  },
  browserNavigate: (url: string) => ipcRenderer.invoke('nori:browser:navigate', url),
  browserGoBack: () => ipcRenderer.send('nori:browser:back'),
  browserGoForward: () => ipcRenderer.send('nori:browser:forward'),
  browserReload: () => ipcRenderer.send('nori:browser:reload'),
  browserOpenDevTools: () => ipcRenderer.send('nori:browser:devtools'),
  browserSetVisible: (visible: boolean) => {
    ipcRenderer.send(visible ? 'nori:browser:show' : 'nori:browser:hide');
  },
  onBrowserState: (callback: (state: Record<string, unknown>) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: Record<string, unknown>) => callback(state);
    ipcRenderer.on('nori:browser:state', handler);
    return () => {
      ipcRenderer.removeListener('nori:browser:state', handler);
    };
  },
  fsReadDir: (dirPath: string) => ipcRenderer.invoke('nori:fs:readDir', dirPath),
  fsReadFile: (filePath: string) => ipcRenderer.invoke('nori:fs:readFile', filePath),
  openInspectorWindow: (input: { tab: string; sessionId?: string; path?: string }) => ipcRenderer.invoke('nori:openInspectorWindow', input),
});
