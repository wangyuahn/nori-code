/**
 * Department pane — read-only Discuss meeting track or sibling Chat.
 *
 * Discuss on: forced meeting UI. Discuss off: Chat. Closing the pane does not
 * exit Discuss or the viewed member session.
 */

import { Container, truncateToWidth, visibleWidth } from '@nori-code/pi-tui';

import { currentTheme } from '#/tui/theme';
import type { DepartmentPaneMode } from '#/tui/utils/team-tree';

export interface DepartmentPaneLine {
  readonly id: string;
  readonly speakerName: string;
  readonly text: string;
  readonly meta?: string;
  readonly speaking?: boolean;
}

export interface DepartmentPaneModel {
  readonly mode: DepartmentPaneMode;
  readonly topic?: string;
  readonly speakingName?: string;
  readonly lines: readonly DepartmentPaneLine[];
  readonly emptyHint: string;
}

export interface DepartmentPaneOptions {
  readonly terminalRows: () => number;
  readonly canUseScrollKeys: () => boolean;
}

const MIN_BODY_LINES = 3;
const PANE_HIDE_HINT = 'Ctrl-Y hide · Esc hide';

export class DepartmentPaneComponent extends Container {
  private model: DepartmentPaneModel;
  private followTail = true;
  private scrollTop = 0;
  private maxScrollTop = 0;

  constructor(
    model: DepartmentPaneModel,
    private readonly options: DepartmentPaneOptions,
  ) {
    super();
    this.model = model;
  }

  setModel(model: DepartmentPaneModel): void {
    this.model = model;
    this.followTail = true;
  }

  scroll(direction: 'up' | 'down'): boolean {
    if (this.maxScrollTop <= 0) return false;
    const current = this.followTail ? this.maxScrollTop : this.scrollTop;
    const next =
      direction === 'up' ? Math.max(0, current - 1) : Math.min(this.maxScrollTop, current + 1);
    this.scrollTop = next;
    this.followTail = next === this.maxScrollTop;
    return true;
  }

  override render(width: number): string[] {
    const safeWidth = Math.max(4, width);
    const title = this.model.mode === 'discuss' ? ' Discuss' : ' Chat';
    const hintParts = [PANE_HIDE_HINT];
    if (this.options.canUseScrollKeys() && this.maxScrollTop > 0) {
      hintParts.unshift('↑↓ scroll');
    }
    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(safeWidth)),
      truncateToWidth(
        currentTheme.boldFg('primary', title) +
          currentTheme.fg('textMuted', `  ${hintParts.join(' · ')}`),
        safeWidth,
      ),
    ];
    const topic = this.model.topic?.trim();
    if (this.model.mode === 'discuss' && topic !== undefined && topic.length > 0) {
      lines.push(truncateToWidth(currentTheme.fg('textMuted', ` Topic: ${topic}`), safeWidth));
    }
    lines.push('');

    const body = this.renderBody(Math.max(1, safeWidth));
    lines.push(...body.map((line) => truncateToWidth(line, safeWidth)));
    lines.push(currentTheme.fg('primary', '─'.repeat(safeWidth)));
    return lines.map((line) => truncateToWidth(line, safeWidth));
  }

  private renderBody(width: number): string[] {
    const raw: string[] = [];
    if (this.model.lines.length === 0) {
      raw.push(currentTheme.fg('textMuted', ` ${this.model.emptyHint}`));
    } else {
      for (const line of this.model.lines) {
        raw.push(...this.renderLine(line, width));
      }
    }
    if (this.model.speakingName !== undefined && this.model.speakingName.length > 0) {
      raw.push(
        currentTheme.fg('success', ` ${this.model.speakingName} is speaking…`),
      );
    }
    return this.fitBody(raw);
  }

  private renderLine(line: DepartmentPaneLine, width: number): string[] {
    const name = currentTheme.boldFg('primary', line.speakerName);
    const speaking = line.speaking === true ? '  ' + currentTheme.fg('success', 'speaking') : '';
    const meta =
      line.meta !== undefined && line.meta.length > 0
        ? '  ' + currentTheme.fg('textMuted', line.meta)
        : '';
    const header = truncateToWidth(` ${name}${speaking}${meta}`, width);
    const out: string[] = [header];
    const body = line.text.trim();
    if (body.length === 0) return out;
    const indent = '  ';
    const bodyWidth = Math.max(1, width - visibleWidth(indent));
    for (const wrapped of wrapPlainText(body, bodyWidth)) {
      out.push(truncateToWidth(indent + currentTheme.fg('text', wrapped), width));
    }
    return out;
  }

  private fitBody(lines: string[]): string[] {
    const limit = this.bodyLimit();
    if (lines.length <= limit) {
      this.followTail = true;
      this.scrollTop = 0;
      this.maxScrollTop = 0;
      return lines;
    }
    this.maxScrollTop = lines.length - limit;
    if (this.followTail) this.scrollTop = this.maxScrollTop;
    else this.scrollTop = Math.min(this.scrollTop, this.maxScrollTop);
    return lines.slice(this.scrollTop, this.scrollTop + limit);
  }

  private bodyLimit(): number {
    const rows = this.options.terminalRows();
    if (!Number.isFinite(rows) || rows <= 0) return MIN_BODY_LINES + 4;
    return Math.max(MIN_BODY_LINES, Math.floor(rows / 4));
  }
}

function wrapPlainText(text: string, width: number): string[] {
  const maxWidth = Math.max(1, width);
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.length === 0) {
      lines.push('');
      continue;
    }
    const words = paragraph.split(/\s+/).filter((word) => word.length > 0);
    let current = '';
    for (const word of words) {
      const candidate = current.length === 0 ? word : `${current} ${word}`;
      if (visibleWidth(candidate) <= maxWidth) {
        current = candidate;
        continue;
      }
      if (current.length > 0) lines.push(current);
      current = visibleWidth(word) <= maxWidth ? word : truncateToWidth(word, maxWidth);
    }
    if (current.length > 0) lines.push(current);
  }
  return lines;
}
