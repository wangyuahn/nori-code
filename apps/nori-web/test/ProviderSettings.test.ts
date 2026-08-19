import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api, type ModelCatalogItem, type ProviderCatalogItem } from '../src/api/client';
import {
  ProviderSettings,
  defaultModelAfterProviderSave,
  providerCustomModelsForPatch,
  providerModelCount,
} from '../src/components/ProviderSettings';
import { I18nProvider } from '../src/i18n';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function setSelectValue(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(select, value);
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const models: ModelCatalogItem[] = [
  { provider: 'other', model: 'other/model', max_context_size: 128000 },
  { provider: 'ds', model: 'ds/deepseek-v4-flash', max_context_size: 128000 },
];

describe('provider model persistence', () => {
  it('uses arrays for custom_models in both discovery modes', () => {
    expect(providerCustomModelsForPatch(true, ['legacy-model'])).toEqual([]);
    expect(providerCustomModelsForPatch(false, ['deepseek-v4-flash'])).toEqual(['deepseek-v4-flash']);
  });

  it('chooses a preferred-provider fallback only when the current default is missing or stale', () => {
    expect(defaultModelAfterProviderSave('other/model', models, 'ds')).toBeUndefined();
    expect(defaultModelAfterProviderSave(undefined, models, 'ds')).toBe('ds/deepseek-v4-flash');
    expect(defaultModelAfterProviderSave('missing/model', models, 'ds')).toBe('ds/deepseek-v4-flash');
  });

  it('shows discovered aliases when auto discovery stores an empty compatibility array', () => {
    const provider: ProviderCatalogItem = {
      id: 'ds',
      type: 'openai',
      has_api_key: true,
      status: 'connected',
      auto_discover: true,
      custom_models: [],
      models: ['ds/deepseek-v4-flash', 'ds/deepseek-reasoner'],
    };
    expect(providerModelCount(provider)).toBe(2);
  });

  it('saves an auto-discovered provider before refreshing models and repairing the default', async () => {
    const provider: ProviderCatalogItem = {
      id: 'ds',
      name: 'DeepSeek',
      type: 'openai',
      base_url: 'https://api.example.test/v1',
      has_api_key: true,
      status: 'connected',
      auto_discover: true,
      custom_models: [],
      models: ['ds/deepseek-v4-flash'],
    };
    const calls: string[] = [];
    vi.spyOn(api.providers, 'list').mockImplementation(async () => {
      calls.push('list-providers');
      return { items: [provider] };
    });
    vi.spyOn(api.providerPresets, 'list').mockResolvedValue({ items: [], source: 'builtin' });
    vi.spyOn(api, 'getConfig').mockResolvedValue({ models: {} });
    const updateConfig = vi.spyOn(api, 'updateConfig').mockImplementation(async () => {
      calls.push('update-config');
      return {};
    });
    vi.spyOn(api.providers, 'refresh').mockImplementation(async () => {
      calls.push('refresh-provider');
      return { changed: [], unchanged: ['ds'], failed: [] };
    });
    vi.spyOn(api.models, 'list').mockImplementation(async () => {
      calls.push('list-models');
      return { items: models };
    });
    const setDefault = vi.spyOn(api.models, 'setDefault').mockImplementation(async (modelId) => {
      calls.push('set-default');
      return { default_model: modelId, model: models[1]! };
    });

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(ProviderSettings)));
      await Promise.resolve();
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    await act(async () => container.querySelector<HTMLButtonElement>('.provider-card-main')!.click());
    for (let attempt = 0; attempt < 10 && container.querySelector('.provider-editor') === null; attempt++) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    }
    await act(async () => container.querySelector<HTMLButtonElement>('.provider-editor .btn-primary')!.click());
    for (let attempt = 0; attempt < 10 && setDefault.mock.calls.length === 0; attempt++) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    }

    expect(updateConfig).toHaveBeenCalledWith({
      providers: {
        ds: expect.objectContaining({
          auto_discover: true,
          custom_models: [],
        }),
      },
    });
    expect(setDefault).toHaveBeenCalledWith('ds/deepseek-v4-flash');
    expect(calls.indexOf('update-config')).toBeLessThan(calls.indexOf('refresh-provider'));
    expect(calls.indexOf('refresh-provider')).toBeLessThan(calls.indexOf('list-models'));
    expect(calls.indexOf('list-models')).toBeLessThan(calls.indexOf('set-default'));

    await act(async () => root.unmount());
  });
});

