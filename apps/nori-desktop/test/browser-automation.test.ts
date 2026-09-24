import { createContext, runInContext } from 'node:vm';
import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import {
  SNAPSHOT_SCRIPT,
  captureScreenshot,
  historyMoveOutcome,
  parseKeypress,
  pressKey,
  settleFinishedRequests,
  snapshotHasContent,
  snapshotPage,
  typePage,
  typeTargetRejection,
  unavailablePageResult,
  waitForRenderedContent,
} from '../src/main/browser-automation';
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

describe('browser keypress validation', () => {
  it('accepts named keys and modifiers', () => {
    expect(parseKeypress('Enter')).toEqual({ keyCode: 'Enter', modifiers: [] });
    expect(parseKeypress('ArrowDown')).toEqual({ keyCode: 'Down', modifiers: [] });
    expect(parseKeypress('Control+L')).toEqual({ keyCode: 'L', modifiers: ['control'] });
  });

  it('rejects an unknown key before any input is sent', () => {
    expect(parseKeypress('NotARealKey')).toEqual({
      error: expect.stringContaining('Unknown key "NotARealKey"'),
    });
  });
});

describe('browser typing targets', () => {
  it('allows text fields and rejects links or buttons', () => {
    expect(typeTargetRejection('input', 'text', false)).toBeUndefined();
    expect(typeTargetRejection('textarea', undefined, false)).toBeUndefined();
    expect(typeTargetRejection('div', undefined, true)).toBeUndefined();
    expect(typeTargetRejection('a', undefined, false)).toEqual(expect.stringContaining('not a text field'));
    expect(typeTargetRejection('input', 'submit', false)).toEqual(expect.stringContaining('not a text field'));
  });
});

describe('browser network settlement', () => {
  it('does not leave a finished response pending after the page is idle', () => {
    const now = Date.parse('2026-09-24T00:00:02.000Z');
    const entries = [
      { state: 'pending' as const, status: 200, startedAt: '2026-09-24T00:00:00.000Z' },
      { state: 'pending' as const, startedAt: '2026-09-24T00:00:01.800Z' },
    ];
    settleFinishedRequests(entries, now);
    expect(entries[0]?.state).toBe('completed');
    expect(entries[1]?.state).toBe('pending');
  });
});

describe('browser snapshot content', () => {
  it('treats page text and svg text refs as content', () => {
    expect(snapshotHasContent('<browser_snapshot>\nURL: https://example.com/\n</browser_snapshot>')).toBe(false);
    expect(snapshotHasContent('<browser_snapshot>\nText: Pelican on a bicycle\n</browser_snapshot>')).toBe(true);
    expect(snapshotHasContent('<browser_snapshot>\n<text ref=n1> Ride\n</browser_snapshot>')).toBe(true);
  });

  it('collects svg text and body text from a fake page', async () => {
    const visible = runSnapshotScript({ width: 800, height: 600, rect: 40 });
    expect(visible.pageText).toContain('Pelican rides a bicycle');
    expect(visible.pageText).toContain('Example Domain');
    expect(visible.elements.some(element => element.tag === 'text' && element.text.includes('Pelican'))).toBe(true);

    const hidden = runSnapshotScript({ width: 0, height: 0, rect: 0 });
    expect(hidden.elements).toEqual([]);
    expect(hidden.pageText).toContain('Pelican rides a bicycle');

    const output = await snapshotPage(scriptedPage(() => hidden));
    expect(output).toContain('Text: ');
    expect(output).toContain('Pelican rides a bicycle');
    expect(snapshotHasContent(output)).toBe(true);

    const empty = await snapshotPage(scriptedPage(() => ({
      url: 'https://example.com/',
      title: 'Empty',
      pageText: '',
      viewport: { width: 0, height: 0, scrollX: 0, scrollY: 0 },
      elements: [],
    })));
    expect(snapshotHasContent(empty)).toBe(false);
  });
});

describe('browser action mocks', () => {
  it('does not send a key event for an unknown key', () => {
    const page = actionPage();
    const result = pressKey(page.webContents, 'NotARealKey');
    expect(result.ok).toBe(false);
    expect(result.output).toContain('Unknown key "NotARealKey"');
    expect(page.sendInputEvent).not.toHaveBeenCalled();
  });

  it('sends key down and key up for a real key', () => {
    const page = actionPage();
    const result = pressKey(page.webContents, 'Enter');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('Pressed Enter');
    expect(page.sendInputEvent).toHaveBeenCalledTimes(2);
  });

  it('refuses to type into a link and does not click it', async () => {
    const page = actionPage(async source => {
      expect(source).toContain('querySelector');
      return { x: 20, y: 30, tag: 'a', disabled: false, contentEditable: false };
    });
    const result = await typePage(page.webContents, 'n1', 'hello');
    expect(result.ok).toBe(false);
    expect(result.output).toContain('not a text field');
    expect(page.sendInputEvent).not.toHaveBeenCalled();
    expect(page.executeJavaScript).toHaveBeenCalledTimes(1);
  });

  it('writes an input through the value script and does not click', async () => {
    const scripts: string[] = [];
    const page = actionPage(async source => {
      scripts.push(source);
      if (scripts.length === 1) {
        return { x: 20, y: 30, tag: 'input', inputType: 'text', disabled: false, contentEditable: false };
      }
      return { ok: true, value: 'hello' };
    });
    const result = await typePage(page.webContents, 'n2', 'hello');
    expect(result.ok).toBe(true);
    expect(result.output).toBe('Typed 5 characters into n2.');
    expect(page.sendInputEvent).not.toHaveBeenCalled();
    expect(scripts[1]).toContain('hello');
    expect(scripts[1]).not.toContain('click');
  });

  it('nudges a sparse tall page once and restores the scroll position', async () => {
    const scripts: string[] = [];
    let probes = 0;
    const page = actionPage(async source => {
      scripts.push(source);
      if (source.includes('scrollBy')) return { x: 12, y: 40 };
      if (source.includes('scrollTo')) return undefined;
      probes += 1;
      return probes === 1
        ? { width: 900, height: 700, textLength: 12, scrollHeight: 5000 }
        : { width: 900, height: 700, textLength: 240, scrollHeight: 5000 };
    });
    await waitForRenderedContent(page.webContents, 1_000);
    expect(scripts.some(source => source.includes('scrollBy'))).toBe(true);
    expect(scripts.some(source => source.includes('scrollTo(12, 40)'))).toBe(true);
  });

  it('does not scroll a page that already has text', async () => {
    const scripts: string[] = [];
    const page = actionPage(async source => {
      scripts.push(source);
      return { width: 900, height: 700, textLength: 240, scrollHeight: 800 };
    });
    await waitForRenderedContent(page.webContents, 1_000);
    expect(scripts.some(source => source.includes('scrollBy'))).toBe(false);
  });
});

