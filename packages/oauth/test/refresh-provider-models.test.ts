import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  refreshProviderModels,
  type RefreshProviderHost,
} from '../src/refresh-provider-models';
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

  it('normalizes Gemini model names and sends the API key as a query parameter', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
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
