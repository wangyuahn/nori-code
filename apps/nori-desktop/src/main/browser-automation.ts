import type { WebContents } from 'electron';

import { BROWSER_HOME_URL } from './browser-url';

export interface NativeBrowserActionRequest {
  readonly action: 'snapshot' | 'navigate' | 'click' | 'type' | 'upload' | 'keypress' | 'scroll' | 'wait' | 'screenshot' | 'back' | 'forward' | 'reload' | 'retry' | 'get_console' | 'get_network' | 'download_list' | 'permission_list' | 'dialog_list' | 'dialog_respond' | 'annotation_list';
  readonly tabId?: string;
  readonly url?: string;
  readonly ref?: string;
  readonly text?: string;
  readonly key?: string;
  readonly x?: number;
  readonly y?: number;
  readonly deltaX?: number;
  readonly deltaY?: number;
  readonly timeoutMs?: number;
  readonly clear?: boolean;
  readonly paths?: readonly string[];
  readonly dialogId?: string;
  readonly accept?: boolean;
  readonly promptText?: string;
  readonly filter?: string;
}

export interface NativeBrowserActionResult {
  readonly ok: boolean;
  readonly output: string;
  readonly url?: string;
  readonly title?: string;
  readonly tabId?: string;
  readonly screenshotDataUrl?: string;
  readonly staleRef?: boolean;
}

const PAGE_REQUIRED_ACTIONS = new Set<NativeBrowserActionRequest['action']>([
  'snapshot',
  'click',
  'type',
  'upload',
  'keypress',
  'scroll',
  'wait',
  'screenshot',
  'back',
  'forward',
  'reload',
  'retry',
  'get_console',
  'get_network',
  'annotation_list',
]);

export function unavailablePageResult(
  request: NativeBrowserActionRequest,
  currentUrl: string | undefined,
): NativeBrowserActionResult | undefined {
  if (!PAGE_REQUIRED_ACTIONS.has(request.action)) return undefined;
  if (currentUrl !== undefined && currentUrl !== '' && currentUrl !== BROWSER_HOME_URL) return undefined;
  return {
    ok: false,
    output: `No browser page is open. Use the Browser navigate action before ${request.action}.`,
  };
}

export interface BrowserAnnotation {
  readonly id: string;
  readonly ref: string;
  readonly text: string;
  readonly tag: string;
  readonly url: string;
  readonly createdAt: string;
  readonly note?: string;
}

interface ElementTarget {
  readonly x: number;
  readonly y: number;
  readonly tag: string;
  readonly disabled: boolean;
  readonly inputType?: string;
  readonly contentEditable: boolean;
}

const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'submit',
  'reset',
  'checkbox',
  'radio',
  'file',
  'image',
  'hidden',
  'color',
  'range',
]);

export function typeTargetRejection(tag: string, inputType: string | undefined, contentEditable: boolean): string | undefined {
  if (contentEditable || tag === 'textarea') return undefined;
  if (tag === 'input') {
    const type = inputType || 'text';
    if (!NON_TEXT_INPUT_TYPES.has(type)) return undefined;
    return `Element is an <input type="${type}">, not a text field. Use click instead of type.`;
  }
  return `Element <${tag}> is not a text field. Use click instead of type.`;
}

