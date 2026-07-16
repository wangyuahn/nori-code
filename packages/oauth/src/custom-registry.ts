import { readApiErrorMessage } from './api-error';
import { isRecord } from './utils';
import { reasoningMetadataFromRecord } from './reasoning-options';

// ── types formerly from managed-kimi-code ──

export interface ManagedKimiModelAliasOverrides {
  maxContextSize?: number | undefined;
  maxOutputSize?: number | undefined;
  capabilities?: string[] | undefined;
  thinkingSupport?: boolean | undefined;
  displayName?: string | undefined;
  reasoningKey?: string | undefined;
  adaptiveThinking?: boolean | undefined;
  supportEfforts?: readonly string[] | undefined;
  defaultEffort?: string | undefined;
  readonly [key: string]: unknown;
}

export interface ManagedKimiModelAlias {
  provider: string;
  model: string;
  maxContextSize: number;
  capabilities?: string[] | undefined;
  thinkingSupport?: boolean | undefined;
  supportEfforts?: readonly string[] | undefined;
  defaultEffort?: string | undefined;
  displayName?: string | undefined;
  protocol?: string;
  betaApi?: boolean;
  adaptiveThinking?: boolean | undefined;
  overrides?: ManagedKimiModelAliasOverrides | undefined;
  readonly [key: string]: unknown;
}

export interface ManagedKimiConfigShape {
  providers: Record<string, Record<string, unknown>>;
  models?: Record<string, ManagedKimiModelAlias | Record<string, unknown>> | undefined;
  defaultModel?: string | undefined;
  thinking?: Record<string, unknown> | undefined;
  services?: Record<string, unknown> | undefined;
  [key: string]: unknown;
}

// ── helpers formerly from model-alias-merge ──

const CUSTOM_REGISTRY_MODEL_FIELDS: ReadonlySet<string> = new Set([
  'provider',
  'model',
  'maxContextSize',
  'capabilities',
  'thinkingSupport',
  'displayName',
  'supportEfforts',
  'defaultEffort',
]);

function cloneOverrides(
  overrides: ManagedKimiModelAliasOverrides | undefined,
): ManagedKimiModelAliasOverrides | undefined {
  if (overrides === undefined) return undefined;
  return structuredClone(overrides);
}

function userExtras(
  existing: Record<string, unknown>,
  remoteOwnedFields: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(existing)) {
    if (key === 'overrides') continue;
    if (!remoteOwnedFields.has(key)) out[key] = value;
  }
  return out;
}

function mergeRefreshedModelAlias(
  existing: unknown,
  remote: ManagedKimiModelAlias,
  remoteOwnedFields: ReadonlySet<string>,
): ManagedKimiModelAlias {
  const current = isRecord(existing) ? existing : {};
  const overrides = cloneOverrides(
    isRecord(current['overrides'])
      ? (current['overrides'] as ManagedKimiModelAliasOverrides)
      : undefined,
  );
  return {
    ...userExtras(current, remoteOwnedFields),
    ...remote,
    ...(overrides !== undefined ? { overrides } : {}),
  };
}

/**
 * Identifies where a custom-registry-managed provider came from. The same
 * URL may produce multiple providers (one per top-level entry in the api.json
 * document). Refresh treats the URL as the stable registry identity and may try
 * more than one API key when existing provider records drift during key
 * rotation.
 */
export interface CustomRegistrySource {
  readonly kind: 'apiJson';
  readonly url: string;
  readonly apiKey: string;
}

export interface FetchCustomRegistryOptions {
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  readonly userAgent?: string;
}

/**
 * The kosong `ProviderConfig` union (`packages/kosong/src/providers/index.ts`)
 * mirrors these literal values. Aliases commonly emitted by third-party
 * registries are normalized to one of these canonical wire types below.
 */
export type CustomRegistryProviderType =
  | 'anthropic'
  | 'openai'
  | 'openai_responses'
  | 'kimi'
  | 'google-genai'
  | 'vertexai';

export interface CustomRegistryModelEntry {
  readonly id: string;
  readonly name?: string;
  readonly limit?: { context?: number; output?: number };
  readonly tool_call?: boolean;
  readonly reasoning?: boolean;
  readonly modalities?: {
    input?: readonly string[];
    output?: readonly string[];
  };
  readonly support_efforts?: readonly string[];
  readonly default_effort?: string;
}

