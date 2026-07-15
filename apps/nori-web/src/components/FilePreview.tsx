import { useEffect, useMemo, useState } from 'react';
import { codeToHtml } from 'shiki';
import type { FsReadResponse } from '../api/client';
import { useI18n } from '../i18n';
import { Icon } from './Icon';
import { MarkdownView } from './MarkdownView';

interface FilePreviewProps {
  path: string;
  file: FsReadResponse | null;
  loading?: boolean;
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico']);

export function FilePreview({ path, file, loading }: FilePreviewProps) {
  const { tr } = useI18n();
  const [highlighted, setHighlighted] = useState('');
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
    setHighlighted('');
    if (!file || isImage || isMarkdown || file.is_binary) return;
    const language = file.language_id || extension || 'text';
    const themes = { light: 'github-light', dark: 'github-dark-default' } as const;
    void codeToHtml(file.content, { lang: language, themes, defaultColor: false })
      .catch(() => codeToHtml(file.content, { lang: 'text', themes, defaultColor: false }))
      .then(html => { if (!cancelled) setHighlighted(html); });
    return () => { cancelled = true; };
  }, [extension, file, isImage, isMarkdown]);

  if (loading) return <div className="file-preview-state"><span className="spinner" />{tr('Loading file', '正在加载文件')}</div>;
  if (!file) return <div className="file-preview-state"><Icon name="files" size={25} /><span>{tr('Select a file to preview', '选择文件以预览')}</span></div>;

  return <section className="file-preview">
    <header className="file-preview-header"><strong title={path}>{fileName}</strong><span>{file.language_id || extension || 'text'} · {formatBytes(file.size)}{file.truncated ? ` · ${tr('truncated', '已截断')}` : ''}</span></header>
    {isImage ? <div className="file-preview-image"><img src={imageSource} alt={fileName} /></div>
      : file.is_binary ? <div className="file-preview-state">{tr('Binary files cannot be previewed.', '无法预览二进制文件。')}</div>
      : isMarkdown ? <div className="markdown-preview-scroll"><MarkdownView content={file.content} /></div>
      : highlighted ? <div className="code-preview" dangerouslySetInnerHTML={{ __html: highlighted }} />
      : <div className="file-preview-state"><span className="spinner spinner-small" />{tr('Highlighting code', '正在高亮代码')}</div>}
  </section>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
