import { BrowserWindow, dialog, ipcMain } from 'electron';
import { loadNoriConfig, type NoriDesktopConfig } from './nori-config';
import { readLock, originFromLock, readServerToken } from './ensure-server';
import { updateTray, type TrayState } from './tray';
import { showNotification } from './notifications';
import { readDir, readTextFile, type FsEntry } from './filesystem';

export function registerIpcHandlers(): void {
  let cachedConfig: NoriDesktopConfig | null = null;

  ipcMain.handle('nori:getServerToken', () => readServerToken());

  ipcMain.handle('nori:selectProjectDirectory', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = owner
      ? await dialog.showOpenDialog(owner, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? undefined : result.filePaths[0];
  });

  ipcMain.handle('nori:getConfig', () => {
    if (!cachedConfig) {
      cachedConfig = loadNoriConfig();
    }
    return cachedConfig ?? undefined;
  });

  ipcMain.handle('nori:reloadConfig', () => {
    cachedConfig = loadNoriConfig();
    return cachedConfig ?? undefined;
  });

  ipcMain.handle('nori:getPhase', async () => {
    const lock = readLock();
    if (!lock) {
      return { phase: 'idle', step: 0 };
    }
    const origin = originFromLock(lock);
    try {
      const res = await fetch(`${origin}/api/v1/phase/status`);
      if (!res.ok) {
        return { phase: 'idle', step: 0 };
      }
      const body = (await res.json()) as {
        code: number;
        data: { phase?: string; step?: number };
      };
      if (body.code !== 0 || !body.data) {
        return { phase: 'idle', step: 0 };
      }
      return {
        phase: body.data.phase ?? 'idle',
        step: body.data.step ?? 0,
      };
    } catch {
      return { phase: 'idle', step: 0 };
    }
  });

  ipcMain.on('nori:updateTray', (_event, state: TrayState) => {
    updateTray(state);
  });

  ipcMain.on('nori:notify', (_event, payload: { title: string; body: string }) => {
    showNotification(payload.title, payload.body);
  });

  ipcMain.on('nori:phaseChange', (_event, payload: { from: string; to: string }) => {
    showNotification(
      'Phase Changed',
      `${payload.from} → ${payload.to}`,
    );
    updateTray({ phase: payload.to, swarmActive: false });
  });

  ipcMain.on('nori:swarmUpdate', (_event, payload: { active: boolean; count?: number }) => {
    if (payload.active) {
      updateTray({ phase: 'implement', swarmActive: true });
      if (payload.count) {
        showNotification('Swarm Active', `${payload.count} sub-agents running`);
      }
    } else {
      updateTray({ phase: 'implement', swarmActive: false });
      showNotification('Swarm Complete', 'All sub-agents finished');
    }
  });

  ipcMain.on('nori:error', (_event, payload: { message: string; tool?: string }) => {
    showNotification(
      'Error',
      payload.tool ? `[${payload.tool}] ${payload.message}` : payload.message,
    );
  });

  ipcMain.handle('nori:fs:readDir', (_event, dirPath: string) => readDir(dirPath));
  ipcMain.handle('nori:fs:readFile', (_event, filePath: string) => readTextFile(filePath));
}
