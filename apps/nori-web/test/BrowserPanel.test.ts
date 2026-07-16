import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrowserPanel } from '../src/components/BrowserPanel';
import { I18nProvider } from '../src/i18n';
import type { NoriBrowserState, NoriDesktopAPI } from '../src/types/nori-desktop';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class TestResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) { this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver); }
  disconnect() {}
  unobserve() {}
}

afterEach(() => {
  vi.restoreAllMocks();
  delete window.noriDesktop;
});

describe('BrowserPanel', () => {
  it('renders the desktop-only state without exposing dead controls in web mode', async () => {
    const { container, root } = renderBrowser();
    try {
      await act(async () => Promise.resolve());
      expect(container.textContent).toContain('Built-in browser requires Nori Work');
      expect(container.querySelector<HTMLButtonElement>('.browser-new-tab')?.disabled).toBe(true);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('connects tabs, navigation, visibility, and native viewport bounds', async () => {
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 240, y: 120, left: 240, top: 120, right: 840, bottom: 620,
      width: 600, height: 500, toJSON: () => ({}),
    });
    const state: NoriBrowserState = {
      activeTabId: 'tab-1',
      visible: true,
      tabs: [{ id: 'tab-1', url: 'about:blank', title: 'New tab', canGoBack: false, canGoForward: false, loading: false }],
    };
    let listener: ((next: NoriBrowserState) => void) | undefined;
    const desktop: NoriDesktopAPI = {
      browserGetState: vi.fn(async () => state),
      browserSetVisible: vi.fn(async visible => ({ ...state, visible })),
      browserResize: vi.fn(),
      browserNavigate: vi.fn(async url => ({ ...state, tabs: [{ ...state.tabs[0], url }] })),
      browserNewTab: vi.fn(async () => state),
      browserCloseTab: vi.fn(async () => state),
      browserActivateTab: vi.fn(async () => state),
      onBrowserState: callback => { listener = callback; return () => { listener = undefined; }; },
    };
    window.noriDesktop = desktop;

    const { container, root } = renderBrowser();
    try {
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
      expect(desktop.browserSetVisible).toHaveBeenCalledWith(true);
      expect(desktop.browserResize).toHaveBeenCalledWith({ x: 240, y: 120, width: 600, height: 500 });

      await act(async () => container.querySelector<HTMLButtonElement>('.browser-new-tab')?.click());
      expect(desktop.browserNewTab).toHaveBeenCalledTimes(1);

      const github = [...container.querySelectorAll<HTMLButtonElement>('.browser-start-links button')]
        .find(button => button.textContent === 'GitHub');
      await act(async () => github?.click());
      expect(desktop.browserNavigate).toHaveBeenCalledWith('https://github.com');

      act(() => listener?.({ ...state, tabs: [{ ...state.tabs[0], title: 'Updated title' }] }));
      expect(container.textContent).toContain('Updated title');
    } finally {
      await act(async () => {
        root.unmount();
      });
      expect(desktop.browserSetVisible).toHaveBeenLastCalledWith(false);
      container.remove();
    }
  });

  it('forwards permission, dialog, download, and network controls to the desktop bridge', async () => {
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    const state: NoriBrowserState = {
      activeTabId: 'tab-1',
      visible: true,
      tabs: [{
        id: 'tab-1',
        url: 'https://example.com',
        title: 'Example',
        canGoBack: false,
        canGoForward: false,
        loading: false,
        annotationMode: false,
        annotations: [],
        network: [{
          id: 'request-1',
          method: 'GET',
          url: 'https://example.com/api',
          resourceType: 'Fetch',
          startedAt: new Date(0).toISOString(),
          status: 200,
          durationMs: 20,
          state: 'completed',
        }],
      }],
      automation: { paused: false, active: null, history: [] },
      downloads: [{
        id: 'download-1', tabId: 'tab-1', filename: 'report.txt', url: 'https://example.com/report.txt',
        savePath: 'C:\\Downloads\\report.txt', createdAt: new Date(0).toISOString(), state: 'completed',
        receivedBytes: 12, totalBytes: 12, speed: 0,
      }],
      permissions: {
        pending: [{ id: 'permission-1', tabId: 'tab-1', permission: 'geolocation', origin: 'https://example.com', createdAt: new Date(0).toISOString() }],
        rules: [],
      },
      dialogs: [{ id: 'dialog-1', tabId: 'tab-1', type: 'prompt', message: 'Name?', defaultPrompt: 'Nori', url: 'https://example.com', createdAt: new Date(0).toISOString() }],
    };
    const desktop: NoriDesktopAPI = {
      browserGetState: vi.fn(async () => state),
      browserSetVisible: vi.fn(async visible => ({ ...state, visible })),
      browserResize: vi.fn(),
      browserResolvePermission: vi.fn(async () => state),
      browserResolveDialog: vi.fn(async () => state),
      browserOpenDownload: vi.fn(async () => undefined),
      browserClearNetwork: vi.fn(async () => state),
      onBrowserState: () => () => undefined,
    };
    window.noriDesktop = desktop;

    const { container, root } = renderBrowser();
    try {
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      const alwaysDeny = [...container.querySelectorAll<HTMLButtonElement>('.browser-native-prompt.permission button')]
        .find(button => button.textContent === 'Always deny');
      await act(async () => alwaysDeny?.click());
      expect(desktop.browserResolvePermission).toHaveBeenCalledWith('permission-1', 'deny_always');

      const prompt = container.querySelector<HTMLInputElement>('.browser-native-prompt.dialog input');
      if (prompt !== null) {
        await act(async () => {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          setter?.call(prompt, 'Workbench');
          prompt.dispatchEvent(new Event('input', { bubbles: true }));
        });
      }
      const accept = [...container.querySelectorAll<HTMLButtonElement>('.browser-native-prompt.dialog button')]
        .find(button => button.textContent === 'OK');
      await act(async () => accept?.click());
      expect(desktop.browserResolveDialog).toHaveBeenCalledWith('dialog-1', true, 'Workbench');

      await act(async () => container.querySelector<HTMLButtonElement>('.browser-status-menu:not(.network) button')?.click());
      expect(desktop.browserOpenDownload).toHaveBeenCalledWith('download-1');

      await act(async () => container.querySelector<HTMLButtonElement>('.browser-status-clear')?.click());
      expect(desktop.browserClearNetwork).toHaveBeenCalledWith('tab-1');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

function renderBrowser() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(I18nProvider, null, createElement(BrowserPanel)));
  });
  return { container, root };
}
