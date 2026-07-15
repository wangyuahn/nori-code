import { WebContentsView, BrowserWindow, ipcMain, session } from 'electron';

export class BrowserViewManager {
  private view: WebContentsView | null = null;
  private window: BrowserWindow;
  private _visible = false;

  constructor(window: BrowserWindow) {
    this.window = window;
  }

  create(): void {
    const partition = 'persist:nori-browser';
    const ses = session.fromPartition(partition);
    this.view = new WebContentsView({ webPreferences: { session: ses, sandbox: true } });
    this.view.setVisible(false);

    const wc = this.view.webContents;

    wc.on('page-title-updated', (_event, title) => {
      this.emitState({ title });
    });

    wc.on('did-navigate', () => {
      this.emitState({
        url: wc.getURL(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
      });
    });

    wc.on('did-navigate-in-page', () => {
      this.emitState({
        url: wc.getURL(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
      });
    });

    wc.on('did-start-loading', () => {
      this.emitState({ loading: true });
    });

    wc.on('did-stop-loading', () => {
      this.emitState({ loading: false });
    });
  }

  private emitState(partial: Partial<Record<string, unknown>> = {}): void {
    if (!this.view || this.window.isDestroyed()) return;
    const wc = this.view.webContents;
    const state = {
      url: wc.getURL(),
      title: wc.getTitle(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      loading: wc.isLoading(),
      ...partial,
    };
    this.window.webContents.send('nori:browser:state', state);
  }

  navigate(url: string): void {
    if (this.view) {
      this.view.webContents.loadURL(url);
    }
  }

  goBack(): void {
    if (this.view && this.view.webContents.navigationHistory.canGoBack()) {
      this.view.webContents.navigationHistory.goBack();
    }
  }

  goForward(): void {
    if (this.view && this.view.webContents.navigationHistory.canGoForward()) {
      this.view.webContents.navigationHistory.goForward();
    }
  }

  reload(): void {
    this.view?.webContents.reload();
  }

  stop(): void {
    this.view?.webContents.stop();
  }

  openDevTools(): void {
    if (this.view) {
      this.view.webContents.openDevTools();
    }
  }

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.view?.setBounds(bounds);
  }

  show(): void {
    if (this.view && !this._visible) {
      this.window.contentView.addChildView(this.view);
      this.view.setVisible(true);
      this._visible = true;
    }
  }

  hide(): void {
    if (this.view && this._visible) {
      this.view.setVisible(false);
      this.window.contentView.removeChildView(this.view);
      this._visible = false;
    }
  }

  destroy(): void {
    if (this.view) {
      this.hide();
      this.view.webContents.close();
      this.view = null;
    }
  }
}

export function registerBrowserIpc(manager: BrowserViewManager): void {
  ipcMain.handle('nori:browser:navigate', (_event, url: string) => {
    if (!url) return;
    manager.navigate(url);
  });

  ipcMain.on('nori:browser:back', () => manager.goBack());
  ipcMain.on('nori:browser:forward', () => manager.goForward());
  ipcMain.on('nori:browser:reload', () => manager.reload());
  ipcMain.on('nori:browser:devtools', () => manager.openDevTools());
  ipcMain.on('nori:browser:show', () => manager.show());
  ipcMain.on('nori:browser:hide', () => manager.hide());
  ipcMain.on('nori:browser:resize', (_event, bounds: { x: number; y: number; width: number; height: number }) => {
    manager.setBounds(bounds);
  });
}
