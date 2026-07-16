import type {
  ManagedKimiConfigShape,
  ManagedKimiModelAlias,
} from './custom-registry';
import type { ManagedKimiOAuthRef } from './stubs';
import {
  isOfficialKimiCodingEndpoint,
  OFFICIAL_KIMI_CODING_INPUT_CAPABILITIES,
} from './provider-capabilities';
import { reasoningMetadataFromRecord } from './reasoning-options';

export interface RefreshProviderHost {
  getConfig(): Promise<ManagedKimiConfigShape>;
  removeProvider(providerId: string): Promise<ManagedKimiConfigShape>;
  setConfig(patch: ManagedKimiConfigShape): Promise<ManagedKimiConfigShape>;
  resolveOAuthToken(providerName: string, oauthRef?: ManagedKimiOAuthRef): Promise<string>;
  readonly userAgent?: string;
}

export interface ProviderChange {
  readonly providerId: string;
  readonly providerName: string;
  readonly added: number;
  readonly removed: number;
}

export type RefreshProviderScope = 'all' | 'oauth';

export interface RefreshProviderOptions {
  readonly scope?: RefreshProviderScope;
  readonly providerId?: string;
}

export interface RefreshResult {
  readonly changed: readonly ProviderChange[];
  readonly unchanged: readonly string[];
  readonly failed: ReadonlyArray<{ readonly provider: string; readonly reason: string }>;
}

type ProviderRecord = Record<string, unknown>;

interface DiscoveredModel {
  readonly id: string;
  readonly displayName?: string;
  readonly maxContextSize?: number;
  readonly capabilities?: string[];
  readonly thinkingSupport?: boolean;
  readonly supportEfforts?: string[];
  readonly defaultEffort?: string;
}

const DEFAULT_CONTEXT_SIZE = 131_072;
const DEFAULT_TIMEOUT_MS = 15_000;

function stringField(record: ProviderRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function recordField(record: ProviderRecord, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function positiveInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
  }
  return undefined;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function openAIModelUrls(configuredBase: string): string[] {
  const base = trimSlash(configuredBase)
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/responses$/i, '');
  if (/\/models$/i.test(base)) return [base];
  if (/\/v\d+(?:beta)?$/i.test(base)) return [base + '/models'];
  return [base + '/models', base + '/v1/models'];
}

async function readModelPayload(response: Response, url: string): Promise<unknown> {
  const body = await response.text();
  if (!response.ok) {
    const detail = body.trim().slice(0, 300);
    throw new Error('Model request failed (HTTP ' + response.status + ')' + (detail ? ': ' + detail : '.'));
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    const kind = contentType.includes('text/html') || /^\s*</.test(body) ? 'HTML' : 'non-JSON data';
    throw new Error(
      `Model endpoint ${url} returned ${kind}. Check that API Base URL points to an OpenAI-compatible API root.`,
    );
  }
}

function isChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  return !lower.includes('embedding') && !/(^|[-_/])embed($|[-_/])/.test(lower);
}

function capabilitiesFor(
  record: ProviderRecord,
  id: string,
  efforts: readonly string[] | undefined,
  endpointCapabilities: readonly string[] = [],
): string[] {
  const capabilities = new Set<string>(['tool_use', ...endpointCapabilities]);
  const raw = record['capabilities'];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string') capabilities.add(item);
    }
  }
  const reasoning = record['reasoning'] ?? record['supports_reasoning'] ?? record['supportsThinking'];
  if (reasoning === true || (efforts?.length ?? 0) > 0 || (reasoning !== false && /(^|[-_.])(o[134]|reason|thinking)/i.test(id))) capabilities.add('thinking');
  if (record['supports_image_in'] === true || record['supportsImageInput'] === true) capabilities.add('image_in');
  if (record['supports_audio_in'] === true || record['supportsAudioInput'] === true) capabilities.add('audio_in');
  if (record['supports_video_in'] === true || record['supportsVideoInput'] === true) capabilities.add('video_in');
  const modalities = recordField(record, 'modalities');
  const inputs = modalities?.['input'];
  if (Array.isArray(inputs)) {
    if (inputs.includes('image')) capabilities.add('image_in');
    if (inputs.includes('audio')) capabilities.add('audio_in');
    if (inputs.includes('video')) capabilities.add('video_in');
  }
  return [...capabilities];
}