export interface CustomRegistryProviderEntry {
  readonly id: string;
  readonly name: string;
  readonly api: string;
  readonly type: CustomRegistryProviderType;
  readonly env?: readonly string[];
  readonly project?: string;
  readonly location?: string;
  readonly models: Record<string, CustomRegistryModelEntry>;
}

/**
 * Tuned slightly below typical real values so the local compactor kicks in
 * before the upstream rejects with a context-overflow 4xx. Users can override
 * by editing `~/.nori-code/config.toml`.
 */
export const CUSTOM_REGISTRY_DEFAULT_MAX_CONTEXT = 131072;
export const CUSTOM_REGISTRY_DEFAULT_CAPABILITIES = ['tool_use'] as const;

const ALLOWED_PROVIDER_TYPES: ReadonlySet<CustomRegistryProviderType> = new Set([
  'anthropic',
  'openai',
  'openai_responses',
  'kimi',
  'google-genai',
  'vertexai',
]);

export class CustomRegistryApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'CustomRegistryApiError';
    this.status = status;
  }
}

const PROVIDER_TYPE_ALIASES: Readonly<Record<string, CustomRegistryProviderType>> = {
  'chat-completions': 'openai',
  'chat_completions': 'openai',
  'openai-compatible': 'openai',
  'openai_compatible': 'openai',
  'openai-legacy': 'openai',
  'openai_legacy': 'openai',
  'responses': 'openai_responses',
  'openai-responses': 'openai_responses',
  'anthropic-messages': 'anthropic',
  'anthropic_messages': 'anthropic',
  'google': 'google-genai',
  'google_genai': 'google-genai',
  'vertex-ai': 'vertexai',
};

function normalizeProviderType(value: unknown): CustomRegistryProviderType | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  const aliased = PROVIDER_TYPE_ALIASES[normalized] ?? normalized;
  return ALLOWED_PROVIDER_TYPES.has(aliased as CustomRegistryProviderType)
    ? (aliased as CustomRegistryProviderType)
    : undefined;
}

function normalizeApiBaseUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const candidate = value.trim().replace(/\/+$/, '');
  if (candidate.length === 0) return undefined;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

function toStringArrayOrUndefined(value: unknown): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return undefined;
    out.push(item);
  }
  return out;
}

function toModelEntry(
  value: unknown,
  fallbackId: string,
  providerType: string,
): CustomRegistryModelEntry | undefined {
  if (!isRecord(value)) return undefined;
  const rawId = value['id'];
  const id =
    typeof rawId === 'string' && rawId.trim().length > 0 ? rawId.trim() : fallbackId.trim();
  if (id.length === 0) return undefined;

  const entry: {
    id: string;
    name?: string;
    limit?: { context?: number; output?: number };
    tool_call?: boolean;
    reasoning?: boolean;
    modalities?: { input?: readonly string[]; output?: readonly string[] };
    support_efforts?: readonly string[];
    default_effort?: string;
  } = { id };

  const name = value['name'];
  if (typeof name === 'string' && name.trim().length > 0) entry.name = name.trim();

  const limit = value['limit'];
  if (isRecord(limit)) {
    const context = limit['context'];
    const output = limit['output'];
    const parsedLimit: { context?: number; output?: number } = {};
    if (typeof context === 'number' && Number.isFinite(context) && context > 0) {
      parsedLimit.context = Math.floor(context);
    }
    if (typeof output === 'number' && Number.isFinite(output) && output > 0) {
      parsedLimit.output = Math.floor(output);
    }
    if (parsedLimit.context !== undefined || parsedLimit.output !== undefined) {
      entry.limit = parsedLimit;
    }
  }

  if (typeof value['tool_call'] === 'boolean') entry.tool_call = value['tool_call'];
  if (typeof value['reasoning'] === 'boolean') entry.reasoning = value['reasoning'];

  const reasoningMetadata = reasoningMetadataFromRecord(value, providerType, id);
  const supportEfforts = reasoningMetadata.efforts;
  if (supportEfforts !== undefined) entry.support_efforts = supportEfforts;
  if (entry.reasoning === undefined && reasoningMetadata.supported !== undefined) {
    entry.reasoning = reasoningMetadata.supported;
  }
  const defaultEffort = value['default_effort'];
  if (typeof defaultEffort === 'string' && defaultEffort.length > 0) {
    entry.default_effort = defaultEffort;
  }

  const modalities = value['modalities'];
  if (isRecord(modalities)) {
    const input = toStringArrayOrUndefined(modalities['input']);
    const output = toStringArrayOrUndefined(modalities['output']);
    if (input !== undefined || output !== undefined) {
      entry.modalities = {
        ...(input !== undefined ? { input } : {}),
        ...(output !== undefined ? { output } : {}),
      };
    }
  }

  return entry;
}

