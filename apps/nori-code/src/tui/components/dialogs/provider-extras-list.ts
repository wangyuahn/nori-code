/**
 * Extra models for `/provider` — coexist with auto-discover (stealth routes, etc.).
 *
 * List is not searchable so `D` can delete. Adding a model id is an in-dialog
 * input substate; thinking mode is dispatched to the host.
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

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { printableChar } from '#/tui/utils/printable-key';
import { pageView } from '#/tui/utils/paging';
import {
  thinkingLabel,
  type ExtraModelDraft,
} from '#/tui/utils/provider-extras';

const ADD_ROW_ID = '__add__';
const PAGE_SIZE = 8;
const ADD_LABEL = '[ Add extra model ]';

interface ExtraRow {
  readonly kind: 'extra';
  readonly id: string;
  readonly draft: ExtraModelDraft;
}

interface AddRow {
  readonly kind: 'add';
  readonly id: typeof ADD_ROW_ID;
}

type Row = ExtraRow | AddRow;

interface ConfirmState {
  readonly id: string;
  readonly label: string;
}

export interface ProviderExtrasListOptions {
  readonly providerId: string;
  readonly drafts: readonly ExtraModelDraft[];
  readonly onAdd: (modelId: string) => void;
  readonly onEdit: (draft: ExtraModelDraft) => void;
  readonly onDelete: (modelId: string) => void;
  readonly onClose: () => void;
}

function buildRows(drafts: readonly ExtraModelDraft[]): readonly Row[] {
  return [
    ...drafts.map((draft): ExtraRow => ({ kind: 'extra', id: draft.id, draft })),
    { kind: 'add', id: ADD_ROW_ID },
  ];
}

export class ProviderExtrasListComponent extends Container implements Focusable {
  focused = false;
  private opts: ProviderExtrasListOptions;
  private rows: readonly Row[];
  private selectedIndex: number;
  private confirm: ConfirmState | undefined;
  private adding = false;
  private readonly addInput = new Input();

  constructor(opts: ProviderExtrasListOptions) {
    super();
    this.opts = opts;
    this.rows = buildRows(opts.drafts);
    this.selectedIndex = 0;
    this.confirm = undefined;
    this.addInput.onSubmit = (value) => {
      this.submitAdd(value);
    };
  }

  setOptions(next: ProviderExtrasListOptions): void {
    const previousId = this.rows[this.selectedIndex]?.id;
    this.opts = next;
    this.rows = buildRows(next.drafts);
    this.confirm = undefined;
    this.adding = false;
    const idx = previousId === undefined ? -1 : this.rows.findIndex((row) => row.id === previousId);
    this.selectedIndex = idx >= 0 ? idx : Math.min(this.selectedIndex, Math.max(0, this.rows.length - 1));
    this.invalidate();
  }

  handleInput(data: string): void {
    if (this.adding) {
      this.handleAddInput(data);
      return;
    }
    if (this.confirm !== undefined) {
      this.handleConfirmInput(data);
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.opts.onClose();
      return;
    }

    const rows = this.rows;
    if (matchesKey(data, Key.up)) {
      if (rows.length === 0) return;
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.down)) {
      if (rows.length === 0) return;
      this.selectedIndex = Math.min(rows.length - 1, this.selectedIndex + 1);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.left) || matchesKey(data, Key.pageUp)) {
      if (rows.length === 0) return;
      this.selectedIndex = Math.max(0, this.selectedIndex - PAGE_SIZE);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.right) || matchesKey(data, Key.pageDown)) {
      if (rows.length === 0) return;
      this.selectedIndex = Math.min(rows.length - 1, this.selectedIndex + PAGE_SIZE);
      this.invalidate();
      return;
    }

    if (matchesKey(data, Key.enter)) {
      const selected = rows[this.selectedIndex];
      if (selected?.kind === 'add') {
        this.adding = true;
        this.invalidate();
        return;
      }
      if (selected?.kind === 'extra') this.opts.onEdit(selected.draft);
      return;
    }

    const ch = printableChar(data);
    if (ch === 'd' || ch === 'D') this.armDeleteConfirm();
  }

  override invalidate(): void {
    super.invalidate();
    this.addInput.invalidate();
  }

  override render(width: number): string[] {
    const hint = this.adding
      ? 'Enter submit · Esc cancel'
      : this.confirm !== undefined
        ? `${this.confirm.label} [y/N]`
        : '↑↓ navigate · Enter select · D delete · Esc cancel';

    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ` Extra models · ${this.opts.providerId}`),
      currentTheme.fg('textMuted', ` ${hint}`),
      '',
    ];

    lines.push(
      truncateToWidth(
        currentTheme.fg(
          'textMuted',
          ' Auto-discover stays on. Extra ids (stealth routes, etc.) survive refresh.',
        ),
        width,
      ),
    );
    lines.push('');

    if (this.adding) {
      this.addInput.focused = this.focused;
      const inputLine = this.addInput.render(Math.max(1, width - 2))[0] ?? '> ';
      lines.push(truncateToWidth(` ${inputLine}`, width));
    } else {
      const view = pageView(this.rows.length, this.selectedIndex, PAGE_SIZE);
      if (this.rows.length === 0) {
        lines.push(currentTheme.fg('textMuted', '  No extra models yet.'));
      } else {
        for (let i = view.start; i < view.end; i++) {
          const row = this.rows[i];
          if (row === undefined) continue;
          lines.push(...this.renderRow(row, i === this.selectedIndex, width));
        }
      }
      if (view.pageCount > 1) {
        lines.push('');
        lines.push(
          currentTheme.fg(
            'textMuted',
            ` Page ${String(view.page + 1)}/${String(view.pageCount)}`,
          ),
        );
      }
    }

    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderRow(row: Row, selected: boolean, width: number): string[] {
    const pointer = selected ? SELECT_POINTER : ' ';
    const pointerStyle = currentTheme.fg(selected ? 'primary' : 'textDim', `  ${pointer} `);
    if (row.kind === 'add') {
      const label = selected
        ? currentTheme.boldFg('primary', ADD_LABEL)
        : currentTheme.fg('primary', ADD_LABEL);
      return [truncateToWidth(pointerStyle + label, width)];
    }
    const name = selected
      ? currentTheme.boldFg('primary', row.draft.id)
      : currentTheme.fg('text', row.draft.id);
    const secondary = currentTheme.fg('textMuted', thinkingLabel(row.draft));
    const gap = '  ';
    const used = 4 + visibleWidth(row.draft.id) + gap.length + visibleWidth(thinkingLabel(row.draft));
    const pad = Math.max(1, width - used);
    return [truncateToWidth(pointerStyle + name + gap + secondary + ' '.repeat(pad), width)];
  }

  private handleAddInput(data: string): void {
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl('c')) ||
      matchesKey(data, Key.ctrl('d'))
    ) {
      this.adding = false;
      this.invalidate();
      return;
    }
    this.addInput.handleInput(data);
  }

  private submitAdd(value: string): void {
    const id = value.trim();
    if (id.length === 0) return;
    this.adding = false;
    this.opts.onAdd(id);
  }

  private armDeleteConfirm(): void {
    const selected = this.rows[this.selectedIndex];
    if (selected === undefined || selected.kind === 'add') return;
    this.confirm = {
      id: selected.draft.id,
      label: `Delete extra "${selected.draft.id}"?`,
    };
    this.invalidate();
  }

  private handleConfirmInput(data: string): void {
    const k = printableChar(data);
    if (matchesKey(data, Key.escape) || k === 'n' || k === 'N') {
      this.confirm = undefined;
      this.invalidate();
      return;
    }
    if (k === 'y' || k === 'Y') {
      const confirm = this.confirm;
      this.confirm = undefined;
      this.invalidate();
      if (confirm !== undefined) this.opts.onDelete(confirm.id);
    }
  }
}
