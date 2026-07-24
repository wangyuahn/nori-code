import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';
import { marked } from 'marked';
import markedKatex from 'marked-katex-extension';
import 'katex/dist/katex.min.css';
import { useI18n } from '../i18n';

marked.setOptions({ gfm: true, breaks: false });
marked.use(markedKatex({ throwOnError: false, nonStandard: true }));

export function MarkdownView({
  content,
  className = '',
  streaming = false,
}: {
  content: string;
  className?: string;
  streaming?: boolean;
}) {
  const { tr } = useI18n();
  const articleRef = useRef<HTMLElement>(null);
  const selectingRef = useRef(false);
  const [selectionSnapshot, setSelectionSnapshot] = useState<string | null>(null);
  const html = useMemo(() => {
    const normalizedEscapedBreaks = normalizeMarkdownEscapedLineBreaks(content);
    const withoutFrontmatter = normalizedEscapedBreaks.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
    const normalizedMath = normalizeLatexMathDelimiters(withoutFrontmatter);
    return sanitizeMarkdown(marked.parse(normalizedMath, { async: false }));
  }, [content]);
  const displayedHtml = selectionSnapshot ?? html;
  const displayedHtmlRef = useRef(displayedHtml);
  displayedHtmlRef.current = displayedHtml;
  const startSelecting = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (event.button !== 0 || isInteractiveTarget(event.target)) return;
    selectingRef.current = true;
    setSelectionSnapshot(current => current ?? displayedHtmlRef.current);
  }, []);
  useEffect(() => {
    const releaseSnapshotIfSelectionEnded = () => {
      if (selectingRef.current) return;
      const article = articleRef.current;
      const selection = window.getSelection();
      if (article !== null && selectionInside(selection, article)) return;
      setSelectionSnapshot(null);
    };
    const finishSelecting = () => {
      selectingRef.current = false;
      releaseSnapshotIfSelectionEnded();
    };
    document.addEventListener('selectionchange', releaseSnapshotIfSelectionEnded);
    document.addEventListener('mouseup', finishSelecting);
    return () => {
      document.removeEventListener('selectionchange', releaseSnapshotIfSelectionEnded);
      document.removeEventListener('mouseup', finishSelecting);
    };
  }, []);
  useEffect(() => {
    if (streaming || selectionSnapshot !== null) return;
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
  }, [displayedHtml, selectionSnapshot, streaming, tr]);
  return <MarkdownArticle
    articleRef={articleRef}
    className={`markdown-view ${className}`.trim()}
    html={displayedHtml}
    onMouseDown={startSelecting}
  />;
}

const MarkdownArticle = memo(function MarkdownArticle({
  articleRef,
  className,
  html,
  onMouseDown,
}: {
  articleRef: RefObject<HTMLElement | null>;
  className: string;
  html: string;
  onMouseDown: (event: ReactMouseEvent<HTMLElement>) => void;
}) {
  return <article
    ref={articleRef}
    className={className}
    onMouseDown={onMouseDown}
    dangerouslySetInnerHTML={{ __html: html }}
  />;
});

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    && target.closest('a, button, input, select, textarea, summary, [role="button"]') !== null;
}

function selectionInside(selection: Selection | null, article: HTMLElement): boolean {
  if (selection === null || selection.isCollapsed) return false;
  const anchor = selection.anchorNode;
  const focus = selection.focusNode;
  return (anchor !== null && article.contains(anchor))
    || (focus !== null && article.contains(focus));
}

export function normalizeLatexMathDelimiters(markdown: string): string {
  const lines = markdown.split(/(\r?\n)/);
  let fence: { marker: '`' | '~'; length: number } | undefined;
  let inlineTicks = 0;

  return lines.map((line) => {
    if (/^\r?\n$/.test(line)) return line;

    const fenceMatch = /^(?: {0,3})(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as '`' | '~';
      const length = fenceMatch[1].length;
      if (!fence) {
        fence = { marker, length };
      } else if (fence.marker === marker && length >= fence.length) {
        fence = undefined;
      }
      return line;
    }
    if (fence) return line;
    if (inlineTicks === 0 && /^(?: {4}|\t)/.test(line)) return line;

    let normalized = '';
    for (let index = 0; index < line.length;) {
      if (line[index] === '`') {
        let end = index + 1;
        while (line[end] === '`') end += 1;
        const runLength = end - index;
        if (inlineTicks === 0) inlineTicks = runLength;
        else if (inlineTicks === runLength) inlineTicks = 0;
        normalized += line.slice(index, end);
        index = end;
        continue;
      }

      const next = line[index + 1];
      if (
        inlineTicks === 0
        && line[index] === '\\'
        && line[index - 1] !== '\\'
        && (next === '[' || next === ']' || next === '(' || next === ')')
      ) {
        normalized += next === '[' || next === ']' ? '$$' : '$';
        index += 2;
        continue;
      }

      normalized += line[index];
      index += 1;
    }
    return normalized;
  }).join('');
}

/**
 * Some model/provider paths return Markdown line breaks as the two literal
 * characters `\\` and `n`. Decode those only in Markdown prose so that lists,
 * paragraphs, and fenced code are parsed correctly without changing source
 * code or inline-code content.
 */
export function normalizeMarkdownEscapedLineBreaks(markdown: string): string {
  const segments = markdown.split(/(\r?\n)/);
  let fence: { marker: '`' | '~'; length: number } | undefined;
  let inlineTicks = 0;

  return segments.map(segment => {
    if (/^\r?\n$/.test(segment)) return segment;

    const fenceMatch = /^(?: {0,3})(`{3,}|~{3,})/.exec(segment);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as '`' | '~';
      const length = fenceMatch[1].length;
      if (!fence) {
        fence = { marker, length };
      } else if (fence.marker === marker && length >= fence.length) {
        fence = undefined;
      }
      return segment;
    }
    if (fence) return segment;

    let normalized = '';
    for (let index = 0; index < segment.length;) {
      if (segment[index] === '`') {
        let end = index + 1;
        while (segment[end] === '`') end += 1;
        const runLength = end - index;
        if (inlineTicks === 0) inlineTicks = runLength;
        else if (inlineTicks === runLength) inlineTicks = 0;
        normalized += segment.slice(index, end);
        index = end;
        continue;
      }

      if (segment[index] !== '\\' || inlineTicks !== 0) {
        normalized += segment[index];
        index += 1;
        continue;
      }

      let slashEnd = index;
      while (segment[slashEnd] === '\\') slashEnd += 1;
      const slashCount = slashEnd - index;
      const next = segment[slashEnd];
      const isCrLf = next === 'r' && segment[slashEnd + 1] === '\\' && segment[slashEnd + 2] === 'n';
      const encodedLength = isCrLf ? 3 : next === 'n' || next === 'r' ? 1 : 0;
      if (encodedLength > 0 && slashCount % 2 === 1) {
        normalized += '\\'.repeat(Math.floor(slashCount / 2));
        normalized += isCrLf ? '\r\n' : next === 'r' ? '\r' : '\n';
        index = slashEnd + encodedLength;
        continue;
      }

      normalized += segment.slice(index, slashEnd);
      index = slashEnd;
    }
    return normalized;
  }).join('');
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
