import { describe, expect, it } from 'vitest';
import { OldKimiJsonSchema, OldSessionStateSchema } from '../src/kimi-cli-schema.js';

describe('OldKimiJsonSchema', () => {
  it('parses a real-shape kimi.json', () => {
    const input = {
      work_dirs: [
        { path: '/Users/x/proj', kaos: 'local', last_session_id: 'abc' },
        { path: '/Users/x/other', kaos: 'local', last_session_id: null },
      ],
    };
    const parsed = OldKimiJsonSchema.parse(input);
    expect(parsed.work_dirs).toHaveLength(2);
    expect(parsed.work_dirs[0]!.kaos).toBe('local');
  });

  it('accepts missing last_session_id', () => {
    const input = { work_dirs: [{ path: '/x', kaos: 'local' }] };
    expect(() => OldKimiJsonSchema.parse(input)).not.toThrow();
  });
});

describe('OldSessionStateSchema', () => {
  it('parses a realistic state.json', () => {
    const input = {
      version: 1,
      approval: { yolo: false, afk: false, auto_approve_actions: [] },
      additional_dirs: [],
      custom_title: 'hi',
      title_generated: false,
      title_generate_attempts: 0,
      plan_mode: false,
      plan_session_id: null,
      plan_slug: null,
      wire_mtime: 1772616338.93,
      archived: true,
      archived_at: 1774273349.5,
      auto_archive_exempt: false,
    };
    const parsed = OldSessionStateSchema.parse(input);
    expect(parsed.custom_title).toBe('hi');
    expect(parsed.archived).toBe(true);
  });

  it('tolerates missing optional fields', () => {
    expect(() => OldSessionStateSchema.parse({ version: 1 })).not.toThrow();
  });
});
