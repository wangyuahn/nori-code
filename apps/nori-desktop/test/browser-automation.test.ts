import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { captureScreenshot, unavailablePageResult } from '../src/main/browser-automation';
import { restoreBrowserAutomationFocus } from '../src/main/browser-focus';

describe('browser automation page availability', () => {
  it('fails page actions immediately when no page is open', () => {
    expect(unavailablePageResult({ action: 'snapshot' }, undefined)).toEqual({
      ok: false,
      output: 'No browser page is open. Use the Browser navigate action before snapshot.',
    });
    expect(unavailablePageResult({ action: 'click', ref: 'e1' }, 'about:blank')).toEqual({
      ok: false,
      output: 'No browser page is open. Use the Browser navigate action before click.',
    });
  });

  it('allows navigation and global browser state actions without a page', () => {
    expect(unavailablePageResult({ action: 'navigate', url: 'https://example.com' }, undefined)).toBeUndefined();
    expect(unavailablePageResult({ action: 'download_list' }, undefined)).toBeUndefined();
    expect(unavailablePageResult({ action: 'permission_list' }, undefined)).toBeUndefined();
  });

  it('allows page actions after a real page is open', () => {
    expect(unavailablePageResult({ action: 'snapshot' }, 'https://example.com/')).toBeUndefined();
    expect(unavailablePageResult({ action: 'snapshot' }, 'file:///C:/workspace/index.html')).toBeUndefined();
  });
});

describe('browser screenshot capture', () => {
  it('rejects an empty 0x0 NativeImage before encoding it', async () => {
    const webContents = screenshotWebContents({
      getSize: () => ({ width: 0, height: 0 }),
      isEmpty: () => true,
      toDataURL: vi.fn(),
    });

    const result = await captureScreenshot(webContents);

    expect(result).toEqual({
      ok: false,
      output: expect.stringContaining('page capture was empty (0x0)'),
    });
  });

  it('rejects an empty screenshot data URL', async () => {
    const webContents = screenshotWebContents({
      getSize: () => ({ width: 800, height: 600 }),
      isEmpty: () => false,
      toDataURL: () => 'data:image/png;base64,',
    });

    const result = await captureScreenshot(webContents);

    expect(result).toEqual({
      ok: false,
      output: expect.stringContaining('Electron returned empty or invalid image data'),
    });
  });

  it('returns a non-empty screenshot with page metadata', async () => {
    const webContents = screenshotWebContents({
      getSize: () => ({ width: 800, height: 600 }),
      isEmpty: () => false,
      toDataURL: () => 'data:image/png;base64,iVBORw0KGgo=',
    });

    await expect(captureScreenshot(webContents)).resolves.toEqual({
      ok: true,
      output: 'Screenshot captured at 800x600.',
      url: 'https://example.com/',
      title: 'Example',
      screenshotDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    });
  });
});

describe('browser automation focus', () => {
  it('restores the previous surface only when the automated browser page stole focus', () => {
    const previous = focusTarget(1);
    const browserPage = focusTarget(2);

    restoreBrowserAutomationFocus(previous, browserPage, browserPage);

    expect(previous.focus).toHaveBeenCalledOnce();
  });

  it('does not override a focus change made by the user during an action', () => {
    const previous = focusTarget(1);
    const browserPage = focusTarget(2);
    const userTarget = focusTarget(3);

    restoreBrowserAutomationFocus(previous, userTarget, browserPage);

    expect(previous.focus).not.toHaveBeenCalled();
  });
});

function focusTarget(id: number) {
  return {
    id,
    isDestroyed: () => false,
    focus: vi.fn(),
  };
}

function screenshotWebContents(image: {
  readonly getSize: () => { readonly width: number; readonly height: number };
  readonly isEmpty: () => boolean;
  readonly toDataURL: () => string;
}): WebContents {
  return {
    capturePage: vi.fn().mockResolvedValue(image),
    getURL: () => 'https://example.com/',
    getTitle: () => 'Example',
  } as unknown as WebContents;
}
