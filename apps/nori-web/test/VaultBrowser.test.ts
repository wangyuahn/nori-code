import { describe, expect, it } from 'vitest';

import {
  compareVaultNotesByWrittenAt,
  formatVaultNoteUpdatedAt,
  formatVaultNoteWrittenAt,
  vaultNoteBodyForEdit,
} from '../src/components/VaultBrowser';
import type { Note } from '../src/api/client';

describe('VaultBrowser memory timestamps', () => {
  it('formats write time from created_at in local YYYY-MM-DD HH:mm and falls back to date-only', () => {
    const withInstant: Pick<Note, 'created_at' | 'date'> = {
      created_at: '2026-08-10T04:15:00.000Z',
      date: '2026-08-10',
    };
    expect(formatVaultNoteWrittenAt(withInstant)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(formatVaultNoteWrittenAt({ date: '2026-07-01' })).toBe('2026-07-01');
    expect(formatVaultNoteWrittenAt({})).toBeUndefined();
  });

  it('formats updated_at independently for the detail pane', () => {
    expect(formatVaultNoteUpdatedAt({ updated_at: '2026-08-11T09:30:00.000Z' }))
      .toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(formatVaultNoteUpdatedAt({})).toBeUndefined();
  });

  it('sorts search/list results by write time descending', () => {
    const notes: Array<Pick<Note, 'created_at' | 'date' | 'title'>> = [
      { title: 'old', created_at: '2026-08-01T10:00:00.000Z' },
      { title: 'date-only', date: '2026-08-10' },
      { title: 'new', created_at: '2026-08-10T08:00:00.000Z' },
    ];
    expect([...notes].sort(compareVaultNotesByWrittenAt).map(note => note.title))
      .toEqual(['new', 'date-only', 'old']);
  });

  it('strips frontmatter when preparing editable body text', () => {
    const note = {
      title: 'Architecture',
      type: 'decision' as const,
      folder: 'decision',
      preview: 'body',
      date: '2026-08-01',
      path: 'decision/architecture.md',
      content: ['---', 'title: Architecture', '---', '', '# Architecture', '', 'Keep the SDK stable.'].join('\n'),
    };
    expect(vaultNoteBodyForEdit(note)).toBe('# Architecture\n\nKeep the SDK stable.');
  });
});
