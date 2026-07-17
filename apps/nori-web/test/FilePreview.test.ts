import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FsReadResponse } from '../src/api/client';
import { FilePreview } from '../src/components/FilePreview';
import { I18nProvider } from '../src/i18n';

vi.mock('shiki', () => ({
  codeToHtml: vi.fn(async (content: string) => `<pre><code><span class="line">${content}</span></code></pre>`),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('FilePreview', () => {
  it('keeps a code selection stable while the same file refreshes', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const render = async (file: FsReadResponse, loading = false) => {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(FilePreview, {
          path: 'src/example.ts',
          file,
          loading,
        })));
        await Promise.resolve();
      });
    };

    try {
      await render(sourceFile('const originalValue = 1;'));
      await vi.waitFor(() => expect(container.querySelector('.code-preview')?.textContent).toContain('originalValue'));
      const preview = container.querySelector<HTMLElement>('.code-preview')!;
      const textNode = preview.querySelector('.line')?.firstChild;
      expect(textNode).toBeDefined();
      const range = document.createRange();
      range.setStart(textNode!, 6);
      range.setEnd(textNode!, 19);

      await act(async () => {
        preview.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      });
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      await act(async () => {
        document.dispatchEvent(new Event('selectionchange'));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
      });
      expect(selection?.toString()).toBe('originalValue');

      await render(sourceFile('const refreshedValue = 2;'), true);

      expect(selection?.toString()).toBe('originalValue');
      expect(container.querySelector('.code-preview')).toBe(preview);
      expect(preview.textContent).toContain('originalValue');

      await act(async () => {
        window.getSelection()?.removeAllRanges();
        document.dispatchEvent(new Event('selectionchange'));
      });
      expect(preview.textContent).toContain('refreshedValue');
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });
});

function sourceFile(content: string): FsReadResponse {
  return {
    path: 'src/example.ts',
    content,
    encoding: 'utf-8',
    size: content.length,
    truncated: false,
    mime: 'text/typescript',
    language_id: 'typescript',
    is_binary: false,
  };
}
