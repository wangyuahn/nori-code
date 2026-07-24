import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest, ModelCatalogItem, QuestionRequest, Session } from '../src/api/client';
import { ChatView, modelSupportsImageInput, type ChatViewProps } from '../src/components/ChatView';
import { I18nProvider } from '../src/i18n';
import { modelThinkingOptions } from '../src/utils/model-thinking';
import { projectFileMention, referenceProjectFile } from '../src/projectFileReference';
import type { NoriBrowserState, NoriDesktopAPI } from '../src/types/nori-desktop';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function pngFile(name: string): File {
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new File([signature], name, { type: 'image/png' });
}

beforeEach(() => {
  localStorage.setItem('nori-ui-language', 'en');
  localStorage.removeItem('nori-composer-loop-mode');
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.replaceChildren();
  delete window.noriDesktop;
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
    const image = pngFile('screen.png');

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
      value: [pngFile('kimi-screen.png')],
    });

    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    await vi.waitFor(() => {
      expect(container.querySelector<HTMLImageElement>('.composer-attachment img')?.alt).toBe('kimi-screen.png');
    });
    expect(container.querySelector('.composer-error')).toBeNull();
  });

  it('encodes and sends an image for a multimodal model', async () => {
    const { container, props } = await renderChat({
      session: session('multimodal-model'),
      models: [model('multimodal-model', ['tool_use', 'image_in'])],
    });
    const fileInput = container.querySelector<HTMLInputElement>('.composer-image-input')!;
    const image = pngFile('screen.png');

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

  it('reports a mislabeled non-image instead of sending it to the model', async () => {
    const { container } = await renderChat({
      session: session('multimodal-model'),
      models: [model('multimodal-model', ['tool_use', 'image_in'])],
    });
    const input = container.querySelector<HTMLInputElement>('.composer-image-input')!;
    const invalidImage = new File(['not an image'], 'broken.png', {
      type: 'text/plain; charset=utf-8',
    });

    Object.defineProperty(input, 'files', { configurable: true, value: [invalidImage] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    await vi.waitFor(() => {
      expect(container.querySelector('[role="status"]')?.textContent).toContain(
        'could not be attached',
      );
    });
    expect(container.querySelector('.composer-attachment')).toBeNull();
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
      value: [pngFile('screen.png')],
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

describe('conversation turn rail', () => {
  it('keeps one visible marker for a single-turn conversation', async () => {
    const { container } = await renderChat({
      messages: [{ id: 'user-1', role: 'user', text: 'single prompt' }],
    });

    const rail = container.querySelector('.chat-turn-rail');
    expect(rail).not.toBeNull();
    expect(rail?.querySelectorAll('button')).toHaveLength(1);
  });

  it('renders one marker per user turn, previews the nearest turn on hover, and jumps on click', async () => {
    const { container } = await renderChat({
      messages: [
        { id: 'user-1', role: 'user', text: 'first prompt' },
        { id: 'assistant-1', role: 'assistant', text: 'first answer' },
        { id: 'user-2', role: 'user', text: 'second prompt' },
        { id: 'assistant-2', role: 'assistant', text: 'second answer' },
        { id: 'user-3', role: 'user', text: 'third prompt' },
      ],
    });
    const scrollContainer = container.querySelector<HTMLDivElement>('.chat-messages')!;
    const scrollTo = vi.fn();
    Object.defineProperty(scrollContainer, 'scrollTo', { configurable: true, value: scrollTo });
    const markers = [...container.querySelectorAll<HTMLButtonElement>('.chat-turn-rail button')];

    expect(markers).toHaveLength(3);
    expect(markers[2]?.classList.contains('active')).toBe(true);

    const rail = container.querySelector<HTMLElement>('.chat-turn-rail')!;
    Object.defineProperty(rail, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 0, bottom: 100, left: 0, right: 30, width: 30, height: 100, x: 0, y: 0, toJSON: () => ({}) }),
    });
    await act(async () => {
      rail.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientY: 50 }));
    });
    expect(markers[1]?.classList.contains('active')).toBe(true);
    expect(container.querySelector('.chat-turn-preview')?.textContent).toContain('second prompt');
    expect(container.querySelector('.chat-turn-preview')?.textContent).toContain('second answer');

    await act(async () => {
      markers[1]?.click();
      await Promise.resolve();
    });
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
    expect(markers[1]?.getAttribute('aria-current')).toBe('step');
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
  it('shows the restored runtime model instead of a stale cached session model', async () => {
    const { container } = await renderChat({
      session: session('cached-model'),
      models: [model('cached-model', ['tool_use'])],
      sessionStatus: {
        status: 'idle',
        model: 'runtime-model',
        thinking_level: 'off',
        permission: 'manual',
        plan_mode: false,
        main_write_enabled: true,
        swarm_mode: false,
        goal: null,
        context_tokens: 0,
        max_context_tokens: 128_000,
        context_usage: 0,
      },
    });

    const select = container.querySelector<HTMLSelectElement>('.model-select');
    expect(select?.value).toBe('runtime-model');
    expect(select?.selectedOptions[0]?.textContent).toBe('runtime-model');
  });

  it('keeps a manual model selection visible while runtime status catches up', async () => {
    let resolveChange!: () => void;
    const onModelChange = vi.fn(() => new Promise<void>(resolve => { resolveChange = resolve; }));
    const { container } = await renderChat({
      session: session('old-model'),
      models: [model('old-model', ['tool_use']), model('new-model', ['tool_use'])],
      onModelChange,
      sessionStatus: {
        status: 'idle',
        model: 'old-model',
        thinking_level: 'off',
        permission: 'manual',
        plan_mode: false,
        main_write_enabled: true,
        swarm_mode: false,
        goal: null,
        context_tokens: 0,
        max_context_tokens: 128_000,
        context_usage: 0,
      },
    });
    const select = container.querySelector<HTMLSelectElement>('.model-select')!;

    await act(async () => {
      select.value = 'new-model';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onModelChange).toHaveBeenCalledWith('new-model');
    expect(select.value).toBe('new-model');
    await act(async () => {
      resolveChange();
      await Promise.resolve();
    });
  });

  it('uses themed in-app lists for model and reasoning selection', async () => {
    const onModelChange = vi.fn();
    const onThinkingChange = vi.fn();
    const { container } = await renderChat({
      models: [model('multimodal-model', ['tool_use', 'image_in']), model('second-model', ['tool_use'])],
      onModelChange,
      onThinkingChange,
    });

    expect(container.querySelector('.model-select')?.classList.contains('composer-native-select')).toBe(true);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.composer-model-trigger')!.click();
      container.querySelector<HTMLButtonElement>('[data-composer-setting="model"] .composer-setting-trigger')!.click();
      await Promise.resolve();
    });
    const modelOptions = container.querySelector('[data-composer-setting="model"] .composer-setting-options');
    expect(modelOptions?.getAttribute('aria-hidden')).toBe('false');

    await act(async () => {
      modelOptions?.querySelector<HTMLButtonElement>('[data-value="second-model"]')?.click();
      await Promise.resolve();
    });
    expect(onModelChange).toHaveBeenCalledWith('second-model');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-composer-setting="thinking"] .composer-setting-trigger')!.click();
      container.querySelector<HTMLButtonElement>('[data-composer-setting="thinking"] [data-value="medium"]')!.click();
      await Promise.resolve();
    });
    expect(onThinkingChange).toHaveBeenCalledWith('medium');
  });

  it('opens model settings immediately while the catalog is still loading', async () => {
    const { container } = await renderChat({ modelsLoading: true, models: [] });
    const trigger = container.querySelector<HTMLButtonElement>('.composer-model-trigger')!;

    expect(trigger.disabled).toBe(false);
    expect(trigger.getAttribute('aria-busy')).toBe('true');

    await act(async () => {
      trigger.click();
      await Promise.resolve();
    });

    expect(container.querySelector('.composer-model-popover')?.getAttribute('aria-hidden')).toBe('false');
  });

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

  it('shows browser permissions in the unified dock above the chat input', async () => {
    const calls: string[] = [];
    const state = browserPermissionState();
    const resolvedState = { ...state, permissions: { ...state.permissions, pending: [] } };
    const browserResolvePermission = vi.fn(async (_id, decision) => {
      calls.push(`resolve:${decision}`);
      return resolvedState;
    });
    const onPermissionChange = vi.fn(async (mode: 'auto' | 'yolo' | 'manual') => {
      calls.push(`mode:${mode}`);
    });
    const desktop: NoriDesktopAPI = {
      browserGetState: vi.fn(async () => state),
      browserResolvePermission,
      onBrowserState: () => () => undefined,
    };
    window.noriDesktop = desktop;

    const { container } = await renderChat({ onPermissionChange });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const composer = container.querySelector('.chat-composer-wrap');
    const permissionCard = composer?.querySelector('.browser-permission-card');
    expect(permissionCard?.textContent).toContain('Browser permission');
    expect(permissionCard?.textContent).toContain('https://example.com');
    expect(container.querySelector('.browser-native-prompt.permission')).toBeNull();

    expect(permissionCard?.textContent).toContain('Switch to AUTO and approve');
    expect(permissionCard?.textContent).toContain('Switch to YOLO and approve');

    const switchToAuto = [...(permissionCard?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
      .find(button => button.textContent === 'Switch to AUTO and approve');
    await act(async () => { switchToAuto?.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(onPermissionChange).toHaveBeenCalledWith('auto');
    expect(browserResolvePermission).toHaveBeenCalledWith('browser-permission-1', 'allow_once');
    expect(calls).toEqual(['mode:auto', 'resolve:allow_once']);
  });

  it.each(['auto', 'yolo'] as const)('automatically allows browser permissions in %s mode', async permissionMode => {
    const state = browserPermissionState();
    const resolvedState = { ...state, permissions: { ...state.permissions, pending: [] } };
    const browserResolvePermission = vi.fn(async () => resolvedState);
    window.noriDesktop = {
      browserGetState: vi.fn(async () => state),
      browserResolvePermission,
      onBrowserState: () => () => undefined,
    };
    const activeSession = session('multimodal-model');
    activeSession.agent_config = { ...activeSession.agent_config, permission_mode: permissionMode };

    const { container } = await renderChat({ session: activeSession });

    await vi.waitFor(() => {
      expect(browserResolvePermission).toHaveBeenCalledWith('browser-permission-1', 'allow_once');
      expect(container.querySelector('.browser-permission-card')).toBeNull();
    });
  });
});

describe('chat rewind', () => {
  it('restores the existing editable composer with the caret at the end after rewind succeeds', async () => {
    const onRewind = vi.fn(async () => 'prompt restored from history');
    const { container } = await renderChat({ onRewind });
    const previousInput = container.querySelector<HTMLTextAreaElement>('.chat-input')!;

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.message-rewind-btn')!.click();
      await Promise.resolve();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      await new Promise<void>(resolve => requestAnimationFrame(() => { resolve(); }));
    });

    expect(onRewind).toHaveBeenCalledWith(1);
    const restoredInput = container.querySelector<HTMLTextAreaElement>('.chat-input')!;
    expect(restoredInput).toBe(previousInput);
    expect(document.activeElement).toBe(restoredInput);
    expect(restoredInput.value).toBe('prompt restored from history');
    expect(restoredInput.selectionStart).toBe(restoredInput.value.length);
    expect(restoredInput.selectionEnd).toBe(restoredInput.value.length);

    await enterText(restoredInput, `${restoredInput.value} with a new instruction`);
    expect(container.querySelector<HTMLTextAreaElement>('.chat-input')!.value)
      .toBe('prompt restored from history with a new instruction');
  });

  it('keeps the rewind composer recoverable when the renderer regains focus later', async () => {
    const onRewind = vi.fn(async () => 'prompt restored after native dialog');
    const originalFocus = HTMLTextAreaElement.prototype.focus;
    let windowReady = false;
    vi.spyOn(HTMLTextAreaElement.prototype, 'focus').mockImplementation(function (this: HTMLTextAreaElement, options) {
      if (!windowReady) return;
      originalFocus.call(this, options);
    });
    const { container } = await renderChat({ onRewind });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.message-rewind-btn')!.click();
      await Promise.resolve();
    });

    windowReady = true;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await new Promise<void>(resolve => requestAnimationFrame(() => { resolve(); }));
    });

    const input = container.querySelector<HTMLTextAreaElement>('.chat-input')!;
    expect(document.activeElement).toBe(input);
    await enterText(input, `${input.value} and continue`);
    expect(input.value).toBe('prompt restored after native dialog and continue');
  });
});

