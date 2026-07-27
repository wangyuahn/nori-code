import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronState = vi.hoisted(() => ({
  nextWebContentsId: 1,
  views: [] as Array<{
    webContents: {
      id: number;
      capturePage: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    };
    setBounds: ReturnType<typeof vi.fn>;
    setVisible: ReturnType<typeof vi.fn>;
  }>,
  browserSession: {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock('electron', () => {
  class MockWebContentsView {
    readonly setBackgroundColor = vi.fn();
    readonly setBounds = vi.fn();
    readonly setVisible = vi.fn();
    readonly webContents: Record<string, unknown> & {
      id: number;
      capturePage: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    };

    constructor() {
      let url = 'about:blank';
      let destroyed = false;
      this.webContents = {
        id: electronState.nextWebContentsId++,
        capturePage: vi.fn(async () => ({ toDataURL: () => 'data:image/png;base64,cHJldmlldw==' })),
        close: vi.fn(() => { destroyed = true; }),
        getTitle: vi.fn(() => url),
        getURL: vi.fn(() => url),
        inspectElement: vi.fn(),
        isDestroyed: vi.fn(() => destroyed),
        isLoading: vi.fn(() => false),
        loadURL: vi.fn(async (nextUrl: string) => { url = nextUrl; }),
        navigationHistory: {
          canGoBack: vi.fn(() => false),
          canGoForward: vi.fn(() => false),
          goBack: vi.fn(),
          goForward: vi.fn(),
        },
        on: vi.fn(),
        openDevTools: vi.fn(),
        reload: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        stop: vi.fn(),
      };
      electronState.views.push(this);
    }
  }

  return {
    app: { getPath: vi.fn(() => 'C:\\Downloads'), isPackaged: true },
    BrowserWindow: class MockBrowserWindow {
      static fromWebContents = vi.fn(() => null);
    },
    dialog: { showOpenDialog: vi.fn() },
    ipcMain: { handle: vi.fn(), on: vi.fn() },
    Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })) },
    session: { fromPartition: vi.fn(() => electronState.browserSession) },
    shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
    webContents: { getFocusedWebContents: vi.fn(() => null) },
    WebContentsView: MockWebContentsView,
  };
});

vi.mock('../src/main/browser-debugger', () => ({
  BrowserDebuggerController: class MockBrowserDebuggerController {
    readonly dispose = vi.fn();
    readonly setFileInputFiles = vi.fn(async () => false);
    readonly start = vi.fn(async () => undefined);
  },
}));

import { BrowserViewManager } from '../src/main/browser-view';

beforeEach(() => {
  electronState.views.length = 0;
  electronState.nextWebContentsId = 1;
  vi.clearAllMocks();
});

describe('BrowserViewManager tab isolation', () => {
  it('attaches only the active page and destroys only the closed page', async () => {
    const contentView = {
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
    };
    const window = {
      contentView,
      isDestroyed: vi.fn(() => false),
      once: vi.fn(),
      webContents: { send: vi.fn() },
    };
    const manager = new BrowserViewManager(window as never);

    const firstState = manager.createTab('https://example.com/first');
    const firstTabId = firstState.activeTabId!;
    manager.setBounds({ x: 100, y: 80, width: 900, height: 600 });
    manager.setVisible(true);

    const firstView = electronState.views[0]!;
    expect(contentView.addChildView).toHaveBeenLastCalledWith(firstView);
    expect(firstView.setVisible).toHaveBeenLastCalledWith(true);

    const secondState = manager.createTab('https://example.com/second');
    const secondTabId = secondState.activeTabId!;
    const secondView = electronState.views[1]!;

    expect(secondTabId).not.toBe(firstTabId);
    expect(secondView).not.toBe(firstView);
    expect(contentView.removeChildView).toHaveBeenCalledWith(firstView);
    expect(contentView.addChildView).toHaveBeenLastCalledWith(secondView);
    expect(secondView.setVisible).toHaveBeenLastCalledWith(true);

    manager.activateTab(firstTabId);

    expect(contentView.removeChildView).toHaveBeenCalledWith(secondView);
    expect(contentView.addChildView).toHaveBeenLastCalledWith(firstView);
    expect(firstView.setVisible).toHaveBeenLastCalledWith(true);

    manager.closeTab(firstTabId);
    await Promise.resolve();

    expect(firstView.webContents.close).toHaveBeenCalledOnce();
    expect(secondView.webContents.close).not.toHaveBeenCalled();
    expect(manager.getState().activeTabId).toBe(secondTabId);
    expect(contentView.addChildView).toHaveBeenLastCalledWith(secondView);

    manager.setVisible(false);

    expect(contentView.removeChildView).toHaveBeenLastCalledWith(secondView);
    expect(secondView.setVisible).toHaveBeenLastCalledWith(false);
  });

  it('keeps the full browser bounds while a renderer menu overlays a captured preview', async () => {
    const contentView = {
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
    };
    const window = {
      contentView,
      isDestroyed: vi.fn(() => false),
      once: vi.fn(),
      webContents: { send: vi.fn() },
    };
    const manager = new BrowserViewManager(window as never);
    const bounds = { x: 100, y: 80, width: 900, height: 600 };

    manager.createTab('https://example.com/full-page');
    manager.setBounds(bounds);
    manager.setVisible(true);
    const view = electronState.views[0]!;

    const occluded = await manager.setOccluded(true);

    expect(view.webContents.capturePage).toHaveBeenCalledOnce();
    expect(occluded).toEqual({ occluded: true, previewDataUrl: 'data:image/png;base64,cHJldmlldw==' });
    expect(contentView.removeChildView).toHaveBeenLastCalledWith(view);
    expect(view.setBounds).toHaveBeenLastCalledWith(bounds);

    const restored = await manager.setOccluded(false);

    expect(restored).toEqual({ occluded: false, previewDataUrl: null });
    expect(contentView.addChildView).toHaveBeenLastCalledWith(view);
    expect(view.setBounds).toHaveBeenLastCalledWith(bounds);
    expect(view.setVisible).toHaveBeenLastCalledWith(true);
  });
});
