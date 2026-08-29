import { describe, expect, it } from 'vitest';

import {
  extraModelAliasPatch,
  extraModelIds,
  extraModelsFromConfig,
  thinkingLabel,
  type ExtraModelDraft,
} from '#/tui/utils/provider-extras';
import type { ModelAlias, ProviderConfig } from '@nori-code/sdk';
import { thinkingAvailability } from '#/tui/components/dialogs/model-selector';

describe('provider extras', () => {
  it('reads customModels even when auto-discover stays on', () => {
    const provider = {
      type: 'openai',
      customModels: ['stealth/ox-alpha', 'stealth/ox-alpha', ''],
    } as unknown as ProviderConfig;
    const models: Record<string, ModelAlias> = {
      'openrouter/stealth/ox-alpha': {
        provider: 'openrouter',
        model: 'stealth/ox-alpha',
        maxContextSize: 128000,
        thinkingSupport: true,
        supportEfforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
        capabilities: ['tool_use', 'thinking'],
      },
    };
    const drafts = extraModelsFromConfig(provider, models, 'openrouter');
    expect(extraModelIds(drafts)).toEqual(['stealth/ox-alpha']);
    expect(drafts[0]?.thinking).toBe('efforts');
    expect(thinkingLabel(drafts[0]!)).toContain('medium');
  });

  it('writes thinking metadata and nulls leftover effort lists', () => {
    const toggle: ExtraModelDraft = {
      id: 'stealth/ox-alpha',
      thinking: 'toggle',
      supportEfforts: ['high'],
      defaultEffort: 'high',
    };
    const patch = extraModelAliasPatch('openrouter', toggle);
    expect(patch['thinkingSupport']).toBe(true);
    expect(patch['supportEfforts']).toBeNull();
    expect(patch['defaultEffort']).toBeNull();
    expect(patch['provider']).toBe('openrouter');

    const efforts: ExtraModelDraft = {
      id: 'stealth/ox-alpha',
      thinking: 'efforts',
      supportEfforts: ['low', 'high'],
      defaultEffort: 'high',
    };
    const effortPatch = extraModelAliasPatch('openrouter', efforts);
    expect(effortPatch['supportEfforts']).toEqual(['low', 'high']);
    expect(effortPatch['defaultEffort']).toBe('high');
  });

  it('lets /model treat thinkingSupport extras as toggleable', () => {
    expect(
      thinkingAvailability({
        provider: 'openrouter',
        model: 'stealth/ox-alpha',
        maxContextSize: 128000,
        thinkingSupport: true,
      }),
    ).toBe('toggle');
  });
});