function toProviderEntry(value: unknown, registryKey: string): CustomRegistryProviderEntry | undefined {
  if (!isRecord(value)) return undefined;
  const rawId = value['id'];
  const id = typeof rawId === 'string' && rawId.trim().length > 0 ? rawId.trim() : registryKey.trim();
  const rawName = value['name'];
  const name = typeof rawName === 'string' && rawName.trim().length > 0 ? rawName.trim() : id;
  const api = normalizeApiBaseUrl(value['api'] ?? value['base_url'] ?? value['baseUrl']);
  const type = normalizeProviderType(value['type'] ?? value['protocol']);
  const models = value['models'];

  if (id.length === 0 || api === undefined || type === undefined || !isRecord(models)) {
    return undefined;
  }

  const parsedModels: Record<string, CustomRegistryModelEntry> = {};
  for (const [key, raw] of Object.entries(models)) {
    const modelEntry = toModelEntry(raw, key, type);
    if (modelEntry === undefined) continue;
    parsedModels[key] = modelEntry;
  }
  if (Object.keys(parsedModels).length === 0) return undefined;

  const env = toStringArrayOrUndefined(value['env']);
  const rawProject = value['project'];
  const project =
    typeof rawProject === 'string' && rawProject.trim().length > 0
      ? rawProject.trim()
      : undefined;
  const rawLocation = value['location'];
  const location =
    typeof rawLocation === 'string' && rawLocation.trim().length > 0
      ? rawLocation.trim()
      : undefined;

  return {
    id,
    name,
    api,
    type,
    ...(env !== undefined ? { env } : {}),
    ...(project !== undefined ? { project } : {}),
    ...(location !== undefined ? { location } : {}),
    models: parsedModels,
  };
}

/**
 * Fetches and validates an api.json document. The returned record is keyed by
 * the top-level provider key in the document (which may differ from
 * `entry.id`); callers should iterate `Object.values` to apply each entry.
 *
 * `userAgent` identifies the host product (e.g. `kimi-code-cli/1.2.3`); when
 * omitted the request falls back to the runtime default (`User-Agent: node`).
 */
export async function fetchCustomRegistry(
  source: CustomRegistrySource,
  options: FetchCustomRegistryOptions = {},
): Promise<Record<string, CustomRegistryProviderEntry>> {
  const { signal, fetchImpl = fetch, userAgent } = options;
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (userAgent !== undefined) {
    headers['User-Agent'] = userAgent;
  }
  if (source.apiKey.length > 0) {
    headers['Authorization'] = `Bearer ${source.apiKey}`;
  }

  const init: RequestInit = { headers };
  if (signal !== undefined) init.signal = signal;

  const response = await fetchImpl(source.url, init);
  if (!response.ok) {
    const message = await readApiErrorMessage(
      response,
      `Failed to fetch custom registry at ${source.url} (HTTP ${response.status}).`,
    );
    throw new CustomRegistryApiError(message, response.status);
  }

  const payload: unknown = await response.json();
  if (!isRecord(payload)) {
    throw new Error(
      `Unexpected custom registry response at ${source.url}: expected a JSON object keyed by provider id.`,
    );
  }

  const out: Record<string, CustomRegistryProviderEntry> = {};
  for (const [key, raw] of Object.entries(payload)) {
    const entry = toProviderEntry(raw, key);
    if (entry === undefined) {
      // Skip invalid/unknown provider entries instead of aborting the whole
      // fetch, mirroring `toModelEntry`'s skip-on-invalid behavior. This keeps
      // existing providers working when kokub adds a new provider type that
      // this client doesn't yet recognize.
      console.warn(
        `[custom-registry] Skipping invalid entry "${key}" at ${source.url}: missing required fields or unsupported type (id, name, api, type, models).`,
      );
      continue;
    }
    out[key] = entry;
  }

  if (Object.keys(out).length === 0) {
    throw new Error(
      `Custom registry at ${source.url} did not contain any supported providers with a valid API URL and at least one model.`,
    );
  }

  return out;
}

