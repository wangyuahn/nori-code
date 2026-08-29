/**
 * Extra / custom model drafts for TUI `/provider`.
 *
 * Auto-discover can coexist with `customModels` extras (stealth routes, etc.).
 * Thinking metadata is stored on the model alias so `/model` and `/effort` work.
 */

import type { ModelAlias, ProviderConfig } from '@nori-code/sdk';

export const COMMON_THINKING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type ExtraThinkingMode = 'unsupported' | 'toggle' | 'efforts';

export interface ExtraModelDraft {
  readonly id: string;
  readonly thinking: ExtraThinkingMode;
  readonly supportEfforts: readonly string[];
  readonly defaultEffort: string;
}

export function extraModelsFromConfig(
  provider: ProviderConfig | undefined,
  models: Record<string, ModelAlias>,
  providerId: string,
): ExtraModelDraft[] {
  const ids = provider?.customModels ?? [];
  const drafts: ExtraModelDraft[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = raw.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    drafts.push(draftFromAlias(id, models[`${providerId}/${id}`] ?? models[id]));
  }
  return drafts;
}

export function extraModelAliasPatch(
  providerId: string,
  draft: ExtraModelDraft,
  existing?: ModelAlias,
): Record<string, unknown> {
  const id = draft.id.trim();
  const capabilities = uniqueStrings([
    ...(existing?.capabilities ?? []),
    'tool_use',
    ...(draft.thinking === 'unsupported' ? [] : ['thinking']),
  ]).filter((capability) => draft.thinking !== 'unsupported' || capability !== 'thinking');

  const patch: Record<string, unknown> = {
    provider: providerId,
    model: id,
    maxContextSize: existing?.maxContextSize ?? 128000,
    capabilities,
    displayName: existing?.displayName ?? id,
    thinkingSupport: draft.thinking !== 'unsupported',
  };

  if (draft.thinking === 'efforts') {
    const efforts = uniqueStrings(draft.supportEfforts);
    patch['supportEfforts'] = efforts;
    patch['defaultEffort'] = efforts.includes(draft.defaultEffort)
      ? draft.defaultEffort
      : defaultEffortFromList(efforts);
  } else {
    patch['supportEfforts'] = null;
    patch['defaultEffort'] = null;
  }
  return patch;
}

export function extraModelIds(drafts: readonly ExtraModelDraft[]): string[] {
  return [...new Set(drafts.map((draft) => draft.id.trim()).filter((id) => id.length > 0))];
}

export function thinkingLabel(draft: ExtraModelDraft): string {
  if (draft.thinking === 'efforts') {
    const fallback = draft.supportEfforts[0] ?? 'medium';
    return `efforts · default ${draft.defaultEffort || fallback}`;
  }
  if (draft.thinking === 'toggle') return 'thinking toggle';
  return 'no thinking';
}

function draftFromAlias(id: string, alias: ModelAlias | undefined): ExtraModelDraft {
  if (alias === undefined) {
    return { id, thinking: 'unsupported', supportEfforts: [], defaultEffort: '' };
  }
  const efforts = uniqueStrings(alias.supportEfforts ?? []);
  if (efforts.length > 0) {
    const defaultEffort = alias.defaultEffort ?? '';
    return {
      id,
      thinking: 'efforts',
      supportEfforts: efforts,
      defaultEffort: efforts.includes(defaultEffort)
        ? defaultEffort
        : (defaultEffortFromList(efforts) ?? ''),
    };
  }
  const caps = alias.capabilities ?? [];
  if (alias.thinkingSupport === true || caps.includes('thinking') || caps.includes('always_thinking')) {
    return { id, thinking: 'toggle', supportEfforts: [], defaultEffort: '' };
  }
  return { id, thinking: 'unsupported', supportEfforts: [], defaultEffort: '' };
}

function defaultEffortFromList(efforts: readonly string[]): string | undefined {
  if (efforts.includes('medium')) return 'medium';
  if (efforts.includes('high')) return 'high';
  return efforts[Math.floor(efforts.length / 2)];
}

function uniqueStrings(value: readonly string[]): string[] {
  return [...new Set(value.flatMap((item) => (item.trim().length > 0 ? [item.trim()] : [])))];
}
