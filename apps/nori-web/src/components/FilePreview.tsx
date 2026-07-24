import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { codeToHtml } from 'shiki';
import type { FsReadResponse } from '../api/client';
import { useI18n } from '../i18n';
import { Icon } from './Icon';
import { MarkdownView } from './MarkdownView';
import { referenceProjectFile } from '../projectFileReference';

interface FilePreviewProps {
  path: string;
  file: FsReadResponse | null;
  loading?: boolean;
  revealLine?: number;
  onRefresh?: () => void | Promise<void>;
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico']);

export function FilePreview({ path, file, loading, revealLine, onRefresh }: FilePreviewProps) {
  const { tr } = useI18n();
  const [highlighted, setHighlighted] = useState<{ path: string; html: string } | null>(null);
  const fileName = path.replace(/\\/g, '/').split('/').at(-1) ?? path;
  const extension = fileName.includes('.') ? fileName.split('.').at(-1)?.toLowerCase() ?? '' : '';
  const isImage = IMAGE_EXTENSIONS.has(extension) || file?.mime.startsWith('image/') === true;
  const isMarkdown = extension === 'md' || extension === 'mdx' || file?.language_id === 'markdown';
  const imageSource = useMemo(() => {
    if (!file || !isImage) return '';
    if (file.content.startsWith('data:')) return file.content;
    return `data:${file.mime || 'application/octet-stream'};base64,${file.content}`;
  }, [file, isImage]);

  useEffect(() => {
    let cancelled = false;
    if (!file || isImage || isMarkdown || file.is_binary) return;
    const language = file.language_id || extension || 'text';
    const themes = { light: 'github-light', dark: 'github-dark-default' } as const;
    void codeToHtml(file.content, { lang: language, themes, defaultColor: false })
      .catch(() => codeToHtml(file.content, { lang: 'text', themes, defaultColor: false }))
      .then(html => { if (!cancelled) setHighlighted({ path, html }); });
    return () => { cancelled = true; };
  }, [extension, file?.content, file?.is_binary, file?.language_id, isImage, isMarkdown, path]);

  const highlightedHtml = highlighted?.path === path ? highlighted.html : '';

  useEffect(() => {
    if (!revealLine || !highlightedHtml) return;
    const timer = requestAnimationFrame(() => {
      const lines = document.querySelectorAll<HTMLElement>('.file-preview .code-preview .line');
      for (const line of lines) line.classList.remove('lsp-reveal-line');
      const target = lines.item(revealLine - 1);
      target?.classList.add('lsp-reveal-line');
      if (target && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ block: 'center' });
      }
    });
    return () => cancelAnimationFrame(timer);
  }, [highlightedHtml, revealLine]);

  if (loading && !file) return <div className="file-preview-state"><span className="spinner" />{tr('Loading file', '正在加载文件')}</div>;
  if (!file) return <div className="file-preview-state"><Icon name="files" size={25} /><span>{tr('Select a file to preview', '选择文件以预览')}</span></div>;

  return <section className="file-preview">
    <header className="file-preview-header"><div><strong title={path}>{fileName}</strong><span>{file.language_id || extension || 'text'} · {formatBytes(file.size)}{file.truncated ? ` · ${tr('truncated', '已截断')}` : ''}{loading ? ` · ${tr('refreshing', '刷新中')}` : ''}</span></div><span className="file-preview-actions">{onRefresh && <button type="button" className="file-preview-refresh" onClick={() => void onRefresh()} title={tr('Refresh preview', '刷新预览')} aria-label={tr('Refresh preview', '刷新预览')}><Icon name="refresh" size={13}/></button>}<button type="button" className="file-preview-reference" onClick={() => referenceProjectFile(path)} title={tr('Reference in chat', '引用到对话')} aria-label={tr('Reference in chat', '引用到对话')}><Icon name="paperclip" size={13}/></button></span></header>
    {isImage ? <div className="file-preview-image"><img src={imageSource} alt={fileName} /></div>
      : file.is_binary ? <div className="file-preview-state">{tr('Binary files cannot be previewed.', '无法预览二进制文件。')}</div>
      : isMarkdown ? <div className="markdown-preview-scroll"><MarkdownView content={file.content} /></div>
      : highlightedHtml ? <SelectionStableCodePreview key={path} html={highlightedHtml} />
      : <div className="file-preview-state"><span className="spinner spinner-small" />{tr('Highlighting code', '正在高亮代码')}</div>}
  </section>;
}

const SelectionStableCodePreview = memo(function SelectionStableCodePreview({ html }: { html: string }) {
  const previewRef = useRef<HTMLDivElement>(null);
  const selectingRef = useRef(false);
  const pendingHtmlRef = useRef<string | null>(null);
  const appliedHtmlRef = useRef('');

  const applyHtml = useCallback((nextHtml: string) => {
    const preview = previewRef.current;
    if (preview === null || appliedHtmlRef.current === nextHtml) return;
    preview.innerHTML = nextHtml;
    preview.querySelectorAll<HTMLElement>('.line').forEach((line, index) => {
      line.dataset.lineNumber = String(index + 1);
    });
    appliedHtmlRef.current = nextHtml;
  }, []);

  const applyPendingIfSelectionEnded = useCallback(() => {
    if (selectingRef.current) return;
    const preview = previewRef.current;
    if (preview !== null && selectionInside(window.getSelection(), preview)) return;
    const pending = pendingHtmlRef.current;
    if (pending === null) return;
    pendingHtmlRef.current = null;
    applyHtml(pending);
  }, [applyHtml]);

  useEffect(() => {
    const preview = previewRef.current;
    if (selectingRef.current || (preview !== null && selectionInside(window.getSelection(), preview))) {
      pendingHtmlRef.current = html;
      return;
    }
    pendingHtmlRef.current = null;
    applyHtml(html);
  }, [applyHtml, html]);

  useEffect(() => {
    const finishSelecting = () => {
      selectingRef.current = false;
      applyPendingIfSelectionEnded();
    };
    document.addEventListener('selectionchange', applyPendingIfSelectionEnded);
    document.addEventListener('mouseup', finishSelecting);
    return () => {
      document.removeEventListener('selectionchange', applyPendingIfSelectionEnded);
      document.removeEventListener('mouseup', finishSelecting);
    };
  }, [applyPendingIfSelectionEnded]);

  const startSelecting = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button === 0) selectingRef.current = true;
  };

  return <div
    ref={previewRef}
    className="code-preview"
    onMouseDown={startSelecting}
  />;
});

function selectionInside(selection: Selection | null, element: HTMLElement): boolean {
  if (selection === null || selection.isCollapsed) return false;
  const anchor = selection.anchorNode;
  const focus = selection.focusNode;
  return (anchor !== null && element.contains(anchor))
    || (focus !== null && element.contains(focus));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