/**
 * Derives kosong capability strings from the rich (optional) fields on a
 * custom-registry model entry. Returns an empty array when none of the rich
 * fields are present; callers are responsible for substituting the default
 * (`CUSTOM_REGISTRY_DEFAULT_CAPABILITIES`) when this returns `[]`.
 */
export function capabilitiesFromCustomEntry(model: CustomRegistryModelEntry): string[] {
  const caps = new Set<string>();
  if (model.tool_call === true) caps.add('tool_use');
  // Declaring concrete effort levels implies thinking support even when the
  // legacy `reasoning` boolean is absent.
  if (model.reasoning === true || (model.support_efforts?.length ?? 0) > 0) {
    caps.add('thinking');
  }
  if (model.modalities?.input?.includes('image') === true) caps.add('image_in');
  if (model.modalities?.input?.includes('video') === true) caps.add('video_in');
  if (model.modalities?.output?.includes('image') === true) caps.add('image_out');
  if (model.modalities?.output?.includes('audio') === true) caps.add('audio_out');
  return [...caps];
}

function hasRichCapabilityHints(model: CustomRegistryModelEntry): boolean {
  return (
    typeof model.tool_call === 'boolean' ||
    typeof model.reasoning === 'boolean' ||
    model.modalities !== undefined ||
    model.support_efforts !== undefined
  );
}

function resolveMaxContextSize(model: CustomRegistryModelEntry): number {
  const context = model.limit?.context;
  if (typeof context === 'number' && Number.isInteger(context) && context > 0) {
    return context;
  }
  // Output-token limits are not context-window limits. Treating a common
  // 4K/8K output limit as the total context makes compaction happen far too
  // early for otherwise large-context third-party models.
  return CUSTOM_REGISTRY_DEFAULT_MAX_CONTEXT;
}

function resolveCapabilities(model: CustomRegistryModelEntry): string[] {
  if (hasRichCapabilityHints(model)) {
    return capabilitiesFromCustomEntry(model);
  }
  return [...CUSTOM_REGISTRY_DEFAULT_CAPABILITIES];
}

/**
 * Writes one custom-registry provider entry into the managed config in place.
 * Mirrors `applyOpenPlatformConfig`'s shape: provider goes to `config.providers`
 * keyed by `entry.id`, each model in `entry.models` becomes an alias under
 * `config.models[\`${entry.id}/${modelId}\`]`. The `source` blob is parked on the
 * provider object via `ManagedKimiProviderConfig`'s index signature so the
 * refresh dispatcher can rediscover it later.
 */
