import { describe, expect, it } from 'vitest';

import {
  BUILTIN_PROVIDER_PRESETS,
  mergeProviderPresetLists,
  toWireProviderPreset,
  uniqueCopiedProviderId,
} from '../src/builtin-provider-presets';

describe('builtin provider presets', () => {
  it('covers mainstream vendors and OpenAI-compatible third parties', () => {
    const ids = BUILTIN_PROVIDER_PRESETS.map(preset => preset.id);
    expect(ids).toEqual(expect.arrayContaining([
      'openai',
      'anthropic',
      'google',
      'openrouter',
      'deepseek',
      'groq',
      'together',
      'ollama',
    ]));
    expect(BUILTIN_PROVIDER_PRESETS.every(preset => preset.builtin)).toBe(true);
    expect(BUILTIN_PROVIDER_PRESETS.find(preset => preset.id === 'openai')?.requiredFields).toEqual(['api_key']);
    expect(BUILTIN_PROVIDER_PRESETS.find(preset => preset.id === 'ollama')?.auth).toBe('none');
  });

  it('copies a preset id instead of mutating the built-in template', () => {
    expect(uniqueCopiedProviderId('openai', ['openai'])).toBe('openai-2');
    expect(toWireProviderPreset(BUILTIN_PROVIDER_PRESETS[0]!).id).toBe(BUILTIN_PROVIDER_PRESETS[0]?.id);
  });

  it('keeps built-in templates ahead of online extras with the same id', () => {
    const builtin = BUILTIN_PROVIDER_PRESETS.slice(0, 1).map(preset => toWireProviderPreset(preset));
    const merged = mergeProviderPresetLists(builtin, [
      { id: 'openai', name: 'Online OpenAI', type: 'openai', env: [], model_count: 9 },
      { id: 'gateway', name: 'Gateway', type: 'openai', env: [], model_count: 1 },
    ]);
    expect(merged[0]?.name).toBe(builtin[0]?.name);
    expect(merged.map(item => item.id)).toEqual(['openai', 'gateway']);
  });
});
