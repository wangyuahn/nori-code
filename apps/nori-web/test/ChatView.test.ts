import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest, ModelCatalogItem, QuestionRequest, Session } from '../src/api/client';
import { ChatView, modelSupportsImageInput, type ChatViewProps } from '../src/components/ChatView';
import { I18nProvider } from '../src/i18n';
import { modelThinkingOptions } from '../src/utils/model-thinking';
import { projectFileMention, referenceProjectFile } from '../src/projectFileReference';

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
    }, { timeout: 3_000 });
  });
});

describe('project file references', () => {
  it('formats relative paths safely for the main agent', () => {
    expect(projectFileMention('src/app.ts')).toBe('@src/app.ts');
    expect(projectFileMention('docs/product brief.md')).toBe('@"docs/product brief.md"');
    expect(projectFileMention('src\\windows.ts')).toBe('@src/windows.ts');
  });

  it('inserts a referenced file into the current draft without sending it', async () => {
    const { container, props } = await renderChat();
    const input = container.querySelector<HTMLTextAreaElement>('.chat-input')!;
    await enterText(input, 'Review');

    await act(async () => {
      referenceProjectFile('docs/product brief.md');
      await new Promise(resolve => requestAnimationFrame(resolve));
    });

    expect(input.value).toBe('Review @"docs/product brief.md" ');
    expect(document.activeElement).toBe(input);
    expect(props.onSendMessage).not.toHaveBeenCalled();
  });
});

describe('model thinking options', () => {
  it('offers Fast and Think when a third-party model omits reasoning metadata', () => {
    expect(modelThinkingOptions(model('gateway-model', ['tool_use']))).toEqual({
      choices: [
        { value: 'off', kind: 'fast' },
        { value: 'medium', kind: 'think' },
      ],
      defaultValue: 'off',
    });
  });

  it('uses provider-declared effort levels without inventing more levels', () => {
    expect(modelThinkingOptions({
      ...model('reasoning-model', ['tool_use', 'thinking']),
      support_efforts: ['minimal', 'high'],
      default_effort: 'high',
    })).toEqual({
      choices: [
        { value: 'off', kind: 'fast' },
        { value: 'minimal', kind: 'effort' },
        { value: 'high', kind: 'effort' },
      ],
      defaultValue: 'high',
    });
  });

  it('uses a declared none effort as Fast without adding a duplicate off choice', () => {
    expect(modelThinkingOptions({
      ...model('catalog-reasoning-model', ['tool_use', 'thinking']),
      support_efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
    })).toEqual({
      choices: [
        { value: 'none', kind: 'fast' },
        { value: 'minimal', kind: 'effort' },
        { value: 'low', kind: 'effort' },
        { value: 'medium', kind: 'effort' },
        { value: 'high', kind: 'effort' },
        { value: 'xhigh', kind: 'effort' },
      ],
      defaultValue: 'medium',
    });
  });

  it('uses a boolean Think switch when support is known but levels are absent', () => {
    expect(modelThinkingOptions({
      ...model('toggle-model', ['tool_use', 'thinking']),
      supports_thinking: true,
    })).toEqual({
      choices: [
        { value: 'off', kind: 'fast' },
        { value: 'medium', kind: 'think' },
      ],
      defaultValue: 'medium',
    });
  });

  it('hides the control when catalog metadata explicitly marks thinking unsupported', () => {
    expect(modelThinkingOptions({
      ...model('text-only-model', ['tool_use']),
      supports_thinking: false,
    })).toEqual({ choices: [], defaultValue: 'off' });
  });
});

describe('interactive user questions', () => {
  it('submits a selected option so the waiting model can continue', async () => {
    const onResolveQuestion = vi.fn(async () => undefined);
    const { container } = await renderChat({
      pendingQuestions: [questionRequest()],
      onResolveQuestion,
      onDismissQuestion: vi.fn(async () => undefined),
    });

    const recommended = Array.from(container.querySelectorAll<HTMLButtonElement>('.question-options button'))
      .find(button => button.textContent?.includes('Use worktree'));
    await act(async () => recommended?.click());
    await act(async () => container.querySelector<HTMLButtonElement>('.question-submit')?.click());

    expect(onResolveQuestion).toHaveBeenCalledWith('question-1', {
      q_0: { kind: 'single', option_id: 'opt_0_0' },
    });
  });

  it('submits a free-form answer through the generated Other option', async () => {
    const onResolveQuestion = vi.fn(async () => undefined);
    const { container } = await renderChat({
      pendingQuestions: [questionRequest()],
      onResolveQuestion,
      onDismissQuestion: vi.fn(async () => undefined),
    });

    await act(async () => container.querySelector<HTMLButtonElement>('.question-other > button')?.click());
    const input = container.querySelector<HTMLInputElement>('.question-other input')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'Use a temporary branch');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>('.question-submit')?.click());

    expect(onResolveQuestion).toHaveBeenCalledWith('question-1', {
      q_0: { kind: 'other', text: 'Use a temporary branch' },
    });
  });
});