const NAMED_KEYS = new Set([
  'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Space',
  'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'Insert',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

const KEY_ALIASES: Record<string, string> = {
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  esc: 'Escape',
  return: 'Enter',
  spacebar: 'Space',
  del: 'Delete',
};

export interface ParsedKeypress {
  readonly keyCode: string;
  readonly modifiers: readonly ('alt' | 'control' | 'meta' | 'shift')[];
}

export function parseKeypress(key: string): ParsedKeypress | { error: string } {
  const parts = key.split('+').map(part => part.trim()).filter(Boolean);
  const rawKey = parts.pop();
  if (rawKey === undefined) return { error: 'Key cannot be empty.' };
  const modifiers: Array<'alt' | 'control' | 'meta' | 'shift'> = [];
  for (const part of parts) {
    const modifier = normalizeModifier(part);
    if (modifier === undefined) {
      return { error: unknownKeyMessage(key) };
    }
    modifiers.push(modifier);
  }
  const keyCode = canonicalKey(rawKey);
  if (keyCode === undefined) return { error: unknownKeyMessage(key) };
  return { keyCode, modifiers };
}

function canonicalKey(raw: string): string | undefined {
  const alias = KEY_ALIASES[raw.toLowerCase()];
  if (alias !== undefined) return alias;
  if (/^[a-z]$/i.test(raw) || /^[0-9]$/.test(raw)) return raw.length === 1 && /[a-z]/i.test(raw) ? raw.toUpperCase() : raw;
  return [...NAMED_KEYS].find(name => name.toLowerCase() === raw.toLowerCase());
}

function unknownKeyMessage(key: string): string {
  return `Unknown key ${JSON.stringify(key)}. Use a letter, digit, F1–F12, or a named key such as Enter, Escape, Tab, Backspace, or ArrowDown. The page was not changed.`;
}

export interface NetworkSettlementEntry {
  state: 'pending' | 'completed' | 'failed';
  status?: number;
  durationMs?: number;
  startedAt: string;
}

/** Finished requests must not stay pending after the document has stopped loading. */
export function settleFinishedRequests(entries: NetworkSettlementEntry[], now: number): void {
  for (const entry of entries) {
    if (entry.state !== 'pending') continue;
    const started = Date.parse(entry.startedAt);
    const age = Number.isFinite(started) ? now - started : 1_500;
    if (entry.status === undefined && age < 1_500) continue;
    entry.state = 'completed';
    if (entry.durationMs === undefined) entry.durationMs = Number.isFinite(started) ? Math.max(0, age) : 0;
  }
}

export function historyMoveOutcome(
  direction: 'back' | 'forward',
  canMove: boolean,
  before: string,
  after: string,
): { ok: true; summary: string } | { ok: false; output: string } {
  if (!canMove) return { ok: false, output: `No ${direction} history. The page URL is unchanged.` };
  if (after === before) return { ok: false, output: `Could not go ${direction}. The page is still ${after}.` };
  return { ok: true, summary: `Navigated ${direction} to ${after}.` };
}

export function snapshotHasContent(output: string): boolean {
  return output.split('\n').some(line => {
    if (line.startsWith('Text: ') && line.slice('Text: '.length).trim() !== '') return true;
    return /^<[a-z][a-z0-9:-]* ref=/i.test(line);
  });
}

export async function snapshotPage(webContents: WebContents): Promise<string> {
  const snapshot = await webContents.executeJavaScript(SNAPSHOT_SCRIPT, true) as {
    url: string;
    title: string;
    pageText?: string;
    viewport: { width: number; height: number; scrollX: number; scrollY: number };
    elements: Array<{ ref: string; tag: string; role: string; text: string; type?: string; value?: string; checked?: boolean; disabled?: boolean; href?: string }>;
  };
  const lines = [
    '<browser_snapshot untrusted="true">',
    `URL: ${snapshot.url}`,
    `Title: ${snapshot.title}`,
    `Viewport: ${snapshot.viewport.width}x${snapshot.viewport.height} at (${snapshot.viewport.scrollX}, ${snapshot.viewport.scrollY})`,
    ...snapshot.elements.map(element => {
      const attrs = [
        `ref=${element.ref}`,
        element.role ? `role=${JSON.stringify(element.role)}` : '',
        element.type ? `type=${JSON.stringify(element.type)}` : '',
        element.href ? `href=${JSON.stringify(element.href)}` : '',
        element.value ? `value=${JSON.stringify(element.value)}` : '',
        element.checked === undefined ? '' : `checked=${String(element.checked)}`,
        element.disabled ? 'disabled=true' : '',
      ].filter(Boolean).join(' ');
      return `<${element.tag} ${attrs}> ${element.text}`.trim();
    }),
    snapshot.pageText ? `Text: ${snapshot.pageText}` : '',
    '</browser_snapshot>',
  ].filter(line => line !== '');
  return lines.join('\n');
}

export async function clickPage(
  webContents: WebContents,
  input: { readonly ref?: string; readonly x?: number; readonly y?: number },
): Promise<NativeBrowserActionResult> {
  let x = input.x;
  let y = input.y;
  if (input.ref !== undefined) {
    const target = await resolveRef(webContents, input.ref);
    if (target === null) return staleReference(input.ref);
    if (target.disabled) return { ok: false, output: `Element ${input.ref} is disabled.` };
    x = target.x;
    y = target.y;
  }
  if (x === undefined || y === undefined) return { ok: false, output: 'Click requires a reference or coordinates.' };
  webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
  webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
  webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
  return pageResult(webContents, `Clicked at (${Math.round(x)}, ${Math.round(y)}).`);
}

export async function typePage(
  webContents: WebContents,
  ref: string,
  text: string,
  clear = true,
): Promise<NativeBrowserActionResult> {
  const target = await resolveRef(webContents, ref);
  if (target === null) return staleReference(ref);
  if (target.disabled) return { ok: false, output: `Element ${ref} is disabled.` };
  const rejection = typeTargetRejection(target.tag, target.inputType, target.contentEditable);
  if (rejection !== undefined) return { ok: false, output: `${rejection} Reference ${ref} was not modified.` };
  const written = await webContents.executeJavaScript(writeEditableValueScript(ref, text, clear), true) as {
    ok?: boolean;
    value?: string;
  };
  if (written.ok !== true) {
    return {
      ok: false,
      output: `Typed into ${ref} but the field value is ${JSON.stringify(written.value ?? '')}. The page did not keep the text.`,
    };
  }
  return pageResult(webContents, `Typed ${String(text.length)} characters into ${ref}.`);
}

export function pressKey(webContents: WebContents, key: string): NativeBrowserActionResult {
  const parsed = parseKeypress(key);
  if ('error' in parsed) return { ok: false, output: parsed.error };
  try {
    webContents.sendInputEvent({ type: 'keyDown', keyCode: parsed.keyCode, modifiers: [...parsed.modifiers] });
    webContents.sendInputEvent({ type: 'keyUp', keyCode: parsed.keyCode, modifiers: [...parsed.modifiers] });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, output: `Key press failed: ${message}` };
  }
  return pageResult(webContents, `Pressed ${key}.`);
}

export async function waitForRenderedContent(webContents: WebContents, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let nudged = false;
  while (Date.now() < deadline && !webContents.isDestroyed()) {
    const probe = await readRenderProbe(webContents);
    if (probe !== undefined && probe.width > 0 && probe.height > 0) {
      const sparse = probe.textLength < 80 && probe.scrollHeight > probe.height + 160;
      if (!nudged && sparse) {
        nudged = true;
        await nudgeScroll(webContents);
        continue;
      }
      if (probe.textLength > 0 || !webContents.isLoading()) return;
    }
    await delay(80);
  }
}

export async function scrollPage(webContents: WebContents, deltaX = 0, deltaY = 600): Promise<NativeBrowserActionResult> {
  const position = await webContents.executeJavaScript(`(() => {
    window.scrollBy({ left: ${JSON.stringify(deltaX)}, top: ${JSON.stringify(deltaY)}, behavior: 'instant' });
    return { x: window.scrollX, y: window.scrollY };
  })()`, true) as { x: number; y: number };
  return pageResult(
    webContents,
    `Scrolled by (${String(deltaX)}, ${String(deltaY)}) to (${String(position.x)}, ${String(position.y)}).`,
  );
}

export async function waitForPage(
  webContents: WebContents,
  input: { readonly ref?: string; readonly text?: string; readonly timeoutMs?: number },
): Promise<NativeBrowserActionResult> {
  const timeoutMs = Math.min(input.timeoutMs ?? 5_000, 30_000);
  const deadline = Date.now() + timeoutMs;
  do {
    const matched = await webContents.executeJavaScript(`(() => {
      const ref = ${JSON.stringify(input.ref)};
      const text = ${JSON.stringify(input.text)};
      if (ref) return document.querySelector('[data-nori-ref="' + CSS.escape(ref) + '"]') !== null;
      if (text) return (document.body?.innerText || '').includes(text);
      return document.readyState === 'complete';
    })()`, true) as boolean;
    if (matched) return pageResult(webContents, 'Wait condition satisfied.');
    await delay(100);
  } while (Date.now() < deadline && !webContents.isDestroyed());
  return { ok: false, output: `Wait condition was not satisfied within ${String(timeoutMs)}ms.` };
}

export async function captureScreenshot(webContents: WebContents): Promise<NativeBrowserActionResult> {
  const image = await webContents.capturePage();
  const size = image.getSize();
  if (image.isEmpty() || size.width <= 0 || size.height <= 0) {
    return {
      ok: false,
      output:
        'Browser screenshot is unavailable because the page capture was empty ' +
        '(' + String(size.width) + 'x' + String(size.height) + '). Wait for the page to render or use ' +
        'Browser snapshot, then retry the screenshot.',
    };
  }
  const bounded = size.width > 1440 ? image.resize({ width: 1440, quality: 'good' }) : image;
  if (bounded.isEmpty()) {
    return {
      ok: false,
      output: 'Browser screenshot is unavailable because resizing produced an empty image. Use Browser snapshot and retry.',
    };
  }
  const screenshotDataUrl = bounded.toDataURL();
  if (!/^data:image\/[a-z0-9.+-]+;base64,.+/is.test(screenshotDataUrl)) {
    return {
      ok: false,
      output: 'Browser screenshot is unavailable because Electron returned empty or invalid image data. Use Browser snapshot and retry.',
    };
  }
  return {
    ...pageResult(webContents, `Screenshot captured at ${String(size.width)}x${String(size.height)}.`),
    screenshotDataUrl,
  };
}

export async function setPageAnnotationMode(webContents: WebContents, enabled: boolean): Promise<BrowserAnnotation[]> {
  return webContents.executeJavaScript(annotationScript(enabled), true) as Promise<BrowserAnnotation[]>;
}

export async function listPageAnnotations(webContents: WebContents): Promise<BrowserAnnotation[]> {
  return webContents.executeJavaScript(`(() => globalThis.__noriAnnotationState?.items ?? [])()`, true) as Promise<BrowserAnnotation[]>;
}

export async function clearPageAnnotations(webContents: WebContents): Promise<void> {
  await webContents.executeJavaScript(`(() => {
    const state = globalThis.__noriAnnotationState;
    if (!state) return;
    for (const node of document.querySelectorAll('[data-nori-annotation]')) {
      node.removeAttribute('data-nori-annotation');
      node.style.removeProperty('outline');
      node.style.removeProperty('outline-offset');
    }
    state.items = [];
  })()`, true);
}

export async function updatePageAnnotation(
  webContents: WebContents,
  id: string,
  note: string,
): Promise<BrowserAnnotation[]> {
  return webContents.executeJavaScript(`(() => {
    const state = globalThis.__noriAnnotationState;
    if (!state) return [];
    const item = state.items.find(candidate => candidate.id === ${JSON.stringify(id)});
    if (item) item.note = ${JSON.stringify(note)};
    return state.items;
  })()`, true) as Promise<BrowserAnnotation[]>;
}

export async function firstVisibleFileInputRef(webContents: WebContents): Promise<string | null> {
  return webContents.executeJavaScript(`(() => {
    const root = globalThis.__noriBrowserAutomation ??= {
      nextRef: 1,
      pageId: Math.random().toString(36).slice(2, 9),
    };
    const element = [...document.querySelectorAll('input[type="file"]')]
      .find(candidate => {
        if (!(candidate instanceof HTMLInputElement) || candidate.disabled) return false;
        const style = getComputedStyle(candidate);
        const rect = candidate.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      });
    if (!(element instanceof HTMLInputElement)) return null;
    let ref = element.getAttribute('data-nori-ref');
    if (!ref) {
      ref = 'n' + root.pageId + '-' + String(root.nextRef++);
      element.setAttribute('data-nori-ref', ref);
    }
    return ref;
  })()`, true) as Promise<string | null>;
}

async function resolveRef(webContents: WebContents, ref: string): Promise<ElementTarget | null> {
  return webContents.executeJavaScript(`(() => {
    const element = document.querySelector('[data-nori-ref="' + CSS.escape(${JSON.stringify(ref)}) + '"]');
    if (!(element instanceof HTMLElement || element instanceof SVGElement)) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const next = element.getBoundingClientRect();
    const tag = element.tagName.toLowerCase();
    return {
      x: next.left + next.width / 2,
      y: next.top + next.height / 2,
      tag,
      disabled: Boolean(element.disabled),
      inputType: element instanceof HTMLInputElement ? element.type : undefined,
      contentEditable: element instanceof HTMLElement && element.isContentEditable,
    };
  })()`, true) as Promise<ElementTarget | null>;
}

function staleReference(ref: string): NativeBrowserActionResult {
  return { ok: false, staleRef: true, output: `Reference ${ref} is stale or not visible. Take a new snapshot and retry.` };
}

function pageResult(webContents: WebContents, output: string): NativeBrowserActionResult {
  return { ok: true, output, url: webContents.getURL(), title: webContents.getTitle() };
}

function normalizeModifier(value: string): 'alt' | 'control' | 'meta' | 'shift' | undefined {
  switch (value.toLowerCase()) {
    case 'alt': return 'alt';
    case 'ctrl':
    case 'control': return 'control';
    case 'cmd':
    case 'command':
    case 'meta': return 'meta';
    case 'shift': return 'shift';
    default: return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function writeEditableValueScript(ref: string, text: string, clear: boolean): string {
  return `(() => {
    const element = document.querySelector('[data-nori-ref="' + CSS.escape(${JSON.stringify(ref)}) + '"]');
    if (!(element instanceof HTMLElement)) return { ok: false, value: '' };
    const text = ${JSON.stringify(text)};
    const clear = ${clear ? 'true' : 'false'};
    element.focus();
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const next = clear ? text : element.value + text;
      const prototype = Object.getPrototypeOf(element);
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
      if (descriptor && descriptor.set) descriptor.set.call(element, next);
      else element.value = next;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: element.value === next, value: element.value };
    }
    if (element.isContentEditable) {
      if (clear) element.replaceChildren();
      const inserted = document.execCommand('insertText', false, text);
      if (!inserted) element.insertAdjacentText('beforeend', text);
      const value = element.innerText || '';
      return { ok: value.includes(text), value };
    }
    return { ok: false, value: '' };
  })()`;
}

interface RenderProbe {
  readonly width: number;
  readonly height: number;
  readonly textLength: number;
  readonly scrollHeight: number;
}

const RENDER_PROBE = `(() => {
  const bodyText = (document.body?.textContent || '').replace(/\\s+/g, ' ').trim();
  const svgText = [...document.querySelectorAll('svg text')].map(node => node.textContent || '').join(' ');
  return {
    width: window.innerWidth || 0,
    height: window.innerHeight || 0,
    textLength: (bodyText + ' ' + svgText).trim().length,
    scrollHeight: document.documentElement?.scrollHeight || 0,
  };
})()`;

async function readRenderProbe(webContents: WebContents): Promise<RenderProbe | undefined> {
  try {
    return await webContents.executeJavaScript(RENDER_PROBE, true) as RenderProbe;
  } catch {
    return undefined;
  }
}

async function nudgeScroll(webContents: WebContents): Promise<void> {
  try {
    const saved = await webContents.executeJavaScript(`(() => {
      const position = { x: window.scrollX || 0, y: window.scrollY || 0 };
      window.scrollBy({ left: 0, top: Math.max(window.innerHeight || 600, 480), behavior: 'instant' });
      return position;
    })()`, true) as { x: number; y: number };
    await delay(250);
    await webContents.executeJavaScript(
      `window.scrollTo(${JSON.stringify(saved.x)}, ${JSON.stringify(saved.y)})`,
      true,
    );
  } catch {
    // A failed nudge still leaves the following snapshot to report whatever rendered.
  }
}

export const SNAPSHOT_SCRIPT = `(() => {
  const root = globalThis.__noriBrowserAutomation ??= {
    nextRef: 1,
    pageId: Math.random().toString(36).slice(2, 9),
  };
  const selector = 'a,button,input,textarea,select,summary,[role],h1,h2,h3,h4,p,li,pre,code,img,text';
  const visible = element => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth;
  };
  const elements = [];
  for (const element of document.querySelectorAll(selector)) {
    if (!((element instanceof HTMLElement) || (element instanceof SVGElement)) || !visible(element)) continue;
    let ref = element.getAttribute('data-nori-ref');
    if (!ref) {
      ref = 'n' + root.pageId + '-' + String(root.nextRef++);
      element.setAttribute('data-nori-ref', ref);
    }
    const rawText = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
      ? (element.getAttribute('aria-label') || element.getAttribute('placeholder') || '')
      : element instanceof SVGElement
        ? (element.textContent || '')
        : (element.innerText || element.getAttribute('aria-label') || element.getAttribute('alt') || '');
    const item = {
      ref,
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role') || '',
      text: rawText.replace(/\\s+/g, ' ').trim().slice(0, 280),
      disabled: Boolean(element.disabled),
    };
    if (element instanceof HTMLInputElement) item.type = element.type;
    if (element instanceof HTMLAnchorElement) item.href = element.href;
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) item.value = element.value.slice(0, 200);
    if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) item.checked = element.checked;
    elements.push(item);
    if (elements.length >= 180) break;
  }
  const pageText = ((document.body && document.body.textContent) || '').replace(/\\s+/g, ' ').trim().slice(0, 8000);
  return { url: location.href, title: document.title, pageText, viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY }, elements };
})()`;

function annotationScript(enabled: boolean): string {
  return `(() => {
    const state = globalThis.__noriAnnotationState ??= { items: [], enabled: false, handler: null };
    if (state.handler) document.removeEventListener('click', state.handler, true);
    state.enabled = ${String(enabled)};
    if (state.enabled) {
      state.handler = event => {
        const element = event.target instanceof HTMLElement ? event.target.closest('a,button,input,textarea,select,[role],h1,h2,h3,h4,p,li,pre,code,img') : null;
        if (!(element instanceof HTMLElement)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const automation = globalThis.__noriBrowserAutomation ??= {
          nextRef: 1,
          pageId: Math.random().toString(36).slice(2, 9),
        };
        let ref = element.getAttribute('data-nori-ref');
        if (!ref) {
          ref = 'n' + automation.pageId + '-' + String(automation.nextRef++);
          element.setAttribute('data-nori-ref', ref);
        }
        const id = 'annotation-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
        const selection = getSelection()?.toString().replace(/\\s+/g, ' ').trim() || '';
        const text = (selection || element.innerText || element.getAttribute('aria-label') || element.getAttribute('alt') || '').replace(/\\s+/g, ' ').trim().slice(0, 800);
        const item = { id, ref, text, tag: element.tagName.toLowerCase(), url: location.href, createdAt: new Date().toISOString() };
        state.items.push(item);
        element.setAttribute('data-nori-annotation', id);
        element.style.setProperty('outline', '2px solid #eab308', 'important');
        element.style.setProperty('outline-offset', '2px', 'important');
        console.info('__NORI_ANNOTATION__' + JSON.stringify(state.items));
      };
      document.addEventListener('click', state.handler, true);
    } else {
      state.handler = null;
    }
    return state.items;
  })()`;
}
