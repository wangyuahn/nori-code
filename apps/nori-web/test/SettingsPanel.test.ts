import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type ConfigResponse } from '../src/api/client';
import { SettingsPanel } from '../src/components/SettingsPanel';
import { I18nProvider } from '../src/i18n';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

beforeEach(() => {
  localStorage.setItem('nori-ui-language', 'en');
  vi.spyOn(api.providers, 'list').mockResolvedValue({ items: [] });
  vi.spyOn(api.providers, 'refresh').mockResolvedValue({ changed: [], failed: [] });
  vi.spyOn(api.providerPresets, 'list').mockResolvedValue({ items: [], source: 'test' });
  vi.spyOn(api, 'updateConfig').mockResolvedValue({});
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => { root.unmount(); });
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('SettingsPanel Memory settings', () => {
  it('loads the independent Memory provider and masked key state', async () => {
    const { container } = await renderSettings({
      memory: {
        vector_enabled: true,
        provider_type: 'openai_responses',
        base_url: 'https://memory.example.test/v1',
        model: 'embed-model',
        has_api_key: true,
      },
    });

    expect(memoryToggle(container).checked).toBe(true);
    expect(memoryInput<HTMLSelectElement>(container, 'Memory API format').value).toBe('openai_responses');
    expect(memoryInput<HTMLInputElement>(container, 'Memory Base URL').value).toBe('https://memory.example.test/v1');
    expect(memoryInput<HTMLInputElement>(container, 'Embedding model').value).toBe('embed-model');
    expect(memoryInput<HTMLInputElement>(container, 'Memory API Key').value).toBe('••••••••');
    expect(container.querySelector('.memory-mode')?.textContent).toBe('Vector + full text + links');
  });

  it('enables the Memory connection controls when vector search is toggled on', async () => {
    const { container } = await renderSettings({ memory: { vector_enabled: false } });
    const baseUrl = memoryInput<HTMLInputElement>(container, 'Memory Base URL');
    expect(baseUrl.disabled).toBe(true);

    await act(async () => { memoryToggle(container).click(); });

    expect(memoryToggle(container).checked).toBe(true);
    expect(baseUrl.disabled).toBe(false);
    expect(container.querySelector('.memory-mode')?.textContent).toBe('Vector + full text + links');
  });

  it('blocks saving enabled vector search until URL, model, and key are configured', async () => {
    const updateConfig = vi.mocked(api.updateConfig);
    const { container } = await renderSettings({ memory: { vector_enabled: false, has_api_key: false } });

    await act(async () => { memoryToggle(container).click(); });
    await act(async () => { saveButton(container).click(); });

    expect(updateConfig).not.toHaveBeenCalled();
    const message = container.querySelector('.settings-save-status.error')?.textContent ?? '';
    expect(message).toContain('valid Base URL');
    expect(message).toContain('embedding model');
    expect(message).toContain('API Key');
  });

  it('saves the Memory patch and sends a replacement key only when entered', async () => {
    const updateConfig = vi.mocked(api.updateConfig);
    const { container } = await renderSettings({
      memory: {
        vector_enabled: true,
        provider_type: 'openai',
        base_url: 'https://memory.example.test/v1',
        model: 'embed-old',
        has_api_key: true,
      },
    });
    const model = memoryInput<HTMLInputElement>(container, 'Embedding model');
    const key = memoryInput<HTMLInputElement>(container, 'Memory API Key');

    await act(async () => {
      saveButton(container).click();
      await Promise.resolve();
    });
    await vi.waitFor(() => { expect(saveButton(container).disabled).toBe(false); });
    expect(updateConfig).toHaveBeenCalledWith(expect.objectContaining({
      memory: {
        vector_enabled: true,
        provider_type: 'openai',
        base_url: 'https://memory.example.test/v1',
        model: 'embed-old',
      },
    }));
    updateConfig.mockClear();

    await enterValue(model, 'embed-new');
    await act(async () => { key.focus(); });
    await enterValue(key, 'memory-secret');
    await act(async () => {
      saveButton(container).click();
      await Promise.resolve();
    });

    await vi.waitFor(() => { expect(updateConfig).toHaveBeenCalled(); });
    expect(updateConfig).toHaveBeenCalledWith(expect.objectContaining({
      memory: {
        vector_enabled: true,
        provider_type: 'openai',
        base_url: 'https://memory.example.test/v1',
        model: 'embed-new',
        api_key: 'memory-secret',
      },
    }));
  });
});

describe('SettingsPanel Provider settings', () => {
  it('clears the existing connection when New provider is selected', async () => {
    vi.mocked(api.providers.list).mockResolvedValue({
      items: [{
        id: 'existing-provider',
        type: 'anthropic',
        base_url: 'https://existing.example.test',
        has_api_key: true,
        status: 'connected',
      }],
    });
    const { container } = await renderSettings({});
    const configuredProvider = providerControl<HTMLSelectElement>(container, 'Configured provider');

    expect(configuredProvider.value).toBe('existing-provider');
    expect(providerControl<HTMLInputElement>(container, 'Provider ID').value).toBe('existing-provider');

    await selectValue(configuredProvider, '');

    expect(configuredProvider.value).toBe('');
    expect(providerControl<HTMLInputElement>(container, 'Provider ID').value).toBe('');
    expect(providerControl<HTMLInputElement>(container, 'API Base URL').value).toBe('');
  });
});

async function renderSettings(config: ConfigResponse) {
  vi.spyOn(api, 'getConfig').mockResolvedValue(config);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(createElement(I18nProvider, null, createElement(SettingsPanel)));
  });
  await vi.waitFor(() => { expect(saveButton(container).disabled).toBe(false); });
  return { container };
}

function memoryToggle(container: HTMLElement) {
  return memoryInput<HTMLInputElement>(container, 'Enable vector search');
}

function memoryInput<T extends HTMLInputElement | HTMLSelectElement>(container: HTMLElement, label: string): T {
  const input = container.querySelector<T>(`[aria-label="${label}"]`);
  if (!input) throw new Error(`Missing Memory control: ${label}`);
  return input;
}

function providerControl<T extends HTMLInputElement | HTMLSelectElement>(container: HTMLElement, label: string): T {
  const control = container.querySelector<T>(`[aria-label="${label}"]`);
  if (!control) throw new Error(`Missing Provider control: ${label}`);
  return control;
}

function saveButton(container: HTMLElement) {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    .find(item => item.textContent === 'Save and refresh models');
  if (!button) throw new Error('Missing save button');
  return button;
}

async function enterValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
}

async function selectValue(select: HTMLSelectElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
}
