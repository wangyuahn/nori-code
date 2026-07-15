import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('noriDesktop', {
  getConfig: () => ipcRenderer.invoke('nori:getConfig'),
  reloadConfig: () => ipcRenderer.invoke('nori:reloadConfig'),
  getPhase: () => ipcRenderer.invoke('nori:getPhase'),
  getServerToken: () => ipcRenderer.invoke('nori:getServerToken') as Promise<string | undefined>,
  selectProjectDirectory: () => ipcRenderer.invoke('nori:selectProjectDirectory') as Promise<string | undefined>,
  onToggleMode: (callback: (mode: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, mode: string) => callback(mode);
    ipcRenderer.on('nori:toggleMode', handler);
    return () => ipcRenderer.removeListener('nori:toggleMode', handler);
  },
  onPhaseChange: (callback: (phase: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, phase: string) => callback(phase);
    ipcRenderer.on('nori:phaseChange', handler);
    return () => ipcRenderer.removeListener('nori:phaseChange', handler);
  },
  onSwarmUpdate: (callback: (data: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on('nori:swarmUpdate', handler);
    return () => ipcRenderer.removeListener('nori:swarmUpdate', handler);
  },
  onError: (callback: (error: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, error: string) => callback(error);
    ipcRenderer.on('nori:error', handler);
    return () => ipcRenderer.removeListener('nori:error', handler);
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
  terminalCreate: (opts: {id: string, cols: number, rows: number, cwd?: string}) => ipcRenderer.invoke('nori:terminal:create', opts),
  terminalWrite: (opts: {id: string, data: string}) => ipcRenderer.invoke('nori:terminal:write', opts),
  terminalResize: (opts: {id: string, cols: number, rows: number}) => ipcRenderer.invoke('nori:terminal:resize', opts),
  terminalDestroy: (opts: {id: string}) => ipcRenderer.invoke('nori:terminal:destroy', opts),
  onTerminalOutput: (callback: (data: {id: string, data: string}) => void) => {
    const handler = (_e: any, payload: {id: string, data: string}) => callback(payload);
    ipcRenderer.on('nori:terminal:output', handler);
    return () => ipcRenderer.removeListener('nori:terminal:output', handler);
  },
});
