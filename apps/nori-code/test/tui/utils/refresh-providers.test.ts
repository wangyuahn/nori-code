import { KIMI_CODE_PROVIDER_NAME, resolveKimiCodeOAuthKey } from '@nori-code/oauth';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { refreshAllProviderModels } from '../../../src/tui/utils/refresh-providers';
import type { KimiConfig } from '@nori-code/sdk';

type FetchMock = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeRefreshHost(initial: KimiConfig): {
  current: () => KimiConfig;
  removeProvider: ReturnType<typeof vi.fn<(providerId: string) => Promise<KimiConfig>>>;
  setConfig: ReturnType<typeof vi.fn<(patch: Partial<KimiConfig>) => Promise<KimiConfig>>>;
} {
  let persisted = structuredClone(initial);
  const removeProvider = vi.fn(async (providerId: string) => {
    const providers = { ...persisted.providers };
    delete providers[providerId];
    const models = { ...persisted.models };
    let defaultRemoved = false;
    for (const [alias, model] of Object.entries(models)) {
      if (model.provider !== providerId) continue;
      delete models[alias];
      if (persisted.defaultModel === alias) defaultRemoved = true;
    }
    persisted = { ...persisted, providers, models };
    if (defaultRemoved) persisted = { ...persisted, defaultModel: undefined };
    return structuredClone(persisted);
  });
  const setConfig = vi.fn(async (patch: Partial<KimiConfig>) => {
    persisted = { ...persisted, ...patch };
    return structuredClone(persisted);
  });
  return {
    current: () => structuredClone(persisted),
    removeProvider,
    setConfig,
  };
}

