import { z } from 'zod';

import {
  ErrorCode,
  getProviderResponseSchema,
  listModelsResponseSchema,
  listProvidersResponseSchema,
  providerSecretResponseSchema,
  refreshProviderModelsResponseSchema,
  setDefaultModelResponseSchema,
  testProviderResponseSchema,
} from '@nori-code/protocol';
import { IModelCatalogService, ModelNotFoundError, ProviderNotFoundError, type IInstantiationService } from '@nori-code/agent-core';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { parseActionSuffix } from './action-suffix';

interface ModelCatalogRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  delete(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const providerIdParamSchema = z.object({
  provider_id: z.string().min(1),
});

const modelActionTailParamSchema = z.object({
  tail: z.string().min(1),
});

const providerActionTailParamSchema = z.object({
  tail: z.string().min(1),
});

const providerCollectionActionParamSchema = z.object({
  action: z.string().min(1),
});

const providerPresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['anthropic', 'openai', 'kimi', 'google-genai', 'openai_responses', 'vertexai']),
  base_url: z.string().optional(),
  env: z.array(z.string()),
  model_count: z.number().int().nonnegative(),
});

const providerPresetsResponseSchema = z.object({
  items: z.array(providerPresetSchema),
  source: z.string(),
  warning: z.string().optional(),
});

const PROVIDER_PRESET_SOURCE = 'https://models.dev/api.json';

type ProviderWireType = 'anthropic' | 'openai' | 'kimi' | 'google-genai' | 'openai_responses' | 'vertexai';

function inferPresetWire(entry: Record<string, unknown>): ProviderWireType | undefined {
  const explicit = typeof entry['type'] === 'string' ? entry['type'] : '';
  if (['anthropic', 'openai', 'kimi', 'google-genai', 'openai_responses', 'vertexai'].includes(explicit)) {
    return explicit as ProviderWireType;
  }
  const hint = [entry['id'], entry['name'], entry['npm']].filter((value): value is string => typeof value === 'string').join(' ').toLowerCase();
  if (hint.includes('anthropic') || hint.includes('claude')) return 'anthropic';
  if (hint.includes('vertex')) return 'vertexai';
  if (hint.includes('google') || hint.includes('gemini')) return 'google-genai';
  if (hint.includes('openai')) return 'openai';
  return undefined;
}

export function normalizeProviderPresets(payload: unknown) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return [];
  const presets = [] as Array<z.infer<typeof providerPresetSchema>>;
  for (const [catalogId, value] of Object.entries(payload)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const type = inferPresetWire({ ...entry, id: typeof entry['id'] === 'string' ? entry['id'] : catalogId });
    if (type === undefined) continue;
    const rawApi = typeof entry['api'] === 'string' && entry['api'].length > 0 ? entry['api'] : undefined;
    const baseUrl = type === 'anthropic' ? rawApi?.replace(/\/v1\/?$/, '') : rawApi;
    const models = typeof entry['models'] === 'object' && entry['models'] !== null && !Array.isArray(entry['models'])
      ? Object.values(entry['models']).filter((model) => {
          if (typeof model !== 'object' || model === null || Array.isArray(model)) return false;
          const record = model as Record<string, unknown>;
          const id = typeof record['id'] === 'string' ? record['id'].toLowerCase() : '';
          const output = (record['modalities'] as Record<string, unknown> | undefined)?.['output'];
          return !id.includes('embed') && (!Array.isArray(output) || output.includes('text'));
        })
      : [];
    presets.push({
      id: typeof entry['id'] === 'string' && entry['id'].length > 0 ? entry['id'] : catalogId,
      name: typeof entry['name'] === 'string' && entry['name'].length > 0 ? entry['name'] : catalogId,
      type,
      ...(baseUrl ? { base_url: baseUrl } : {}),
      env: Array.isArray(entry['env']) ? entry['env'].filter((item): item is string => typeof item === 'string') : [],
      model_count: models.length,
    });
  }
  return presets.sort((a, b) => a.name.localeCompare(b.name));
}

