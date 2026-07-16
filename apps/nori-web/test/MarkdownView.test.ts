import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../src/i18n';
import { MarkdownView } from '../src/components/MarkdownView';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('MarkdownView code blocks', () => {
  it('copies code and shows completion feedback', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    localStorage.setItem('nori-ui-language', 'en');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(MarkdownView, {
          content: '```ts\nconst answer = 42;\n```',
        })));
      });
      const button = container.querySelector<HTMLButtonElement>('.markdown-code-copy');
      expect(button?.textContent).toBe('Copy');

      await act(async () => {
        button?.click();
        await Promise.resolve();
      });
      expect(writeText).toHaveBeenCalledWith('const answer = 42;\n');
      expect(button?.textContent).toBe('Copied');
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });
});
