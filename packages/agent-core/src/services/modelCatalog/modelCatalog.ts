import { createDecorator } from '../../di';
import { effectiveModelAlias, type KimiConfig, type ModelAlias, type ProviderConfig } from '../../config';
import {
  isOfficialKimiCodingEndpoint,
  OFFICIAL_KIMI_CODING_INPUT_CAPABILITIES,
} from '@nori-code/oauth';
import type {
  ModelCatalogItem,
  ProviderCatalogItem,
  RefreshOAuthProviderModelsResponse,
  RefreshProviderModelsResponse,
  SetDefaultModelResponse,
} from '@nori-code/protocol';

export type RefreshProviderModelsScope = 'all' | 'oauth';

export interface RefreshProviderModelsOptions {
  readonly scope?: RefreshProviderModelsScope;
  /** Refresh only this provider id. When set, `scope` is ignored. */
  readonly providerId?: string;
}

export interface IModelCatalogService {
  readonly _serviceBrand: undefined;

  listModels(): Promise<readonly ModelCatalogItem[]>;
  listProviders(): Promise<readonly ProviderCatalogItem[]>;
  getProvider(providerId: string): Promise<ProviderCatalogItem>;
  getProviderSecret(providerId: string): Promise<{ provider_id: string; api_key: string }>;
  removeProvider(providerId: string): Promise<{ deleted: true }>;
  testProvider(providerId: string): Promise<{ ok: boolean; message: string }>;
  setDefaultModel(modelId: string): Promise<SetDefaultModelResponse>;
  refreshOAuthProviderModels(): Promise<RefreshOAuthProviderModelsResponse>;
  refreshProviderModels(
    options?: RefreshProviderModelsOptions,
  ): Promise<RefreshProviderModelsResponse>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IModelCatalogService = createDecorator<IModelCatalogService>(
  'modelCatalogService',
);

export class ProviderNotFoundError extends Error {
  readonly providerId: string;

  constructor(providerId: string) {
    super(`provider ${providerId} does not exist`);
    this.name = 'ProviderNotFoundError';
    this.providerId = providerId;
  }
}

export class ModelNotFoundError extends Error {
  readonly modelId: string;

  constructor(modelId: string) {
    super(`model ${modelId} does not exist`);
    this.name = 'ModelNotFoundError';
    this.modelId = modelId;
  }
}

export function toProtocolModel(
  modelId: string,
  alias: ModelAlias,
  provider?: ProviderConfig,
): ModelCatalogItem {
  const effective = effectiveModelAlias(alias);
  const capabilities = new Set(effective.capabilities ?? []);
  if (isOfficialKimiCodingEndpoint(provider?.baseUrl)) {
    for (const capability of OFFICIAL_KIMI_CODING_INPUT_CAPABILITIES) {
      capabilities.add(capability);
    }
  }
  return {
    provider: effective.provider,
    provider_name: provider?.name ?? effective.provider,
    model: modelId,
    display_name: effective.displayName ?? effective.model,
    max_context_size: effective.maxContextSize,
    capabilities: capabilities.size > 0 ? [...capabilities] : undefined,
    supports_thinking: effective.thinkingSupport
      ?? (capabilities.has('thinking') || capabilities.has('always_thinking') ? true : undefined),
    support_efforts: effective.supportEfforts,
    default_effort: effective.defaultEffort,
  };
}

export interface ProviderCredentialState {
  readonly hasApiKey: boolean;
  readonly hasOAuthToken: boolean;
}

export function configuredApiKeyLength(provider: ProviderConfig): number | undefined {
  const inline = nonEmpty(provider.apiKey);
  if (inline !== undefined) return inline.length;
  const env = provider.env;
  if (env === undefined) return undefined;
  switch (provider.type) {
    case 'anthropic':
      return nonEmpty(env['ANTHROPIC_API_KEY'])?.length;
    case 'openai':
    case 'openai_responses':
      return nonEmpty(env['OPENAI_API_KEY'])?.length;
    case 'kimi':
      return nonEmpty(env['KIMI_API_KEY'])?.length;
    case 'google-genai':
      return nonEmpty(env['GOOGLE_API_KEY'])?.length;
    case 'vertexai': {
      const vertex = nonEmpty(env['VERTEXAI_API_KEY']);
      if (vertex !== undefined) return vertex.length;
      return nonEmpty(env['GOOGLE_API_KEY'])?.length;
    }
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function toProtocolProvider(
  providerId: string,
  provider: ProviderConfig,
  config: KimiConfig,
  credential: ProviderCredentialState,
): ProviderCatalogItem {
  const models = modelIdsForProvider(config, providerId);
  const defaultModel = provider.defaultModel ?? globalDefaultForProvider(config, providerId);
  const apiKeyLength = credential.hasApiKey ? configuredApiKeyLength(provider) : undefined;
  return {
    id: providerId,
    name: provider.name ?? providerId,
    type: provider.type,
    base_url: provider.baseUrl,
    default_model: defaultModel,
    has_api_key: credential.hasApiKey,
    api_key_length: apiKeyLength,
    status: provider.disabled
      ? 'error'
      : credential.hasApiKey || credential.hasOAuthToken ? 'connected' : 'unconfigured',
    disabled: provider.disabled,
    auto_discover: provider.autoDiscover,
    custom_models: provider.customModels,
    models,
  };
}

export function modelIdsForProvider(
  config: KimiConfig,
  providerId: string,
): string[] {
  const customModels = config.providers?.[providerId]?.customModels;
  if (customModels !== undefined) return [...customModels];
  const models = config.models ?? {};
  return Object.entries(models)
    .filter(([, alias]) => alias.provider === providerId)
    .map(([modelId]) => modelId);
}

function globalDefaultForProvider(
  config: KimiConfig,
  providerId: string,
): string | undefined {
  const defaultModel = config.defaultModel;
  if (defaultModel === undefined) return undefined;
  const alias = config.models?.[defaultModel];
  return alias?.provider === providerId ? defaultModel : undefined;
}

void IModelCatalogService;
