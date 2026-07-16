import { extname, isAbsolute, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOST_LIKE_INPUT = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|(?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d{1,5})?(?:[/?#].*)?$/i;
const EXPLICIT_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export const BROWSER_HOME_URL = 'about:blank';
export const BROWSER_SEARCH_URL = 'https://www.bing.com/search?q=';

export function normalizeBrowserInput(input: string): string {
  const value = input.trim();
  if (!value || value === BROWSER_HOME_URL) return BROWSER_HOME_URL;

  if (isAbsolute(value) || win32.isAbsolute(value)) {
    try {
      const url = pathToFileURL(value).toString();
      return isAllowedBrowserUrl(url) ? url : BROWSER_HOME_URL;
    } catch {
      return BROWSER_HOME_URL;
    }
  }

  if (HOST_LIKE_INPUT.test(value)) {
    const local = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::|[/?#]|$)/i.test(value);
    try {
      return new URL(`${local ? 'http' : 'https'}://${value}`).toString();
    } catch {
      return `${BROWSER_SEARCH_URL}${encodeURIComponent(value)}`;
    }
  }

  if (EXPLICIT_SCHEME.test(value)) {
    return isAllowedBrowserUrl(value) ? new URL(value).toString() : BROWSER_HOME_URL;
  }

  return `${BROWSER_SEARCH_URL}${encodeURIComponent(value)}`;
}

export function isAllowedBrowserUrl(input: string): boolean {
  if (input === BROWSER_HOME_URL) return true;
  try {
    const url = new URL(input);
    return url.protocol === 'http:' || url.protocol === 'https:' || localHtmlPath(url) !== undefined;
  } catch {
    return false;
  }
}

export function localHtmlPath(input: string | URL): string | undefined {
  try {
    const url = typeof input === 'string' ? new URL(input) : input;
    if (url.protocol !== 'file:' || (url.hostname !== '' && url.hostname !== 'localhost')) return undefined;
    const filePath = fileURLToPath(url);
    const extension = extname(filePath).toLowerCase();
    return extension === '.html' || extension === '.htm' ? filePath : undefined;
  } catch {
    return undefined;
  }
}
