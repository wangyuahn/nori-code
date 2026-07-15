import { describe, expect, it } from 'vitest';

import type { SessionMeta } from '../../src/session';
import { promptMetadataTextFromPayload } from '../../src/session/prompt-metadata';
import { shouldUpdateEasyTitle } from '../../src/session/rpc';

describe('session prompt metadata', () => {
  it('keeps the visible first prompt and removes leading system reminders', () => {
    const text = promptMetadataTextFromPayload({
      input: [{
        type: 'text',
        text: '<system-reminder>Generate a title.</system-reminder>\n修复流式输出',
      }],
    });

    expect(text).toBe('修复流式输出');
  });

  it('does not derive a title from the user prompt when smart titles are enabled', () => {
    const metadata = sessionMeta({ custom: { nori_smart_title: true } });

    expect(shouldUpdateEasyTitle(metadata)).toBe(false);
  });

  it('keeps the legacy prompt title fallback for non-smart clients', () => {
    expect(shouldUpdateEasyTitle(sessionMeta())).toBe(true);
  });
});

function sessionMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
    title: 'New Session',
    isCustomTitle: false,
    agents: {},
    custom: {},
    ...overrides,
  };
}
