export function reasoningEffortsFromRecord(record: Record<string, unknown>): string[] | undefined {
  const legacy = stringArray(record['support_efforts'] ?? record['supported_efforts']);
  if (legacy !== undefined) return legacy;

  const options = record['reasoning_options'];
  if (!Array.isArray(options)) return undefined;
  const effort = options.find(option => isRecord(option) && option['type'] === 'effort');
  if (isRecord(effort) && Array.isArray(effort['values'])) {
    const values = effort['values'].flatMap(value => {
      if (value === null) return ['none'];
      return typeof value === 'string' && value.trim().length > 0 ? [value.trim()] : [];
    });
    return values.length > 0 ? [...new Set(values)] : undefined;
  }

  const hasToggle = options.some(option => isRecord(option) && option['type'] === 'toggle');
  const hasBudget = options.some(option => isRecord(option) && option['type'] === 'budget_tokens');
  if (hasToggle && hasBudget) return ['off', 'high', 'max'];
  if (hasToggle) return ['off', 'on'];
  if (hasBudget) return ['high', 'max'];
  return undefined;
}

export interface ReasoningMetadata {
  readonly supported: boolean | undefined;
  readonly efforts: string[] | undefined;
}

/**
 * Resolves adjustable reasoning metadata using the same precedence as OpenCode:
 * explicit catalog options win, while provider/model-family variants are only
 * used when the catalog did not declare reasoning_options at all.
 */
export function reasoningMetadataFromRecord(
  record: Record<string, unknown>,
  providerType: string | undefined,
  modelId: string,
): ReasoningMetadata {
  const explicitSupport = booleanValue(
    record['reasoning'] ?? record['supports_reasoning'] ?? record['supportsThinking'],
  );
  const explicitEfforts = reasoningEffortsFromRecord(record);
  const hasDeclaredOptions = Object.prototype.hasOwnProperty.call(record, 'reasoning_options');
  if (explicitSupport === false) return { supported: false, efforts: undefined };
  if (explicitEfforts !== undefined || hasDeclaredOptions) {
    return {
      supported: explicitSupport ?? (explicitEfforts !== undefined ? true : undefined),
      efforts: explicitEfforts,
    };
  }

  const inferred = fallbackReasoningMetadata(providerType, modelId, explicitSupport);
  return {
    supported: explicitSupport ?? inferred.supported,
    efforts: inferred.efforts,
  };
}

export function fallbackReasoningMetadata(
  providerType: string | undefined,
  modelId: string,
  declaredSupport?: boolean,
): ReasoningMetadata {
  const id = modelId.toLowerCase();
  const knownReasoning = isKnownReasoningModel(id);
  if (declaredSupport !== true && !knownReasoning) {
    return { supported: undefined, efforts: undefined };
  }

  // OpenCode deliberately exposes these families as fixed/boolean thinking.
  if (
    id.includes('deepseek-chat')
    || id.includes('deepseek-reasoner')
    || id.includes('deepseek-r1')
    || id.includes('deepseek-v3')
    || id.includes('minimax')
    || (id.includes('glm') && !isGlm52(id))
    || id.includes('kimi')
    || id.includes('k2p')
    || id.includes('qwen')
    || id.includes('big-pickle')
  ) {
    return { supported: true, efforts: undefined };
  }

  if (providerType === 'google-genai' || providerType === 'vertexai') {
    return { supported: true, efforts: googleReasoningEfforts(id) };
  }
  if (providerType === 'anthropic') {
    return { supported: true, efforts: anthropicReasoningEfforts(id) };
  }

  if (isGlm52(id)) return { supported: true, efforts: ['high', 'max'] };
  if (id.includes('deepseek-v4')) {
    return { supported: true, efforts: ['low', 'medium', 'high', 'max'] };
  }
  if (id.includes('grok-3-mini')) return { supported: true, efforts: ['low', 'high'] };
  if (isGpt5(id)) return { supported: true, efforts: openAICompatibleGpt5Efforts(id) };

  // OpenCode's OpenAI-compatible path uses these broadly-supported effort
  // values once a model is known to support adjustable reasoning.
  return { supported: true, efforts: ['low', 'medium', 'high'] };
}

function isKnownReasoningModel(id: string): boolean {
  return isGpt5(id)
    || /(?:^|[/_.-])o[134](?:[/_.-]|$)/.test(id)
    || id.includes('reason')
    || id.includes('thinking')
    || id.includes('claude-3-7')
    || id.includes('claude-4')
    || id.includes('claude-fable-5')
    || id.includes('gemini-2.5')
    || id.includes('gemini-3')
    || id.includes('grok-3-mini')
    || id.includes('deepseek-')
    || id.includes('minimax-')
    || id.includes('glm-')
    || id.includes('kimi-')
    || id.includes('k2p')
    || id.includes('qwen3')
    || id.includes('big-pickle');
}

function isGpt5(id: string): boolean {
  return /(?:^|\/)gpt-5(?:[.-]|$)/.test(id);
}

function openAICompatibleGpt5Efforts(id: string): string[] {
  const version = Number(/(?:^|\/)gpt-5[.-](\d+)(?:[.-]|$)/.exec(id)?.[1]) || undefined;
  if (id.includes('-chat')) return version === undefined ? [] : ['medium'];
  if (/(?:^|\/)gpt-5[.-]?pro(?:[.-]|$)/.test(id)) return ['high'];
  if (/(?:^|\/)gpt-5[.-]\d+[.-]pro(?:[.-]|$)/.test(id)) return ['medium', 'high', 'xhigh'];
  if (id.includes('codex')) {
    if (version !== undefined && version >= 3) return ['none', 'low', 'medium', 'high', 'xhigh'];
    if (id.includes('codex-max') || (version !== undefined && version >= 2)) {
      return ['low', 'medium', 'high', 'xhigh'];
    }
    return ['low', 'medium', 'high'];
  }
  if (version === 1) return ['none', 'low', 'medium', 'high'];
  if (version !== undefined && version >= 2) return ['none', 'low', 'medium', 'high', 'xhigh'];
  return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
}

function anthropicReasoningEfforts(id: string): string[] {
  if (
    /opus-(?:[5-9]|4[.-](?:[7-9]|\d{2,}))/.test(id)
    || /sonnet-(?:[5-9]|\d{2,})(?:[.@-]|$)/.test(id)
    || id.includes('fable-5')
  ) {
    return ['low', 'medium', 'high', 'xhigh', 'max'];
  }
  if (
    ['opus-4-6', 'opus-4.6', '4-6-opus', '4.6-opus', 'sonnet-4-6', 'sonnet-4.6', '4-6-sonnet', '4.6-sonnet']
      .some(value => id.includes(value))
  ) {
    return ['low', 'medium', 'high', 'max'];
  }
  if (id.includes('opus-4-5') || id.includes('opus-4.5')) return ['low', 'medium', 'high'];
  return ['high', 'max'];
}

function googleReasoningEfforts(id: string): string[] {
  if (id.includes('2.5')) return ['high', 'max'];
  if (!id.includes('gemini-3')) return ['low', 'high'];
  if (id.includes('flash-image')) return ['minimal', 'high'];
  if (id.includes('pro-image')) return ['high'];
  if (id.includes('flash')) return ['minimal', 'low', 'medium', 'high'];
  return ['low', 'medium', 'high'];
}

function isGlm52(id: string): boolean {
  return ['glm-5.2', 'glm-5-2', 'glm-5p2'].some(value => id.includes(value));
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.flatMap(item => typeof item === 'string' && item.trim().length > 0 ? [item.trim()] : []);
  return items.length > 0 ? [...new Set(items)] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
