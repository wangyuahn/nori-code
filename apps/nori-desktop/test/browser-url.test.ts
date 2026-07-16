import { describe, expect, it } from 'vitest';

import {
  BROWSER_HOME_URL,
  isAllowedBrowserUrl,
  localHtmlPath,
  normalizeBrowserInput,
} from '../src/main/browser-url';

describe('embedded browser URL policy', () => {
  it('keeps supported web URLs and infers host schemes', () => {
    expect(normalizeBrowserInput('https://example.com/docs')).toBe('https://example.com/docs');
    expect(normalizeBrowserInput('example.com/docs')).toBe('https://example.com/docs');
    expect(normalizeBrowserInput('localhost:5173/test')).toBe('http://localhost:5173/test');
    expect(normalizeBrowserInput('127.0.0.1:3000')).toBe('http://127.0.0.1:3000/');
  });

  it('turns non-host text into an encoded search', () => {
    expect(normalizeBrowserInput('Nori agent browser')).toBe(
      'https://www.bing.com/search?q=Nori%20agent%20browser',
    );
  });

  it('opens local HTML files from file URLs and absolute paths', () => {
    const url = normalizeBrowserInput('C:\\workspace\\demo page.html');
    expect(url).toBe('file:///C:/workspace/demo%20page.html');
    expect(localHtmlPath(url)).toBe('C:\\workspace\\demo page.html');
    expect(isAllowedBrowserUrl('file:///C:/workspace/index.htm')).toBe(true);
  });

  it('blocks privileged and executable schemes', () => {
    for (const input of ['javascript:alert(1)', 'file:///C:/secret.txt', 'file://server/share/index.html', 'data:text/html,test', 'devtools://devtools']) {
      expect(normalizeBrowserInput(input)).toBe(BROWSER_HOME_URL);
      expect(isAllowedBrowserUrl(input)).toBe(false);
    }
    expect(isAllowedBrowserUrl('http://localhost:5173')).toBe(true);
    expect(isAllowedBrowserUrl('https://example.com')).toBe(true);
    expect(isAllowedBrowserUrl(BROWSER_HOME_URL)).toBe(true);
  });
});
