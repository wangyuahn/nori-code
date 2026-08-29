/**
 * Searchable skill list for `/skills`.
 *
 * Enter activates a no-arg skill or restores `/name ` into the editor when
 * the skill takes arguments.
 */

import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@nori-code/pi-tui';
import type { SkillSummary } from '@nori-code/sdk';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { SearchableList } from '#/tui/utils/searchable-list';

export interface SkillPickerItem {
  readonly slashName: string;
  readonly skill: SkillSummary;
}

export interface SkillsSelectorOptions {
  readonly items: readonly SkillPickerItem[];
  readonly onSelect: (item: SkillPickerItem) => void;
  readonly onCancel: () => void;
}

function itemSearchText(item: SkillPickerItem): string {
  return `${item.slashName} ${item.skill.name} ${item.skill.description}`;
}

export class SkillsSelectorComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: SkillsSelectorOptions;
  private readonly list: SearchableList<SkillPickerItem>;

  constructor(opts: SkillsSelectorOptions) {
    super();
    this.opts = opts;
    this.list = new SearchableList({
      items: opts.items,
      toSearchText: itemSearchText,
      searchable: true,
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.list.clearQuery()) return;
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.list.pageUp();
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.list.pageDown();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const chosen = this.list.selected();
      if (chosen !== undefined) this.opts.onSelect(chosen);
      return;
    }
    this.list.handleKey(data);
  }

  override render(width: number): string[] {
    const view = this.list.view();
    const titleSuffix =
      view.query.length === 0 ? currentTheme.fg('textMuted', '  (type to search)') : '';
    const hintParts = ['↑↓ navigate'];
    if (view.page.pageCount > 1) hintParts.push('←→ page');
    if (view.query.length > 0) hintParts.push('Backspace clear');
    hintParts.push('Enter select', 'Esc cancel');

    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ' Skills') + titleSuffix,
      currentTheme.fg('textMuted', ` ${hintParts.join(' · ')}`),
      '',
    ];

    if (view.query.length > 0) {
      lines.push(currentTheme.fg('primary', ' Search: ') + currentTheme.fg('text', view.query));
    }

    if (view.items.length === 0) {
      const empty = this.opts.items.length === 0 ? 'No skills' : 'No matches';
      lines.push(currentTheme.fg('textMuted', `   ${empty}`));
    } else {
      const nameCap = Math.max(8, Math.floor(width * 0.4));
      let nameWidth = 0;
      for (let i = view.page.start; i < view.page.end; i++) {
        const item = view.items[i];
        if (item !== undefined) nameWidth = Math.max(nameWidth, visibleWidth(item.slashName));
      }
      nameWidth = Math.min(nameWidth, nameCap);

      for (let i = view.page.start; i < view.page.end; i++) {
        const item = view.items[i];
        if (item === undefined) continue;
        const isSelected = i === view.selectedIndex;
        const pointer = isSelected ? SELECT_POINTER : ' ';
        const truncatedName = truncateToWidth(item.slashName, nameWidth, '…');
        const namePad = ' '.repeat(Math.max(0, nameWidth - visibleWidth(truncatedName)));
        const description = item.skill.description.trim();
        let line = currentTheme.fg(isSelected ? 'primary' : 'textDim', `  ${pointer} `);
        line +=
          (isSelected
            ? currentTheme.boldFg('primary', truncatedName)
            : currentTheme.fg('text', truncatedName)) + namePad;
        if (description.length > 0) {
          line += '  ' + currentTheme.fg('textMuted', description);
        }
        lines.push(truncateToWidth(line, width));
      }
    }

    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width));
  }
}
