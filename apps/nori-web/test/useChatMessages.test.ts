import { describe, expect, it } from 'vitest';
import type { Message } from '../src/api/client';
import { apiMessageToChat, foldConversationTurns, shouldIgnoreTranscriptEvent } from '../src/hooks/useChatMessages';

describe('main transcript projection', () => {
  it('ignores subagent transcript events but keeps shared code changes', () => {
    expect(shouldIgnoreTranscriptEvent('assistant.delta', 'agent-2')).toBe(true);
    expect(shouldIgnoreTranscriptEvent('turn.ended', 'agent-2')).toBe(true);
    expect(shouldIgnoreTranscriptEvent('code.change', 'agent-2')).toBe(false);
    expect(shouldIgnoreTranscriptEvent('assistant.delta', 'main')).toBe(false);
  });

  it('turns every hidden trigger into an assistant turn boundary', () => {
    for (const kind of ['background_task', 'system_trigger', 'cron_job', 'retry']) {
      const projected = apiMessageToChat(message({ role: 'user', text: '<system-reminder>continue</system-reminder>', originKind: kind }));
      expect(projected).toMatchObject({ role: 'system', text: '', turnBoundary: true });
    }
  });

  it('keeps separate assistant turns around a hidden trigger', () => {
    const first = apiMessageToChat(message({ id: 'a1', role: 'assistant', text: 'Agent started in the background.' }))!;
    const boundary = apiMessageToChat(message({ id: 'wake', role: 'user', text: 'done', originKind: 'background_task' }))!;
    const second = apiMessageToChat(message({ id: 'a2', role: 'assistant', text: 'The agent completed successfully.' }))!;
    expect(foldConversationTurns([first, boundary, second]).map(item => item.text)).toEqual([
      'Agent started in the background.',
      'The agent completed successfully.',
    ]);
  });

  it('preserves visible text from multiple model steps in one turn', () => {
    const folded = foldConversationTurns([
      { id: 'a1', role: 'assistant', text: 'I will inspect the files.' },
      { id: 'a2', role: 'assistant', text: 'The issue is in the event projector.' },
    ]);
    expect(folded).toHaveLength(1);
    expect(folded[0]?.text).toBe('I will inspect the files.\n\nThe issue is in the event projector.');
    expect(folded[0]?.thinking).toBeUndefined();
  });
});

function message(input: { id?: string; role: Message['role']; text: string; originKind?: string }): Message {
  return {
    id: input.id ?? `${input.role}-${input.originKind ?? 'user'}`,
    role: input.role,
    content: [{ type: 'text', text: input.text }],
    created_at: '2026-07-14T00:00:00.000Z',
    ...(input.originKind ? { metadata: { origin: { kind: input.originKind } } } : {}),
  };
}
