import { describe, expect, it } from 'vitest';
import type { Message } from '../src/api/client';
import { apiMessageToChat, canApplyGeneratedSessionTitle, chatFilesFromPromptAttachments, chatScopeKey, confirmOptimisticUserMessage, contextInjectionSource, fallbackSessionTitle, firstPromptWithTitleInstruction, foldConversationTurns, generatedSessionTitle, insertSteerBoundary, isTransientChatMessageId, latestTodos, liveAssistantMessage, mergeHistory, mergeInFlightWorkBlocks, promptForRewind, RealtimeSubscriptionGate, removeTerminatedAgent, shouldFinishAbortedPrompt, shouldIgnoreTranscriptEvent, splitUploadedFileMarkup, statusForSession, stripGeneratedSessionTitle } from '../src/hooks/useChatMessages';

describe('agent activity events', () => {
  it('removes a manually terminated agent from the live activity set', () => {
    expect(removeTerminatedAgent(['agent-1', 'agent-2'], 'agent-1')).toEqual(['agent-2']);
    expect(removeTerminatedAgent(['agent-2'], 'missing')).toEqual(['agent-2']);
  });
});

describe('session-bound realtime status', () => {
  const status = {
    status: 'idle',
    model: 'session-a-model',
    thinking_level: 'off',
    permission: 'manual',
    discuss_mode: false,
    main_write_enabled: true,
    goal: null,
    context_tokens: 0,
    max_context_tokens: 128_000,
    context_usage: 0,
  };

  it('hides a previous session status immediately when the active session changes', () => {
    expect(statusForSession(status, 'session-a', 'session-a')).toBe(status);
    expect(statusForSession(status, 'session-a', 'session-b')).toBeNull();
    expect(statusForSession(status, 'session-a', null)).toBeNull();
    expect(statusForSession(status, null, null)).toBeNull();
  });

  it('keeps transient chat state scoped by both parent session and agent', () => {
    expect(chatScopeKey('session-a', 'main')).toBe('session-a\u0000main');
    expect(chatScopeKey('session-a', 'agent-review')).toBe('session-a\u0000agent-review');
    expect(chatScopeKey('session-a', 'main')).not.toBe(chatScopeKey('session-a', 'agent-review'));
    expect(statusForSession(status, chatScopeKey('session-a', 'main'), chatScopeKey('session-a', 'agent-review'))).toBeNull();
  });
});

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
  it('keeps completed tool calls when a reconnect snapshot lists only the currently running tool', () => {
    const merged = mergeInFlightWorkBlocks([
      { id: 'thinking-1', type: 'thinking', text: 'Inspect the target first.' },
      { id: 'read-1', type: 'tool', tool: { id: 'read-1', name: 'Read', args: { path: 'src/a.ts' }, result: 'file contents' } },
      { id: 'edit-1', type: 'tool', tool: { id: 'edit-1', name: 'Edit', args: { path: 'src/a.ts' }, result: 'updated' } },
    ], [
      { id: 'snapshot-thinking-7', type: 'thinking', text: 'Inspect the target first. Apply the follow-up.' },
      { id: 'write-1', type: 'tool', tool: { id: 'write-1', name: 'Write', args: { path: 'src/b.ts' } } },
    ]);

    expect(merged).toMatchObject([
      { type: 'thinking', text: 'Inspect the target first.' },
      { type: 'tool', tool: { id: 'read-1', result: 'file contents' } },
      { type: 'tool', tool: { id: 'edit-1', result: 'updated' } },
      { type: 'tool', tool: { id: 'write-1', name: 'Write' } },
    ]);
  });

  it('places steer guidance between work progress already shown and the final summary', () => {
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
      ['assistant', ''],
      ['user', 'Use the parser threshold.'],
      ['assistant', 'Second output.'],
    ]);
    expect(completed[1]?.workBlocks).toMatchObject([
      { type: 'progress', text: 'First output.' },
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

  it('accepts a title marker with harmless attributes and has a prompt fallback', () => {
    const answer = '<nori-session-title data-source="model">修复标题</nori-session-title>\n\n完成。';
    expect(generatedSessionTitle(answer)).toBe('修复标题');
    expect(stripGeneratedSessionTitle(answer)).toBe('完成。');
    expect(fallbackSessionTitle('修复模型标题显示问题，并保留项目会话。')).toBe('修复模型标题显示问题，并保留项目会话。');
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

  it('extracts uploaded files from persisted user messages and hides the inlined markup', () => {
    const projected = apiMessageToChat({
      id: 'file-message',
      role: 'user',
      created_at: '2026-07-15T00:00:00.000Z',
      content: [
        { type: 'text', text: 'Please inspect this.\n<uploaded-file name="notes.txt" media-type="text/plain" size="12">\nhello world\n</uploaded-file>' },
        { type: 'file', name: 'diagram.pdf', file_id: 'f_pdf', media_type: 'application/pdf', size: 2048 },
      ],
    });

    expect(projected?.text).toBe('Please inspect this.');
    expect(projected?.files).toEqual([
      { name: 'diagram.pdf', mediaType: 'application/pdf', size: 2048 },
      { name: 'notes.txt', mediaType: 'text/plain', size: 12 },
    ]);
  });

  it('keeps a file-only user message instead of dropping it', () => {
    const projected = apiMessageToChat({
      id: 'file-only',
      role: 'user',
      created_at: '2026-07-15T00:00:00.000Z',
      content: [
        { type: 'text', text: '<uploaded-file name="notes.txt" media-type="text/plain" size="5">\nhello\n</uploaded-file>' },
      ],
    });

    expect(projected).toMatchObject({
      id: 'file-only',
      role: 'user',
      text: '',
      files: [{ name: 'notes.txt', mediaType: 'text/plain', size: 5 }],
    });
  });

  it('maps prompt file attachments into chat file chips', () => {
    expect(chatFilesFromPromptAttachments([
      { kind: 'file', name: 'notes.txt', file_id: 'f_1', media_type: 'text/plain', size: 12 },
      { kind: 'image', name: 'shot.png', source: { kind: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
    ])).toEqual([{ name: 'notes.txt', mediaType: 'text/plain', size: 12 }]);
    expect(splitUploadedFileMarkup('see <uploaded-file name="a.txt" media-type="text/plain" size="1">x</uploaded-file>')).toEqual({
      text: 'see',
      files: [{ name: 'a.txt', mediaType: 'text/plain', size: 1 }],
    });
  });

  it('confirms an optimistic user message with the authoritative server identity', () => {
    const confirmed = confirmOptimisticUserMessage([
      {
        id: 'local-user-1',
        role: 'user',
        text: 'Only show this once.',
        createdAt: '2026-07-15T00:00:00.000Z',
      },
    ], 'local-user-1', 'server-user-1', '2026-07-15T00:00:30.000Z');

    expect(confirmed).toEqual([{
      id: 'server-user-1',
      role: 'user',
      text: 'Only show this once.',
      createdAt: '2026-07-15T00:00:30.000Z',
    }]);
  });

  it('removes the optimistic duplicate when server history arrives first', () => {
    const confirmed = confirmOptimisticUserMessage([
      {
        id: 'server-user-1',
        role: 'user',
        text: 'Only show this once.',
        createdAt: '2026-07-15T00:00:30.000Z',
      },
      {
        id: 'local-user-1',
        role: 'user',
        text: 'Only show this once.',
        createdAt: '2026-07-15T00:00:00.000Z',
      },
    ], 'local-user-1', 'server-user-1', '2026-07-15T00:00:30.000Z');

    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]?.id).toBe('server-user-1');
  });

  it('drops the optimistic row when history already has the derived transcript id', () => {
    expect(isTransientChatMessageId('msg_sess_pending_prompt_abc')).toBe(true);
    expect(isTransientChatMessageId('msg_sess_000003')).toBe(false);

    const confirmed = confirmOptimisticUserMessage([
      {
        id: 'msg_sess_000003',
        role: 'user',
        text: 'Only show this once.',
        createdAt: '2026-07-15T00:00:05.000Z',
      },
      {
        id: 'local-user-1',
        role: 'user',
        text: 'Only show this once.',
        createdAt: '2026-07-15T00:00:00.000Z',
      },
    ], 'local-user-1', 'msg_sess_pending_prompt_abc', '2026-07-15T00:00:05.000Z');

    expect(confirmed).toEqual([{
      id: 'msg_sess_000003',
      role: 'user',
      text: 'Only show this once.',
      createdAt: '2026-07-15T00:00:05.000Z',
    }]);
  });

  it('collapses a pending user_message_id when history arrives with the derived id', () => {
    const merged = mergeHistory(
      [{
        id: 'msg_sess_pending_prompt_abc',
        role: 'user',
        text: 'Only show this once.',
        createdAt: '2026-07-15T00:00:00.000Z',
      }],
      [{
        id: 'msg_sess_000003',
        role: 'user',
        text: 'Only show this once.',
        createdAt: '2026-07-15T00:00:01.000Z',
      }],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: 'msg_sess_000003',
      role: 'user',
      text: 'Only show this once.',
    });
  });

  it('preserves local image data when confirming an optimistic message', () => {
    const confirmed = confirmOptimisticUserMessage([
      {
        id: 'local-user-image',
        role: 'user',
        text: '[image.png]',
        images: [{ src: 'data:image/png;base64,aGVsbG8=', alt: 'image.png' }],
        createdAt: '2026-07-15T00:00:00.000Z',
      },
    ], 'local-user-image', 'server-user-image', '2026-07-15T00:00:01.000Z');

    expect(confirmed[0]).toMatchObject({
      id: 'server-user-image',
      images: [{ src: 'data:image/png;base64,aGVsbG8=', alt: 'image.png' }],
    });
  });

  it('preserves local file chips when confirming an optimistic message', () => {
    const confirmed = confirmOptimisticUserMessage([
      {
        id: 'local-user-file',
        role: 'user',
        text: 'Please inspect this file.',
        files: [{ name: 'notes.txt', mediaType: 'text/plain', size: 12 }],
        createdAt: '2026-07-15T00:00:00.000Z',
      },
    ], 'local-user-file', 'server-user-file', '2026-07-15T00:00:01.000Z');

    expect(confirmed[0]).toMatchObject({
      id: 'server-user-file',
      files: [{ name: 'notes.txt', mediaType: 'text/plain', size: 12 }],
    });
  });

  it('routes transcript events to the selected agent without leaking them to main', () => {
    expect(shouldIgnoreTranscriptEvent('assistant.delta', 'agent-2')).toBe(true);
    expect(shouldIgnoreTranscriptEvent('turn.ended', 'agent-2')).toBe(true);
    expect(shouldIgnoreTranscriptEvent('prompt.aborted', 'agent-2')).toBe(true);
    expect(shouldIgnoreTranscriptEvent('assistant.delta', 'agent-2', 'agent-2')).toBe(false);
    expect(shouldIgnoreTranscriptEvent('assistant.delta', 'main', 'agent-2')).toBe(true);
    expect(shouldIgnoreTranscriptEvent('code.change', 'agent-2')).toBe(false);
    expect(shouldIgnoreTranscriptEvent('subagent.started', 'agent-2')).toBe(false);
    expect(shouldIgnoreTranscriptEvent('assistant.delta', 'main')).toBe(false);
  });

  it('turns a stopped live draft into a retained assistant message', () => {
    const stopped = liveAssistantMessage({
      sessionId: 'session-stop',
      text: 'This part was already streamed.',
      thinking: 'Partial reasoning',
      workBlocks: [
        { id: 'progress-1', type: 'progress', text: 'Inspecting the parser.' },
        { id: 'tool-1', type: 'tool', tool: { id: 'tool-1', name: 'Read', args: { path: 'src/parser.ts' }, result: 'contents' } },
      ],
      usage: { input_other: 10, output: 4, input_cache_read: 0, input_cache_creation: 0 },
      createdAt: '2026-08-16T04:00:00.000Z',
    });

    expect(stopped).toMatchObject({
      id: 'live-session-stop-1786852800000',
      role: 'assistant',
      text: 'This part was already streamed.',
      thinking: 'Partial reasoning',
      toolCalls: [{ id: 'tool-1', name: 'Read', result: 'contents' }],
      usage: { input_other: 10, output: 4 },
      createdAt: '2026-08-16T04:00:00.000Z',
    });
    expect(liveAssistantMessage({
      sessionId: 'session-stop',
      text: '',
      thinking: '',
      workBlocks: [],
    })).toBeNull();
  });

  it('only finalizes the active prompt when an abort event arrives', () => {
    expect(shouldFinishAbortedPrompt('prompt-active', 'prompt-active')).toBe(true);
    expect(shouldFinishAbortedPrompt('prompt-active', 'prompt-queued')).toBe(false);
    expect(shouldFinishAbortedPrompt(null, 'prompt-queued')).toBe(false);
    expect(shouldFinishAbortedPrompt('prompt-active', undefined)).toBe(true);
  });

  it('turns silent wake-ups into an assistant turn boundary', () => {
    for (const kind of ['background_task', 'cron_job', 'cron_missed', 'retry']) {
      const projected = apiMessageToChat(message({ role: 'user', text: '<system-reminder>continue</system-reminder>', originKind: kind }));
      expect(projected).toMatchObject({ role: 'system', text: '', turnBoundary: true });
    }
  });

  it('projects loop, skill, and other context injections as visible system rows', () => {
    expect(contextInjectionSource({ kind: 'system_trigger', name: 'goal_intake' })).toBe('goal_intake');
    expect(contextInjectionSource({ kind: 'skill_activation', skillName: 'skill-catalog' })).toBe('skill-catalog');
    expect(contextInjectionSource({ kind: 'injection', variant: '@deepseek-ai/dsh-system-prompt' })).toBe('@deepseek-ai/dsh-system-prompt');

    const loop = apiMessageToChat(message({ role: 'user', text: 'Continue the goal.', originKind: 'system_trigger' }));
    expect(loop).toMatchObject({
      role: 'system',
      text: '',
      workBlocks: [{ type: 'context_injection', source: 'system_trigger' }],
    });
    expect(loop).not.toHaveProperty('turnBoundary', true);

    const skill = apiMessageToChat({
      id: 'skill-1',
      role: 'user',
      content: [{ type: 'text', text: 'Available skills' }],
      created_at: '2026-07-14T00:00:00.000Z',
      metadata: { origin: { kind: 'skill_activation', skillName: 'skill-catalog' } },
    });
    expect(skill).toMatchObject({
      workBlocks: [{ type: 'context_injection', source: 'skill-catalog' }],
    });
  });

  it('keeps one assistant turn around a hidden wake-up trigger', () => {
    const first = apiMessageToChat(message({ id: 'a1', role: 'assistant', text: 'Agent started in the background.' }))!;
    const boundary = apiMessageToChat(message({ id: 'wake', role: 'user', text: 'done', originKind: 'background_task' }))!;
    const second = apiMessageToChat(message({ id: 'a2', role: 'assistant', text: 'The agent completed successfully.' }))!;
    const folded = foldConversationTurns([first, boundary, second]);
    expect(folded.map(item => item.text)).toEqual(['The agent completed successfully.']);
    expect(folded[0]?.workBlocks).toMatchObject([
      { type: 'progress', text: 'Agent started in the background.' },
    ]);
  });

  it('merges a background wake-up answer into the live assistant turn without a refresh', () => {
    const previous = [
      { id: 'u1', role: 'user' as const, text: 'Run a SubAgent', createdAt: '2026-07-14T00:00:00.000Z' },
      { id: 'a1', role: 'assistant' as const, text: 'The SubAgent is running.', createdAt: '2026-07-14T00:00:01.000Z' },
    ];
    const completedAfterWake = [
      { id: 'a2', role: 'assistant' as const, text: 'The SubAgent finished.', createdAt: '2026-07-14T00:00:02.000Z' },
    ];

    expect(mergeHistory(previous, completedAfterWake)).toMatchObject([
      { role: 'user', text: 'Run a SubAgent' },
      {
        role: 'assistant',
        text: 'The SubAgent finished.',
        workBlocks: [{ type: 'progress', text: 'The SubAgent is running.' }],
      },
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
    expect(merged[0]?.text).toBe('Done.');
    expect(merged[0]?.workBlocks).toMatchObject([{ type: 'progress', text: 'Done.' }]);
  });

  it('keeps earlier model text as progress and only the last segment as the answer', () => {
    const folded = foldConversationTurns([
      { id: 'a1', role: 'assistant', text: 'I will inspect the files.' },
      { id: 'a2', role: 'assistant', text: 'The issue is in the event projector.' },
    ]);
    expect(folded).toHaveLength(1);
    expect(folded[0]?.text).toBe('The issue is in the event projector.');
    expect(folded[0]?.workBlocks).toMatchObject([
      { type: 'progress', text: 'I will inspect the files.' },
    ]);
    expect(folded[0]?.thinking).toBeUndefined();
  });

  it('keeps a retried assistant answer after the visible system error that caused it', () => {
    const folded = foldConversationTurns([
      { id: 'u', role: 'user', text: 'question' },
      { id: 'a1', role: 'assistant', text: 'first answer' },
      { id: 'error', role: 'system', text: 'turn failed' },
      { id: 'a2', role: 'assistant', text: 'retry answer' },
    ]);

    expect(folded.map(message => [message.id, message.role, message.text])).toEqual([
      ['u', 'user', 'question'],
      ['a1', 'assistant', 'first answer'],
      ['error', 'system', 'turn failed'],
      ['a2', 'assistant', 'retry answer'],
    ]);
  });

  it('projects text before a tool call into the ordered work process', () => {
    const projected = apiMessageToChat({
      id: 'step-with-progress',
      role: 'assistant',
      created_at: '2026-07-14T00:00:01.000Z',
      content: [
        { type: 'thinking', thinking: 'Choose the smallest change.' },
        { type: 'text', text: 'I am updating the event projector now.' },
        { type: 'tool_use', tool_call_id: 'edit-1', tool_name: 'Edit', input: { path: 'src/events.ts' } },
      ],
    });

    expect(projected?.text).toBe('');
    expect(projected?.workBlocks).toMatchObject([
      { type: 'thinking', text: 'Choose the smallest change.' },
      { type: 'progress', text: 'I am updating the event projector now.' },
      { type: 'tool', tool: { id: 'edit-1', name: 'Edit' } },
    ]);
  });

  it('preserves failed tool status from persisted aggregate tool calls', () => {
    const projected = apiMessageToChat({
      id: 'failed-edit',
      role: 'assistant',
      created_at: '2026-07-14T00:00:01.000Z',
      content: [],
      tool_calls: [{
        id: 'edit-1',
        name: 'Edit',
        args: { path: 'src/a.ts', expected_tag: 'A1B2', line_ops: [{ op: 'del', start: 1, end: 1 }] },
        result: 'Content tag mismatch',
        is_error: true,
      }],
    });

    expect(projected?.toolCalls).toMatchObject([{
      id: 'edit-1',
      result: 'Content tag mismatch',
      isError: true,
    }]);
  });

  it('keeps a folded final summary stable when history is reconciled again', () => {
    const once = foldConversationTurns([
      {
        id: 'step-1',
        role: 'assistant',
        text: 'I am applying the change.',
        toolCalls: [{ id: 'edit-1', name: 'Edit', args: { path: 'src/events.ts' }, result: 'ok' }],
      },
      { id: 'step-2', role: 'assistant', text: 'The change is complete and verified.' },
    ]);

    const twice = foldConversationTurns(once);

    expect(twice).toEqual(once);
    expect(twice[0]?.text).toBe('The change is complete and verified.');
  });

  it('keeps tool calls between the reasoning blocks that surrounded them', () => {
    const first = apiMessageToChat({
      id: 'step-1',
      role: 'assistant',
      created_at: '2026-07-14T00:00:01.000Z',
      content: [
        { type: 'thinking', thinking: 'Inspect the target.' },
        { type: 'tool_use', tool_call_id: 'edit-1', tool_name: 'Edit', input: { path: 'src/a.ts', expected_tag: 'A1B2', line_ops: [{ op: 'swap', start: 1, end: 1, content: 'b' }] } },
      ],
    })!;
    const result = apiMessageToChat({
      id: 'tool-1',
      role: 'tool',
      created_at: '2026-07-14T00:00:02.000Z',
      content: [{ type: 'tool_result', tool_call_id: 'edit-1', output: 'Content tag mismatch', is_error: true }],
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
      tool: { id: 'edit-1', name: 'Edit', result: 'Content tag mismatch', isError: true },
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

  it('restores the Todo List from the retained history after later tool calls are removed', () => {
    const earlier = {
      id: 'assistant-1',
      role: 'assistant' as const,
      text: '',
      toolCalls: [{
        name: 'TodoList',
        args: { todos: [{ title: 'Keep this task', status: 'in_progress' }] },
      }],
    };
    const later = {
      id: 'assistant-2',
      role: 'assistant' as const,
      text: '',
      toolCalls: [{
        name: 'TodoList',
        args: { todos: [{ title: 'Later task', status: 'done' }] },
      }],
    };

    expect(latestTodos([earlier, later])).toEqual([{ title: 'Later task', status: 'done' }]);
    expect(latestTodos([earlier])).toEqual([{ title: 'Keep this task', status: 'in_progress' }]);
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
