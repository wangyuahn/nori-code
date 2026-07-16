import { describe, expect, it } from 'vitest';

import { unavailablePageResult } from '../src/main/browser-automation';

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
