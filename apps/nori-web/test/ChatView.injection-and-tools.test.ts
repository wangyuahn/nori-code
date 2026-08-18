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

  it('renders context injection rows with a document icon and source name', async () => {
    const { container } = await renderChat({
      messages: [{
        id: 'inject-1',
        role: 'system',
        text: '',
        workBlocks: [
          { id: 'prompt-1', type: 'context_injection', source: '@deepseek-ai/dsh-system-prompt' },
          { id: 'skill-1', type: 'context_injection', source: 'skill-catalog' },
          { id: 'loop-1', type: 'context_injection', source: 'goal_intake', text: 'Continue the current goal.' },
        ],
      }],
    });

    const rows = [...container.querySelectorAll('.compact-context-injection')];
    expect(rows.map(row => row.textContent)).toEqual([
      expect.stringContaining('Context injection · @deepseek-ai/dsh-system-prompt'),
      expect.stringContaining('Context injection · skill-catalog'),
      expect.stringContaining('Context injection · goal_intake'),
    ]);
    expect(container.querySelectorAll('.compact-context-injection .compact-tool-icon svg').length).toBe(3);
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
    onTaskModeChange: vi.fn(),
    onRunSlashCommand: vi.fn(async () => true),
    onMainWriteChange: vi.fn(),
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
