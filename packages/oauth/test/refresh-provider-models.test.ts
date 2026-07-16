import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  refreshProviderModels,
  type RefreshProviderHost,
} from '../src/refresh-provider-models';
import { isOfficialKimiCodingEndpoint } from '../src/provider-capabilities';
import type { ManagedKimiConfigShape } from '../src/custom-registry';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeHost(initial: ManagedKimiConfigShape) {
  let config = structuredClone(initial);
  const host: RefreshProviderHost = {
    getConfig: async () => structuredClone(config),
    removeProvider: async (providerId) => {
      delete config.providers[providerId];
      for (const [key, alias] of Object.entries(config.models ?? {})) {
        if (typeof alias === 'object' && alias !== null && alias.provider === providerId) {
          delete config.models?.[key];
        }
      }
      return structuredClone(config);
    },
    setConfig: async (patch) => {
      config = structuredClone(patch);
      return structuredClone(config);
    },
    resolveOAuthToken: async () => {
      throw new Error('OAuth should not be used in these tests.');
    },
    userAgent: 'nori-test',
  };
  return { host, config: () => config };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('refreshProviderModels', () => {
  it('recognizes only the exact official Kimi Coding endpoint', () => {
    expect(isOfficialKimiCodingEndpoint('https://api.kimi.com/coding')).toBe(true);
    expect(isOfficialKimiCodingEndpoint('https://api.kimi.com/coding/v1/')).toBe(true);
    expect(isOfficialKimiCodingEndpoint('http://api.kimi.com/coding')).toBe(false);
    expect(isOfficialKimiCodingEndpoint('https://api.kimi.com.evil.test/coding')).toBe(false);
    expect(isOfficialKimiCodingEndpoint('https://api.kimi.com/coding-other')).toBe(false);
  });

  it('discovers OpenAI-compatible models and replaces stale aliases', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      data: [
        { id: 'gpt-new', display_name: 'GPT New', context_window: 200000 },
        { id: 'text-embedding-3-large' },
      ],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const harness = makeHost({
      providers: {
        custom: {
          type: 'openai',
          baseUrl: 'https://gateway.example/v1',
          apiKey: 'secret',
        },
      },
      models: {
        'custom/stale': {
          provider: 'custom',
          model: 'stale',
          maxContextSize: 4096,
        },
      },
      defaultModel: 'custom/stale',
    });

    const result = await refreshProviderModels(harness.host, { providerId: 'custom' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://gateway.example/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer secret',
          Accept: 'application/json',
          'User-Agent': 'nori-test',
        }),
      }),
    );
    expect(result.changed).toEqual([
      expect.objectContaining({ providerId: 'custom', added: 1, removed: 1 }),
    ]);
    expect(result.failed).toEqual([]);
    expect(harness.config().models?.['custom/stale']).toBeUndefined();
    expect(harness.config().models?.['custom/gpt-new']).toEqual(
      expect.objectContaining({
        provider: 'custom',
        model: 'gpt-new',
        displayName: 'GPT New',
        maxContextSize: 200000,
      }),
    );
    expect(harness.config().defaultModel).toBe('custom/gpt-new');
  });

  it('enriches preset models with models.dev reasoning metadata', async () => {
    const fetchMock = vi.fn(async (input: string) => input === 'https://models.dev/api.json'
      ? jsonResponse({
          openrouter: {
            id: 'openrouter',
            models: {
              reasoning: {
                id: 'vendor/reasoning-model',
                name: 'Reasoning Model',
                reasoning: true,
                limit: { context: 200000 },
                support_efforts: ['low', 'high'],
                default_effort: 'high',
              },
            },
          },
        })
      : jsonResponse({ data: [{ id: 'vendor/reasoning-model' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const harness = makeHost({
      providers: {
        openrouter: {
          type: 'openai',
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: 'secret',
          source: {
            kind: 'modelsDev',
            url: 'https://models.dev/api.json',
            catalogId: 'openrouter',
          },
        },
      },
      models: {},
    });

    const result = await refreshProviderModels(harness.host, { providerId: 'openrouter' });

    expect(result.failed).toEqual([]);
    expect(fetchMock.mock.calls.map(([input]) => input)).toEqual([
      'https://openrouter.ai/api/v1/models',
      'https://models.dev/api.json',
    ]);
    expect(harness.config().models?.['openrouter/vendor/reasoning-model']).toEqual(
      expect.objectContaining({
        displayName: 'Reasoning Model',
        maxContextSize: 200000,
        thinkingSupport: true,
        capabilities: expect.arrayContaining(['thinking']),
        supportEfforts: ['low', 'high'],
        defaultEffort: 'high',
      }),
    );
  });

  it('falls back to /v1/models when a custom provider root returns HTML', async () => {
    const fetchMock = vi.fn(async (input: string) => input.endsWith('/v1/models')
      ? jsonResponse({ data: [{ id: 'custom-chat' }] })
      : new Response('<!doctype html><title>Gateway</title>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const harness = makeHost({
      providers: {
        custom: {
          type: 'openai',
          baseUrl: 'https://gateway.example',
          apiKey: 'secret',
        },
      },
      models: {},
    });

    const result = await refreshProviderModels(harness.host, { providerId: 'custom' });

    expect(fetchMock.mock.calls.map(([input]) => input)).toEqual([
      'https://gateway.example/models',
      'https://gateway.example/v1/models',
    ]);
    expect(result.failed).toEqual([]);
    expect(harness.config().models?.['custom/custom-chat']).toBeDefined();
  });

  it('reports an actionable error when every custom model endpoint returns HTML', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html><title>Gateway</title>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    })));
    const harness = makeHost({
      providers: {
        custom: {
          type: 'openai',
          baseUrl: 'https://gateway.example',
          apiKey: 'secret',
        },
      },
      models: {},
    });

    const result = await refreshProviderModels(harness.host, { providerId: 'custom' });

    expect(result.failed[0]?.reason).toContain('returned HTML');
    expect(result.failed[0]?.reason).not.toContain('Unexpected token');
  });

  it('uses the Anthropic model endpoint and required headers', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      data: [{ id: 'claude-sonnet-4', display_name: 'Claude Sonnet 4' }],
    }));
    vi.stubGlobal('fetch', fetchMock);
    const harness = makeHost({
      providers: {
        anthropic: {
          type: 'anthropic',
          baseUrl: 'https://anthropic.example/v1',
          apiKey: 'anthropic-key',
        },
      },
      models: {},
    });

    const result = await refreshProviderModels(harness.host, { providerId: 'anthropic' });

    expect(result.failed).toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://anthropic.example/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-api-key': 'anthropic-key',
          'anthropic-version': '2023-06-01',
        }),
      }),
    );
  });

  it('refreshes unchanged Kimi model ids when raw image capabilities change', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      data: [{
        id: 'kimi-for-coding',
        display_name: 'Kimi for Coding',
        context_length: 262144,
        supports_reasoning: true,
      }],
    })));
    const harness = makeHost({
      providers: {
        'kimi-code': {
          type: 'anthropic',
          baseUrl: 'https://api.kimi.com/coding',
          apiKey: 'kimi-key',
        },
      },
      models: {
        'kimi-code/kimi-for-coding': {
          provider: 'kimi-code',
          model: 'kimi-for-coding',
          displayName: 'Kimi for Coding',
          maxContextSize: 262144,
          capabilities: ['tool_use', 'thinking'],
        },
      },
    });

    const result = await refreshProviderModels(harness.host, { providerId: 'kimi-code' });

    expect(result.changed).toEqual([
      expect.objectContaining({ providerId: 'kimi-code', added: 0, removed: 0 }),
    ]);
    expect(result.unchanged).toEqual([]);
    expect(harness.config().models?.['kimi-code/kimi-for-coding']).toEqual(
      expect.objectContaining({
        capabilities: expect.arrayContaining(['tool_use', 'thinking', 'image_in', 'video_in']),
      }),
    );
  });

  it('normalizes Gemini model names and sends the API key as a query parameter', async () => {
    const fetchMock = vi.fn(async (_input: string) => jsonResponse({
      models: [{
        name: 'models/gemini-2.5-pro',
        displayName: 'Gemini 2.5 Pro',
        inputTokenLimit: 1048576,
      }],
    }));
    vi.stubGlobal('fetch', fetchMock);
    const harness = makeHost({
      providers: {
        google: {
          type: 'google-genai',
          baseUrl: 'https://generativelanguage.googleapis.com',
          apiKey: 'google-key',
        },
      },
      models: {},
    });

    const result = await refreshProviderModels(harness.host, { providerId: 'google' });

    expect(result.failed).toEqual([]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models?key=google-key',
    );
    expect(harness.config().models?.['google/gemini-2.5-pro']).toEqual(
      expect.objectContaining({
        model: 'gemini-2.5-pro',
        maxContextSize: 1048576,
      }),
    );
  });

  it('reports provider HTTP failures without deleting the existing catalog', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'denied' }, 401)));
    const harness = makeHost({
      providers: {
        custom: {
          type: 'openai_responses',
          baseUrl: 'https://gateway.example/v1',
          apiKey: 'bad-key',
        },
      },
      models: {
        'custom/existing': {
          provider: 'custom',
          model: 'existing',
          maxContextSize: 8192,
        },
      },
    });

    const result = await refreshProviderModels(harness.host, { providerId: 'custom' });

    expect(result.changed).toEqual([]);
    expect(result.failed[0]).toEqual(
      expect.objectContaining({ provider: 'custom' }),
    );
    expect(result.failed[0]?.reason).toContain('HTTP 401');
    expect(harness.config().models?.['custom/existing']).toBeDefined();
  });
});