export function registerModelCatalogRoutes(
  app: ModelCatalogRouteHost,
  ix: IInstantiationService,
): void {
  const listModelsRoute = defineRoute(
    {
      method: 'GET',
      path: '/models',
      success: { data: listModelsResponseSchema },
      description: 'List configured model aliases',
      tags: ['models'],
    },
    async (req, reply) => {
      const items = await ix.invokeFunction((a) =>
        a.get(IModelCatalogService).listModels(),
      );
      reply.send(okEnvelope({ items }, req.id));
    },
  );
  app.get(
    listModelsRoute.path,
    listModelsRoute.options,
    listModelsRoute.handler as Parameters<ModelCatalogRouteHost['get']>[2],
  );

  const providerPresetsRoute = defineRoute(
    {
      method: 'GET',
      path: '/provider-presets',
      success: { data: providerPresetsResponseSchema },
      description: 'List online provider presets from models.dev',
      tags: ['providers'],
    },
    async (req, reply) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch(PROVIDER_PRESET_SOURCE, {
          headers: { Accept: 'application/json', 'User-Agent': 'nori-work' },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const items = normalizeProviderPresets(await response.json());
        reply.send(okEnvelope({ items, source: PROVIDER_PRESET_SOURCE }, req.id));
      } catch (error) {
        const warning = error instanceof Error ? error.message : String(error);
        reply.send(okEnvelope({ items: [], source: PROVIDER_PRESET_SOURCE, warning }, req.id));
      } finally {
        clearTimeout(timeout);
      }
    },
  );
  app.get(
    providerPresetsRoute.path,
    providerPresetsRoute.options,
    providerPresetsRoute.handler as Parameters<ModelCatalogRouteHost['get']>[2],
  );

  const setDefaultModelRoute = defineRoute(
    {
      method: 'POST',
      path: '/models/{tail}',
      params: modelActionTailParamSchema,
      success: { data: setDefaultModelResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.MODEL_NOT_FOUND]: {},
      },
      description: 'Set the global default model alias',
      tags: ['models'],
      operationId: 'setDefaultModel',
    },
    async (req, reply) => {
      try {
        const { tail } = req.params;
        const parsed = parseActionSuffix({
          tail,
          allowedActions: ['set_default'] as const,
          resourceLabel: 'model',
        });
        if (parsed.kind !== 'action') {
          const message = parsed.kind === 'invalid'
            ? parsed.reason
            : `unsupported action: ${tail}`;
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, message, req.id));
          return;
        }
        const result = await ix.invokeFunction((a) =>
          a.get(IModelCatalogService).setDefaultModel(parsed.id),
        );
        reply.send(okEnvelope(result, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.post(
    setDefaultModelRoute.path,
    setDefaultModelRoute.options,
    setDefaultModelRoute.handler as Parameters<ModelCatalogRouteHost['post']>[2],
  );

  const listProvidersRoute = defineRoute(
    {
      method: 'GET',
      path: '/providers',
      success: { data: listProvidersResponseSchema },
      description: 'List configured providers',
      tags: ['providers'],
    },
    async (req, reply) => {
      const items = await ix.invokeFunction((a) =>
        a.get(IModelCatalogService).listProviders(),
      );
      reply.send(okEnvelope({ items }, req.id));
    },
  );
  app.get(
    listProvidersRoute.path,
    listProvidersRoute.options,
    listProvidersRoute.handler as Parameters<ModelCatalogRouteHost['get']>[2],
  );

  // Collection-level refresh actions share a single `/providers:<action>` route
  // because Fastify's router collapses every one-segment `/providers:xxx` path
  // onto one parameter slot (so `/providers:refresh` and `/providers:refresh_oauth`
  // cannot be registered separately). We dispatch on the captured action instead.
  const refreshProvidersRoute = defineRoute(
    {
      method: 'POST',
      path: '/providers:action',
      params: providerCollectionActionParamSchema,
      success: { data: z.union([refreshProviderModelsResponseSchema, testProviderResponseSchema]) },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
      },
      description:
        'Refresh provider model metadata. Use `:refresh` for all providers or `:refresh_oauth` for OAuth-backed providers only.',
      tags: ['providers'],
      operationId: 'refreshProviders',
    },
    async (req, reply) => {
      const raw = req.params.action;
      const action = raw.startsWith(':') ? raw.slice(1) : raw;
      if (action === 'refresh_oauth') {
        const result = await ix.invokeFunction((a) =>
          a.get(IModelCatalogService).refreshOAuthProviderModels(),
        );
        reply.send(okEnvelope(result, req.id));
        return;
      }
      if (action === 'refresh') {
        const result = await ix.invokeFunction((a) =>
          a.get(IModelCatalogService).refreshProviderModels({ scope: 'all' }),
        );
        reply.send(okEnvelope(result, req.id));
        return;
      }
      reply.send(
        errEnvelope(ErrorCode.VALIDATION_FAILED, `unsupported action: ${raw}`, req.id),
      );
    },
  );
  app.post(
    refreshProvidersRoute.path,
    refreshProvidersRoute.options,
    refreshProvidersRoute.handler as Parameters<ModelCatalogRouteHost['post']>[2],
  );

  const refreshProviderRoute = defineRoute(
    {
      method: 'POST',
      path: '/providers/{tail}',
      params: providerActionTailParamSchema,
      success: { data: z.union([refreshProviderModelsResponseSchema, testProviderResponseSchema]) },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.PROVIDER_NOT_FOUND]: {},
      },
      description: 'Refresh model metadata for a single provider',
      tags: ['providers'],
      operationId: 'refreshProvider',
    },
    async (req, reply) => {
      try {
        const { tail } = req.params;
        const parsed = parseActionSuffix({
          tail,
          allowedActions: ['refresh', 'test'] as const,
          resourceLabel: 'provider',
        });
        if (parsed.kind !== 'action') {
          const message = parsed.kind === 'invalid'
            ? parsed.reason
            : `unsupported action: ${tail}`;
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, message, req.id));
          return;
        }
        const result = parsed.action === 'test'
          ? await ix.invokeFunction((a) => a.get(IModelCatalogService).testProvider(parsed.id))
          : await ix.invokeFunction((a) => a.get(IModelCatalogService).refreshProviderModels({ providerId: parsed.id }));
        reply.send(okEnvelope(result, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.post(
    refreshProviderRoute.path,
    refreshProviderRoute.options,
    refreshProviderRoute.handler as Parameters<ModelCatalogRouteHost['post']>[2],
  );

  const getProviderRoute = defineRoute(
    {
      method: 'GET',
      path: '/providers/{provider_id}',
      params: providerIdParamSchema,
      success: { data: getProviderResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.PROVIDER_NOT_FOUND]: {},
      },
      description: 'Get a configured provider by ID',
      tags: ['providers'],
    },
    async (req, reply) => {
      try {
        const { provider_id } = req.params;
        const provider = await ix.invokeFunction((a) =>
          a.get(IModelCatalogService).getProvider(provider_id),
        );
        reply.send(okEnvelope(provider, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.get(
    getProviderRoute.path,
    getProviderRoute.options,
    getProviderRoute.handler as Parameters<ModelCatalogRouteHost['get']>[2],
  );

  const providerSecretRoute = defineRoute(
    {
      method: 'GET',
      path: '/providers/{provider_id}/secret',
      params: providerIdParamSchema,
      success: { data: providerSecretResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.PROVIDER_NOT_FOUND]: {},
      },
      description: 'Read a configured provider API key for local UI use',
      tags: ['providers'],
    },
    async (req, reply) => {
      try {
        const { provider_id } = req.params;
        const secret = await ix.invokeFunction((a) => a.get(IModelCatalogService).getProviderSecret(provider_id));
        reply.send(okEnvelope(secret, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.get(
    providerSecretRoute.path,
    providerSecretRoute.options,
    providerSecretRoute.handler as Parameters<ModelCatalogRouteHost['get']>[2],
  );

  const removeProviderRoute = defineRoute(
    {
      method: 'DELETE',
      path: '/providers/{provider_id}',
      params: providerIdParamSchema,
      success: { data: z.object({ deleted: z.literal(true) }) },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.PROVIDER_NOT_FOUND]: {},
      },
      description: 'Delete a configured provider',
      tags: ['providers'],
    },
    async (req, reply) => {
      try {
        const { provider_id } = req.params;
        const result = await ix.invokeFunction((a) => a.get(IModelCatalogService).removeProvider(provider_id));
        reply.send(okEnvelope(result, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.delete(
    removeProviderRoute.path,
    removeProviderRoute.options,
    removeProviderRoute.handler as Parameters<ModelCatalogRouteHost['delete']>[2],
  );
}

function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): void {
  if (err instanceof ProviderNotFoundError) {
    const error = err as ProviderNotFoundError;
    reply.send(errEnvelope(ErrorCode.PROVIDER_NOT_FOUND, error.message, requestId));
    return;
  }
  if (err instanceof ModelNotFoundError) {
    const error = err as ModelNotFoundError;
    reply.send(errEnvelope(ErrorCode.MODEL_NOT_FOUND, error.message, requestId));
    return;
  }
  throw err;
}
