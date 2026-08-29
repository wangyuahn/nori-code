/**
 * Multi-select thinking efforts for an extra / stealth model.
 * Space toggles in place; Enter submits the enabled set.
 */

import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  type Focusable,
} from '@nori-code/pi-tui';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { printableChar } from '#/tui/utils/printable-key';
import { COMMON_THINKING_EFFORTS } from '#/tui/utils/provider-extras';

export interface ExtraEffortTogglesOptions {
  readonly selected: readonly string[];
  readonly onSubmit: (efforts: readonly string[]) => void;
  readonly onCancel: () => void;
}

export class ExtraEffortTogglesComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: ExtraEffortTogglesOptions;
  private readonly enabled = new Set<string>();
  private selectedIndex = 0;

  constructor(opts: ExtraEffortTogglesOptions) {
    super();
    this.opts = opts;
    for (const effort of opts.selected) this.enabled.add(effort);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(COMMON_THINKING_EFFORTS.length - 1, this.selectedIndex + 1);
      this.invalidate();
      return;
    }
    const decoded = printableChar(data);
    if (matchesKey(data, Key.space) || decoded === ' ') {
      const effort = COMMON_THINKING_EFFORTS[this.selectedIndex];
      if (effort === undefined) return;
      if (this.enabled.has(effort)) this.enabled.delete(effort);
      else this.enabled.add(effort);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const efforts = COMMON_THINKING_EFFORTS.filter((effort) => this.enabled.has(effort));
      this.opts.onSubmit(efforts);
    }
  }

  override render(width: number): string[] {
    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ' Thinking efforts'),
      currentTheme.fg('textMuted', ' ↑↓ navigate · Space toggle · Enter apply · Esc cancel'),
      '',
    ];

    for (let i = 0; i < COMMON_THINKING_EFFORTS.length; i++) {
      const effort = COMMON_THINKING_EFFORTS[i]!;
      const selected = i === this.selectedIndex;
      const pointer = selected ? SELECT_POINTER : ' ';
      const name = selected
        ? currentTheme.boldFg('primary', effort)
        : currentTheme.fg('text', effort);
      const on = this.enabled.has(effort);
      const status = on
        ? currentTheme.fg('success', '  enabled')
        : currentTheme.fg('textDim', '  disabled');
      const prefix = currentTheme.fg(selected ? 'primary' : 'textDim', `  ${pointer} `);
      lines.push(truncateToWidth(prefix + name + status, width));
    }

    lines.push('');
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width));
  }
}
