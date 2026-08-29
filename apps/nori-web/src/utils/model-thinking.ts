import type { ModelCatalogItem } from '../api/client';

export interface ModelThinkingChoice {
  value: string;
  kind: 'fast' | 'think' | 'effort';
}

export interface ModelThinkingOptions {
  choices: ModelThinkingChoice[];
  defaultValue: string;
}

export interface ComposerThinkingState {
  choices: ModelThinkingChoice[];
  selectedValue: string;
}

export function resolveComposerThinking(input: {
  model: ModelCatalogItem | undefined;
  runtimeThinking?: string;
  sessionThinking?: string;
  draftThinking?: string;
}): ComposerThinkingState {
  const options = modelThinkingOptions(input.model);
  if (options.choices.length === 0) {
    return { choices: [], selectedValue: 'off' };
  }

  const requested = normalizeThinking(input.runtimeThinking)
    ?? normalizeThinking(input.sessionThinking)
    ?? normalizeThinking(input.draftThinking)
    ?? options.defaultValue;

  let choices = options.choices;
  if (!choices.some(choice => choice.value === requested)) {
    choices = [...choices, { value: requested, kind: effortKind(requested) }];
  }

  const selectedValue = choices.find(choice => choice.value === requested)?.value
    ?? choices.find(choice => choice.value === options.defaultValue)?.value
    ?? choices[0]?.value
    ?? 'off';

  return { choices, selectedValue };
}

/**
 * Ordered thinking choices for a catalog model — mirrors TUI `segmentsFor`:
 * effort-capable models expose declared levels (with a leading `off` when the
 * model is not always-on and the list does not already include off/none);
 * boolean models expose on/off.
 */
export function modelThinkingOptions(
  model: ModelCatalogItem | undefined,
): ModelThinkingOptions {
  if (model === undefined) return { choices: [], defaultValue: 'off' };

  const record = model as ModelCatalogItem & Record<string, unknown>;
  const capabilities = new Set(
    (model.capabilities ?? []).map(capability => capability.trim().toLowerCase()),
  );
  const alwaysThinking = capabilities.has('always_thinking');
  const declaredEfforts = uniqueNonEmpty(
    model.support_efforts
      ?? stringArrayField(record['supportEfforts'])
      ?? [],
  );
  const supportsThinking = model.supports_thinking
    ?? booleanField(record['supportsThinking'])
    ?? booleanField(record['thinkingSupport'])
    ?? (capabilities.has('thinking') || alwaysThinking || booleanField(record['adaptiveThinking']) === true
      ? true
      : undefined);
  const declaredDefault = model.default_effort
    ?? stringField(record['defaultEffort']);

  if (supportsThinking === false) return { choices: [], defaultValue: 'off' };

  if (declaredEfforts.length > 0) {
    const toggleOnly = declaredEfforts.every(value => value === 'off' || value === 'on');
    const values = !toggleOnly
      && !alwaysThinking
      && !declaredEfforts.includes('off')
      && !declaredEfforts.includes('none')
      ? ['off', ...declaredEfforts]
      : declaredEfforts;
    const choices = values.map(value => ({
      value,
      kind: effortKind(value),
    }));
    const defaultValue = declaredDefault !== undefined
      && choices.some(choice => choice.value === declaredDefault)
      ? declaredDefault
      : declaredEfforts[Math.floor(declaredEfforts.length / 2)]
        ?? choices[Math.floor(choices.length / 2)]?.value
        ?? 'off';
    return { choices, defaultValue };
  }

  if (supportsThinking === true) {
    const defaultValue = declaredDefault === 'off' || declaredDefault === 'on'
      ? declaredDefault
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

function effortKind(value: string): ModelThinkingChoice['kind'] {
  if (value === 'off' || value === 'none') return 'fast';
  if (value === 'on') return 'think';
  return 'effort';
}

function normalizeThinking(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === '' ? undefined : trimmed;
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function stringArrayField(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = uniqueNonEmpty(value.flatMap(item => typeof item === 'string' ? [item] : []));
  return items.length > 0 ? items : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
