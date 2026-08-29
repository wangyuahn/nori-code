/**
 * Single-line rounded text input (DESIGN §9). Geometry matches
 * `ApiKeyInputDialogComponent`; the value is shown in the clear (not masked).
 */

import {
  Container,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@nori-code/pi-tui';

import { currentTheme } from '#/tui/theme';

export type TextInputDialogResult =
  | { readonly kind: 'ok'; readonly value: string }
  | { readonly kind: 'cancel' };

export interface TextInputDialogOptions {
  readonly title: string;
  readonly subtitle?: string;
  readonly initialValue?: string;
  readonly allowEmpty?: boolean;
  readonly emptyHint?: string;
  readonly onDone: (result: TextInputDialogResult) => void;
}

const FOOTER = 'Enter submit · Esc cancel';
const DEFAULT_EMPTY_HINT = 'Value cannot be empty.';

export class TextInputDialogComponent extends Container implements Focusable {
  focused = false;

  private readonly input = new Input();
  private readonly opts: TextInputDialogOptions;
  private done = false;
  private emptyHinted = false;

  constructor(opts: TextInputDialogOptions) {
    super();
    this.opts = opts;
    const initial = opts.initialValue ?? '';
    // Inserting character-by-character leaves the cursor at the end; `setValue`
    // would keep it at 0.
    for (const ch of initial) this.input.handleInput(ch);
    this.input.onSubmit = (value) => {
      this.submit(value);
    };
  }

  handleInput(data: string): void {
    if (this.done) return;
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl('c')) ||
      matchesKey(data, Key.ctrl('d'))
    ) {
      this.cancel();
      return;
    }
    if (this.emptyHinted) {
      this.emptyHinted = false;
    }
    this.input.handleInput(data);
  }

  override invalidate(): void {
    super.invalidate();
    this.input.invalidate();
  }

  override render(width: number): string[] {
    this.input.focused = this.focused && !this.done;

    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];
    const innerWidth = Math.max(1, safeWidth - 4);
    const pad = '  ';

    const border = (s: string): string => currentTheme.fg('primary', s);
    const titleStyled = currentTheme.boldFg('textStrong', this.opts.title);
    const subtitleText = this.emptyHinted
      ? (this.opts.emptyHint ?? DEFAULT_EMPTY_HINT)
      : this.opts.subtitle;
    const footerStyled = currentTheme.fg('textDim', FOOTER);

    const titleLine = truncateToWidth(titleStyled, innerWidth, '…');
    const footerLine = truncateToWidth(footerStyled, innerWidth, '…');
    const inputLine = this.input.render(innerWidth)[0] ?? '> ';

    const contentLines: string[] = [titleLine, ''];
    if (subtitleText !== undefined && subtitleText.length > 0) {
      contentLines.push(
        truncateToWidth(currentTheme.fg('textDim', subtitleText), innerWidth, '…'),
        '',
      );
    }
    contentLines.push(inputLine, '', footerLine);

    if (safeWidth < 4) {
      return ['', ...contentLines.map((line) => truncateToWidth(line, safeWidth, '…'))];
    }

    const lines: string[] = [
      '',
      border('╭' + '─'.repeat(safeWidth - 2) + '╮'),
      border('│') + ' '.repeat(safeWidth - 2) + border('│'),
    ];

    for (const content of contentLines) {
      const vis = visibleWidth(content);
      const rightPad = Math.max(0, innerWidth - vis);
      lines.push(border('│') + pad + content + ' '.repeat(rightPad) + border('│'));
    }

    lines.push(border('│') + ' '.repeat(safeWidth - 2) + border('│'));
    lines.push(border('╰' + '─'.repeat(safeWidth - 2) + '╯'));
    lines.push('');

    return lines.map((line) => truncateToWidth(line, safeWidth, '…'));
  }

  private submit(value: string): void {
    if (this.done) return;
    const trimmed = value.trim();
    if (trimmed.length === 0 && this.opts.allowEmpty !== true) {
      this.emptyHinted = true;
      return;
    }
    this.done = true;
    this.opts.onDone({ kind: 'ok', value: trimmed });
  }

  private cancel(): void {
    if (this.done) return;
    this.done = true;
    this.opts.onDone({ kind: 'cancel' });
  }
}
