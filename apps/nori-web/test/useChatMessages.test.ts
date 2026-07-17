import { describe, expect, it } from 'vitest';
import type { Message } from '../src/api/client';
import { apiMessageToChat, canApplyGeneratedSessionTitle, firstPromptWithTitleInstruction, foldConversationTurns, generatedSessionTitle, insertSteerBoundary, mergeHistory, promptForRewind, RealtimeSubscriptionGate, shouldIgnoreTranscriptEvent, stripGeneratedSessionTitle } from '../src/hooks/useChatMessages';

describe('realtime subscription readiness', () => {
  it('settles pending sends from the subscribe acknowledgement', async () => {
    const gate = new RealtimeSubscriptionGate();
    const waiting = gate.wait(1_000);

    gate.markReady();

    await expect(waiting).resolves.toBe(true);
    await expect(gate.wait(1_000)).resolves.toBe(true);
  });

  it('keeps waiters pending through reconnects and cancels them on session reset', async () => {
    const gate = new RealtimeSubscriptionGate();
    const reconnecting = gate.wait(1_000);
    gate.markPending();
    gate.markReady();
    await expect(reconnecting).resolves.toBe(true);

    gate.markPending();
    const staleSession = gate.wait(1_000);
    gate.reset();
    await expect(staleSession).resolves.toBe(false);
  });

  it('cancels a pending subscription wait immediately when sending is aborted', async () => {
    const gate = new RealtimeSubscriptionGate();
    const controller = new AbortController();
    const waiting = gate.wait(30_000, controller.signal);

    controller.abort();

    await expect(waiting).resolves.toBe(false);
  });
});

describe('main transcript projection', () => {
  it('places steer guidance between the output already shown and later output', () => {
    const before = [{ id: 'u1', role: 'user' as const, text: 'initial task' }];
    const withGuidance = insertSteerBoundary(
      before,
      { id: 'a1', role: 'assistant', text: 'First output.' },
      { id: 'u2', role: 'user', text: 'Use the parser threshold.' },
    );
    const completed = foldConversationTurns([
      ...withGuidance,
      { id: 'a2', role: 'assistant', text: 'Second output.' },
    ]);

    expect(completed.map(item => [item.role, item.text])).toEqual([
      ['user', 'initial task'],
      ['assistant', 'First output.'],
      ['user', 'Use the parser threshold.'],
      ['assistant', 'Second output.'],
    ]);
  });

  it('asks the main agent for a title without exposing the instruction as the user message', () => {
    const prompt = firstPromptWithTitleInstruction('修复流式输出');
    const projected = apiMessageToChat(message({ role: 'user', text: prompt }));

    expect(prompt).toContain('<nori-session-title>YOUR TITLE</nori-session-title>');
    expect(projected?.text).toBe('修复流式输出');
  });

  it('extracts only an agent-generated title and hides its marker from the answer', () => {
    const answer = '<nori-session-title>修复流式输出</nori-session-title>\n\n我会先检查事件链。';

    expect(generatedSessionTitle(answer)).toBe('修复流式输出');
    expect(stripGeneratedSessionTitle(answer)).toBe('我会先检查事件链。');
    expect(generatedSessionTitle('用户要求修复流式输出')).toBeUndefined();
  });

  it('only repairs missing or reminder-polluted automatic titles', () => {
    expect(canApplyGeneratedSessionTitle(undefined)).toBe(true);
    expect(canApplyGeneratedSessionTitle('<system-reminder>title instruction')).toBe(true);
    expect(canApplyGeneratedSessionTitle('用户手动命名')).toBe(false);
  });

  it('preserves base64 and URL images from persisted user messages', () => {
    const projected = apiMessageToChat({
      id: 'image-message',
      role: 'user',
      created_at: '2026-07-15T00:00:00.000Z',
      content: [
        { type: 'image', source: { kind: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
        { type: 'image', source: { kind: 'url', url: 'https://example.com/image.png' } },
      ],
    });

    expect(projected?.images).toEqual([
      { src: 'data:image/png;base64,aGVsbG8=', alt: 'Attached image 1' },
      { src: 'https://example.com/image.png', alt: 'Attached image 2' },
    ]);
  });

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

  it('merges a background wake-up answer into the live assistant turn without a refresh', () => {
    const previous = [
      { id: 'u1', role: 'user' as const, text: 'Run a swarm', createdAt: '2026-07-14T00:00:00.000Z' },
      { id: 'a1', role: 'assistant' as const, text: 'The swarm is running.', createdAt: '2026-07-14T00:00:01.000Z' },
    ];
    const completedAfterWake = [
      { id: 'a2', role: 'assistant' as const, text: 'The swarm finished.', createdAt: '2026-07-14T00:00:02.000Z' },
    ];

    expect(mergeHistory(previous, completedAfterWake)).toMatchObject([
      { role: 'user', text: 'Run a swarm' },
      { role: 'assistant', text: 'The swarm is running.\n\nThe swarm finished.' },
    ]);
  });

  it('preserves distinct persisted wake-up messages even when their text is identical', () => {
    const previous = [
      { id: 'assistant-a', role: 'assistant' as const, text: 'Done.', createdAt: '2026-07-14T00:00:01.000Z' },
    ];
    const incoming = [
      { id: 'assistant-b', role: 'assistant' as const, text: 'Done.', createdAt: '2026-07-14T00:00:02.000Z' },
    ];

    const merged = mergeHistory(previous, incoming);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.text).toBe('Done.\n\nDone.');
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
