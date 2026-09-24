import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/styles/nori-theme.css'), 'utf8');

afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
  delete document.documentElement.dataset.theme;
});

describe('visual theme contract', () => {
  it('gives the light shell a flat composer, a bordered todo strip, and colored diffs', () => {
    mountTheme('light');
    const shell = document.querySelector<HTMLElement>('.codex-layout');
    if (!shell) throw new Error('shell missing');
    const input = shell.querySelector('.chat-input-area');
    const strip = shell.querySelector('.composer-context-strip');
    const sidebar = shell.querySelector('.sidebar');
    const card = shell.querySelector('.card');
    const name = shell.querySelector('.file-tree-name');
    const added = shell.querySelector('.edit-diff-add');
    const removed = shell.querySelector('.edit-diff-del');
    if (!input || !strip || !sidebar || !card || !name || !added || !removed) throw new Error('fixture missing');

    expect(getComputedStyle(input).boxShadow).toBe('none');
    expect(getComputedStyle(sidebar).boxShadow).toBe('none');
    expect(getComputedStyle(card).boxShadow).toBe('none');
    expect(getComputedStyle(shell).getPropertyValue('--nori-shadow').trim()).toBe('none');

    const rules = [...(document.styleSheets[0]?.cssRules ?? [])];
    const ruleText = (selector: string) => rules.find(rule => rule.cssText.startsWith(selector))?.cssText ?? '';
    const stripRule = ruleText('.composer-context-strip {');
    expect(stripRule).toContain('border: 1px solid var(--nori-border-strong)');
    expect(stripRule).toContain('background: var(--nori-surface-raised)');
    expect(ruleText('.file-tree-name {')).toContain('font-size: calc(13px * var(--nori-ui-font-scale))');
    expect(ruleText('.edit-diff-add {')).toContain('var(--nori-success)');
    expect(ruleText('.edit-diff-del {')).toContain('var(--nori-danger)');
    expect(getComputedStyle(name).fontSize === '13px' || ruleText('.file-tree-name {').includes('13px')).toBe(true);
  });

  it('keeps a shadow on the dark composer', () => {
    mountTheme('dark');
    const input = document.querySelector('.chat-input-area');
    if (!input) throw new Error('composer missing');
    expect(getComputedStyle(input).boxShadow).not.toBe('none');
    const shell = document.querySelector('.codex-layout');
    if (!shell) throw new Error('shell missing');
    expect(getComputedStyle(shell).getPropertyValue('--nori-shadow').trim()).not.toBe('none');
  });
});

function mountTheme(theme: 'light' | 'dark'): void {
  document.documentElement.dataset.theme = theme;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
  const shell = document.createElement('div');
  shell.className = 'codex-layout';
  shell.dataset.theme = theme;
  shell.innerHTML = `
    <aside class="sidebar expanded"></aside>
    <div class="chat-input-area"></div>
    <div class="composer-context-strip"></div>
    <div class="card"></div>
    <div class="file-tree-name">App.tsx</div>
    <div class="edit-diff-add">+const mode = "yolo";</div>
    <div class="edit-diff-del">-const mode = "manual";</div>
  `;
  document.body.append(shell);
}
