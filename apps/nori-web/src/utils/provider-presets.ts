import type { ProviderPreset } from '../api/client';
import type { CustomModelDraft } from './custom-model-effort';
import { emptyCustomModelDraft } from './custom-model-effort';

export function uniqueCopiedProviderId(baseId: string, existingIds: readonly string[]): string {
  const normalized = baseId.trim() || 'provider';
  if (!existingIds.includes(normalized)) return normalized;
  let suffix = 2;
  while (existingIds.includes(`${normalized}-${String(suffix)}`)) suffix += 1;
  return `${normalized}-${String(suffix)}`;
}

export function presetRequiresApiKey(preset: ProviderPreset): boolean {
  if (preset.auth === 'none') return false;
  if (preset.required_fields?.includes('api_key')) return true;
  return (preset.env?.length ?? 0) > 0;
}

export function draftFromProviderPreset(
  preset: ProviderPreset,
  existingIds: readonly string[],
): {
  id: string;
  name: string;
  type: ProviderPreset['type'];
  baseUrl: string;
  apiKey: string;
  autoDiscover: boolean;
  customModels: CustomModelDraft[];
  disabled: boolean;
  requiresApiKey: boolean;
  catalogId?: string;
  fromPreset: true;
} {
  const customModels = preset.default_model
    ? [{ ...emptyCustomModelDraft(), id: preset.default_model }]
    : [emptyCustomModelDraft()];
  return {
    id: uniqueCopiedProviderId(preset.id, existingIds),
    name: preset.name,
    type: preset.type,
    baseUrl: preset.base_url ?? '',
    apiKey: '',
    autoDiscover: true,
    customModels,
    disabled: false,
    requiresApiKey: presetRequiresApiKey(preset),
    catalogId: preset.catalog_id ?? (preset.builtin === true ? preset.id : undefined),
    fromPreset: true,
  };
}

export function providerSourcePatch(catalogId: string | undefined): Record<string, unknown> | undefined {
  if (catalogId === undefined || catalogId.trim() === '') return undefined;
  return {
    kind: 'modelsDev',
    url: 'https://models.dev/api.json',
    catalogId: catalogId.trim(),
  };
}

export function formatProviderRefreshNotice(result: {
  changed: Array<{ provider_id?: string; added?: number; removed?: number }>;
  unchanged: string[];
  failed: Array<{ provider: string; reason: string }>;
}): { text: string; error: boolean } {
  const failed = result.failed.length;
  const changed = result.changed.length;
  const unchanged = result.unchanged.length;
  if (failed > 0 && changed === 0 && unchanged === 0) {
    return { text: result.failed[0]?.reason ?? 'Model discovery failed.', error: true };
  }
  if (failed > 0) {
    return {
      text: `Updated ${String(changed)}, unchanged ${String(unchanged)}, failed ${String(failed)}: ${result.failed[0]?.reason ?? 'unknown error'}`,
      error: true,
    };
  }
  if (changed > 0) {
    return { text: `Provider saved and models refreshed (${String(changed)} updated).`, error: false };
  }
  return { text: 'Provider saved and models refreshed.', error: false };
}
