import { describe, expect, it } from 'vitest';
import type { Message } from '../src/api/client';
import { apiMessageToChat, foldConversationTurns, promptForRewind, shouldIgnoreTranscriptEvent } from '../src/hooks/useChatMessages';

describe('main transcript projection', () => {
  it('ignores subagent transcript events but keeps shared code changes', () => {
    expect(shouldIgnoreTranscriptEvent('assistant.delta', 'agent-2')).toBe(true);
    expect(shouldIgnoreTranscriptEvent('turn.ended', 'agent-2')).toBe(true);
    expect(shouldIgnoreTranscriptEvent('code.change', 'agent-2')).toBe(false);
    expect(shouldIgnoreTranscriptEvent('subagent.started', 'agent-2')).toBe(false);
    expect(shouldIgnoreTranscriptEvent('assistant.delta', 'main')).toBe(false);
  });

  it('turns every hidden trigger into an assistant turn boundary', () => {
    for (const kind of ['background_task', 'system_trigger', 'cron_job', 'retry']) {
      const projected = apiMessageToChat(message({ role: 'user', text: '<system-reminder>continue</system-reminder>', originKind: kind }));
      expect(projected).toMatchObject({ role: 'system', text: '', turnBoundary: true });
    }
  });

  it('keeps one assistant turn around a hidden wake-up trigger', () => {
    const first = apiMessageToChat(message({ id: 'a1', role: 'assistant', text: 'Agent started in the background.' }))!;
    const boundary = apiMessageToChat(message({ id: 'wake', role: 'user', text: 'done', originKind: 'background_task' }))!;
    const second = apiMessageToChat(message({ id: 'a2', role: 'assistant', text: 'The agent completed successfully.' }))!;
    expect(foldConversationTurns([first, boundary, second]).map(item => item.text)).toEqual([
      'Agent started in the background.\n\nThe agent completed successfully.',
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

  it('keeps tool calls between the reasoning blocks that surrounded them', () => {
    const first = apiMessageToChat({
      id: 'step-1',
      role: 'assistant',
      created_at: '2026-07-14T00:00:01.000Z',
      content: [
        { type: 'thinking', thinking: 'Inspect the target.' },
        { type: 'tool_use', tool_call_id: 'edit-1', tool_name: 'Edit', input: { path: 'src/a.ts', old_string: 'a', new_string: 'b' } },
      ],
    })!;
    const result = apiMessageToChat({
      id: 'tool-1',
      role: 'tool',
      created_at: '2026-07-14T00:00:02.000Z',
      content: [{ type: 'tool_result', tool_call_id: 'edit-1', output: 'Updated src/a.ts' }],
    })!;
    const second = apiMessageToChat({
      id: 'step-2',
      role: 'assistant',
      created_at: '2026-07-14T00:00:03.000Z',
      content: [{ type: 'thinking', thinking: 'Verify the change.' }, { type: 'text', text: 'Done.' }],
    })!;

    const folded = foldConversationTurns([first, result, second]);
    expect(folded[0]?.workBlocks?.map(block => block.type)).toEqual(['thinking', 'tool', 'thinking']);
    expect(folded[0]?.workBlocks?.[1]).toMatchObject({
      type: 'tool',
      tool: { id: 'edit-1', name: 'Edit', result: 'Updated src/a.ts' },
    });
  });
});

describe('conversation rewind prompt', () => {
  it('returns the requested user prompt counting back from the latest turn', () => {
    const messages = [
      { id: 'u1', role: 'user' as const, text: 'first prompt' },
      { id: 'a1', role: 'assistant' as const, text: 'first answer' },
      { id: 'u2', role: 'user' as const, text: 'second prompt' },
    ];

    expect(promptForRewind(messages, 1)).toBe('second prompt');
    expect(promptForRewind(messages, 2)).toBe('first prompt');
    expect(promptForRewind(messages, 0)).toBeUndefined();
    expect(promptForRewind(messages, 3)).toBeUndefined();
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
