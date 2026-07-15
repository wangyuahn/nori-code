import { useMemo } from 'react';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: false });

export function MarkdownView({ content, className = '' }: { content: string; className?: string }) {
  const html = useMemo(() => {
    const withoutFrontmatter = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
    return sanitizeMarkdown(marked.parse(withoutFrontmatter, { async: false }));
  }, [content]);
  return <article className={`markdown-view ${className}`.trim()} dangerouslySetInnerHTML={{ __html: html }} />;
}

function sanitizeMarkdown(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  template.content.querySelectorAll('script, style, iframe, object, embed, form, input, button').forEach(element => element.remove());
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
