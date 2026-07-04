import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('noriDesktop', {
  getConfig: () => ipcRenderer.invoke('nori:getConfig'),
  reloadConfig: () => ipcRenderer.invoke('nori:reloadConfig'),
  getPhase: () => ipcRenderer.invoke('nori:getPhase'),
  onPhaseChange: (callback: (phase: string) => void) => {
    ipcRenderer.on('nori:phaseChange', (_, phase) => callback(phase));
    return () => ipcRenderer.removeAllListeners('nori:phaseChange');
  },
  onSwarmUpdate: (callback: (data: unknown) => void) => {
    ipcRenderer.on('nori:swarmUpdate', (_, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('nori:swarmUpdate');
  },
  onError: (callback: (error: string) => void) => {
    ipcRenderer.on('nori:error', (_, error) => callback(error));
    return () => ipcRenderer.removeAllListeners('nori:error');
  }
});
