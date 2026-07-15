import { describe, expect, it } from 'vitest';

import { normalizeProviderPresets } from '../src/routes/modelCatalog';

describe('normalizeProviderPresets', () => {
  it('normalizes supported models.dev providers and strips Anthropic /v1', () => {
    const result = normalizeProviderPresets({
      anthropic: {
        id: 'anthropic',
        name: 'Anthropic',
        npm: '@ai-sdk/anthropic',
        api: 'https://api.anthropic.com/v1',
        env: ['ANTHROPIC_API_KEY'],
        models: {
          claude: {
            id: 'claude-sonnet-4',
            modalities: { output: ['text'] },
          },
          embedding: {
            id: 'claude-embed',
            modalities: { output: ['text'] },
          },
        },
      },
      gateway: {
        id: 'gateway',
        name: 'Gateway',
        npm: '@ai-sdk/openai-compatible',
        api: 'https://gateway.example/v1',
        models: {
          chat: {
            id: 'chat-model',
            modalities: { output: ['text'] },
          },
          image: {
            id: 'image-model',
            modalities: { output: ['image'] },
          },
        },
      },
    });

    expect(result).toEqual([
      expect.objectContaining({
        id: 'anthropic',
        type: 'anthropic',
        base_url: 'https://api.anthropic.com',
        model_count: 1,
      }),
      expect.objectContaining({
        id: 'gateway',
        type: 'openai',
        base_url: 'https://gateway.example/v1',
        model_count: 1,
      }),
    ]);
  });

  it('omits catalog entries whose wire protocol cannot be inferred', () => {
    expect(normalizeProviderPresets({
      unknown: {
        id: 'unknown',
        name: 'Unknown',
        api: 'https://unknown.example',
        models: {},
      },
    })).toEqual([]);
  });
});