function thinkingSupportFor(
  record: ProviderRecord,
  id: string,
  efforts: readonly string[] | undefined,
): boolean | undefined {
  const reasoning = record['reasoning'] ?? record['supports_reasoning'] ?? record['supportsThinking'];
  if (typeof reasoning === 'boolean') return reasoning || (efforts?.length ?? 0) > 0;
  if ((efforts?.length ?? 0) > 0 || /(^|[-_.])(o[134]|reason|thinking)/i.test(id)) return true;
  return undefined;
}

function normalizeModels(
  payload: unknown,
  providerType: string,
  endpointCapabilities: readonly string[] = [],
): DiscoveredModel[] {
  if (typeof payload !== 'object' || payload === null) throw new Error('Model endpoint returned an invalid JSON object.');
  const root = payload as Record<string, unknown>;
  const rawItems = Array.isArray(root['data'])
    ? root['data']
    : Array.isArray(root['models'])
      ? root['models']
      : Array.isArray(payload)
        ? payload
        : undefined;
  if (rawItems === undefined) throw new Error('Model endpoint response does not contain data[] or models[].');

  const models = new Map<string, DiscoveredModel>();
  for (const item of rawItems) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const record = item as ProviderRecord;
    const rawId = stringField(record, 'id') ?? stringField(record, 'name');
    if (rawId === undefined) continue;
    const id = rawId.replace(/^models\//, '');
    if (!isChatModel(id)) continue;
    const reasoning = reasoningMetadataFromRecord(record, providerType, id);
    const efforts = reasoning.efforts;
    models.set(id, {
      id,
      displayName: stringField(record, 'display_name') ?? stringField(record, 'displayName') ?? stringField(record, 'name'),
      maxContextSize: positiveInteger(record['context_window'], record['context_length'], record['max_context_size'], record['inputTokenLimit']),
      capabilities: capabilitiesFor(record, id, efforts, endpointCapabilities),
      thinkingSupport: reasoning.supported ?? thinkingSupportFor(record, id, efforts),
      supportEfforts: efforts,
      defaultEffort: stringField(record, 'default_effort'),
    });
  }
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function enrichModelsFromCatalog(
  discovered: DiscoveredModel[],
  provider: ProviderRecord,
  providerType: string,
  signal: AbortSignal,
  userAgent?: string,
): Promise<DiscoveredModel[]> {
  const source = recordField(provider, 'source');
  if (source?.['kind'] !== 'modelsDev') return discovered;
  const url = stringField(source, 'url');
  const catalogId = stringField(source, 'catalogId') ?? stringField(source, 'catalog_id');
  if (url === undefined || catalogId === undefined) return discovered;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (userAgent !== undefined) headers['User-Agent'] = userAgent;
  const response = await fetch(url, { headers, signal });
  if (!response.ok) return discovered;
  const payload: unknown = await response.json();
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return discovered;
  const providers = payload as Record<string, unknown>;
  const rawProvider = providers[catalogId] ?? Object.values(providers).find(value => {
    return typeof value === 'object'
      && value !== null
      && !Array.isArray(value)
      && (value as ProviderRecord)['id'] === catalogId;
  });
  if (typeof rawProvider !== 'object' || rawProvider === null || Array.isArray(rawProvider)) {
    return discovered;
  }
  const rawModels = (rawProvider as ProviderRecord)['models'];
  if (typeof rawModels !== 'object' || rawModels === null || Array.isArray(rawModels)) {
    return discovered;
  }

  const byId = new Map<string, ProviderRecord>();
  for (const [key, value] of Object.entries(rawModels)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const record = value as ProviderRecord;
    const id = stringField(record, 'id') ?? key;
    byId.set(id, record);
    byId.set(key, record);
  }

  return discovered.map(model => {
    const record = byId.get(model.id);
    if (record === undefined) return model;
    const reasoning = reasoningMetadataFromRecord(record, providerType, model.id);
    const efforts = reasoning.efforts;
    const limit = recordField(record, 'limit');
    const catalogCapabilities = capabilitiesFor(record, model.id, efforts);
    return {
      ...model,
      displayName: stringField(record, 'name') ?? model.displayName,
      maxContextSize: positiveInteger(limit?.['context']) ?? model.maxContextSize,
      capabilities: [...new Set([...(model.capabilities ?? []), ...catalogCapabilities])],
      thinkingSupport: reasoning.supported ?? thinkingSupportFor(record, model.id, efforts) ?? model.thinkingSupport,
      supportEfforts: efforts ?? model.supportEfforts,
      defaultEffort: stringField(record, 'default_effort') ?? model.defaultEffort,
    };
  });
}

async function discoverModels(
  providerId: string,
  provider: ProviderRecord,
  host: RefreshProviderHost,
): Promise<DiscoveredModel[]> {
  const type = stringField(provider, 'type');
  if (type === undefined) throw new Error('Provider API format is missing.');
  let apiKey = stringField(provider, 'apiKey');
  const oauth = recordField(provider, 'oauth') as ManagedKimiOAuthRef | undefined;
  if (apiKey === undefined && oauth !== undefined) apiKey = await host.resolveOAuthToken(providerId, oauth);

  const configuredBase = stringField(provider, 'baseUrl');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (host.userAgent) headers['User-Agent'] = host.userAgent;
  let urls: string[];

  switch (type) {
    case 'anthropic': {
      if (apiKey === undefined) throw new Error('API key is required to request Anthropic models.');
      const base = trimSlash(configuredBase ?? 'https://api.anthropic.com').replace(/\/v1$/, '');
      urls = [base + '/v1/models'];
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
      break;
    }
    case 'google-genai': {
      if (apiKey === undefined) throw new Error('API key is required to request Gemini models.');
      const base = trimSlash(configuredBase ?? 'https://generativelanguage.googleapis.com');
      const url = base.endsWith('/v1beta') ? base + '/models' : base + '/v1beta/models';
      urls = [url + (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(apiKey)];
      break;
    }
    case 'vertexai':
      throw new Error('Vertex AI model discovery needs project and location metadata; add model aliases manually or use a models.dev preset.');
    case 'openai':
    case 'openai_responses':
    case 'kimi': {
      if (configuredBase === undefined) throw new Error('Base URL is required for this provider.');
      urls = openAIModelUrls(configuredBase);
      if (apiKey !== undefined) headers['Authorization'] = 'Bearer ' + apiKey;
      break;
    }
    default:
      throw new Error('Unsupported provider API format: ' + type);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const failures: Error[] = [];
    for (const url of urls) {
      try {
        const response = await fetch(url, { headers, signal: controller.signal });
        const endpointCapabilities = isOfficialKimiCodingEndpoint(configuredBase)
          ? OFFICIAL_KIMI_CODING_INPUT_CAPABILITIES
          : [];
        const discovered = normalizeModels(await readModelPayload(response, url), type, endpointCapabilities);
        return await enrichModelsFromCatalog(discovered, provider, type, controller.signal, host.userAgent)
          .catch(() => discovered);
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    throw failures.at(-1) ?? new Error('Model discovery failed.');
  } finally {
    clearTimeout(timer);
  }
}

function aliasesForProvider(config: ManagedKimiConfigShape, providerId: string): Array<[string, ManagedKimiModelAlias]> {
  const output: Array<[string, ManagedKimiModelAlias]> = [];
  for (const [key, value] of Object.entries(config.models ?? {})) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const alias = value as ManagedKimiModelAlias;
    if (alias.provider === providerId && typeof alias.model === 'string') output.push([key, alias]);
  }
  return output;
}

function sameModels(current: Array<[string, ManagedKimiModelAlias]>, discovered: DiscoveredModel[]): boolean {
  if (current.length !== discovered.length) return false;
  const previousByModel = new Map(current.map(([, alias]) => [alias.model, alias]));
  for (const model of discovered) {
    const existing = previousByModel.get(model.id);
    if (existing === undefined) return false;
    if (model.maxContextSize !== undefined && existing.maxContextSize !== model.maxContextSize) return false;
    if (model.displayName !== undefined && existing.displayName !== model.displayName) return false;
    if (model.defaultEffort !== undefined && existing.defaultEffort !== model.defaultEffort) return false;
    if (model.thinkingSupport !== undefined && existing.thinkingSupport !== model.thinkingSupport) return false;
    if (!sameStringSet(existing.capabilities ?? ['tool_use'], model.capabilities ?? existing.capabilities ?? ['tool_use'])) return false;
    if (!sameStringSet(existing.supportEfforts ?? [], model.supportEfforts ?? existing.supportEfforts ?? [])) return false;
  }
  return true;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const values = new Set(left);
  return right.every(value => values.has(value));
}

export async function refreshProviderModels(
  host: RefreshProviderHost,
  options: RefreshProviderOptions = {},
): Promise<RefreshResult> {
  let config = await host.getConfig();
  const changed: ProviderChange[] = [];
  const unchanged: string[] = [];
  const failed: Array<{ provider: string; reason: string }> = [];
  const targetIds = options.providerId ? [options.providerId] : Object.keys(config.providers ?? {});

  for (const providerId of targetIds) {
    const rawProvider = config.providers?.[providerId];
    if (rawProvider === undefined) {
      failed.push({ provider: providerId, reason: 'Provider is not configured.' });
      continue;
    }
    const provider = rawProvider as ProviderRecord;
    if (options.scope === 'oauth' && recordField(provider, 'oauth') === undefined) continue;

    try {
      const discovered = await discoverModels(providerId, provider, host);
      if (discovered.length === 0) throw new Error('Provider returned no usable chat models.');
      const current = aliasesForProvider(config, providerId);
      if (sameModels(current, discovered)) {
        unchanged.push(providerId);
        continue;
      }

      const previousByModel = new Map(current.map(([, alias]) => [alias.model, alias]));
      const nextModels: Record<string, ManagedKimiModelAlias | Record<string, unknown>> = {};
      for (const [key, alias] of Object.entries(config.models ?? {})) {
        if (typeof alias === 'object' && alias !== null && !Array.isArray(alias) && (alias as ManagedKimiModelAlias).provider === providerId) continue;
        nextModels[key] = alias;
      }
      for (const model of discovered) {
        const existing = previousByModel.get(model.id);
        nextModels[providerId + '/' + model.id] = {
          ...existing,
          provider: providerId,
          model: model.id,
          maxContextSize: model.maxContextSize ?? existing?.maxContextSize ?? DEFAULT_CONTEXT_SIZE,
          capabilities: model.capabilities ?? existing?.capabilities ?? ['tool_use'],
          thinkingSupport: model.thinkingSupport ?? existing?.thinkingSupport,
          displayName: model.displayName ?? existing?.displayName,
          supportEfforts: model.supportEfforts ?? existing?.supportEfforts,
          defaultEffort: model.defaultEffort ?? existing?.defaultEffort,
        };
      }

      const oldIds = new Set(current.map(([, alias]) => alias.model));
      const nextIds = new Set(discovered.map((model) => model.id));
      const added = [...nextIds].filter((id) => !oldIds.has(id)).length;
      const removed = [...oldIds].filter((id) => !nextIds.has(id)).length;
      const firstDiscovered = discovered[0];
      const nextDefault = config.defaultModel && nextModels[config.defaultModel]
        ? config.defaultModel
        : (config.defaultModel?.startsWith(providerId + '/') && firstDiscovered !== undefined
          ? providerId + '/' + firstDiscovered.id
          : config.defaultModel);

      await host.removeProvider(providerId);
      config = await host.setConfig({
        providers: { ...config.providers, [providerId]: provider },
        models: nextModels,
        defaultModel: nextDefault,
        thinking: config.thinking,
      });
      changed.push({ providerId, providerName: providerId, added, removed });
    } catch (error) {
      failed.push({
        provider: providerId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { changed, unchanged, failed };
}
