import { describe, expect, it, vi } from 'vitest';

import { ExtraEffortTogglesComponent } from '#/tui/components/dialogs/extra-effort-toggles';
import { ProviderExtrasListComponent } from '#/tui/components/dialogs/provider-extras-list';
import { SELECT_POINTER } from '#/tui/constant/symbols';

const ANSI = /\u001B\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');
const ESC = String.fromCodePoint(27);

describe('ProviderExtrasListComponent', () => {
  it('lists extras without requiring auto-discover off', () => {
    const picker = new ProviderExtrasListComponent({
      providerId: 'openrouter',
      drafts: [
        {
          id: 'stealth/ox-alpha',
          thinking: 'efforts',
          supportEfforts: ['low', 'medium', 'high'],
          defaultEffort: 'medium',
        },
      ],
      onAdd: vi.fn(),
      onEdit: vi.fn(),
      onDelete: vi.fn(),
      onClose: vi.fn(),
    });
    const out = picker.render(80).map(strip).join('\n');
    expect(out).toContain('Extra models');
    expect(out).toContain('Auto-discover stays on');
    expect(out).toContain('stealth/ox-alpha');
    expect(out).toContain(SELECT_POINTER);
    expect(out).toContain('Add extra model');
    expect(out).toContain('Esc cancel');
  });

  it('edits thinking on Enter and deletes with D', () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const picker = new ProviderExtrasListComponent({
      providerId: 'openrouter',
      drafts: [
        {
          id: 'stealth/ox-alpha',
          thinking: 'unsupported',
          supportEfforts: [],
          defaultEffort: '',
        },
      ],
      onAdd: vi.fn(),
      onEdit,
      onDelete,
      onClose: vi.fn(),
    });
    picker.handleInput('\r');
    expect(onEdit).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'stealth/ox-alpha' }),
    );
    picker.handleInput('D');
    expect(picker.render(80).map(strip).join('\n')).toContain('[y/N]');
    picker.handleInput('y');
    expect(onDelete).toHaveBeenCalledWith('stealth/ox-alpha');
  });

  it('cancels on Esc', () => {
    const onClose = vi.fn();
    const picker = new ProviderExtrasListComponent({
      providerId: 'openrouter',
      drafts: [],
      onAdd: vi.fn(),
      onEdit: vi.fn(),
      onDelete: vi.fn(),
      onClose,
    });
    picker.handleInput(ESC);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ExtraEffortTogglesComponent', () => {
  it('toggles efforts in place and submits the enabled set', () => {
    const onSubmit = vi.fn();
    const picker = new ExtraEffortTogglesComponent({
      selected: ['none'],
      onSubmit,
      onCancel: vi.fn(),
    });
    expect(picker.render(60).map(strip).join('\n')).toContain('enabled');
    expect(picker.render(60).map(strip).join('\n')).toContain('Enter apply');
    expect(picker.render(60).map(strip).join('\n')).not.toContain('Enter select');
    picker.handleInput(' ');
    picker.handleInput('\r');
    expect(onSubmit).toHaveBeenCalledWith([]);
  });

  it('cancels on Esc', () => {
    const onCancel = vi.fn();
    const picker = new ExtraEffortTogglesComponent({
      selected: [],
      onSubmit: vi.fn(),
      onCancel,
    });
    picker.handleInput(ESC);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