describe('tool permission controls', () => {
  it('switches the session to AUTO before approving the pending tool', async () => {
    const calls: string[] = [];
    const onPermissionChange = vi.fn(async (mode: 'auto' | 'yolo' | 'manual') => {
      calls.push(`mode:${mode}`);
    });
    const onResolveApproval = vi.fn(async (_id, decision) => {
      calls.push(`resolve:${decision}`);
    });
    const { container } = await renderChat({
      pendingApprovals: [approvalRequest()],
      onPermissionChange,
      onResolveApproval,
    });
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>('.approval-actions button'))
      .find(candidate => candidate.textContent?.includes('Switch to AUTO'));

    await act(async () => {
      button?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onPermissionChange).toHaveBeenCalledWith('auto');
    expect(onResolveApproval).toHaveBeenCalledWith(
      'approval-1',
      'approved',
      expect.objectContaining({ remember: false }),
    );
    expect(calls).toEqual(['mode:auto', 'resolve:approved']);
  });
});

describe('chat rewind', () => {
  it('restores an editable composer with the caret at the end after rewind succeeds', async () => {
    const onRewind = vi.fn(async () => 'prompt restored from history');
    const { container } = await renderChat({ onRewind });
    const previousInput = container.querySelector<HTMLTextAreaElement>('.chat-input')!;

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.message-rewind-btn')!.click();
      await Promise.resolve();
      await new Promise<void>(resolve => requestAnimationFrame(() => { resolve(); }));
    });

    expect(onRewind).toHaveBeenCalledWith(1);
    const restoredInput = container.querySelector<HTMLTextAreaElement>('.chat-input')!;
    expect(restoredInput).not.toBe(previousInput);
    expect(restoredInput.value).toBe('prompt restored from history');
    expect(restoredInput.selectionStart).toBe(restoredInput.value.length);
    expect(restoredInput.selectionEnd).toBe(restoredInput.value.length);

    await enterText(restoredInput, `${restoredInput.value} with a new instruction`);
    expect(container.querySelector<HTMLTextAreaElement>('.chat-input')!.value)
      .toBe('prompt restored from history with a new instruction');
  });
});

describe('live response controls', () => {
  it('merges a wake-up stream into the existing assistant bubble immediately', async () => {
    const { container } = await renderChat({
      messages: [
        { id: 'user-1', role: 'user', text: 'Run the swarm' },
        { id: 'assistant-1', role: 'assistant', text: 'The swarm is running.' },
      ],
      streaming: 'The swarm completed successfully.',
      isStreaming: true,
    });

    const assistantMessages = container.querySelectorAll('.chat-message-assistant');
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.textContent).toContain('The swarm is running.');
    expect(assistantMessages[0]?.textContent).toContain('The swarm completed successfully.');
    expect(assistantMessages[0]?.classList.contains('chat-message-streaming')).toBe(true);
  });

  it('serializes immediate guidance and keeps the draft until steering succeeds', async () => {
    let resolveSteer!: (accepted: boolean) => void;
    const onSendMessage = vi.fn(() => new Promise<boolean>(resolve => { resolveSteer = resolve; }));
    const { container } = await renderChat({ isStreaming: true, onSendMessage });
    const input = container.querySelector<HTMLTextAreaElement>('.chat-input')!;
    await enterText(input, 'Focus on the parser race');

    await act(async () => container.querySelector<HTMLButtonElement>('.chat-steer-btn')!.click());

    expect(onSendMessage).toHaveBeenCalledWith('Focus on the parser race', [], 'steer');
    expect(container.querySelector<HTMLButtonElement>('.chat-steer-btn')!.disabled).toBe(true);
    expect(input.value).toBe('Focus on the parser race');

    await act(async () => { resolveSteer(true); await Promise.resolve(); });
    expect(input.value).toBe('');
    await enterText(input, 'One more constraint');
    expect(container.querySelector<HTMLButtonElement>('.chat-steer-btn')!.disabled).toBe(false);
  });

  it('prevents duplicate stop requests and reports a failed stop', async () => {
    let resolveStop!: (stopped: boolean) => void;
    const onAbort = vi.fn(() => new Promise<boolean>(resolve => { resolveStop = resolve; }));
    const { container } = await renderChat({ isStreaming: true, onAbort });
    const button = container.querySelector<HTMLButtonElement>('.chat-abort-btn')!;

    await act(async () => button.click());
    button.click();
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('Stopping');

    await act(async () => { resolveStop(false); await Promise.resolve(); });
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain('Stop response');
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

function questionRequest(): QuestionRequest {
  return {
    question_id: 'question-1',
    session_id: 'session-1',
    tool_call_id: 'tool-question-1',
    created_at: '2026-07-15T00:00:00.000Z',
    questions: [{
      id: 'q_0',
      header: 'Workflow',
      question: 'How should this task be isolated?',
      options: [
        { id: 'opt_0_0', label: 'Use worktree', description: 'Keep changes isolated.' },
        { id: 'opt_0_1', label: 'Use local checkout', description: 'Modify the active workspace.' },
      ],
      allow_other: true,
      other_label: 'Other',
      other_description: 'Describe another approach',
    }],
  };
}

function approvalRequest(): ApprovalRequest {
  return {
    approval_id: 'approval-1',
    session_id: 'session-1',
    tool_call_id: 'tool-1',
    tool_name: 'Bash',
    action: 'Run pnpm test',
    tool_input_display: { kind: 'command', command: 'pnpm test' },
    created_at: '2026-07-15T00:00:00.000Z',
    expires_at: '2026-07-15T00:05:00.000Z',
  };
}
