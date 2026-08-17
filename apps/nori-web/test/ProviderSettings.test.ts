import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type ProviderCatalogItem, type ProviderPreset } from '../src/api/client';
import { ProviderSettings } from '../src/components/ProviderSettings';
import { I18nProvider } from '../src/i18n';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

const PROVIDER: ProviderCatalogItem = {
  id: 'openrouter',
  name: 'OpenRouter',
  type: 'openai',
  base_url: 'https://openrouter.ai/api/v1',
  has_api_key: true,
  api_key_length: 22,
  status: 'connected',
  auto_discover: true,
  custom_models: [],
};

const PRESETS: ProviderPreset[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    type: 'openai',
    base_url: 'https://openrouter.ai/api/v1',
    env: ['OPENROUTER_API_KEY'],
    model_count: 12,
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    type: 'anthropic',
    base_url: 'https://api.anthropic.com',
    env: ['ANTHROPIC_API_KEY'],
    model_count: 4,
  },
];

beforeEach(() => {
  localStorage.setItem('nori-ui-language', 'en');
  vi.spyOn(api.providers, 'list').mockResolvedValue({ items: [PROVIDER] });
  vi.spyOn(api.providerPresets, 'list').mockResolvedValue({
    items: PRESETS,
    source: 'https://models.dev/api.json',
  });
  vi.spyOn(api.providers, 'secret').mockResolvedValue({
    provider_id: 'openrouter',
    api_key: 'sk-live-secret-key-12345',
  });
  vi.spyOn(api, 'getConfig').mockResolvedValue({ models: {} });
  vi.spyOn(api, 'updateConfig').mockResolvedValue({});
  vi.spyOn(api.providers, 'refresh').mockResolvedValue({ changed: [], unchanged: ['openrouter'], failed: [] });
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => { root.unmount(); });
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('ProviderSettings', () => {
  it('loads online presets into the editor', async () => {
    const { container } = await renderProviders();
    await openEditor(container);

    const preset = container.querySelector<HTMLSelectElement>('[aria-label="Online preset"]');
    expect(preset).not.toBeNull();
    expect(Array.from(preset?.options ?? []).map(option => option.value)).toEqual([
      'custom',
      'openrouter',
      'anthropic',
    ]);
    expect(preset?.value).toBe('openrouter');
  });

  it('applies a preset into id, type, and base URL', async () => {
    const { container } = await renderProviders();
    await openEditor(container);

    const preset = container.querySelector<HTMLSelectElement>('[aria-label="Online preset"]');
    await act(async () => {
      if (!preset) throw new Error('Missing preset select');
      preset.value = 'anthropic';
      preset.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.querySelector<HTMLInputElement>('[aria-label="Provider ID"]')?.value).toBe('anthropic');
    expect(container.querySelector<HTMLInputElement>('input[placeholder="https://api.example.com/v1"]')?.value)
      .toBe('https://api.anthropic.com');
  });

  it('keeps a length-matched mask until the eye reveals the real key', async () => {
    const { container } = await renderProviders();
    await openEditor(container);
    const key = apiKeyInput(container);

    expect(key.value).toBe('•'.repeat(22));
    expect(key.type).toBe('password');
    expect(key.readOnly).toBe(true);

    await act(async () => {
      key.focus();
      await Promise.resolve();
    });
    expect(key.value).toBe('•'.repeat(22));
    expect(vi.mocked(api.providers.secret)).not.toHaveBeenCalled();

    await act(async () => {
      showKeyButton(container).click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(vi.mocked(api.providers.secret)).toHaveBeenCalledWith('openrouter');
    });
    expect(key.value).toBe('sk-live-secret-key-12345');
    expect(key.type).toBe('text');
    expect(key.readOnly).toBe(false);

    await act(async () => {
      showKeyButton(container).click();
      await Promise.resolve();
    });
    expect(key.type).toBe('password');
    expect(key.value).toBe('sk-live-secret-key-12345');
  });

  it('allows clearing the key without resurrecting mask dots', async () => {
    const { container } = await renderProviders();
    await openEditor(container);
    const key = apiKeyInput(container);

    await act(async () => {
      showKeyButton(container).click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(key.value).toBe('sk-live-secret-key-12345');
    });

    await enterValue(key, '');
    expect(key.value).toBe('');

    await enterValue(key, 'a');
    await enterValue(key, '');
    expect(key.value).toBe('');
    expect(key.value.includes('•')).toBe(false);
  });

  it('saves a replacement key only after the field was edited', async () => {
    const updateConfig = vi.mocked(api.updateConfig);
    const { container } = await renderProviders();
    await openEditor(container);

    await act(async () => {
      saveButton(container).click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(updateConfig).toHaveBeenCalled();
    });
    const firstPatch = updateConfig.mock.calls[0]?.[0] as { providers?: Record<string, Record<string, unknown>> };
    expect(firstPatch.providers?.openrouter?.api_key).toBeUndefined();
    updateConfig.mockClear();

    await openEditor(container);
    const key = apiKeyInput(container);
    await act(async () => {
      key.focus();
      await Promise.resolve();
    });
    await enterValue(key, 'sk-replacement');
    await act(async () => {
      saveButton(container).click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(updateConfig).toHaveBeenCalled();
    });
    const secondPatch = updateConfig.mock.calls[0]?.[0] as { providers?: Record<string, Record<string, unknown>> };
    expect(secondPatch.providers?.openrouter?.api_key).toBe('sk-replacement');
  });

  it('does not wipe discovered aliases or write leftover custom IDs when auto-discovery is on', async () => {
    vi.mocked(api.providers.list).mockResolvedValue({
      items: [{ ...PROVIDER, custom_models: ['leftover-id'] }],
    });
    vi.mocked(api.getConfig).mockResolvedValue({
      models: {
        'openrouter/existing': { provider: 'openrouter', model: 'existing' },
      },
      default_model: 'openrouter/existing',
    });
    const updateConfig = vi.mocked(api.updateConfig);
    const { container } = await renderProviders();
    await openEditor(container);
    await act(async () => {
      saveButton(container).click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(updateConfig).toHaveBeenCalled();
    });
    const firstPatch = updateConfig.mock.calls[0]?.[0] as { models?: Record<string, unknown> };
    expect(firstPatch.models).toBeUndefined();
  });

  it('sets default_model after a successful refresh when none is configured', async () => {
    const updateConfig = vi.mocked(api.updateConfig);
    vi.mocked(api.getConfig)
      .mockResolvedValueOnce({ models: {} })
      .mockResolvedValueOnce({
        models: { 'openrouter/gpt-4o': { provider: 'openrouter', model: 'gpt-4o' } },
      });
    const { container } = await renderProviders();
    await openEditor(container);
    await act(async () => {
      saveButton(container).click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(updateConfig.mock.calls.some(call => {
        const patch = call[0] as { default_model?: string };
        return patch.default_model === 'openrouter/gpt-4o';
      })).toBe(true);
    });
  });
});

async function renderProviders() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(createElement(I18nProvider, null, createElement(ProviderSettings)));
  });
  await vi.waitFor(() => {
    expect(container.querySelector('.provider-card-main')).not.toBeNull();
  });
  return { container };
}

async function openEditor(container: HTMLElement) {
  const card = container.querySelector<HTMLButtonElement>('.provider-card-main');
  if (!card) throw new Error('Missing provider card');
  await act(async () => {
    card.click();
    await Promise.resolve();
  });
  await vi.waitFor(() => {
    expect(container.querySelector('.provider-editor')).not.toBeNull();
  });
}

function apiKeyInput(container: HTMLElement) {
  const input = container.querySelector<HTMLInputElement>('[aria-label="API Key"]');
  if (!input) throw new Error('Missing API Key input');
  return input;
}

function showKeyButton(container: HTMLElement) {
  const button = container.querySelector<HTMLButtonElement>('[aria-label="Show API key"], [aria-label="Hide API key"]');
  if (!button) throw new Error('Missing API key visibility toggle');
  return button;
}

function saveButton(container: HTMLElement) {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    .find(item => item.textContent === 'Save provider');
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
