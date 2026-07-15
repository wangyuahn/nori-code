import { BrowserWindow, dialog, ipcMain } from 'electron';
import { readServerToken } from './ensure-server';
import { readDir, readTextFile, type FsEntry } from './filesystem';

export function registerIpcHandlers(): void {
  ipcMain.handle('nori:getServerToken', () => readServerToken());

  ipcMain.handle('nori:selectProjectDirectory', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = owner
      ? await dialog.showOpenDialog(owner, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? undefined : result.filePaths[0];
  });

  ipcMain.handle('nori:fs:readDir', (_event, dirPath: string) => readDir(dirPath));
  ipcMain.handle('nori:fs:readFile', (_event, filePath: string) => readTextFile(filePath));
}
