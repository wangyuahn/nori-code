import { describe, expect, it } from 'vitest';

import {
  compareMemoryNotesByWrittenAtDesc,
  formatMemoryWrittenAtLocal,
  formatMemoryWrittenAtUtc,
  resolveMemoryNoteTimestamps,
  timestampsConflict,
} from '../../../../src/tools/builtin/nori/memory-note-meta';

describe('memory-note-meta', () => {
  it('resolves created_at / updated_at from frontmatter without inventing clock times for date-only notes', () => {
    expect(resolveMemoryNoteTimestamps({
      created_at: '2026-08-10T04:15:00.000Z',
      updated_at: '2026-08-11T09:30:00.000Z',
      date: '2026-08-10',
    })).toEqual({
      created_at: '2026-08-10T04:15:00.000Z',
      updated_at: '2026-08-11T09:30:00.000Z',
      date: '2026-08-10',
    });

    expect(resolveMemoryNoteTimestamps({ date: '2026-07-01' }, {
      fileMtimeIso: '2026-07-02T12:00:00.000Z',
    })).toEqual({
      created_at: undefined,
      updated_at: '2026-07-02T12:00:00.000Z',
      date: '2026-07-01',
    });
  });

  it('formats UTC and local write times as YYYY-MM-DD HH:mm without fabricating times', () => {
    expect(formatMemoryWrittenAtUtc('2026-08-10T04:15:00.000Z')).toBe('2026-08-10 04:15 UTC');
    expect(formatMemoryWrittenAtUtc('2026-08-10')).toBeUndefined();

    const local = formatMemoryWrittenAtLocal({ created_at: '2026-08-10T04:15:00.000Z' });
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(formatMemoryWrittenAtLocal({ date: '2026-07-01' })).toBe('2026-07-01');
  });

  it('sorts by real write time descending, falling back to date-only midnight UTC', () => {
    const notes = [
      { created_at: '2026-08-01T10:00:00.000Z' },
      { date: '2026-08-10' },
      { created_at: '2026-08-10T08:00:00.000Z' },
    ];
    expect([...notes].sort(compareMemoryNotesByWrittenAtDesc)).toEqual([
      { created_at: '2026-08-10T08:00:00.000Z' },
      { date: '2026-08-10' },
      { created_at: '2026-08-01T10:00:00.000Z' },
    ]);
  });

  it('detects optimistic-concurrency conflicts on updated_at', () => {
    expect(timestampsConflict('2026-08-10T04:15:00.000Z', '2026-08-10T04:15:00.000Z')).toBe(false);
    expect(timestampsConflict('2026-08-10T04:15:00.000Z', '2026-08-10T05:00:00.000Z')).toBe(true);
    expect(timestampsConflict(undefined, '2026-08-10T05:00:00.000Z')).toBe(false);
    expect(timestampsConflict('not-a-date', '2026-08-10T05:00:00.000Z')).toBe(true);
  });
});
