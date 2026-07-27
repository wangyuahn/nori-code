import { fallbackReasoningMetadata } from '@nori-code/oauth';

import type { ModelAlias } from './schema';

export function effectiveModelAlias(alias: ModelAlias): ModelAlias {
  const { overrides, ...base } = alias;
  const effective: ModelAlias = overrides === undefined
    ? alias
    : { ...base, ...overrides };

  if (
    overrides !== undefined &&
    overrides.supportEfforts !== undefined &&
    overrides.defaultEffort === undefined &&
    effective.defaultEffort !== undefined &&
    !overrides.supportEfforts.includes(effective.defaultEffort)
  ) {
    delete effective.defaultEffort;
  }

  return withInferredReasoningMetadata(effective);
}

function withInferredReasoningMetadata(alias: ModelAlias): ModelAlias {
  const capabilities = new Set(alias.capabilities ?? []);
  const hasDeclaredReasoning = alias.thinkingSupport !== undefined
    || alias.supportEfforts !== undefined
    || alias.adaptiveThinking !== undefined
    || capabilities.has('thinking')
    || capabilities.has('always_thinking');
  if (hasDeclaredReasoning) return alias;

  const inferred = fallbackReasoningMetadata(undefined, alias.model);
  if (inferred.supported === undefined && inferred.efforts === undefined) return alias;
  if (inferred.supported === true || (inferred.efforts?.length ?? 0) > 0) {
    capabilities.add('thinking');
  }

  return {
    ...alias,
    capabilities: [...capabilities],
    ...(inferred.supported !== undefined ? { thinkingSupport: inferred.supported } : {}),
    ...(inferred.efforts !== undefined ? { supportEfforts: inferred.efforts } : {}),
  };
}

export function effectiveModelAliases(
  models: Record<string, ModelAlias>,
): Record<string, ModelAlias> {
  return Object.fromEntries(
    Object.entries(models).map(([alias, model]) => [alias, effectiveModelAlias(model)]),
  );
}
