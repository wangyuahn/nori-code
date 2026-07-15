import { ipcMain, BrowserWindow } from 'electron';
import type { IPty } from 'node-pty';

// Dynamic import because node-pty is a native module
let ptyModule: typeof import('node-pty') | null = null;

interface TerminalSession {
  pty: IPty;
  cols: number;
  rows: number;
}

const sessions = new Map<string, TerminalSession>();

function spawnShell(id: string, cols: number, rows: number, cwd?: string): IPty {
  if (!ptyModule) ptyModule = require('node-pty');
  if (!ptyModule) throw new Error('Failed to load node-pty');
  const shell = process.platform === 'win32' ? 'powershell.exe' : (process.env['SHELL'] || 'bash');
  const pty = ptyModule.spawn(shell, [], {
    name: 'xterm-color',
    cols,
    rows,
    cwd: cwd || process.cwd(),
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  return pty;
}

export function registerTerminalIpc(mainWindow: BrowserWindow): void {
  ipcMain.handle('nori:terminal:create', (event, { id, cols, rows, cwd }) => {
    const pty = spawnShell(id, cols, rows, cwd);
    sessions.set(id, { pty, cols, rows });

    pty.onData((data) => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('nori:terminal:output', { id, data });
      }
    });

    pty.onExit(() => {
      sessions.delete(id);
    });

    return { ok: true };
  });

  ipcMain.handle('nori:terminal:write', (event, { id, data }) => {
    const session = sessions.get(id);
    if (session) session.pty.write(data);
    return { ok: true };
  });

  ipcMain.handle('nori:terminal:resize', (event, { id, cols, rows }) => {
    const session = sessions.get(id);
    if (session) {
      session.cols = cols;
      session.rows = rows;
      session.pty.resize(cols, rows);
    }
    return { ok: true };
  });

  ipcMain.handle('nori:terminal:destroy', (event, { id }) => {
    const session = sessions.get(id);
    if (session) {
      session.pty.kill();
      sessions.delete(id);
    }
    return { ok: true };
  });
}
