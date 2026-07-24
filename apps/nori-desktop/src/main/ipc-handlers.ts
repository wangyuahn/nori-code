import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { readServerToken } from './ensure-server';
import { readDir, readTextFile } from './filesystem';

export function registerIpcHandlers(): void {
  ipcMain.handle('nori:getServerToken', () => readServerToken());

  ipcMain.on('nori:window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.handle('nori:window:toggle-maximize', (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (owner === null) return false;
    if (owner.isMaximized()) owner.unmaximize();
    else owner.maximize();
    return owner.isMaximized();
  });
  ipcMain.handle('nori:window:is-maximized', (event) =>
    BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false,
  );
  ipcMain.on('nori:window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

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
  ipcMain.handle('nori:fs:reveal', async (_event, input: { path?: string; isDirectory?: boolean }) => {
    const targetPath = typeof input?.path === 'string' ? input.path.trim() : '';
    if (targetPath.length === 0 || !isAbsolute(targetPath)) {
      throw new Error('A non-empty absolute path is required.');
    }
    if (input.isDirectory === true) {
      const error = await shell.openPath(targetPath);
      if (error.length > 0) throw new Error(error);
      return;
    }
    shell.showItemInFolder(targetPath);
  });
  ipcMain.handle('nori:openInspectorWindow', (event, input: { tab?: string; sessionId?: string; path?: string }) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const url = new URL(event.sender.getURL());
    const params = new URLSearchParams(url.hash.replace(/^#/, ''));
    params.set('inspector', input.tab ?? 'changes');
    if (input.sessionId) params.set('session', input.sessionId);
    if (input.path) params.set('path', input.path);
    url.hash = params.toString();
    const panel = new BrowserWindow({
      width: 760,
      height: 780,
      minWidth: 440,
      minHeight: 320,
      parent: owner,
      title: `Nori Work - ${input.tab ?? 'Inspector'}`,
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        sandbox: true,
        preload: join(__dirname, 'preload.cjs'),
      },
    });
    panel.setMenu(null);
    void panel.loadURL(url.href);
  });
}