describe('live response controls', () => {
  it('pins fast streaming output without animation and only animates an explicit return to latest', async () => {
    const { container, props, root } = await renderChat();
    const messageList = container.querySelector<HTMLDivElement>('.chat-messages')!;
    Object.defineProperty(messageList, 'scrollHeight', { configurable: true, value: 1_000 });
    Object.defineProperty(messageList, 'clientHeight', { configurable: true, value: 400 });
    messageList.scrollTop = 600;

    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(ChatView, {
        ...props,
        streaming: 'a fast streamed response',
        isStreaming: true,
      })));
    });

    expect(messageList.scrollTop).toBe(1_000);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();

    await act(async () => {
      messageList.scrollTop = 100;
      messageList.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    const jumpButton = container.querySelector<HTMLButtonElement>('.chat-jump-latest')!;
    expect(jumpButton).not.toBeNull();

    await act(async () => { jumpButton.click(); });
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth' });
  });

  it('re-enables follow output when switching conversations', async () => {
    const { container, props, root } = await renderChat();
    const messageList = container.querySelector<HTMLDivElement>('.chat-messages')!;
    Object.defineProperty(messageList, 'scrollHeight', { configurable: true, value: 1_000 });
    Object.defineProperty(messageList, 'clientHeight', { configurable: true, value: 400 });

    await act(async () => {
      messageList.scrollTop = 100;
      messageList.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(container.querySelector('.chat-jump-latest')).not.toBeNull();

    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(ChatView, {
        ...props,
        session: { ...props.session!, id: 'session-2' },
        messages: [{ id: 'user-2', role: 'user', text: 'new conversation' }],
      })));
    });

    expect(container.querySelector('.chat-jump-latest')).toBeNull();
    expect(messageList.scrollTop).toBe(1_000);
  });

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

    await act(async () => container.querySelector<HTMLButtonElement>('.chat-send-btn')!.click());

    expect(onSendMessage).toHaveBeenCalledWith('Focus on the parser race', [], 'steer');
    expect(container.querySelector<HTMLButtonElement>('.chat-send-btn')!.disabled).toBe(true);
    expect(input.value).toBe('Focus on the parser race');

    await act(async () => { resolveSteer(true); await Promise.resolve(); });
    expect(input.value).toBe('');
    await enterText(input, 'One more constraint');
    expect(container.querySelector<HTMLButtonElement>('.chat-send-btn')!.disabled).toBe(false);
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
  it('sends the per-prompt Loop option when the composer toggle is enabled', async () => {
    const { container, props } = await renderChat();
    const toggle = container.querySelector<HTMLInputElement>('.loop-mode-toggle input')!;
    const input = container.querySelector<HTMLTextAreaElement>('.chat-input')!;

    await act(async () => {
      toggle.click();
      await Promise.resolve();
    });
    await enterText(input, 'Implement the parser fix');
    await pressKey(input, 'Enter');

    expect(props.onSendMessage).toHaveBeenCalledWith(
      'Implement the parser fix',
      [],
      'queue',
      { loopMode: true },
    );
    expect(localStorage.getItem('nori-composer-loop-mode')).toBe('true');
  });

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

  it('updates the task-mode control immediately while the server status is stale', async () => {
    let resolveUpdate!: () => void;
    const onTaskModeChange = vi.fn(() => new Promise<void>(resolve => { resolveUpdate = resolve; }));
    const { container } = await renderChat({
      onTaskModeChange,
      sessionStatus: {
        status: 'ready',
        thinking_level: 'off',
        permission: 'manual',
        plan_mode: false,
        main_write_enabled: true,
        swarm_mode: false,
        goal: null,
        context_tokens: 0,
        max_context_tokens: 128_000,
        context_usage: 0,
      },
    });
    const modeButton = container.querySelector<HTMLButtonElement>('.composer-task-cycle')!;

    expect(modeButton.dataset.mode).toBe('code');
    await act(async () => {
      modeButton.click();
      await Promise.resolve();
    });

    expect(onTaskModeChange).toHaveBeenCalledWith('plan');
    expect(modeButton.dataset.mode).toBe('plan');
    expect(container.querySelector('.main-write-icon-toggle')).toBeNull();

    await act(async () => {
      resolveUpdate();
      await Promise.resolve();
    });
  });

  it('updates the main-write control immediately while the server profile is stale', async () => {
    let resolveUpdate!: () => void;
    const onMainWriteChange = vi.fn(() => new Promise<void>(resolve => { resolveUpdate = resolve; }));
    const { container } = await renderChat({
      onMainWriteChange,
      sessionStatus: {
        status: 'ready',
        thinking_level: 'off',
        permission: 'manual',
        plan_mode: false,
        main_write_enabled: true,
        swarm_mode: false,
        goal: null,
        context_tokens: 0,
        max_context_tokens: 128_000,
        context_usage: 0,
      },
    });
    const toggle = container.querySelector<HTMLInputElement>('.main-write-icon-toggle input')!;

    await act(async () => {
      toggle.click();
      await Promise.resolve();
    });

    expect(onMainWriteChange).toHaveBeenCalledWith(false);
    expect(toggle.checked).toBe(false);
    expect(container.querySelector('.main-write-icon-toggle')?.classList.contains('active')).toBe(false);

    await act(async () => {
      resolveUpdate();
      await Promise.resolve();
    });
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

describe('conversation presentation', () => {
  it('uses the application title bar and renders assistant replies without an avatar', async () => {
    const { container } = await renderChat({
      messages: [
        { id: 'user-1', role: 'user', text: 'Inspect the layout.' },
        { id: 'assistant-1', role: 'assistant', text: 'The reply now uses the full conversation column.' },
      ],
    });

    expect(container.querySelector('.chat-header')).toBeNull();
    expect(container.querySelector('.chat-message-assistant .message-avatar')).toBeNull();
    expect(container.querySelector('.chat-message-assistant .message-body')?.textContent).toContain('full conversation column');
    expect(container.querySelector('.chat-message-user .message-avatar')).toBeNull();
    expect(container.querySelector('.chat-message-user .chat-message-role')?.textContent).not.toContain('You');
    expect(container.querySelector('.chat-message-user .chat-message-content')?.textContent).toBe('Inspect the layout.');
  });

  it('updates work elapsed time while live and freezes it when the turn completes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-23T12:00:05.000Z'));
    const startedAt = '2026-07-23T12:00:00.000Z';
    const { container, props, root } = await renderChat({
      messages: [
        { id: 'user-1', role: 'user', text: 'Measure this turn.', createdAt: startedAt },
        { id: 'assistant-1', role: 'assistant', text: '', createdAt: '2026-07-23T12:00:01.000Z' },
      ],
      workBlocks: [{ id: 'thinking-1', type: 'thinking', text: 'Checking.' }],
      isStreaming: true,
    });

    expect(container.querySelector('.live-work-elapsed')?.textContent).toBe('5s');
    await act(async () => { vi.advanceTimersByTime(2_000); });
    expect(container.querySelector('.live-work-elapsed')?.textContent).toBe('7s');

    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(ChatView, {
        ...props,
        messages: [
          { id: 'user-1', role: 'user', text: 'Measure this turn.', createdAt: startedAt },
          { id: 'assistant-1', role: 'assistant', text: 'Done.', createdAt: '2026-07-23T12:01:05.000Z', workBlocks: [{ id: 'thinking-1', type: 'thinking', text: 'Checking.' }] },
        ],
        workBlocks: [],
        isStreaming: false,
      })));
    });
    expect(container.querySelector('.work-process-elapsed')?.textContent).toBe('1m 05s');
    await act(async () => { vi.advanceTimersByTime(5_000); });
    expect(container.querySelector('.work-process-elapsed')?.textContent).toBe('1m 05s');
    vi.useRealTimers();
  });

  it('grows the composer with content and caps it at the scrolling height', async () => {
    const { container } = await renderChat();
    const input = container.querySelector<HTMLTextAreaElement>('.chat-input')!;
    expect(input.rows).toBe(1);

    Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 196 });
    await enterText(input, 'one\ntwo\nthree\nfour');
    expect(input.style.height).toBe('196px');
    expect(input.style.overflowY).toBe('hidden');

    Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 420 });
    await enterText(input, 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight');
    expect(input.style.height).toBe('260px');
    expect(input.style.overflowY).toBe('auto');
  });

  it('keeps live thought separate from normal output, then collapses the completed work', async () => {
    const blocks = [
      { id: 'thinking-1', type: 'thinking' as const, text: 'Inspecting the relevant call path.' },
      { id: 'tool-1', type: 'tool' as const, tool: { id: 'tool-1', name: 'ReadFile', args: { path: 'src/app.ts' }, result: 'ok' } },
      { id: 'progress-1', type: 'progress' as const, text: 'The target file is loaded.' },
    ];
    const liveMessage = { id: 'assistant-1', role: 'assistant' as const, text: '' };
    const { container, props, root } = await renderChat({
      messages: [liveMessage],
      workBlocks: blocks,
      isStreaming: true,
    });

    expect(container.querySelector('.chat-work-process')).toBeNull();
    const liveThought = container.querySelector<HTMLDetailsElement>('.live-thinking-block')!;
    expect(liveThought.open).toBe(false);
    expect(liveThought.textContent).toContain('Inspecting the relevant call path.');
    expect(container.querySelector('.compact-tool-call')?.textContent).toContain('ReadFile');

    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(ChatView, {
        ...props,
        messages: [{ ...liveMessage, text: 'Finished.', workBlocks: blocks }],
        workBlocks: [],
        isStreaming: false,
      })));
    });

    const details = container.querySelector<HTMLDetailsElement>('.chat-work-process')!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('Work process');
    expect(details.textContent).toContain('1 tool');
    expect(details.querySelector('.work-process-chevron')).not.toBeNull();
    expect(details.querySelector('.work-process-status')).toBeNull();
    expect(container.querySelector('.chat-message-content:not(.transcript-assistant-output)')?.textContent).toContain('Finished.');

    await act(async () => {
      details.querySelector('summary')?.click();
      await Promise.resolve();
    });
    expect(details.open).toBe(true);
    expect(container.querySelector<HTMLDetailsElement>('.work-thinking-block')?.open).toBe(false);
    expect(container.querySelector('.transcript-assistant-output')?.textContent).toContain('The target file is loaded.');
  });

  it('renders ordinary live text as normal assistant output while work is active', async () => {
    const { container } = await renderChat({
      messages: [{ id: 'assistant-1', role: 'assistant', text: 'The first inspection pass is complete.' }],
      streaming: 'I am checking the event boundary now.',
      isStreaming: true,
    });

    expect(container.querySelector('.chat-work-process')).toBeNull();
    expect(container.querySelectorAll('.work-progress-block')).toHaveLength(0);
    const outputs = container.querySelectorAll('.transcript-assistant-output');
    expect(outputs).toHaveLength(2);
    expect(outputs[0]?.textContent).toContain('The first inspection pass is complete.');
    expect(outputs[1]?.textContent).toContain('I am checking the event boundary now.');
    expect(container.querySelector('.activity-island')).toBeNull();
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
  return { container, props, root };
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

function browserPermissionState(): NoriBrowserState {
  return {
    activeTabId: 'tab-1',
    visible: true,
    tabs: [{
      id: 'tab-1',
      url: 'https://example.com',
      title: 'Example',
      canGoBack: false,
      canGoForward: false,
      loading: false,
      annotationMode: false,
      annotations: [],
      network: [],
    }],
    automation: { paused: false, active: null, history: [] },
    downloads: [],
    permissions: {
      pending: [{
        id: 'browser-permission-1',
        tabId: 'tab-1',
        permission: 'geolocation',
        origin: 'https://example.com',
        createdAt: '2026-07-17T00:00:00.000Z',
      }],
      rules: [],
    },
    dialogs: [],
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
