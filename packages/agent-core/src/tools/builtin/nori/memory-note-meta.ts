/**
 * Shared memory-note timestamp helpers.
 *
 * Storage is ISO-8601 UTC in YAML frontmatter (`created_at`, `updated_at`).
 * `date` remains a UTC calendar date for Obsidian compatibility and must not
 * be treated as a full write timestamp.
 */

const DATE_ONLY = /^(\d{4}-\d{2}-\d{2})$/;

export interface MemoryNoteTimestamps {
  /** Write/create instant as ISO UTC, only when a real timestamp exists. */
  readonly created_at?: string;
  /** Last modification instant as ISO UTC when known. */
  readonly updated_at?: string;
  /**
   * UTC calendar date (`YYYY-MM-DD`) for Obsidian `date:` / filename use.
   * Never includes a clock time.
   */
  readonly date?: string;
}

export function nowUtcIso(now: Date = new Date()): string {
  return now.toISOString();
}

export function utcDateOnly(isoOrDate: string | Date): string {
  const iso = typeof isoOrDate === 'string' ? isoOrDate : isoOrDate.toISOString();
  return iso.slice(0, 10);
}

export function resolveMemoryNoteTimestamps(
  frontmatter: Record<string, unknown>,
  options?: { fileMtimeIso?: string },
): MemoryNoteTimestamps {
  const created_at = parseFullTimestamp(frontmatter['created_at']);
  const updatedFromFrontmatter = parseFullTimestamp(frontmatter['updated_at']);
  const dateOnly = parseDateOnly(frontmatter['date']) ?? parseDateOnly(frontmatter['created_at']);
  const updated_at = updatedFromFrontmatter ?? parseFullTimestamp(options?.fileMtimeIso);

  return {
    created_at,
    updated_at,
    date: created_at !== undefined ? utcDateOnly(created_at) : dateOnly,
  };
}

/** Format a stored UTC instant as `YYYY-MM-DD HH:mm UTC`. Missing/invalid → undefined. */
export function formatMemoryWrittenAtUtc(iso: string | undefined): string | undefined {
  const normalized = parseFullTimestamp(iso);
  if (normalized === undefined) return undefined;
  const date = new Date(normalized);
  const stamp = `${utcDateOnly(date)} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
  return `${stamp} UTC`;
}

/**
 * Format a stored UTC instant in the viewer's local timezone as `YYYY-MM-DD HH:mm`.
 * Date-only legacy notes return `YYYY-MM-DD` without inventing a clock time.
 */
export function formatMemoryWrittenAtLocal(
  timestamps: Pick<MemoryNoteTimestamps, 'created_at' | 'date'>,
  now: Date = new Date(),
): string | undefined {
  void now;
  const normalized = parseFullTimestamp(timestamps.created_at);
  if (normalized !== undefined) {
    const date = new Date(normalized);
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }
  return timestamps.date;
}

export function compareMemoryNotesByWrittenAtDesc(
  left: Pick<MemoryNoteTimestamps, 'created_at' | 'date'>,
  right: Pick<MemoryNoteTimestamps, 'created_at' | 'date'>,
): number {
  return writtenAtSortMs(right) - writtenAtSortMs(left);
}

export function timestampsConflict(expectedIso: string | undefined, currentIso: string | undefined): boolean {
  if (expectedIso === undefined || expectedIso.trim() === '') return false;
  const expected = Date.parse(expectedIso);
  const current = currentIso === undefined ? Number.NaN : Date.parse(currentIso);
  if (Number.isNaN(expected) || Number.isNaN(current)) return true;
  return expected !== current;
}

function writtenAtSortMs(timestamps: Pick<MemoryNoteTimestamps, 'created_at' | 'date'>): number {
  const created = parseFullTimestamp(timestamps.created_at);
  if (created !== undefined) return Date.parse(created);
  if (timestamps.date !== undefined && DATE_ONLY.test(timestamps.date)) {
    return Date.parse(`${timestamps.date}T00:00:00.000Z`);
  }
  return 0;
}

function parseFullTimestamp(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || DATE_ONLY.test(trimmed)) return undefined;
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString();
}

function parseDateOnly(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const match = DATE_ONLY.exec(trimmed);
    if (match) return match[1];
    const full = parseFullTimestamp(trimmed);
    return full === undefined ? undefined : utcDateOnly(full);
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return utcDateOnly(value);
  }
  return undefined;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
