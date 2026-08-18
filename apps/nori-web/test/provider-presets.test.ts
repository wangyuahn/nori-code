import { describe, expect, it } from 'vitest';

import {
  draftFromProviderPreset,
  presetRequiresApiKey,
  uniqueCopiedProviderId,
} from '../src/utils/provider-presets';

describe('provider preset drafts', () => {
  it('copies the template id and requires an API key unless auth is none', () => {
    expect(uniqueCopiedProviderId('openai', ['openai'])).toBe('openai-2');
    expect(presetRequiresApiKey({
      id: 'openai',
      name: 'OpenAI',
      type: 'openai',
      env: ['OPENAI_API_KEY'],
      model_count: 0,
      builtin: true,
      auth: 'api_key',
      required_fields: ['api_key'],
    })).toBe(true);
    expect(presetRequiresApiKey({
      id: 'ollama',
      name: 'Ollama',
      type: 'openai',
      env: [],
      model_count: 0,
      auth: 'none',
    })).toBe(false);
  });

  it('pre-fills auto-discover and catalog source from a builtin template', () => {
    const draft = draftFromProviderPreset({
      id: 'anthropic',
      name: 'Anthropic',
      type: 'anthropic',
      base_url: 'https://api.anthropic.com',
      env: ['ANTHROPIC_API_KEY'],
      model_count: 0,
      builtin: true,
      auth: 'api_key',
      required_fields: ['api_key'],
      catalog_id: 'anthropic',
    }, []);
    expect(draft).toEqual(expect.objectContaining({
      id: 'anthropic',
      type: 'anthropic',
      autoDiscover: true,
      fromPreset: true,
      requiresApiKey: true,
      catalogId: 'anthropic',
    }));
  });
});
