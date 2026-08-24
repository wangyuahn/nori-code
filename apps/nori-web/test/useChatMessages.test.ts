import { describe, expect, it } from 'vitest';
import type { Message } from '../src/api/client';
import { apiMessageToChat, applyRealtimeStatusEvent, isClientNoticeId, reconcileHistory, turnFailureText, canApplyGeneratedSessionTitle, chatFilesFromPromptAttachments, chatScopeKey, confirmOptimisticUserMessage, fallbackSessionTitle, firstPromptWithTitleInstruction, foldConversationTurns, generatedSessionTitle, insertSteerBoundary, isTransientChatMessageId, latestTodos, liveAssistantMessage, mergeHistory, mergeInFlightWorkBlocks, promptForRewind, RealtimeEventDeduper, RealtimeSubscriptionGate, shouldFinishAbortedPrompt, shouldIgnoreTranscriptEvent, splitUploadedFileMarkup, statusForSession, stripGeneratedSessionTitle, unwrapWholeAnswerCodeFence } from '../src/hooks/useChatMessages';

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

  it('applies agent status events to the current mode without affecting another scope', () => {
    expect(applyRealtimeStatusEvent(status, 'agent.status.updated', { discussMode: true }))
      .toMatchObject({ discuss_mode: true, main_write_enabled: true });
    expect(applyRealtimeStatusEvent(status, 'event.agent.status.updated', { discussMode: false, coderWriteEnabled: false }))
      .toMatchObject({ discuss_mode: false, main_write_enabled: false });
    expect(applyRealtimeStatusEvent(null, 'agent.status.updated', { discussMode: true })).toBeNull();
    expect(applyRealtimeStatusEvent(status, 'discussion.updated', { discussMode: true })).toBe(status);
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

describe('realtime event identity', () => {
  it('drops a replayed durable event but accepts volatile frames sharing its watermark', () => {
    const deduper = new RealtimeEventDeduper();

    expect(deduper.accept({ seq: 10, epoch: 'epoch-a' })).toBe(true);
    expect(deduper.accept({ seq: 10, epoch: 'epoch-a' })).toBe(false);
    expect(deduper.accept({ seq: 10, epoch: 'epoch-a', volatile: true })).toBe(true);
    expect(deduper.accept({ seq: 11, epoch: 'epoch-a' })).toBe(true);
  });

  it('starts a new durable sequence when the journal epoch changes', () => {
    const deduper = new RealtimeEventDeduper();

    expect(deduper.accept({ seq: 42, epoch: 'epoch-a' })).toBe(true);
    expect(deduper.accept({ seq: 1, epoch: 'epoch-b' })).toBe(true);
    expect(deduper.accept({ seq: 1, epoch: 'epoch-b' })).toBe(false);
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

  it('keeps steer guidance and the prior assistant message independent', () => {
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

    expect(completed.map(item => [item.id, item.role, item.text])).toEqual([
      ['u1', 'user', 'initial task'],
      ['a1', 'assistant', 'First output.'],
      ['u2', 'user', 'Use the parser threshold.'],
      ['a2', 'assistant', 'Second output.'],
    ]);
    expect(completed[1]?.workBlocks).toBeUndefined();
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

  it('unwraps an answer the model fenced as html so it renders as markdown', () => {
    const answer = [
      '```html',
      '<nori-session-title>修复解析</nori-session-title>',
      '',
      '## 结论',
      '',
      '**已修复**，运行 `pnpm test`：',
      '',
      '```bash',
      'pnpm test',
      '```',
      '',
      '就这些。',
      '```',
    ].join('\n');

    expect(generatedSessionTitle(answer)).toBe('修复解析');
    const stripped = stripGeneratedSessionTitle(answer);
    expect(stripped.startsWith('## 结论')).toBe(true);
    expect(stripped).toContain('```bash\npnpm test\n```');
    expect(stripped).not.toContain('```html');
  });

  it('unwraps the outer fence while it is still streaming, before any closer arrives', () => {
    expect(stripGeneratedSessionTitle('```html\n<nori-session-title>修复解析</nori-session-title>\n\n## 结'))
      .toBe('## 结');
    expect(unwrapWholeAnswerCodeFence('~~~markdown\n<nori-session-title>标题</nori-session-title>\n正文'))
      .toBe('<nori-session-title>标题</nori-session-title>\n正文');
  });

  it('leaves genuine code blocks and raw-markdown answers fenced', () => {
    const bash = '```bash\npnpm test\n```';
    expect(unwrapWholeAnswerCodeFence(bash)).toBe(bash);

    const page = '```html\n<div class="card">\n  <span>hi</span>\n</div>\n```';
    expect(unwrapWholeAnswerCodeFence(page)).toBe(page);

    const rawMarkdown = '```markdown\n# 标题\n\n正文\n```';
    expect(unwrapWholeAnswerCodeFence(rawMarkdown)).toBe(rawMarkdown);

    const prose = '这是普通回复，**加粗**正常。';
    expect(unwrapWholeAnswerCodeFence(prose)).toBe(prose);
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

  it('consumes ContextInjection from the standard tool content shape', () => {
    const loop = apiMessageToChat(message({ role: 'user', text: 'Continue the goal.', originKind: 'system_trigger' }));
    expect(loop).toMatchObject({ role: 'user', text: 'Continue the goal.' });
    expect(loop?.toolCalls).toBeUndefined();

    const injection = apiMessageToChat({
      id: 'skill-1',
      role: 'assistant',
      content: [{
        type: 'tool_use',
        tool_call_id: 'context-injection-1',
        tool_name: 'ContextInjection',
        input: { source: 'skill-catalog', variant: 'skill-catalog' },
      }],
      created_at: '2026-07-14T00:00:00.000Z',
    });
    expect(injection).toMatchObject({
      role: 'assistant',
      text: '',
      toolCalls: undefined,
      workBlocks: [{
        type: 'context',
        source: 'skill-catalog',
      }],
    });
  });

  it('keeps internal permission reminders visible without making them callable', () => {
    const permissionReminder = apiMessageToChat({
      id: 'permission-reminder',
      role: 'assistant',
      content: [{
        type: 'tool_use',
        tool_call_id: 'context-injection-permission',
        tool_name: 'ContextInjection',
        input: { source: 'permission_mode', variant: 'permission_mode' },
      }],
      created_at: '2026-07-14T00:00:00.000Z',
    });
    expect(permissionReminder).toMatchObject({
      role: 'assistant',
      toolCalls: undefined,
      workBlocks: [{ type: 'context', source: 'permission_mode' }],
    });
  });

  it('keeps ordinary user prompts and team discussion messages out of context injections', () => {
    const user = apiMessageToChat(message({ role: 'user', text: '普通用户消息', originKind: 'user' }));
    const teamSpeak = apiMessageToChat({
      id: 'team-speak',
      role: 'user',
      content: [{ type: 'text', text: '缓存策略应该保留。' }],
      created_at: '2026-07-14T00:00:00.000Z',
      metadata: {
        origin: {
          kind: 'system_trigger',
          name: 'team_discussion_statement',
          discussionEntryId: 1,
          speaker: { from: 'team', speakerId: 'member-1', speakerName: '缓存审查员' },
        },
      },
    });
    const teamDm = apiMessageToChat({
      id: 'team-dm',
      role: 'user',
      content: [{ type: 'text', text: '<system-reminder>请检查缓存键。</system-reminder>' }],
      created_at: '2026-07-14T00:00:01.000Z',
      metadata: {
        origin: {
          kind: 'system_trigger',
          name: 'team_dm',
          speaker: { from: 'team', speakerId: 'agent-alpha', speakerName: 'Alpha' },
        },
      },
    });

    expect(user).toMatchObject({ role: 'user', text: '普通用户消息' });
    expect(user?.workBlocks).toBeUndefined();
    expect(teamSpeak).toMatchObject({
      role: 'system',
      kind: 'discussion',
      text: '缓存策略应该保留。',
      speaker: { from: 'team', name: '缓存审查员' },
    });
    expect(teamSpeak?.workBlocks).toBeUndefined();
    // A team DM is injected context, not a chat bubble: it renders as a
    // context-injection row attributed to its speaker.
    expect(teamDm).toMatchObject({
      role: 'assistant',
      text: '',
      workBlocks: [{ type: 'context', source: 'team-dm · Alpha', content: '请检查缓存键。' }],
    });

    const legacyTeamDm = apiMessageToChat({
      id: 'legacy-team-dm',
      role: 'user',
      content: [{ type: 'text', text: '<system-reminder>旧版私信。</system-reminder>' }],
      created_at: '2026-07-14T00:00:02.000Z',
      metadata: {
        origin: {
          kind: 'system_trigger',
          name: 'team_member',
          speaker: { from: 'team', speakerId: 'member-1', speakerName: '缓存审查员' },
        },
      },
    });
    expect(legacyTeamDm).toMatchObject({
      role: 'assistant',
      workBlocks: [{ type: 'context', source: 'team-dm · 缓存审查员', content: '旧版私信。' }],
    });
  });

  it('keeps each assistant message around a hidden wake-up trigger', () => {
    const first = apiMessageToChat(message({ id: 'a1', role: 'assistant', text: 'Agent started in the background.' }))!;
    const boundary = apiMessageToChat(message({ id: 'wake', role: 'user', text: 'done', originKind: 'background_task' }))!;
    const second = apiMessageToChat(message({ id: 'a2', role: 'assistant', text: 'The agent completed successfully.' }))!;
    const folded = foldConversationTurns([first, boundary, second]);
    expect(folded.map(item => item.text)).toEqual([
      'Agent started in the background.',
      'The agent completed successfully.',
    ]);
  });

  it('keeps a background wake-up answer as a separate assistant message', () => {
    const previous = [
      { id: 'u1', role: 'user' as const, text: 'Run a SubAgent', createdAt: '2026-07-14T00:00:00.000Z' },
      { id: 'a1', role: 'assistant' as const, text: 'The SubAgent is running.', createdAt: '2026-07-14T00:00:01.000Z' },
    ];
    // The wake-up is recorded as a silent boundary row; it answers a background
    // event, not the user's command, so it must break the command group.
    const completedAfterWake = [
      { id: 'wake', role: 'system' as const, text: '', turnBoundary: true as const, createdAt: '2026-07-14T00:00:02.000Z' },
      { id: 'a2', role: 'assistant' as const, text: 'The SubAgent finished.', createdAt: '2026-07-14T00:00:03.000Z' },
    ];

    expect(mergeHistory(previous, completedAfterWake)).toMatchObject([
      { role: 'user', text: 'Run a SubAgent' },
      { role: 'assistant', text: 'The SubAgent is running.' },
      { role: 'assistant', text: 'The SubAgent finished.' },
    ]);
  });

  it('preserves distinct persisted wake-up messages even when their text is identical', () => {
    const previous = [
      { id: 'assistant-a', role: 'assistant' as const, text: 'Done.', createdAt: '2026-07-14T00:00:01.000Z' },
      { id: 'wake', role: 'system' as const, text: '', turnBoundary: true as const, createdAt: '2026-07-14T00:00:01.500Z' },
    ];
    const incoming = [
      { id: 'assistant-b', role: 'assistant' as const, text: 'Done.', createdAt: '2026-07-14T00:00:02.000Z' },
    ];

    const merged = mergeHistory(previous, incoming);

    expect(merged).toHaveLength(2);
    expect(merged.map(message => message.id)).toEqual(['assistant-a', 'assistant-b']);
    expect(merged.every(message => message.text === 'Done.')).toBe(true);
  });

  it('does not fold a live completion into an existing history message', () => {
    const remote = [{
      id: 'msg_session_000002',
      role: 'assistant' as const,
      text: '最终回答只出现一次。',
      workBlocks: [
        { id: 'history-progress', type: 'progress' as const, text: '正在检查文件。' },
        { id: 'history-tool', type: 'tool' as const, tool: { id: 'tool-1', name: 'Read', args: { path: 'src/a.ts' }, result: 'ok' } },
      ],
      createdAt: '2026-08-19T05:00:00.000Z',
    }];
    const live = [{
      id: 'live-session-temporary-id',
      role: 'assistant' as const,
      text: '最终回答只出现一次。',
      workBlocks: [
        { id: 'live-progress', type: 'progress' as const, text: '正在检查文件。' },
        { id: 'live-tool', type: 'tool' as const, tool: { id: 'tool-1', name: 'Read', args: { path: 'src/a.ts' } } },
      ],
      createdAt: '2026-08-19T05:00:04.000Z',
    }];

    const merged = mergeHistory(live, remote);

    expect(merged).toHaveLength(2);
    expect(merged.map(message => message.id)).toEqual(['msg_session_000002', 'live-session-temporary-id']);
    expect(merged.every(message => message.text === '最终回答只出现一次。')).toBe(true);
  });

  it('keeps a live process row separate from the stable final history row', () => {
    const merged = mergeHistory([
      {
        id: 'live-session-other-temporary-id',
        role: 'assistant',
        text: '',
        workBlocks: [{ id: 'live-progress', type: 'progress', text: '过程输出。' }],
        createdAt: '2026-08-19T05:00:04.000Z',
      },
    ], [{
      id: 'msg_session_000002',
      role: 'assistant',
      text: '真正的最终回答。',
      workBlocks: [{ id: 'history-progress', type: 'progress', text: '过程输出。' }],
      createdAt: '2026-08-19T05:00:00.000Z',
    }]);

    expect(merged).toHaveLength(2);
    expect(merged.map(message => message.id)).toEqual(['msg_session_000002', 'live-session-other-temporary-id']);
    expect(merged[0]).toMatchObject({ text: '真正的最终回答。' });
    expect(merged[1]?.text).toBe('');
  });

  it('does not turn an already confirmed final answer into a progress block', () => {
    const confirmed = {
      id: 'msg_session_000002',
      role: 'assistant' as const,
      text: '最终回答。',
      workBlocks: [{ id: 'history-progress', type: 'progress' as const, text: '检查完成。' }],
      createdAt: '2026-08-19T05:00:00.000Z',
    };
    const completedLive = {
      id: 'live-session-completed-temporary-id',
      role: 'assistant' as const,
      text: '最终回答。',
      workBlocks: [{ id: 'live-progress', type: 'progress' as const, text: '检查完成。' }],
      createdAt: '2026-08-19T05:00:04.000Z',
    };

    const merged = mergeHistory([confirmed], [completedLive]);

    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ id: 'msg_session_000002', text: '最终回答。' });
    expect(merged[1]).toMatchObject({ id: 'live-session-completed-temporary-id', text: '最终回答。' });
  });

  it('does not merge a team member report into an assistant answer', () => {
    const report = {
      id: 'team-report-1',
      role: 'system' as const,
      kind: 'discussion' as const,
      text: '成员回报：缓存策略应该保留。',
      speaker: { from: 'team' as const, id: 'member-1', name: '缓存审查员' },
    };

    const merged = mergeHistory([report], [report]);

    expect(merged).toEqual([report]);
  });

  it('folds consecutive assistant messages of one command into a single row', () => {
    const folded = foldConversationTurns([
      { id: 'a1', role: 'assistant', text: 'I will inspect the files.' },
      { id: 'a2', role: 'assistant', text: 'The issue is in the event projector.' },
    ]);
    expect(folded).toHaveLength(1);
    expect(folded[0]?.text).toBe('The issue is in the event projector.');
    expect(folded[0]?.workBlocks?.map(block => block.type)).toEqual(['progress']);
    expect(folded[0]?.workBlocks?.[0]).toMatchObject({ type: 'progress', text: 'I will inspect the files.' });
  });

  it('folds a retried answer into the same command row while the error stays visible', () => {
    const folded = foldConversationTurns([
      { id: 'u', role: 'user', text: 'question' },
      { id: 'a1', role: 'assistant', text: 'first answer' },
      { id: 'error', role: 'system', text: 'turn failed' },
      { id: 'a2', role: 'assistant', text: 'retry answer' },
    ]);

    expect(folded.map(message => [message.id, message.role, message.text])).toEqual([
      ['u', 'user', 'question'],
      ['a1', 'assistant', 'retry answer'],
      ['error', 'system', 'turn failed'],
    ]);
    expect(folded[1]?.workBlocks?.[0]).toMatchObject({ type: 'progress', text: 'first answer' });
  });

  it('keeps one turn in one work process when a discussion statement lands between its steps', () => {
    // A team statement is recorded between two steps of the same turn and carries
    // that turn's id. Folding by adjacency split the turn here, so one response
    // rendered as several work processes.
    const folded = foldConversationTurns([
      { id: 'u', role: 'user', text: '检查缓存策略' },
      {
        id: 'step1',
        role: 'assistant',
        turnId: '7',
        text: '',
        workBlocks: [{ id: 'read-1', type: 'tool', tool: { id: 'read-1', name: 'Read', args: {} } }],
      },
      {
        id: 'statement',
        role: 'system',
        kind: 'discussion',
        turnId: '7',
        text: '成员回报：缓存策略应该保留。',
        speaker: { from: 'team', id: 'member-1', name: '缓存审查员' },
      },
      {
        id: 'step2',
        role: 'assistant',
        turnId: '7',
        text: '缓存策略保持不变。',
        workBlocks: [{ id: 'edit-1', type: 'tool', tool: { id: 'edit-1', name: 'Edit', args: {} } }],
      },
    ]);

    expect(folded.map(message => message.id)).toEqual(['u', 'step1', 'statement']);
    const turn = folded[1];
    expect(turn?.text).toBe('缓存策略保持不变。');
    expect(turn?.workBlocks?.map(block => block.id)).toEqual(['read-1', 'edit-1']);
  });

  it('starts a new work process for work that follows a steer instead of folding it back', () => {
    // Steering keeps the server turn id. The work after the interjection must not
    // fold into the row above it, or it would render before the message that
    // asked for it.
    const folded = foldConversationTurns([
      {
        id: 'pre',
        role: 'assistant',
        turnId: '7',
        text: '',
        workBlocks: [{ id: 'read-1', type: 'tool', tool: { id: 'read-1', name: 'Read', args: {} } }],
      },
      { id: 'steer', role: 'user', text: '先看配置文件' },
      {
        id: 'post',
        role: 'assistant',
        turnId: '7',
        text: '配置文件没有问题。',
        workBlocks: [{ id: 'read-2', type: 'tool', tool: { id: 'read-2', name: 'Read', args: {} } }],
      },
    ]);

    expect(folded.map(message => message.id)).toEqual(['pre', 'steer', 'post']);
    expect(folded[0]?.workBlocks?.map(block => block.id)).toEqual(['read-1']);
    expect(folded[2]?.workBlocks?.map(block => block.id)).toEqual(['read-2']);
  });

  it('folds every step of one turn into a single row even across many steps', () => {
    const folded = foldConversationTurns([
      { id: 's1', role: 'assistant', turnId: '3', text: '', workBlocks: [{ id: 't1', type: 'tool', tool: { id: 't1', name: 'Read', args: {} } }] },
      { id: 's2', role: 'assistant', turnId: '3', text: '', workBlocks: [{ id: 't2', type: 'tool', tool: { id: 't2', name: 'Grep', args: {} } }] },
      { id: 's3', role: 'assistant', turnId: '3', text: '完成。', workBlocks: [] },
    ]);

    expect(folded).toHaveLength(1);
    expect(folded[0]?.text).toBe('完成。');
    expect(folded[0]?.workBlocks?.map(block => block.id)).toEqual(['t1', 't2']);
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

  it('keeps folded command rows stable when history is projected again', () => {
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
    expect(twice).toHaveLength(1);
    expect(twice[0]?.text).toBe('The change is complete and verified.');
  });

  it('folds tool results into the assistant turn that called them', () => {
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
    expect(folded).toHaveLength(1);
    expect(folded[0]?.workBlocks?.map(block => block.type)).toEqual(['thinking', 'tool', 'thinking']);
    expect(folded[0]?.toolCalls).toMatchObject([{
      id: 'edit-1',
      result: 'Content tag mismatch',
      isError: true,
    }]);
    expect(folded[0]?.text).toBe('Done.');
  });

  it('drops an orphan tool result without inventing the name tool', () => {
    const orphan = apiMessageToChat({
      id: 'orphan-result',
      role: 'tool',
      created_at: '2026-07-14T00:00:00.000Z',
      content: [{ type: 'tool_result', tool_call_id: 'missing', output: 'stale' }],
    });
    expect(orphan?.toolResult?.toolCallId).toBe('missing');
    expect(foldConversationTurns([orphan!])).toEqual([]);
  });

  it('groups consecutive tool-only assistant steps into one work process', () => {
    const first = apiMessageToChat({
      id: 'step-a', role: 'assistant', created_at: '2026-07-14T00:00:01.000Z',
      content: [{ type: 'tool_use', tool_call_id: 'read-1', tool_name: 'Read', input: { path: 'a.ts' } }],
    })!;
    const firstResult = apiMessageToChat({
      id: 'result-a', role: 'tool', created_at: '2026-07-14T00:00:02.000Z',
      content: [{ type: 'tool_result', tool_call_id: 'read-1', output: 'a' }],
    })!;
    const second = apiMessageToChat({
      id: 'step-b', role: 'assistant', created_at: '2026-07-14T00:00:03.000Z',
      content: [{ type: 'tool_use', tool_call_id: 'grep-1', tool_name: 'Grep', input: { pattern: 'x' } }],
    })!;
    const secondResult = apiMessageToChat({
      id: 'result-b', role: 'tool', created_at: '2026-07-14T00:00:04.000Z',
      content: [{ type: 'tool_result', tool_call_id: 'grep-1', output: 'b' }],
    })!;

    const folded = foldConversationTurns([first!, firstResult!, second!, secondResult!]);
    expect(folded).toHaveLength(1);
    expect(folded[0]?.workBlocks?.filter(block => block.type === 'tool')).toHaveLength(2);
    expect(folded[0]?.toolCalls?.map(tool => tool.name)).toEqual(['Read', 'Grep']);
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

/**
 * A failed turn is the one moment the reader most needs the transcript to hold
 * still: the round's output plus what went wrong. The authoritative refresh that
 * follows the failure used to replace the list wholesale, taking the error notice
 * with it.
 */
describe('failed turns keep their output and their cause', () => {
  const remote = [
    { id: 'msg_1', role: 'user' as const, text: 'do the thing', createdAt: '2026-08-24T10:00:00.000Z' },
    { id: 'msg_2', role: 'assistant' as const, text: 'half an answ', createdAt: '2026-08-24T10:00:05.000Z' },
  ];

  it('keeps a client error notice through an authoritative replace, in transcript order', () => {
    const notice = {
      id: 'turn-error-session-a-main-7',
      role: 'system' as const,
      text: 'max output tokens exceeded',
      createdAt: '2026-08-24T10:00:06.000Z',
    };
    const reconciled = reconcileHistory([...remote, notice], remote);

    expect(reconciled.map(message => message.id)).toEqual(['msg_1', 'msg_2', 'turn-error-session-a-main-7']);
    expect(reconciled.at(-1)?.text).toBe('max output tokens exceeded');
  });

  it('drops the local notice once the server reports the same id', () => {
    const notice = { id: 'stream-error-1', role: 'system' as const, text: 'boom', createdAt: '2026-08-24T10:00:06.000Z' };
    const authoritative = [...remote, { ...notice, text: 'boom (from server)' }];

    expect(reconcileHistory([...remote, notice], authoritative).filter(m => m.id === 'stream-error-1'))
      .toEqual([expect.objectContaining({ text: 'boom (from server)' })]);
  });

  it('only treats client-generated ids as notices to preserve', () => {
    expect(isClientNoticeId('turn-error-a-main-1')).toBe(true);
    expect(isClientNoticeId('stream-error-123')).toBe(true);
    expect(isClientNoticeId('msg_probe_0001')).toBe(false);
  });

  it('shows the provider wording, and keeps the code for reporting', () => {
    expect(turnFailureText({ message: 'max output tokens exceeded', code: 'provider_api_error' }))
      .toBe('max output tokens exceeded\n\n`provider_api_error`');
    expect(turnFailureText({ message: 'rate limited' })).toBe('rate limited');
    expect(turnFailureText({ code: 'provider_rate_limit' })).toBe('Turn failed: `provider_rate_limit`');
    expect(turnFailureText(undefined)).toBe('Turn failed without a reported cause.');
  });
});
