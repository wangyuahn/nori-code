import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest, ModelCatalogItem, Session } from '../src/api/client';
import { ChatView, modelSupportsImageInput, type ChatViewProps } from '../src/components/ChatView';
import { I18nProvider } from '../src/i18n';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

beforeEach(() => {
  localStorage.setItem('nori-ui-language', 'en');
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('chat image attachments', () => {
  it('renders images stored in chat history', async () => {
    const { container } = await renderChat({
      messages: [{
        id: 'user-image',
        role: 'user',
        text: 'Please inspect this screenshot.',
        images: [{ src: 'data:image/png;base64,aGVsbG8=', alt: 'screen.png' }],
      }],
    });

    const image = container.querySelector<HTMLImageElement>('.chat-message-images img');
    expect(image?.src).toBe('data:image/png;base64,aGVsbG8=');
    expect(image?.alt).toBe('screen.png');
  });

  it('uses catalog capabilities instead of model names', () => {
    expect(modelSupportsImageInput(model('custom-model', ['image_in']))).toBe(true);
    expect(modelSupportsImageInput(model('vision-in-name-only', ['tool_use']))).toBe(false);
    expect(modelSupportsImageInput(undefined)).toBe(false);
  });

  it('supports both mapped and raw managed-Kimi catalog capability shapes', () => {
    const mappedKimi = model('kimi-code/kimi-for-coding', [
      'thinking',
      'image_in',
      'video_in',
      'tool_use',
    ]);
    const rawKimi = {
      ...model('kimi-code/kimi-for-coding', ['thinking', 'tool_use']),
      display_name: 'Kimi for Coding',
      supports_image_in: true,
    };
    const runtimeKimi = {
      ...model('kimi-code/kimi-for-coding', ['thinking', 'tool_use']),
      model_capabilities: { image_in: true },
    };
    const modelsDevKimi = {
      ...model('k2p7', []),
      modalities: { input: ['text', 'image', 'video'] },
    };

    expect(modelSupportsImageInput(mappedKimi)).toBe(true);
    expect(modelSupportsImageInput(rawKimi)).toBe(true);
    expect(modelSupportsImageInput(runtimeKimi)).toBe(true);
    expect(modelSupportsImageInput(modelsDevKimi)).toBe(true);
  });

  it('does not infer image support from a Kimi-looking model name', () => {
    expect(modelSupportsImageInput({
      ...model('kimi-code/kimi-text-only', ['thinking', 'tool_use']),
      supports_image_in: false,
    })).toBe(false);
  });

  it('shows a clear error when an unsupported model receives an image', async () => {
    const { container, props } = await renderChat({
      session: session('text-model'),
      models: [model('text-model', ['tool_use'])],
    });
    const input = container.querySelector<HTMLInputElement>('.composer-image-input')!;
    const image = new File(['image'], 'screen.png', { type: 'image/png' });

    Object.defineProperty(input, 'files', { configurable: true, value: [image] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));

    expect(container.querySelector('[role="status"]')?.textContent).toContain('does not support image input');
    expect(container.querySelector('.composer-attachment')).toBeNull();
    expect(props.onSendMessage).not.toHaveBeenCalled();
  });

  it('allows image attachment for the raw managed-Kimi catalog shape', async () => {
    const kimiModel = {
      ...model('kimi-code/kimi-for-coding', ['thinking', 'tool_use']),
      display_name: 'Kimi for Coding',
      supports_image_in: true,
    };
    const { container } = await renderChat({
      session: session(kimiModel.model),
      models: [kimiModel],
    });
    const input = container.querySelector<HTMLInputElement>('.composer-image-input')!;
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['image'], 'kimi-screen.png', { type: 'image/png' })],
    });

    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(container.querySelector<HTMLImageElement>('.composer-attachment img')?.alt).toBe('kimi-screen.png');
    expect(container.querySelector('.composer-error')).toBeNull();
  });

  it('encodes and sends an image for a multimodal model', async () => {
    const { container, props } = await renderChat({
      session: session('multimodal-model'),
      models: [model('multimodal-model', ['tool_use', 'image_in'])],
    });
    const fileInput = container.querySelector<HTMLInputElement>('.composer-image-input')!;
    const image = new File(['image'], 'screen.png', { type: 'image/png' });

    Object.defineProperty(fileInput, 'files', { configurable: true, value: [image] });
    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    await vi.waitFor(() => {
      expect(container.querySelector<HTMLImageElement>('.composer-attachment img')?.alt).toBe('screen.png');
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.chat-send-btn')!.click();
      await Promise.resolve();
    });

    expect(props.onSendMessage).toHaveBeenCalledWith(
      '',
      [expect.objectContaining({
        kind: 'image',
        name: 'screen.png',
        source: expect.objectContaining({ kind: 'base64', media_type: 'image/png' }),
      })],
      'queue',
    );
  });

  it('removes images with an explicit warning when switching to a text-only model', async () => {
    const { container, props } = await renderChat({
      models: [
        model('multimodal-model', ['image_in']),
        model('text-model', ['tool_use']),
      ],
    });
    const fileInput = container.querySelector<HTMLInputElement>('.composer-image-input')!;
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: [new File(['image'], 'screen.png', { type: 'image/png' })],
    });
    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    const select = container.querySelector<HTMLSelectElement>('.model-select')!;
    await act(async () => {
      select.value = 'text-model';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(props.onModelChange).toHaveBeenCalledWith('text-model');
    await vi.waitFor(() => {
      expect(container.querySelector('.composer-attachment')).toBeNull();
      expect(container.querySelector('[role="status"]')?.textContent).toContain('does not support image input');
    });
  });
});

