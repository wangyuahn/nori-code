import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { app, BrowserWindow, globalShortcut, Menu, screen, session, shell } from 'electron';

import { ensureServer, serverLogPath } from './ensure-server';
import { registerIpcHandlers } from './ipc-handlers';
import { registerUpdateHandlers } from './updater';
import { resolveSeaPath } from './sea-path';
import { createTray } from './tray';
import { BrowserViewManager, registerBrowserIpc } from './browser-view';
import { createSplashWindow } from './splash';
import {
  configureNoriApplicationIdentity,
  NORI_PRODUCT_NAME,
  NORI_PROTOCOL,
  noriRuntimeIconPath,
} from './brand';

configureNoriApplicationIdentity();

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let browserManager: BrowserViewManager | null = null;

// --- window state persistence -------------------------------------------------

interface WindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

const DEFAULT_BOUNDS: WindowBounds = { width: 1280, height: 860 };

function stateFile(): string {
  return join(app.getPath('userData'), 'window-state.json');
}

function loadBounds(): WindowBounds {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), 'utf-8')) as Partial<WindowBounds>;
    if (typeof parsed.width !== 'number' || typeof parsed.height !== 'number') {
      return DEFAULT_BOUNDS;
    }

    let width = parsed.width;
    let height = parsed.height;
    let x = typeof parsed.x === 'number' ? parsed.x : undefined;
    let y = typeof parsed.y === 'number' ? parsed.y : undefined;

    const displays = screen.getAllDisplays();
    const primaryDisplay = screen.getPrimaryDisplay();

    let display = primaryDisplay;
    if (x !== undefined && y !== undefined) {
      const cx = x;
      const cy = y;
      const onADisplay = displays.some((d) => {
        const { x: dx, y: dy, width: dw, height: dh } = d.workArea;
        return cx >= dx && cx < dx + dw && cy >= dy && cy < dy + dh;
      });
      if (onADisplay) {
        display = screen.getDisplayNearestPoint({ x: cx, y: cy });
      } else {
        x = undefined;
        y = undefined;
      }
    }

    width = Math.min(width, display.workArea.width);
    height = Math.min(height, display.workArea.height);

    return { width, height, x, y };
  } catch {
    // No saved state yet, or it is unreadable - fall back to defaults.
  }
  return DEFAULT_BOUNDS;
}

function saveBounds(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  try {
    const bounds = win.getBounds();
    mkdirSync(dirname(stateFile()), { recursive: true });
    writeFileSync(
      stateFile(),
      JSON.stringify({ width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y }),
    );
  } catch {
    // Best-effort; losing window position is not worth surfacing an error.
  }
}

// --- startup screens (no separate renderer files; inline data URLs) -----------

function dataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

const SCREEN_STYLE = `
  <style>
    html, body { height: 100%; margin: 0; }
    body {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 18px; background: #0b0b0c; color: #e7e7ea; font: 14px/1.5 system-ui, sans-serif;
      -webkit-user-select: none; user-select: none; text-align: center; padding: 0 32px;
    }
    .spinner {
      width: 34px; height: 34px; border-radius: 50%;
      border: 3px solid #2a2a2e; border-top-color: #7c8cff; animation: spin 0.9s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    h1 { font-size: 15px; font-weight: 600; margin: 0; }
    p { margin: 0; color: #9a9aa2; max-width: 560px; }
    code { color: #c8c8d0; word-break: break-all; }
  </style>
`;

function usesChineseUi(): boolean {
  return app.getLocale().toLowerCase().startsWith('zh');
}

function loadingHtml(): string {
  const status = usesChineseUi() ? '正在启动 Nori 本地服务...' : 'Starting the local Nori service...';
  return `<!doctype html><meta charset="utf-8">${SCREEN_STYLE}
    <div class="spinner"></div>
    <h1>Nori Work</h1>
    <p>${status}</p>`;
}

function errorHtml(message: string): string {
  const safe = message.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const title = usesChineseUi() ? '无法启动本地服务' : 'Unable to start the local service';
  const logLabel = usesChineseUi() ? '服务日志' : 'Service log';
  const help = usesChineseUi()
    ? '请重启 Nori Work，或先检查服务日志。'
    : 'Restart Nori Work, or inspect the service log first.';
  return `<!doctype html><meta charset="utf-8">${SCREEN_STYLE}
    <h1>${title}</h1>
    <p>${safe}</p>
    <p>${logLabel}: <code>${serverLogPath()}</code></p>
    <p>${help}</p>`;
}

// --- connect flow -------------------------------------------------------------