describe('custom model thinking effort', () => {
  it('persists adjustable efforts for a manually added model', async () => {
    const provider: ProviderCatalogItem = {
      id: 'custom',
      name: 'Custom',
      type: 'openai',
      base_url: 'https://api.example.test/v1',
      has_api_key: true,
      status: 'connected',
      auto_discover: false,
      custom_models: ['local-chat'],
      models: ['custom/local-chat'],
    };
    vi.spyOn(api.providers, 'list').mockResolvedValue({ items: [provider] });
    vi.spyOn(api.providerPresets, 'list').mockResolvedValue({ items: [], source: 'builtin' });
    vi.spyOn(api, 'getConfig').mockResolvedValue({
      models: {
        'custom/local-chat': {
          provider: 'custom',
          model: 'local-chat',
          maxContextSize: 128000,
          capabilities: ['tool_use'],
        },
      },
    });
    const updateConfig = vi.spyOn(api, 'updateConfig').mockResolvedValue({});
    vi.spyOn(api.models, 'list').mockResolvedValue({
      items: [{
        provider: 'custom',
        model: 'custom/local-chat',
        max_context_size: 128000,
        supports_thinking: true,
        support_efforts: ['low', 'medium', 'high'],
        default_effort: 'medium',
      }],
    });
    vi.spyOn(api.models, 'setDefault').mockResolvedValue({
      default_model: 'custom/local-chat',
      model: {
        provider: 'custom',
        model: 'custom/local-chat',
        max_context_size: 128000,
      },
    });

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(ProviderSettings)));
      await Promise.resolve();
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    await act(async () => container.querySelector<HTMLButtonElement>('.provider-card-main')!.click());
    for (let attempt = 0; attempt < 10 && container.querySelector('[aria-label="Thinking mode"]') === null; attempt++) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    }

    const thinkingSelect = container.querySelector<HTMLSelectElement>('[aria-label="Thinking mode"]');
    expect(thinkingSelect).not.toBeNull();
    await setInputValue(container.querySelector<HTMLInputElement>('[aria-label="Custom model display name"]')!, 'Local Chat');
    await setInputValue(container.querySelector<HTMLInputElement>('[aria-label="Custom model context length"]')!, '65536');
    await setSelectValue(thinkingSelect!, 'efforts');
    for (let attempt = 0; attempt < 10 && container.querySelector('.custom-model-effort-options') === null; attempt++) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    }
    const high = Array.from(container.querySelectorAll<HTMLInputElement>('.custom-model-effort-options input')).find(input => input.parentElement?.textContent?.trim() === 'high');
    expect(high).toBeDefined();
    await act(async () => high!.click());
    const medium = Array.from(container.querySelectorAll<HTMLInputElement>('.custom-model-effort-options input')).find(input => input.parentElement?.textContent?.trim() === 'medium');
    await act(async () => medium!.click());
    const low = Array.from(container.querySelectorAll<HTMLInputElement>('.custom-model-effort-options input')).find(input => input.parentElement?.textContent?.trim() === 'low');
    await act(async () => low!.click());
    const defaultSelect = container.querySelector<HTMLSelectElement>('[aria-label="Default effort"]');
    expect(defaultSelect).not.toBeNull();
    await setSelectValue(defaultSelect!, 'medium');
    await act(async () => container.querySelector<HTMLButtonElement>('.provider-editor .btn-primary')!.click());
    for (let attempt = 0; attempt < 10 && updateConfig.mock.calls.length === 0; attempt++) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    }

    expect(updateConfig).toHaveBeenCalledWith(expect.objectContaining({
      models: {
        'custom/local-chat': expect.objectContaining({
          display_name: 'Local Chat',
          max_context_size: 65536,
          thinking_support: true,
          support_efforts: expect.arrayContaining(['low', 'medium', 'high']),
          default_effort: 'medium',
        }),
      },
    }));

    await act(async () => root.unmount());
  });

  it('shows a visible validation error for an empty context length', async () => {
    const provider: ProviderCatalogItem = {
      id: 'custom',
      name: 'Custom',
      type: 'openai',
      has_api_key: true,
      status: 'connected',
      auto_discover: false,
      custom_models: ['local-chat'],
    };
    vi.spyOn(api.providers, 'list').mockResolvedValue({ items: [provider] });
    vi.spyOn(api.providerPresets, 'list').mockResolvedValue({ items: [], source: 'builtin' });
    vi.spyOn(api, 'getConfig').mockResolvedValue({
      models: { 'custom/local-chat': { provider: 'custom', model: 'local-chat', maxContextSize: 128000 } },
    });
    const updateConfig = vi.spyOn(api, 'updateConfig').mockResolvedValue({});
    vi.spyOn(api.models, 'list').mockResolvedValue({ items: [] });

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(ProviderSettings)));
      await Promise.resolve();
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    await act(async () => container.querySelector<HTMLButtonElement>('.provider-card-main')!.click());
    await vi.waitFor(() => expect(container.querySelector('.provider-editor')).not.toBeNull());
    await setInputValue(container.querySelector<HTMLInputElement>('[aria-label="Custom model context length"]')!, '');
    await act(async () => container.querySelector<HTMLButtonElement>('.provider-editor footer .btn-primary')!.click());

    expect(updateConfig).not.toHaveBeenCalled();
    expect(container.querySelector('.provider-notice.error')?.textContent).toContain('positive integer context length');
    await act(async () => root.unmount());
  });
});