export function applyCustomRegistryProvider(
  config: ManagedKimiConfigShape,
  entry: CustomRegistryProviderEntry,
  source: CustomRegistrySource,
): void {
  const providerKey = entry.id;

  const usesVertexProjectAuth =
    entry.type === 'vertexai' && (entry.project !== undefined || entry.location !== undefined);
  config.providers[providerKey] = {
    type: entry.type,
    baseUrl: entry.api,
    // Vertex project/location authentication is mutually exclusive with API
    // keys in @google/genai. The registry key remains in `source` for refresh.
    ...(!usesVertexProjectAuth ? { apiKey: source.apiKey } : {}),
    ...(entry.type === 'vertexai' ? { vertexai: true } : {}),
    ...(entry.project !== undefined ? { project: entry.project } : {}),
    ...(entry.location !== undefined ? { location: entry.location } : {}),
    source,
  };

  const existingModels = config.models ?? {};
  // Selectively merge upstream models into the existing config so any fields
  // the user added by hand (or that upstream does not declare) survive a
  // refresh. Models that upstream no longer lists are removed; the rest are
  // merged field-by-field.
  const upstreamKeys = new Set(
    Object.keys(entry.models).map((modelKey) => `${providerKey}/${modelKey}`),
  );
  for (const [key, alias] of Object.entries(existingModels)) {
    if (isRecord(alias) && alias['provider'] === providerKey && !upstreamKeys.has(key)) {
      delete existingModels[key];
    }
  }

  for (const [modelKey, model] of Object.entries(entry.models)) {
    const aliasKey = `${providerKey}/${modelKey}`;
    const maxContextSize = resolveMaxContextSize(model);
    const capabilities = resolveCapabilities(model);
    const displayName =
      typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id;
    const existing = isRecord(existingModels[aliasKey]) ? existingModels[aliasKey] : {};

    const remoteAlias: ManagedKimiModelAlias = {
      provider: providerKey,
      model: model.id,
      maxContextSize,
      capabilities,
      ...(typeof model.reasoning === 'boolean'
        ? { thinkingSupport: model.reasoning || (model.support_efforts?.length ?? 0) > 0 }
        : (model.support_efforts?.length ?? 0) > 0
          ? { thinkingSupport: true }
          : {}),
      displayName,
      ...(model.support_efforts !== undefined ? { supportEfforts: model.support_efforts } : {}),
      ...(model.default_effort !== undefined ? { defaultEffort: model.default_effort } : {}),
    };
    existingModels[aliasKey] = mergeRefreshedModelAlias(
      existing,
      remoteAlias,
      CUSTOM_REGISTRY_MODEL_FIELDS,
    );
  }

  config.models = existingModels;
}

/**
 * Removes a custom-registry provider and every model alias that referenced it.
 * Clears `defaultModel` if it pointed at a removed alias. Mirrors
 * `removeOpenPlatformConfig`.
 */
export function removeCustomRegistryProvider(
  config: ManagedKimiConfigShape,
  providerId: string,
): void {
  delete config.providers[providerId];

  let removedDefault = false;
  const existingModels = config.models ?? {};
  for (const [key, alias] of Object.entries(existingModels)) {
    if (!isRecord(alias) || alias['provider'] !== providerId) continue;
    delete existingModels[key];
    if (config.defaultModel === key) removedDefault = true;
  }
  config.models = existingModels;

  if (removedDefault) {
    config.defaultModel = undefined;
  }

  if (config['defaultProvider'] === providerId) {
    config['defaultProvider'] = undefined;
  }
}

/**
 * Applies every entry from a single api.json import in memory. Mirrors the
 * "remove if present, then apply" sequence the Add Platform flow used to do
 * via the `removeProvider` RPC, but stays purely in-memory so callers can
 * persist the whole batch with a single write at the end.
 *
 * Bug fixed: previously the caller interleaved in-memory `applyCustomRegistry-
 * Provider` with the disk-writing `removeProvider` RPC inside a loop. Each
 * RPC re-read disk and returned a fresh config object, discarding entries that
 * had already been merged in-memory from earlier iterations. Re-importing a
 * multi-provider api.json silently lost N-1 of N providers.
 *
 * Re-import semantics: providers previously imported from the same source URL
 * but no longer present in `entries` are removed (along with their aliases and
 * any `defaultModel` pointing at them). Without this, deleting a provider
 * upstream and re-importing the registry leaves orphaned provider records and
 * model aliases behind. Matching is by `source.url` only — the apiKey commonly
 * rotates between imports, but the URL is the stable identity of "the same
 * registry".
 */
export function applyCustomRegistryEntries(
  config: ManagedKimiConfigShape,
  entries: Record<string, CustomRegistryProviderEntry>,
  source: CustomRegistrySource,
): void {
  const surviving = new Set(Object.values(entries).map((entry) => entry.id));
  for (const [providerId, provider] of Object.entries(config.providers)) {
    if (surviving.has(providerId)) continue;
    if (!isRecord(provider)) continue;
    const existingSource = provider['source'];
    if (
      isRecord(existingSource) &&
      existingSource['kind'] === 'apiJson' &&
      existingSource['url'] === source.url
    ) {
      removeCustomRegistryProvider(config, providerId);
    }
  }

  for (const entry of Object.values(entries)) {
    if (entry.id in config.providers) {
      removeCustomRegistryProvider(config, entry.id);
    }
    applyCustomRegistryProvider(config, entry, source);
  }
}