describe('refreshAllProviderModels', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('refreshes the managed OAuth provider against its persisted base URL', async () => {
    const configuredBaseUrl = 'https://api.configured.example.test/coding/v1';
    const configuredOauthKey = resolveKimiCodeOAuthKey({ baseUrl: configuredBaseUrl });
    const persistedOauth = {
      storage: 'file' as const,
      key: configuredOauthKey,
      oauthHost: 'https://auth.kimi.com',
    };
    const config: KimiConfig = {
      providers: {
        [KIMI_CODE_PROVIDER_NAME]: {
          type: 'kimi',
          baseUrl: configuredBaseUrl,
          apiKey: '',
          oauth: persistedOauth,
        },
      },
      models: {
        'kimi-code/kimi-for-coding': {
          provider: KIMI_CODE_PROVIDER_NAME,
          model: 'kimi-for-coding',
          maxContextSize: 262144,
          capabilities: ['thinking', 'tool_use'],
        },
      },
      defaultModel: 'kimi-code/kimi-for-coding',
      telemetry: true,
    };
    const resolveOAuthToken = vi.fn(async (_providerName, oauthRef) => {
      expect(oauthRef).toEqual(persistedOauth);
      return 'env-access-token';
    });
    const fetchMock = vi.fn<FetchMock>(async (input, init) => {
      expect(fetchInputUrl(input)).toBe(`${configuredBaseUrl}/models`);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer env-access-token');
      return jsonResponse({
        data: [
          {
            id: 'kimi-for-coding',
            context_length: 262144,
            supports_reasoning: true,
          },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshAllProviderModels({
      getConfig: async () => config,
      removeProvider: vi.fn(),
      setConfig: vi.fn(),
      resolveOAuthToken,
    });

    expect(result.failed).toEqual([]);
    expect(result.unchanged).toEqual([KIMI_CODE_PROVIDER_NAME]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resolveOAuthToken).toHaveBeenCalledWith(KIMI_CODE_PROVIDER_NAME, persistedOauth);
  });

  it('can refresh only the managed OAuth provider without fetching third-party registries', async () => {
    const baseUrl = 'https://api.example.test/coding/v1';
    const registryUrl = 'https://registry.example.test/v1/models/api.json';
    const config: KimiConfig = {
      providers: {
        [KIMI_CODE_PROVIDER_NAME]: {
          type: 'kimi',
          baseUrl,
          apiKey: '',
          oauth: {
            storage: 'file',
            key: resolveKimiCodeOAuthKey({ baseUrl }),
          },
        },
        custom: {
          type: 'openai',
          baseUrl: 'https://custom.example.test/v1',
          apiKey: 'sk-test-token',
          source: { kind: 'apiJson', url: registryUrl, apiKey: 'sk-test-token' },
        },
      },
      models: {
        'kimi-code/kimi-for-coding': {
          provider: KIMI_CODE_PROVIDER_NAME,
          model: 'kimi-for-coding',
          maxContextSize: 262144,
          capabilities: ['thinking', 'tool_use'],
          displayName: 'Old Kimi',
        },
        'custom/m1': {
          provider: 'custom',
          model: 'm1',
          maxContextSize: 131072,
          capabilities: ['tool_use'],
          displayName: 'Custom M1',
        },
      },
      defaultModel: 'kimi-code/kimi-for-coding',
      telemetry: true,
    };
    const host = makeRefreshHost(config);
    const resolveOAuthToken = vi.fn(async () => 'oauth-access-token');
    const fetchMock = vi.fn<FetchMock>(async (input, init) => {
      expect(fetchInputUrl(input)).toBe(`${baseUrl}/models`);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer oauth-access-token');
      return jsonResponse({
        data: [
          {
            id: 'kimi-for-coding',
            context_length: 262144,
            supports_reasoning: true,
            display_name: 'Fresh Kimi',
          },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshAllProviderModels(
      {
        getConfig: async () => host.current(),
        removeProvider: host.removeProvider,
        setConfig: host.setConfig,
        resolveOAuthToken,
      },
      { scope: 'oauth' },
    );

    expect(result.failed).toEqual([]);
    expect(result.changed).toEqual([
      {
        providerId: KIMI_CODE_PROVIDER_NAME,
        providerName: KIMI_CODE_PROVIDER_NAME,
        added: 0,
        removed: 0,
      },
    ]);
    expect(result.unchanged).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(host.current().models?.[`${KIMI_CODE_PROVIDER_NAME}/kimi-for-coding`]?.displayName).toBe('Fresh Kimi');
    expect(host.current().models?.['custom/m1']?.displayName).toBe('Custom M1');
  });

  it('refreshes OpenAI and Anthropic model capabilities from their /models endpoints', async () => {
    const providerId = 'example_chat-completions';
    const siblingProviderId = 'example_messages';
    const modelId = 'reasoner-pro';
    const modelAlias = `${providerId}/${modelId}`;
    const siblingModelAlias = `${siblingProviderId}/${modelId}`;
    const userAlias = 'my-reasoner';
    const userAliasModel = {
      provider: providerId,
      model: modelId,
      maxContextSize: 262144,
      capabilities: ['tool_use'],
      displayName: 'My Reasoner',
    };
    const host = makeRefreshHost({
      providers: {
        [providerId]: {
          type: 'openai',
          baseUrl: 'https://api.example.test/v1',
          apiKey: 'sk-test-token',
        },
        [siblingProviderId]: {
          type: 'anthropic',
          baseUrl: 'https://messages.example.test',
          apiKey: 'sk-ant-token',
        },
      },
      models: {
        [modelAlias]: {
          provider: providerId,
          model: modelId,
          maxContextSize: 262144,
          capabilities: ['tool_use'],
          displayName: 'Reasoner Pro',
        },
        [siblingModelAlias]: {
          provider: siblingProviderId,
          model: modelId,
          maxContextSize: 262144,
          capabilities: ['tool_use'],
          displayName: 'Reasoner Pro',
        },
        [userAlias]: userAliasModel,
      },
      defaultModel: modelAlias,
      telemetry: true,
    } as unknown as KimiConfig);

    const fetchMock = vi.fn<FetchMock>(async (input) => {
      const url = fetchInputUrl(input);
      const payload = {
        data: [
          {
            id: modelId,
            display_name: 'Reasoner Pro',
            context_length: 262144,
            supports_reasoning: true,
            modalities: { input: ['text', 'image', 'video'], output: ['text'] },
          },
        ],
      };
      if (url === 'https://api.example.test/v1/models' || url === 'https://messages.example.test/v1/models') {
        return jsonResponse(payload);
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshAllProviderModels({
      getConfig: async () => host.current(),
      removeProvider: host.removeProvider,
      setConfig: host.setConfig,
      resolveOAuthToken: vi.fn(),
    });

    expect(result.failed).toEqual([]);
    expect(result.unchanged).toEqual([]);
    expect(result.changed).toEqual([
      {
        providerId,
        providerName: providerId,
        added: 0,
        removed: 0,
      },
      {
        providerId: siblingProviderId,
        providerName: siblingProviderId,
        added: 0,
        removed: 0,
      },
    ]);
    expect(host.removeProvider).toHaveBeenCalledWith(providerId);
    expect(host.removeProvider).toHaveBeenCalledWith(siblingProviderId);
    expect(host.current().models?.[modelAlias]?.capabilities).toEqual([
      'tool_use',
      'thinking',
      'image_in',
      'video_in',
    ]);
    expect(host.current().models?.[siblingModelAlias]?.capabilities).toEqual([
      'tool_use',
      'thinking',
      'image_in',
      'video_in',
    ]);
  });

  it('adds models that appear on an existing provider', async () => {
    const apiKey = 'sk-test-token';
    const host = makeRefreshHost({
      providers: {
        a: {
          type: 'openai',
          baseUrl: 'https://a.example.test/v1',
          apiKey,
        },
      },
      models: {
        'a/m1': {
          provider: 'a',
          model: 'm1',
          maxContextSize: 131072,
          capabilities: ['tool_use'],
          displayName: 'm1',
        },
      },
      telemetry: true,
    } as unknown as KimiConfig);

    const fetchMock = vi.fn<FetchMock>(async () =>
      jsonResponse({
        data: [
          { id: 'm1', display_name: 'm1', context_length: 131072 },
          { id: 'm2', display_name: 'm2', context_length: 131072 },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshAllProviderModels({
      getConfig: async () => host.current(),
      removeProvider: host.removeProvider,
      setConfig: host.setConfig,
      resolveOAuthToken: vi.fn(),
    });

    expect(result.failed).toEqual([]);
    expect(result.unchanged).toEqual([]);
    expect(result.changed).toEqual([
      {
        providerId: 'a',
        providerName: 'a',
        added: 1,
        removed: 0,
      },
    ]);
    expect(host.current().models?.['a/m2']?.model).toBe('m2');
  });

  it('drops models that disappear from a provider /models list', async () => {
    const apiKey = 'sk-test-token';
    const host = makeRefreshHost({
      providers: {
        a: {
          type: 'openai',
          baseUrl: 'https://a.example.test/v1',
          apiKey,
        },
        b: {
          type: 'openai',
          baseUrl: 'https://b.example.test/v1',
          apiKey,
        },
      },
      models: {
        'a/m1': {
          provider: 'a',
          model: 'm1',
          maxContextSize: 131072,
          capabilities: ['tool_use'],
          displayName: 'm1',
        },
        'b/m1': {
          provider: 'b',
          model: 'm1',
          maxContextSize: 131072,
          capabilities: ['tool_use'],
          displayName: 'm1',
        },
        'b/m2': {
          provider: 'b',
          model: 'm2',
          maxContextSize: 131072,
          capabilities: ['tool_use'],
          displayName: 'm2',
        },
      },
      telemetry: true,
    } as unknown as KimiConfig);

    const fetchMock = vi.fn<FetchMock>(async (input) => {
      const url = fetchInputUrl(input);
      if (url === 'https://a.example.test/v1/models') {
        return jsonResponse({
          data: [{ id: 'm1', display_name: 'm1', context_length: 131072 }],
        });
      }
      if (url === 'https://b.example.test/v1/models') {
        return jsonResponse({
          data: [{ id: 'm1', display_name: 'm1', context_length: 131072 }],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshAllProviderModels({
      getConfig: async () => host.current(),
      removeProvider: host.removeProvider,
      setConfig: host.setConfig,
      resolveOAuthToken: vi.fn(),
    });

    expect(result.failed).toEqual([]);
    expect(result.unchanged).toEqual(['a']);
    expect(result.changed).toEqual([
      {
        providerId: 'b',
        providerName: 'b',
        added: 0,
        removed: 1,
      },
    ]);
    expect(host.current().models?.['a/m1']).toBeDefined();
    expect(host.current().models?.['b/m1']).toBeDefined();
    expect(host.current().models?.['b/m2']).toBeUndefined();
  });

  it('refreshes each provider from its own /models endpoint', async () => {
    const host = makeRefreshHost({
      providers: {
        a: {
          type: 'openai',
          baseUrl: 'https://a.example.test/v1',
          apiKey: 'sk-a-token',
        },
        b: {
          type: 'openai',
          baseUrl: 'https://b.example.test/v1',
          apiKey: 'sk-b-token',
        },
      },
      models: {
        'a/m1': {
          provider: 'a',
          model: 'm1',
          maxContextSize: 131072,
          capabilities: ['tool_use'],
          displayName: 'm1',
        },
        'b/m1': {
          provider: 'b',
          model: 'm1',
          maxContextSize: 131072,
          capabilities: ['tool_use'],
          displayName: 'm1',
        },
      },
      telemetry: true,
    } as unknown as KimiConfig);

    const fetchMock = vi.fn<FetchMock>(async (input) => {
      const url = fetchInputUrl(input);
      if (url === 'https://a.example.test/v1/models') {
        return jsonResponse({
          data: [{ id: 'm1', display_name: 'm1', context_length: 131072 }],
        });
      }
      if (url === 'https://b.example.test/v1/models') {
        return jsonResponse({
          data: [
            { id: 'm1', display_name: 'm1', context_length: 131072 },
            { id: 'm2', display_name: 'm2', context_length: 131072 },
          ],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshAllProviderModels({
      getConfig: async () => host.current(),
      removeProvider: host.removeProvider,
      setConfig: host.setConfig,
      resolveOAuthToken: vi.fn(),
    });

    expect(result.failed).toEqual([]);
    expect(result.unchanged).toEqual(['a']);
    expect(result.changed).toEqual([
      {
        providerId: 'b',
        providerName: 'b',
        added: 1,
        removed: 0,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(host.current().models?.['b/m2']?.model).toBe('m2');
  });

  it('treats matching /models metadata as unchanged', async () => {
    const providerId = 'example_chat-completions';
    const modelId = 'reasoner-pro';
    const modelAlias = `${providerId}/${modelId}`;
    const host = makeRefreshHost({
      providers: {
        [providerId]: {
          type: 'openai',
          baseUrl: 'https://api.example.test/v1',
          apiKey: 'sk-test-token',
        },
      },
      models: {
        [modelAlias]: {
          provider: providerId,
          model: modelId,
          maxContextSize: 262144,
          capabilities: ['tool_use', 'thinking', 'image_in'],
          displayName: 'Reasoner Pro',
        },
      },
      defaultModel: modelAlias,
      thinking: { enabled: false },
      telemetry: true,
    } as unknown as KimiConfig);

    const fetchMock = vi.fn<FetchMock>(async () =>
      jsonResponse({
        data: [
          {
            id: modelId,
            display_name: 'Reasoner Pro',
            context_length: 262144,
            supports_reasoning: true,
            modalities: { input: ['text', 'image'], output: ['text'] },
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshAllProviderModels({
      getConfig: async () => host.current(),
      removeProvider: host.removeProvider,
      setConfig: host.setConfig,
      resolveOAuthToken: vi.fn(),
    });

    expect(result.failed).toEqual([]);
    expect([...result.changed.map((c) => c.providerId), ...result.unchanged]).toEqual([
      providerId,
    ]);
    expect(host.current().defaultModel).toBe(modelAlias);
    expect(host.current().thinking?.enabled).toBe(false);
  });

  it('refreshes a managed provider when a base URL is configured without forcing thinking on', async () => {
    const host = makeRefreshHost({
      providers: {
        [KIMI_CODE_PROVIDER_NAME]: {
          type: 'kimi',
          baseUrl: 'https://api.example.test/coding/v1',
          apiKey: '',
          oauth: { storage: 'file', key: 'oauth/kimi-code' },
        },
      },
      models: {
        [`${KIMI_CODE_PROVIDER_NAME}/kimi-deep-coder`]: {
          provider: KIMI_CODE_PROVIDER_NAME,
          model: 'kimi-deep-coder',
          maxContextSize: 262144,
          capabilities: ['thinking', 'tool_use'],
        },
      },
      defaultModel: `${KIMI_CODE_PROVIDER_NAME}/kimi-deep-coder`,
      thinking: { enabled: false },
      telemetry: true,
    } as unknown as KimiConfig);

    const fetchMock = vi.fn<FetchMock>(async () =>
      jsonResponse({
        data: [
          {
            id: 'kimi-deep-coder',
            context_length: 262144,
            supports_reasoning: true,
            supports_thinking_type: 'only',
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshAllProviderModels({
      getConfig: async () => host.current(),
      removeProvider: host.removeProvider,
      setConfig: host.setConfig,
      resolveOAuthToken: vi.fn(async () => 'oauth-access-token'),
    });

    expect(result.failed).toEqual([]);
    expect(host.current().models?.[`${KIMI_CODE_PROVIDER_NAME}/kimi-deep-coder`]?.capabilities).toEqual(
      ['thinking', 'tool_use'],
    );
    expect(host.current().defaultModel).toBe(`${KIMI_CODE_PROVIDER_NAME}/kimi-deep-coder`);
    expect(host.current().thinking?.enabled).toBe(false);
  });
});
