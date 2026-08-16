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
      kind: value === 'off' || value === 'none'
        ? 'fast' as const
        : value === 'on' ? 'think' as const : 'effort' as const,
    }));
    const declaredDefault = model.default_effort;
    const defaultValue = declaredDefault !== undefined
      && choices.some(choice => choice.value === declaredDefault)
      ? declaredDefault
      : choices[Math.floor(choices.length / 2)]?.value ?? 'off';
    return { choices, defaultValue };
  }

  if (supportsThinking === true) {
    const defaultValue = model.default_effort === 'off' || model.default_effort === 'on'
      ? model.default_effort
      : 'on';
    return {
      choices: [
        ...(!alwaysThinking ? [{ value: 'off', kind: 'fast' as const }] : []),
        { value: 'on', kind: 'think' },
      ],
      defaultValue: alwaysThinking && defaultValue === 'off' ? 'on' : defaultValue,
    };
  }

  return { choices: [], defaultValue: 'off' };
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}
