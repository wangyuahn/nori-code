import { visibleWidth } from '@nori-code/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import {
  TextInputDialogComponent,
  type TextInputDialogResult,
} from '#/tui/components/dialogs/text-input-dialog';

const ANSI = /\u001B\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');
const ESC = String.fromCodePoint(27);

function plain(dialog: TextInputDialogComponent, width = 60): string {
  return dialog.render(width).map(strip).join('\n');
}

describe('TextInputDialogComponent', () => {
  it('renders a rounded box with submit/cancel footer', () => {
    const dialog = new TextInputDialogComponent({
      title: 'Memory Base URL',
      subtitle: 'http(s) endpoint for embedding requests.',
      onDone: vi.fn(),
    });
    dialog.focused = true;
    const text = plain(dialog);

    expect(text).toContain('╭');
    expect(text).toContain('╯');
    expect(text).toContain('Memory Base URL');
    expect(text).toContain('http(s) endpoint for embedding requests.');
    expect(text).toContain('Enter submit · Esc cancel');
  });

  it('shows the initial value in the clear and submits on Enter', () => {
    const onDone = vi.fn<(result: TextInputDialogResult) => void>();
    const dialog = new TextInputDialogComponent({
      title: 'Embedding model',
      initialValue: 'text-embedding-3-small',
      allowEmpty: true,
      onDone,
    });
    dialog.focused = true;
    expect(plain(dialog)).toContain('text-embedding-3-small');
    expect(plain(dialog)).not.toContain('•'.repeat(5));

    dialog.handleInput('\r');
    expect(onDone).toHaveBeenCalledWith({ kind: 'ok', value: 'text-embedding-3-small' });
  });

  it('rejects an empty submit unless allowEmpty is set', () => {
    const onDone = vi.fn();
    const dialog = new TextInputDialogComponent({
      title: 'Required field',
      onDone,
    });
    dialog.focused = true;
    dialog.handleInput('\r');
    expect(onDone).not.toHaveBeenCalled();
    expect(plain(dialog)).toContain('Value cannot be empty.');
  });

  it('submits an empty string when allowEmpty is true', () => {
    const onDone = vi.fn();
    const dialog = new TextInputDialogComponent({
      title: 'Optional field',
      allowEmpty: true,
      onDone,
    });
    dialog.focused = true;
    dialog.handleInput('\r');
    expect(onDone).toHaveBeenCalledWith({ kind: 'ok', value: '' });
  });

  it('cancels on Esc', () => {
    const onDone = vi.fn();
    const dialog = new TextInputDialogComponent({
      title: 'Memory Base URL',
      onDone,
    });
    dialog.handleInput(ESC);
    expect(onDone).toHaveBeenCalledWith({ kind: 'cancel' });
  });

  it('keeps every line within narrow widths', () => {
    const dialog = new TextInputDialogComponent({
      title: 'Memory Base URL',
      initialValue: 'https://api.example.com/v1/embeddings',
      onDone: vi.fn(),
    });
    dialog.focused = true;
    for (const width of [39, 20, 10, 4]) {
      for (const line of dialog.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});
