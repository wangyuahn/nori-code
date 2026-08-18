import { describe, expect, it } from 'vitest';

import { normalizeProviderPresets } from '../src/routes/modelCatalog';
import { BUILTIN_PROVIDER_PRESETS, mergeProviderPresetLists, toWireProviderPreset } from '@nori-code/oauth';

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

  it('keeps builtin templates when merging with models.dev results', () => {
    const builtin = BUILTIN_PROVIDER_PRESETS.map(preset => toWireProviderPreset(preset));
    const merged = mergeProviderPresetLists(builtin, [
      { id: 'openai', name: 'Online OpenAI', type: 'openai', env: [], model_count: 3 },
      { id: 'custom-gateway', name: 'Gateway', type: 'openai', env: [], model_count: 1 },
    ]);
    expect(merged[0]?.builtin).toBe(true);
    expect(merged.some(item => item.id === 'custom-gateway')).toBe(true);
    expect(merged.filter(item => item.id === 'openai')).toHaveLength(1);
  });
});