describe('chat rewind', () => {
  it('fills the restored prompt into the composer after rewind succeeds', async () => {
    const onRewind = vi.fn(async () => 'prompt restored from history');
    const { container } = await renderChat({ onRewind });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.message-rewind-btn')!.click();
      await Promise.resolve();
    });

    expect(onRewind).toHaveBeenCalledWith(1);
    expect(container.querySelector<HTMLTextAreaElement>('.chat-input')!.value).toBe('prompt restored from history');
  });
});

describe('chat slash commands and task-mode shortcut', () => {
  it('shows supported commands without duplicating the Plan control', async () => {
    const { container } = await renderChat();
    const input = container.querySelector<HTMLTextAreaElement>('.chat-input')!;

    await enterText(input, '/');

    const commands = Array.from(container.querySelectorAll<HTMLElement>('.composer-command-menu code')).map(element => element.textContent);
    expect(commands).toEqual(['/compact [instruction]', '/goal <objective>', '/swarm <task>']);
    expect(commands).not.toContain('/plan');
  });

  it('uses Tab to complete an open command menu without changing task mode', async () => {
    const { container, props } = await renderChat();
    const input = container.querySelector<HTMLTextAreaElement>('.chat-input')!;
    await enterText(input, '/');

    await pressKey(input, 'Tab');

    expect(input.value).toBe('/compact ');
    expect(props.onTaskModeChange).not.toHaveBeenCalled();
  });

  it('toggles Code to Plan with Tab only when the composer is unobstructed', async () => {
    const onTaskModeChange = vi.fn();
    const { container } = await renderChat({ onTaskModeChange });
    const input = container.querySelector<HTMLTextAreaElement>('.chat-input')!;

    await pressKey(input, 'Tab');
    expect(onTaskModeChange).toHaveBeenCalledWith('plan');

    onTaskModeChange.mockClear();
    const blocked = await renderChat({ onTaskModeChange, pendingApprovals: [{} as ApprovalRequest] });
    await pressKey(blocked.container.querySelector<HTMLTextAreaElement>('.chat-input')!, 'Tab');
    expect(onTaskModeChange).not.toHaveBeenCalled();
  });

  it('executes a goal command through the injected application handler', async () => {
    const onRunSlashCommand = vi.fn(async () => true);
    const activeSession = session('multimodal-model');
    activeSession.agent_config = { ...activeSession.agent_config, permission_mode: 'auto' };
    const { container } = await renderChat({ session: activeSession, onRunSlashCommand });
    const input = container.querySelector<HTMLTextAreaElement>('.chat-input')!;
    await enterText(input, '/goal ship the release');

    await pressKey(input, 'Enter');

    expect(onRunSlashCommand).toHaveBeenCalledWith('goal', 'ship the release');
    expect(input.value).toBe('');
  });

  it('rejects /plan instead of sending it as a normal prompt', async () => {
    const { container, props } = await renderChat();
    const input = container.querySelector<HTMLTextAreaElement>('.chat-input')!;
    await enterText(input, '/plan');

    await pressKey(input, 'Enter');

    expect(props.onRunSlashCommand).not.toHaveBeenCalled();
    expect(props.onSendMessage).not.toHaveBeenCalled();
    expect(container.querySelector('.composer-command-notice')?.textContent).toContain('Unknown slash command');
  });
});

async function renderChat(overrides: Partial<ChatViewProps> = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const props: ChatViewProps = {
    session: session('multimodal-model'),
    messages: [{ id: 'user-1', role: 'user', text: 'original prompt' }],
    streaming: '',
    thinking: '',
    isStreaming: false,
    models: [model('multimodal-model', ['tool_use', 'image_in'])],
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
    onRewind: vi.fn(async () => 'original prompt'),
    ...overrides,
  };
  await act(async () => {
    root.render(createElement(I18nProvider, null, createElement(ChatView, props)));
  });
  return { container, props };
}

async function enterText(input: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
}

async function pressKey(input: HTMLTextAreaElement, key: string) {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

function model(id: string, capabilities: string[]): ModelCatalogItem {
  return { provider: 'test', model: id, max_context_size: 128_000, capabilities };
}

function session(modelId: string): Session {
  return {
    id: 'session-1',
    title: 'Test conversation',
    status: 'idle',
    created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:00:00.000Z',
    agent_config: { model: modelId },
  };
}
