import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelCatalogItem, Session } from '../src/api/client';
import { ChatView, type ChatViewProps } from '../src/components/ChatView';
import { I18nProvider } from '../src/i18n';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: ReturnType<typeof createRoot>[] = [];

beforeEach(() => {
  localStorage.setItem('nori-ui-language', 'en');
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('ChatView tool details and context injection', () => {
  it('expands a tool call into real arguments, result, status, duration, and error', async () => {
    const { container } = await renderChat({
      messages: [{
        id: 'assistant-1',
        role: 'assistant',
        text: 'Edited the file.',
        workBlocks: [{
          id: 'edit-1',
          type: 'tool',
          tool: {
            id: 'edit-1',
            name: 'Edit',
            args: {
              path: 'src/a.ts',
              expected_tag: 'A1B2',
              line_ops: [{ op: 'swap', start: 1, end: 1, content: 'running' }],
            },
            result: '[src/a.ts#C3D4]\nApplied 1 line operation to src/a.ts.',
            startedAt: 1_000,
            endedAt: 1_400,
          },
        }],
      }],
    });

    const details = container.querySelector<HTMLDetailsElement>('.compact-tool-call')!;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });
    expect(container.textContent).toContain('Tool');
    expect(container.textContent).toContain('Edit');
    expect(container.textContent).toContain('Arguments');
    expect(container.textContent).toContain('src/a.ts');
    expect(container.textContent).toContain('Result');
    expect(container.textContent).toContain('Applied 1 line operation');
    expect(container.textContent).toContain('Duration');
    expect(container.textContent).toContain('400ms');
    expect(container.textContent).toContain('File path');
    expect(container.textContent).toContain('Expected tag');
    expect(container.textContent).toContain('A1B2');
    expect(container.textContent).toContain('Line operations');
    expect(container.textContent).toContain('replace lines 1-1');
    expect(container.textContent).toContain('Changes');
    expect(container.textContent).toContain('running');
    expect(container.textContent).toContain('Apply result');
    expect(container.querySelector('.compact-tool-detail')).not.toBeNull();
  });

  it('renders context injections as compact visible transcript rows', async () => {
    const { container } = await renderChat({
      messages: [{
        id: 'inject-1',
        role: 'assistant',
        text: '',
        workBlocks: [
          { id: 'prompt-1', type: 'tool', tool: { id: 'prompt-1', name: 'ContextInjection', args: { source: '@deepseek-ai/dsh-system-prompt' }, result: '' } },
          { id: 'skill-1', type: 'tool', tool: { id: 'skill-1', name: 'ContextInjection', args: { source: 'skill-catalog' }, result: '' } },
          { id: 'loop-1', type: 'tool', tool: { id: 'loop-1', name: 'ContextInjection', args: { source: 'goal_intake' }, result: 'Continue the current goal.' } },
        ],
      }],
    });

    const rows = [...container.querySelectorAll('.context-injection-row')];
    expect(rows.map(row => row.textContent)).toEqual([
      expect.stringContaining('@deepseek-ai/dsh-system-prompt'),
      expect.stringContaining('skill-catalog'),
      expect.stringContaining('goal_intake'),
    ]);
    expect(container.querySelectorAll('.context-injection-row > summary svg').length).toBe(4);
  });

  it('expands visible context injection content without a callable tool card', async () => {
    const { container } = await renderChat({
      messages: [
        {
          id: 'inject-expand',
          role: 'assistant',
          text: '',
          workBlocks: [{
            id: 'inject-body',
            type: 'tool',
            tool: {
              id: 'inject-body',
              name: 'ContextInjection',
              args: { source: 'system_reminder' },
              result: 'Only the model should see this reminder.',
            },
          }],
        },
        {
          id: 'discussion-visible',
          role: 'system',
          kind: 'discussion',
          text: '成员建议保留兼容字段。',
          speaker: { from: 'team', name: '兼容性成员' },
        },
      ],
    });

    const details = container.querySelector<HTMLDetailsElement>('.context-injection-row')!;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(container.querySelector('.chat-message-discussion')?.textContent).toContain('成员建议保留兼容字段。');
    expect(container.querySelector('.chat-message-discussion')?.textContent).toContain('Discussion member');

    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });
    expect(details.open).toBe(true);
    expect(details.textContent).toContain('Only the model should see this reminder.');
    expect(container.querySelector('.compact-tool-call')).toBeNull();
  });

  it('streams into the turn it belongs to instead of rendering a second live block', async () => {
    // The live work of a turn that already has a transcript row must extend that
    // row. Rendering the standalone live stream as well showed the same turn in
    // both the history area and the live area at once.
    const { container } = await renderChat({
      messages: [{
        id: 'turn-row',
        role: 'assistant',
        turnId: '9',
        text: '',
        workBlocks: [{ id: 'read-1', type: 'tool', tool: { id: 'read-1', name: 'Read', args: {} } }],
      }],
      isStreaming: true,
      streamingTurnId: '9',
      workBlocks: [{ id: 'edit-1', type: 'tool', tool: { id: 'edit-1', name: 'Edit', args: {} } }],
    });

    expect(container.querySelectorAll('.chat-message-streaming').length).toBe(0);
    expect(container.querySelectorAll('.chat-work-stream').length).toBe(1);
    const tools = [...container.querySelectorAll('.compact-tool-call')];
    expect(tools.length).toBe(2);
  });
});

async function renderChat(overrides: Partial<ChatViewProps> = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const props: ChatViewProps = {
    session: session(),
    messages: [],
    streaming: '',
    thinking: '',
    isStreaming: false,
    models: [model()],
    modelsLoading: false,
    modelError: null,
    onSendMessage: vi.fn(async () => true),
    onAbort: vi.fn(),
    onRefreshModels: vi.fn(),
    onModelChange: vi.fn(),
    onThinkingChange: vi.fn(),
    onPermissionChange: vi.fn(),
    onRunSlashCommand: vi.fn(async () => true),
    onRewind: vi.fn(async () => ''),
    ...overrides,
  };
  await act(async () => {
    root.render(createElement(I18nProvider, null, createElement(ChatView, props)));
  });
  return { container, props, root };
}

function model(): ModelCatalogItem {
  return { provider: 'test', model: 'test-model', max_context_size: 128_000, capabilities: ['tool_use'] };
}

function session(): Session {
  return {
    id: 'session-1',
    title: 'Test conversation',
    status: 'idle',
    created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:00:00.000Z',
    agent_config: { model: 'test-model' },
  };
}
