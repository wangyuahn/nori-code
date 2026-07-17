import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../src/i18n';
import { MarkdownView, normalizeLatexMathDelimiters } from '../src/components/MarkdownView';

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
        button?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
        button?.click();
        await Promise.resolve();
      });
      expect(writeText).toHaveBeenCalledWith('const answer = 42;\n');
      expect(container.querySelector('.markdown-code-copy')).toBe(button);
      expect(button?.textContent).toBe('Copied');
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it('keeps copy controls hidden while streaming and mounts them when streaming ends', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(MarkdownView, {
          content: '```ts\nconst partial =',
          streaming: true,
        })));
      });
      expect(container.querySelector('.markdown-code-copy')).toBeNull();
      expect(container.querySelector('pre')?.classList.contains('markdown-code-block')).toBe(false);

      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(MarkdownView, {
          content: '```ts\nconst complete = true;\n```',
          streaming: true,
        })));
      });
      expect(container.querySelector('.markdown-code-copy')).toBeNull();

      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(MarkdownView, {
          content: '```ts\nconst complete = true;\n```',
          streaming: false,
        })));
      });
      expect(container.querySelector('.markdown-code-copy')?.textContent).toBe('Copy');
      expect(container.querySelector('pre')?.classList.contains('markdown-code-block')).toBe(true);

      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(MarkdownView, {
          content: '```ts\nconst fenceWasNotClosed = true;',
          streaming: false,
        })));
      });
      expect(container.querySelector('.markdown-code-copy')?.textContent).toBe('Copy');
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it('keeps the rendered text stable while the user is dragging a selection', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(MarkdownView, {
          content: 'First streamed text',
          streaming: true,
        })));
      });
      const article = container.querySelector<HTMLElement>('.markdown-view')!;
      await act(async () => {
        article.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        root.render(createElement(I18nProvider, null, createElement(MarkdownView, {
          content: 'First streamed text with a later chunk',
          streaming: true,
        })));
      });

      expect(article.textContent?.trim()).toBe('First streamed text');

      const textNode = article.querySelector('p')?.firstChild;
      expect(textNode).toBeDefined();
      const range = document.createRange();
      range.setStart(textNode!, 6);
      range.setEnd(textNode!, 14);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      await act(async () => {
        document.dispatchEvent(new Event('selectionchange'));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        root.render(createElement(I18nProvider, null, createElement(MarkdownView, {
          content: 'First streamed text with two later chunks',
          streaming: true,
        })));
      });
      expect(selection?.toString()).toBe('streamed');
      expect(article.textContent?.trim()).toBe('First streamed text');

      await act(async () => {
        selection?.removeAllRanges();
        document.dispatchEvent(new Event('selectionchange'));
      });
      expect(article.textContent?.trim()).toBe('First streamed text with two later chunks');
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('renders inline and block math with KaTeX without touching code blocks', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(MarkdownView, {
          content: 'Inline$E = mc^2$formula.\n\n$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$\n\n```text\n$not_math$\n```',
        })));
      });

      expect(container.querySelectorAll('.katex')).toHaveLength(2);
      expect(container.querySelector('.katex-display')).not.toBeNull();
      expect(container.querySelector('pre code')?.textContent).toBe('$not_math$\n');
      expect(container.querySelector('pre .katex')).toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it('normalizes model-style LaTeX delimiters without changing code', async () => {
    const markdown = [
      'Inline \\(q_t + K_t\\) formula.',
      '',
      '\\[ \\mathcal I_t = \\operatorname{TopK}(q_t) \\]',
      '',
      '`\\(inline_code\\)`',
      '',
      '    \\[indented_code\\]',
      '',
      '```tex',
      '\\[block_code\\]',
      '```',
    ].join('\n');
    const normalized = normalizeLatexMathDelimiters(markdown);

    expect(normalized).toContain('$q_t + K_t$');
    expect(normalized).toContain('$$ \\mathcal I_t = \\operatorname{TopK}(q_t) $$');
    expect(normalized).toContain('`\\(inline_code\\)`');
    expect(normalized).toContain('    \\[indented_code\\]');
    expect(normalized).toContain('```tex\n\\[block_code\\]\n```');

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(MarkdownView, { content: markdown })));
      });

      expect(container.querySelectorAll('.katex')).toHaveLength(2);
      expect(container.querySelector('.katex-display')).not.toBeNull();
      expect(container.querySelector('code')?.textContent).toBe('\\(inline_code\\)');
      const codeBlocks = Array.from(container.querySelectorAll('pre code'), code => code.textContent);
      expect(codeBlocks).toContain('\\[indented_code\\]\n');
      expect(codeBlocks).toContain('\\[block_code\\]\n');
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });
});