describe('browser history outcomes', () => {
  it('fails when there is no history or the URL does not change', () => {
    expect(historyMoveOutcome('back', false, 'https://example.com/a', 'https://example.com/a')).toEqual({
      ok: false,
      output: 'No back history. The page URL is unchanged.',
    });
    expect(historyMoveOutcome('forward', true, 'https://example.com/a', 'https://example.com/a')).toEqual({
      ok: false,
      output: 'Could not go forward. The page is still https://example.com/a.',
    });
    expect(historyMoveOutcome('forward', true, 'https://example.com/a', 'https://example.com/b')).toEqual({
      ok: true,
      summary: 'Navigated forward to https://example.com/b.',
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

interface SnapshotCollection {
  url: string;
  title: string;
  pageText: string;
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
  elements: Array<{ tag: string; text: string }>;
}

function runSnapshotScript(options: { width: number; height: number; rect: number }): SnapshotCollection {
  const context = createContext({});
  runInContext(snapshotDomPrelude(options.width, options.height, options.rect), context);
  return runInContext(SNAPSHOT_SCRIPT, context) as SnapshotCollection;
}

function snapshotDomPrelude(width: number, height: number, rect: number): string {
  return `
    var HTMLElement = class HTMLElement {
      constructor(tag, text) {
        this.tagName = String(tag).toUpperCase();
        this.textContent = text || '';
        this.innerText = text || '';
        this.attrs = {};
        this.children = [];
        this.disabled = false;
        this.type = 'text';
        this.value = '';
        this.href = '';
        this.checked = false;
      }
      setAttribute(key, value) { this.attrs[key] = String(value); }
      getAttribute(key) { return Object.prototype.hasOwnProperty.call(this.attrs, key) ? this.attrs[key] : null; }
      getBoundingClientRect() {
        return { width: ${String(rect)}, height: ${String(rect)}, top: 8, left: 8, bottom: ${String(8 + rect)}, right: ${String(8 + rect)} };
      }
      append(child) {
        this.children.push(child);
        this.textContent += child.textContent || '';
      }
    };
    var SVGElement = class SVGElement extends HTMLElement {};
    var HTMLInputElement = class HTMLInputElement extends HTMLElement {};
    var HTMLTextAreaElement = class HTMLTextAreaElement extends HTMLElement {};
    var HTMLAnchorElement = class HTMLAnchorElement extends HTMLElement {};
    var HTMLSelectElement = class HTMLSelectElement extends HTMLElement {};
    function walk(node, out) {
      out.push(node);
      for (const child of node.children) walk(child, out);
      return out;
    }
    var body = new HTMLElement('body', '');
    var heading = new HTMLElement('h1', 'Example Domain');
    var svg = new SVGElement('svg', '');
    var label = new SVGElement('text', 'Pelican rides a bicycle');
    svg.append(label);
    var link = new HTMLAnchorElement('a', 'More information');
    link.href = 'https://example.com/more';
    body.append(heading);
    body.append(svg);
    body.append(link);
    var document = {
      title: 'Example',
      body: body,
      querySelectorAll: function (selector) {
        var tags = selector.split(',').map(function (part) { return part.trim().toLowerCase(); }).filter(function (part) { return part && part.charAt(0) !== '['; });
        return walk(body, []).filter(function (node) { return tags.indexOf(node.tagName.toLowerCase()) !== -1; });
      },
    };
    var location = { href: 'https://example.com/' };
    var innerWidth = ${String(width)};
    var innerHeight = ${String(height)};
    var scrollX = 0;
    var scrollY = 0;
    function getComputedStyle() { return { visibility: 'visible', display: 'block' }; }
  `;
}

function scriptedPage(result: () => unknown): WebContents {
  return {
    executeJavaScript: vi.fn(async () => result()),
    getURL: () => 'https://example.com/',
    getTitle: () => 'Example',
  } as unknown as WebContents;
}

function actionPage(execute?: (source: string) => unknown): {
  webContents: WebContents;
  sendInputEvent: ReturnType<typeof vi.fn>;
  executeJavaScript: ReturnType<typeof vi.fn>;
} {
  const sendInputEvent = vi.fn();
  const executeJavaScript = vi.fn(async (source: string) => execute?.(source));
  const webContents = {
    executeJavaScript,
    sendInputEvent,
    getURL: () => 'https://example.com/',
    getTitle: () => 'Example',
    isDestroyed: () => false,
    isLoading: () => false,
  } as unknown as WebContents;
  return { webContents, sendInputEvent, executeJavaScript };
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
