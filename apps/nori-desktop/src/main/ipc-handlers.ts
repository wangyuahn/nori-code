import { BrowserWindow, dialog, ipcMain } from 'electron';
import { writeFile } from 'node:fs/promises';
import { readServerToken } from './ensure-server';
import { readDir, readTextFile } from './filesystem';

export function registerIpcHandlers(): void {
  ipcMain.handle('nori:getServerToken', () => readServerToken());

  ipcMain.handle('nori:selectProjectDirectory', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = owner
      ? await dialog.showOpenDialog(owner, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? undefined : result.filePaths[0];
  });

  ipcMain.handle('nori:saveMarkdown', async (event, input: { suggestedName?: string; content?: string }) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const suggestedName = typeof input?.suggestedName === 'string' && input.suggestedName.trim()
      ? input.suggestedName.trim()
      : 'nori-session.md';
    const content = typeof input?.content === 'string' ? input.content : '';
    const options = {
      defaultPath: suggestedName,
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
    };
    const result = owner
      ? await dialog.showSaveDialog(owner, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return undefined;
    await writeFile(result.filePath, content, 'utf8');
    return result.filePath;
  });

  ipcMain.handle('nori:fs:readDir', (_event, dirPath: string) => readDir(dirPath));
  ipcMain.handle('nori:fs:readFile', (_event, filePath: string) => readTextFile(filePath));
}
