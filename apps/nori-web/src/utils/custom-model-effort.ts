import type { ModelCatalogItem } from '../api/client';

export type CustomModelThinkingMode = 'unsupported' | 'toggle' | 'efforts';

export interface CustomModelDraft {
  id: string;
  displayName?: string;
  contextLength?: string;
  thinking: CustomModelThinkingMode;
  supportEfforts: string[];
  defaultEffort: string;
}

export const COMMON_THINKING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export function emptyCustomModelDraft(): CustomModelDraft {
  return { id: '', displayName: '', contextLength: '128000', thinking: 'unsupported', supportEfforts: [], defaultEffort: '' };
}

export function parseCustomModelDrafts(
  customModelIds: readonly string[],
  aliases: Record<string, unknown> | undefined,
  providerId: string,
  options?: { includeUnlistedAliases?: boolean },
): CustomModelDraft[] {
  const drafts: CustomModelDraft[] = [];
  const seen = new Set<string>();
  for (const rawId of customModelIds) {
    const id = rawId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const scopedAlias = aliases?.[`${providerId}/${id}`];
    const legacyAlias = aliases?.[id];
    const alias = scopedAlias ?? (isAliasForProvider(legacyAlias, providerId) ? legacyAlias : undefined);
    drafts.push(aliasToCustomModelDraft(id, alias));
  }
  if ((options?.includeUnlistedAliases ?? true) && aliases !== undefined) {
    for (const [modelId, alias] of Object.entries(aliases)) {
      if (!isAliasForProvider(alias, providerId)) continue;
      const id = modelIdFromAlias(modelId, alias);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      drafts.push(aliasToCustomModelDraft(id, alias));
    }
  }
  return drafts.length > 0 ? drafts : [emptyCustomModelDraft()];
}

export function customModelIds(drafts: readonly CustomModelDraft[]): string[] {
  return [...new Set(drafts.map(draft => draft.id.trim()).filter(Boolean))];
}

export function customModelAliasPatch(
  providerId: string,
  draft: CustomModelDraft,
  existing?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const id = draft.id.trim();
  if (!id) return undefined;
  const previous = existing ?? {};
  const capabilities = uniqueStrings([
    ...stringArray(previous['capabilities'] ?? previous['Capabilities']),
    'tool_use',
    ...(draft.thinking === 'unsupported' ? [] : ['thinking']),
  ]).filter(capability => draft.thinking !== 'unsupported' || capability !== 'thinking');

  const patch: Record<string, unknown> = {
    ...previous,
    provider: providerId,
    model: id,
    max_context_size: parseContextLength(draft.contextLength)
      ?? numberField(previous['max_context_size'] ?? previous['maxContextSize'])
      ?? 128000,
    capabilities,
    display_name: draft.displayName !== undefined
      ? (draft.displayName.trim() || id)
      : stringField(previous['display_name'] ?? previous['displayName']) ?? id,
    thinking_support: draft.thinking !== 'unsupported',
  };

  delete patch.supportEfforts;
  delete patch.defaultEffort;
  if (draft.thinking === 'efforts') {
    const efforts = uniqueStrings(draft.supportEfforts);
    patch.support_efforts = efforts;
    patch.default_effort = efforts.includes(draft.defaultEffort)
      ? draft.defaultEffort
      : defaultEffortFromList(efforts);
  } else {
    // Explicit nulls survive snake→camel conversion and tell mergeConfigPatch
    // to drop leftover discovery/manual effort lists.
    patch.support_efforts = null;
    patch.default_effort = null;
  }

  return patch;
}

export function validateCustomModelDrafts(
  drafts: readonly CustomModelDraft[],
  options?: { requireAtLeastOne?: boolean },
): string | undefined {
  const ids = customModelIds(drafts);
  if ((options?.requireAtLeastOne ?? true) && ids.length === 0) {
    return 'Add at least one custom model when automatic discovery is disabled.';
  }
  for (const draft of drafts) {
    if (!draft.id.trim()) continue;
    const contextLength = parseContextLength(draft.contextLength);
    if (contextLength === undefined) {
      return `Model ${draft.id.trim()} needs a positive integer context length.`;
    }
    if (draft.thinking === 'efforts' && uniqueStrings(draft.supportEfforts).length === 0) {
      return `Model ${draft.id.trim()} needs at least one thinking effort.`;
    }
  }
  return undefined;
}

function aliasToCustomModelDraft(id: string, alias: unknown): CustomModelDraft {
  if (!isRecord(alias)) {
    return { ...emptyCustomModelDraft(), id };
  }
  const displayName = stringField(alias['display_name'] ?? alias['displayName']) ?? '';
  const contextLength = String(
    parseContextLength(alias['max_context_size'] ?? alias['maxContextSize']) ?? 128000,
  );
  const efforts = uniqueStrings(alias['support_efforts'] ?? alias['supportEfforts']);
  const capabilities = uniqueStrings(alias['capabilities']);
  const thinkingSupport = booleanField(alias['thinking_support'] ?? alias['thinkingSupport'])
    ?? (capabilities.includes('thinking') || capabilities.includes('always_thinking') ? true : undefined);
  if (efforts.length > 0) {
    const defaultEffort = stringField(alias['default_effort'] ?? alias['defaultEffort']) ?? '';
    return {
      id,
      displayName,
      contextLength,
      thinking: 'efforts',
      supportEfforts: efforts,
      defaultEffort: efforts.includes(defaultEffort) ? defaultEffort : defaultEffortFromList(efforts) ?? '',
    };
  }
  if (thinkingSupport === true) {
    return { id, displayName, contextLength, thinking: 'toggle', supportEfforts: [], defaultEffort: '' };
  }
  return { id, displayName, contextLength, thinking: 'unsupported', supportEfforts: [], defaultEffort: '' };
}

export function customModelToCatalogItem(
  providerId: string,
  draft: CustomModelDraft,
): ModelCatalogItem {
  const alias = customModelAliasPatch(providerId, draft) ?? {
    provider: providerId,
    model: draft.id,
    max_context_size: 128000,
  };
  return {
    provider: providerId,
    model: `${providerId}/${draft.id.trim()}`,
    max_context_size: numberField(alias['max_context_size']) ?? 128000,
    display_name: stringField(alias['display_name']) ?? undefined,
    capabilities: stringArray(alias['capabilities']),
    supports_thinking: alias['thinking_support'] === true,
    support_efforts: Array.isArray(alias['support_efforts']) ? stringArray(alias['support_efforts']) : undefined,
    default_effort: stringField(alias['default_effort']),
  };
}

function defaultEffortFromList(efforts: readonly string[]): string | undefined {
  if (efforts.includes('medium')) return 'medium';
  if (efforts.includes('high')) return 'high';
  return efforts[Math.floor(efforts.length / 2)];
}

function isAliasForProvider(value: unknown, providerId: string): boolean {
  return isRecord(value) && stringField(value['provider']) === providerId;
}

function modelIdFromAlias(modelId: string, alias: unknown): string {
  const configured = isRecord(alias) ? stringField(alias['model']) : undefined;
  if (configured) return configured;
  const prefix = `${modelId.split('/')[0]}/`;
  return modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId;
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap(item => typeof item === 'string' && item.trim() ? [item.trim()] : []))];
}

function stringArray(value: unknown): string[] {
  return uniqueStrings(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseContextLength(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 ? value : undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
