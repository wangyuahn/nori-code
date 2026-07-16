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
}

export async function snapshotPage(webContents: WebContents): Promise<string> {
  const snapshot = await webContents.executeJavaScript(SNAPSHOT_SCRIPT, true) as {
    url: string;
    title: string;
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
    '</browser_snapshot>',
  ];
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
  await clickPage(webContents, { x: target.x, y: target.y });
  if (clear) {
    const modifier = process.platform === 'darwin' ? 'meta' : 'control';
    webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: [modifier] });
    webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: [modifier] });
    webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
    webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
  }
  await webContents.insertText(text);
  return pageResult(webContents, `Typed ${String(text.length)} characters into ${ref}.`);
}

export function pressKey(webContents: WebContents, key: string): NativeBrowserActionResult {
  const parts = key.split('+').map(part => part.trim()).filter(Boolean);
  const keyCode = parts.pop();
  if (keyCode === undefined) return { ok: false, output: 'Key cannot be empty.' };
  const modifiers = parts.map(part => normalizeModifier(part)).filter((part): part is 'alt' | 'control' | 'meta' | 'shift' => part !== undefined);
  webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  return pageResult(webContents, `Pressed ${key}.`);
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
  const bounded = size.width > 1440 ? image.resize({ width: 1440, quality: 'good' }) : image;
  return {
    ...pageResult(webContents, `Screenshot captured at ${String(size.width)}x${String(size.height)}.`),
    screenshotDataUrl: bounded.toDataURL(),
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
    if (!(element instanceof HTMLElement)) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const next = element.getBoundingClientRect();
    return { x: next.left + next.width / 2, y: next.top + next.height / 2, tag: element.tagName.toLowerCase(), disabled: Boolean(element.disabled) };
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

const SNAPSHOT_SCRIPT = `(() => {
  const root = globalThis.__noriBrowserAutomation ??= {
    nextRef: 1,
    pageId: Math.random().toString(36).slice(2, 9),
  };
  const selector = 'a,button,input,textarea,select,summary,[role],h1,h2,h3,h4,p,li,pre,code,img';
  const visible = element => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth;
  };
  const elements = [];
  for (const element of document.querySelectorAll(selector)) {
    if (!(element instanceof HTMLElement) || !visible(element)) continue;
    let ref = element.getAttribute('data-nori-ref');
    if (!ref) {
      ref = 'n' + root.pageId + '-' + String(root.nextRef++);
      element.setAttribute('data-nori-ref', ref);
    }
    const rawText = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
      ? (element.getAttribute('aria-label') || element.getAttribute('placeholder') || '')
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
  return { url: location.href, title: document.title, viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY }, elements };
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
