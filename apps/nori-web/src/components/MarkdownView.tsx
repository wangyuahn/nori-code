import { useEffect, useMemo, useRef } from 'react';
import { marked } from 'marked';
import { useI18n } from '../i18n';

marked.setOptions({ gfm: true, breaks: false });

export function MarkdownView({ content, className = '' }: { content: string; className?: string }) {
  const { tr } = useI18n();
  const articleRef = useRef<HTMLElement>(null);
  const html = useMemo(() => {
    const withoutFrontmatter = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
    return sanitizeMarkdown(marked.parse(withoutFrontmatter, { async: false }));
  }, [content]);
  useEffect(() => {
    const article = articleRef.current;
    if (!article) return;
    const cleanups: Array<() => void> = [];
    for (const pre of article.querySelectorAll('pre')) {
      const code = pre.querySelector('code');
      if (!code) continue;
      pre.classList.add('markdown-code-block');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'markdown-code-copy';
      button.textContent = tr('Copy', '复制');
      button.title = tr('Copy code', '复制代码');
      button.setAttribute('aria-label', tr('Copy code', '复制代码'));
      let resetTimer: ReturnType<typeof setTimeout> | undefined;
      const copy = () => {
        void copyText(code.textContent ?? '').then(() => {
          button.classList.add('copied');
          button.textContent = tr('Copied', '已复制');
          if (resetTimer !== undefined) clearTimeout(resetTimer);
          resetTimer = setTimeout(() => {
            button.classList.remove('copied');
            button.textContent = tr('Copy', '复制');
          }, 1600);
        });
      };
      button.addEventListener('click', copy);
      pre.append(button);
      cleanups.push(() => {
        if (resetTimer !== undefined) clearTimeout(resetTimer);
        button.removeEventListener('click', copy);
        button.remove();
      });
    }
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [html, tr]);
  return <article ref={articleRef} className={`markdown-view ${className}`.trim()} dangerouslySetInnerHTML={{ __html: html }} />;
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Hardened browser contexts can expose Clipboard API but deny writes.
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function sanitizeMarkdown(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  template.content.querySelectorAll('script, style, iframe, object, embed, form, input, button').forEach(element => {
    element.remove();
  });
  template.content.querySelectorAll('*').forEach(element => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (name.startsWith('on') || ((name === 'href' || name === 'src') && value.startsWith('javascript:'))) {
        element.removeAttribute(attribute.name);
      }
    }
    if (element instanceof HTMLAnchorElement) {
      element.rel = 'noreferrer noopener';
      element.target = '_blank';
    }
  });
  return template.innerHTML;
}
