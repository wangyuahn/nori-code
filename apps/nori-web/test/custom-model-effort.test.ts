import { describe, expect, it } from 'vitest';

import { modelThinkingOptions } from '../src/utils/model-thinking';
import {
  customModelAliasPatch,
  customModelToCatalogItem,
  parseCustomModelDrafts,
  validateCustomModelDrafts,
} from '../src/utils/custom-model-effort';

describe('custom model effort persistence', () => {
  it('writes thinking_support false and clears leftover effort lists when thinking is unsupported', () => {
    expect(customModelAliasPatch('ds', {
      id: 'chat',
      thinking: 'unsupported',
      supportEfforts: ['high'],
      defaultEffort: 'high',
    })).toEqual(expect.objectContaining({
      provider: 'ds',
      model: 'chat',
      thinking_support: false,
      capabilities: ['tool_use'],
      support_efforts: null,
      default_effort: null,
    }));
  });

  it('keeps thinking enabled without effort lists for on/off custom models', () => {
    expect(customModelAliasPatch('ds', {
      id: 'chat',
      thinking: 'toggle',
      supportEfforts: ['high'],
      defaultEffort: 'high',
    })).toEqual(expect.objectContaining({
      thinking_support: true,
      capabilities: expect.arrayContaining(['tool_use', 'thinking']),
      support_efforts: null,
      default_effort: null,
    }));
  });

  it('writes supported efforts and a default for adjustable custom models', () => {
    const patch = customModelAliasPatch('ds', {
      id: 'reasoner',
      thinking: 'efforts',
      supportEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
    });
    expect(patch).toEqual(expect.objectContaining({
      thinking_support: true,
      capabilities: expect.arrayContaining(['tool_use', 'thinking']),
      support_efforts: ['low', 'medium', 'high'],
      default_effort: 'medium',
    }));
  });

  it('hydrates drafts from existing aliases and rejects empty effort lists', () => {
    const drafts = parseCustomModelDrafts(['local-chat'], {
      'custom/local-chat': {
        provider: 'custom',
        model: 'local-chat',
        thinkingSupport: true,
        supportEfforts: ['low', 'high'],
        defaultEffort: 'high',
      },
    }, 'custom');
    expect(drafts).toEqual([
      expect.objectContaining({
        id: 'local-chat',
        contextLength: '128000',
        thinking: 'efforts',
        supportEfforts: ['low', 'high'],
        defaultEffort: 'high',
      }),
    ]);
    expect(validateCustomModelDrafts([{
      id: 'local-chat',
      contextLength: '128000',
      thinking: 'efforts',
      supportEfforts: [],
      defaultEffort: '',
    }])).toContain('needs at least one thinking effort');
  });

  it('writes the edited display name and context length into the model alias', () => {
    expect(customModelAliasPatch('custom', {
      id: 'local-chat',
      displayName: 'Local Chat',
      contextLength: '65536',
      thinking: 'unsupported',
      supportEfforts: [],
      defaultEffort: '',
    })).toEqual(expect.objectContaining({
      display_name: 'Local Chat',
      max_context_size: 65536,
    }));
    expect(validateCustomModelDrafts([{
      id: 'local-chat',
      displayName: '',
      contextLength: '',
      thinking: 'unsupported',
      supportEfforts: [],
      defaultEffort: '',
    }])).toContain('positive integer context length');
  });

  it('does not hydrate a same-named legacy alias owned by another provider', () => {
    expect(parseCustomModelDrafts(['shared-model'], {
      'shared-model': {
        provider: 'other-provider',
        model: 'shared-model',
        thinking_support: true,
        support_efforts: ['xhigh'],
        default_effort: 'xhigh',
      },
    }, 'target-provider')).toEqual([{
      id: 'shared-model',
      displayName: '',
      contextLength: '128000',
      thinking: 'unsupported',
      supportEfforts: [],
      defaultEffort: '',
    }]);
  });

  it('does not hydrate unlisted aliases when extras-only mode is on', () => {
    expect(parseCustomModelDrafts([], {
      'openrouter/gpt-new': {
        provider: 'openrouter',
        model: 'gpt-new',
      },
    }, 'openrouter', { includeUnlistedAliases: false })).toEqual([
      expect.objectContaining({ id: '' }),
    ]);
    expect(parseCustomModelDrafts(['stealth/ox-alpha'], {
      'openrouter/gpt-new': {
        provider: 'openrouter',
        model: 'gpt-new',
      },
      'openrouter/stealth/ox-alpha': {
        provider: 'openrouter',
        model: 'stealth/ox-alpha',
        thinkingSupport: true,
        supportEfforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
      },
    }, 'openrouter', { includeUnlistedAliases: false })).toEqual([
      expect.objectContaining({
        id: 'stealth/ox-alpha',
        thinking: 'efforts',
        supportEfforts: ['low', 'medium', 'high'],
      }),
    ]);
  });

  it('exposes the same chat effort choices as discovered models after save', () => {
    const item = customModelToCatalogItem('ds', {
      id: 'reasoner',
      thinking: 'efforts',
      supportEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
    });
    expect(modelThinkingOptions(item)).toEqual({
      choices: [
        { value: 'off', kind: 'fast' },
        { value: 'low', kind: 'effort' },
        { value: 'medium', kind: 'effort' },
        { value: 'high', kind: 'effort' },
      ],
      defaultValue: 'medium',
    });
    expect(modelThinkingOptions(customModelToCatalogItem('ds', {
      id: 'fast',
      thinking: 'unsupported',
      supportEfforts: [],
      defaultEffort: '',
    })).choices).toEqual([]);
  });
});