async function connect(win: BrowserWindow): Promise<void> {
  await win.loadURL(dataUrl(loadingHtml()));
  try {
    const { origin } = await ensureServer(resolveSeaPath());
    process.stdout.write(`[nori-desktop] connected to ${origin}\n`);
    if (!win.isDestroyed()) {
      // Resolve nori-web dist path (packaged vs dev)
      const noriWebDist = app.isPackaged
        ? join(process.resourcesPath, 'nori-web', 'dist', 'index.html')
        : join(app.getAppPath(), '..', 'nori-web', 'dist', 'index.html');

      // Pass only the server origin via hash fragment; the token is fetched
      // securely through the preload bridge instead of the URL.
      const hash = new URLSearchParams({ server: origin }).toString();

      process.stdout.write(`[nori-desktop] loading nori-web from ${noriWebDist}\n`);
      await win.loadFile(noriWebDist, { hash });
      splashWindow?.close();
      splashWindow = null;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[nori-desktop] ensureServer failed: ${message}\n`);
    splashWindow?.close();
    splashWindow = null;
    if (!win.isDestroyed()) {
      await win.loadURL(dataUrl(errorHtml(message)));
    }
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    ...loadBounds(),
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#111111',
    autoHideMenuBar: true,
    title: NORI_PRODUCT_NAME,
    icon: noriRuntimeIconPath(),
    // macOS: hide the native title bar and float the traffic lights over the
    // content; the web UI reserves a draggable strip at the top to clear them.
    // 'default' on other platforms (they keep their native title bar).
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      sandbox: true,
      preload: join(__dirname, 'preload.cjs'),
    },
  });
  win.setMenu(null);
  win.setMenuBarVisibility(false);
  mainWindow = win;
  browserManager = new BrowserViewManager(win);
  // Note: create() is NOT called here - lazy init; the renderer triggers it.
  createTray(win);
  // Keep the window title as the product name. The web page sets document.title
  // ("Nori Code Web"), which would otherwise replace it.
  win.webContents.on('page-title-updated', (event) => {
    event.preventDefault();
  });
  // Block unexpected external navigation and open http(s) links in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      void shell.openExternal(url).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[nori-desktop] failed to open external url: ${message}\n`);
      });
    }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const currentUrl = win.webContents.getURL();
    if (url !== currentUrl) {
      event.preventDefault();
      if (url.startsWith('http:') || url.startsWith('https:')) {
        void shell.openExternal(url).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`[nori-desktop] failed to open external url: ${message}\n`);
        });
      }
    }
  });
  win.on('close', () => {
    saveBounds(win);
  });
  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });
  void connect(win);
}

// --- protocol + single-instance helpers --------------------------------------

function focusMainWindow(): void {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  }
}

function parseProtocolUrl(args: string[]): string | undefined {
  return args.find((arg) => arg.startsWith(`${NORI_PROTOCOL}://`));
}

function logProtocolUrl(url: string): void {
  process.stdout.write(`[nori-desktop] protocol url: ${url}\n`);
}

// --- app lifecycle ------------------------------------------------------------

function main(): void {
  // Register only Nori Work's own protocol; do not share another product identity.
  const protocolRegistered = app.setAsDefaultProtocolClient(NORI_PROTOCOL);
  if (!protocolRegistered) {
    process.stderr.write('[nori-desktop] failed to register nori-work:// protocol handler\n');
  }

  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) {
    app.quit();
    return;
  }

  // The shared daemon is deliberately left running on quit - it self-exits ~60s
  // after the last client disconnects, so we never tear down a server another
  // client (CLI / browser / TUI) may still be using.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });

  app.on('second-instance', (_event, argv) => {
    const url = parseProtocolUrl(argv);
    if (url) {
      logProtocolUrl(url);
    }
    focusMainWindow();
  });

  app.on('open-url', (_event, url) => {
    if (url.startsWith(`${NORI_PROTOCOL}://`)) {
      logProtocolUrl(url);
    }
    focusMainWindow();
  });

  app.on('open-file', (_event, path) => {
    if (path.startsWith(`${NORI_PROTOCOL}://`)) {
      logProtocolUrl(path);
    }
    focusMainWindow();
  });

  void app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    registerIpcHandlers();
    registerUpdateHandlers();
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false);
    });

    splashWindow = createSplashWindow();
    createWindow();

    // Register browser IPC after createWindow() so browserManager is set.
    if (browserManager) {
      registerBrowserIpc(browserManager);
    }

    const showOrHideRegistered = globalShortcut.register('CmdOrCtrl+Shift+N', () => {
      if (mainWindow === null) {
        createWindow();
        return;
      }
      if (mainWindow.isMinimized() || !mainWindow.isVisible()) {
        mainWindow.show();
        mainWindow.focus();
      } else {
        mainWindow.hide();
      }
    });
    if (!showOrHideRegistered) {
      process.stderr.write('[nori-desktop] failed to register CmdOrCtrl+Shift+N shortcut\n');
    }

    const toggleModeRegistered = globalShortcut.register('CmdOrCtrl+Shift+W', () => {
      if (mainWindow !== null && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('nori:toggleMode', 'toggle');
      }
    });
    if (!toggleModeRegistered) {
      process.stderr.write('[nori-desktop] failed to register CmdOrCtrl+Shift+W shortcut\n');
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

main();
