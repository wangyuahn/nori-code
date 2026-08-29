/**
 * Discuss meeting utterance — a partner or chair speaking in the main
 * transcript during Discuss, labeled with the speaker's name.
 */

import { truncateToWidth, visibleWidth, type Component } from '@nori-code/pi-tui';

import { currentTheme } from '#/tui/theme';

export class DiscussUtteranceComponent implements Component {
  private speakerName: string;
  private speaking: boolean;
  private text = '';

  constructor(speakerName: string, speaking = false) {
    this.speakerName = speakerName;
    this.speaking = speaking;
  }

  setSpeaking(speaking: boolean): void {
    this.speaking = speaking;
  }

  updateContent(text: string, opts?: { speaking?: boolean }): void {
    this.text = text;
    if (opts?.speaking !== undefined) this.speaking = opts.speaking;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];

    const name = currentTheme.boldFg('primary', this.speakerName);
    const speakingTag = this.speaking ? '  ' + currentTheme.fg('success', 'speaking') : '';
    const header = truncateToWidth(` ${name}${speakingTag}`, safeWidth);
    const lines: string[] = [header];
    const body = this.text.trim();
    if (body.length === 0) return lines.map((line) => truncateToWidth(line, safeWidth));

    const indent = '  ';
    const bodyWidth = Math.max(1, safeWidth - visibleWidth(indent));
    for (const wrapped of wrapPlainText(body, bodyWidth)) {
      lines.push(truncateToWidth(indent + currentTheme.fg('text', wrapped), safeWidth));
    }
    return lines;
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
