import type { ModelCatalogItem } from '../api/client';

export interface ModelThinkingChoice {
  value: string;
  kind: 'fast' | 'think' | 'effort';
}

export interface ModelThinkingOptions {
  choices: ModelThinkingChoice[];
  defaultValue: string;
}

export function modelThinkingOptions(
  model: ModelCatalogItem | undefined,
): ModelThinkingOptions {
  if (model === undefined) return { choices: [], defaultValue: 'off' };

  const capabilities = new Set(
    (model.capabilities ?? []).map(capability => capability.trim().toLowerCase()),
  );
  const alwaysThinking = capabilities.has('always_thinking');
  const declaredEfforts = uniqueNonEmpty(model.support_efforts ?? []);
  const supportsThinking = model.supports_thinking
    ?? (capabilities.has('thinking') || alwaysThinking ? true : undefined);

  if (supportsThinking === false) return { choices: [], defaultValue: 'off' };

  if (declaredEfforts.length > 0) {
    const choices = declaredEfforts.map(value => ({
      value,
      kind: value === 'off' ? 'fast' as const : 'effort' as const,
    }));
    if (!alwaysThinking && !choices.some(choice => choice.value === 'off')) {
      choices.unshift({ value: 'off', kind: 'fast' });
    }
    const selectableEfforts = choices.filter(choice => choice.value !== 'off');
    const declaredDefault = model.default_effort;
    const defaultValue = declaredDefault !== undefined
      && choices.some(choice => choice.value === declaredDefault)
      ? declaredDefault
      : selectableEfforts[Math.floor(selectableEfforts.length / 2)]?.value ?? 'off';
    return { choices, defaultValue };
  }

  if (supportsThinking === true) {
    const thinkValue = model.default_effort !== undefined && model.default_effort !== 'off'
      ? model.default_effort
      : 'medium';
    return {
      choices: [
        ...(!alwaysThinking ? [{ value: 'off', kind: 'fast' as const }] : []),
        { value: thinkValue, kind: 'think' },
      ],
      defaultValue: thinkValue,
    };
  }

  return {
    choices: [
      { value: 'off', kind: 'fast' },
      { value: 'medium', kind: 'think' },
    ],
    defaultValue: 'off',
  };
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}
