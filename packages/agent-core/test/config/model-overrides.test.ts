import { describe, expect, it } from 'vitest';

import { effectiveModelAlias } from '#/config/model';
import type { ModelAlias } from '#/config/schema';

function alias(overrides?: ModelAlias['overrides']): ModelAlias {
  return {
    provider: 'managed:kimi-code',
    model: 'kimi-k2',
    maxContextSize: 262144,
    capabilities: ['thinking'],
    supportEfforts: ['low', 'high', 'max'],
    defaultEffort: 'max',
    overrides,
  };
}

describe('effectiveModelAlias', () => {
  it('returns the alias unchanged when there are no overrides', () => {
    const model = alias();

    expect(effectiveModelAlias(model)).toEqual(model);
  });

  it('lets overrides win over top-level fields', () => {
    const model = alias({ supportEfforts: ['low', 'high'] });

    expect(effectiveModelAlias(model).supportEfforts).toEqual(['low', 'high']);
  });

  it('allows overriding non-identity model fields such as maxContextSize', () => {
    const model = alias({ maxContextSize: 128000 });

    expect(effectiveModelAlias(model).maxContextSize).toBe(128000);
  });

  it('drops an incompatible defaultEffort when supportEfforts is overridden', () => {
    const model = alias({ supportEfforts: ['low', 'high'] });

    expect(effectiveModelAlias(model).defaultEffort).toBeUndefined();
  });

  it('keeps an explicit defaultEffort override when it is valid', () => {
    const model = alias({ supportEfforts: ['low', 'high'], defaultEffort: 'high' });

    expect(effectiveModelAlias(model).defaultEffort).toBe('high');
  });

  it('infers reasoning metadata for a known custom model id', () => {
    const model: ModelAlias = {
      provider: 'custom-gateway',
      model: 'glm-5.2',
      maxContextSize: 1_000_000,
      capabilities: ['tool_use'],
    };

    expect(effectiveModelAlias(model)).toMatchObject({
      capabilities: ['tool_use', 'thinking'],
      thinkingSupport: true,
      supportEfforts: ['high', 'max'],
    });
  });

  it('does not replace explicit provider reasoning metadata', () => {
    const model: ModelAlias = {
      provider: 'custom-gateway',
      model: 'glm-5.2',
      maxContextSize: 1_000_000,
      capabilities: ['tool_use'],
      thinkingSupport: false,
    };

    expect(effectiveModelAlias(model)).toEqual(model);
  });
});
