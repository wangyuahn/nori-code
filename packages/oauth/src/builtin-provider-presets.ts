/**
 * Built-in provider templates for Nori Code / Nori Work.
 *
 * These are copy-on-add templates, not live config. `nori-workspace/presets/`
 * is a DSH agent-preset experiment and is intentionally not used here.
 */

export const MODELS_DEV_CATALOG_URL = 'https://models.dev/api.json';

export type BuiltinProviderAuth = 'api_key' | 'none';

export type BuiltinProviderType =
  | 'anthropic'
  | 'openai'
  | 'kimi'
  | 'google-genai'
  | 'openai_responses'
  | 'vertexai';

export interface BuiltinProviderPreset {
  readonly id: string;
  readonly name: string;
  readonly type: BuiltinProviderType;
  readonly baseUrl?: string;
  readonly env: readonly string[];
  readonly auth: BuiltinProviderAuth;
  readonly requiredFields: readonly string[];
  readonly defaultModel?: string;
  readonly catalogId?: string;
  readonly builtin: true;
}

export const BUILTIN_PROVIDER_PRESETS: readonly BuiltinProviderPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    env: ['OPENAI_API_KEY'],
    auth: 'api_key',
    requiredFields: ['api_key'],
    catalogId: 'openai',
    builtin: true,
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    type: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    env: ['ANTHROPIC_API_KEY'],
    auth: 'api_key',
    requiredFields: ['api_key'],
    catalogId: 'anthropic',
    builtin: true,
  },
  {
    id: 'google',
    name: 'Google Gemini',
    type: 'google-genai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    env: ['GOOGLE_API_KEY'],
    auth: 'api_key',
    requiredFields: ['api_key'],
    catalogId: 'google',
    builtin: true,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    type: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    env: ['OPENROUTER_API_KEY'],
    auth: 'api_key',
    requiredFields: ['api_key'],
    catalogId: 'openrouter',
    builtin: true,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'openai',
    baseUrl: 'https://api.deepseek.com',
    env: ['DEEPSEEK_API_KEY'],
    auth: 'api_key',
    requiredFields: ['api_key'],
    defaultModel: 'deepseek-chat',
    catalogId: 'deepseek',
    builtin: true,
  },
  {
    id: 'groq',
    name: 'Groq',
    type: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    env: ['GROQ_API_KEY'],
    auth: 'api_key',
    requiredFields: ['api_key'],
    catalogId: 'groq',
    builtin: true,
  },
  {
    id: 'together',
    name: 'Together AI',
    type: 'openai',
    baseUrl: 'https://api.together.xyz/v1',
    env: ['TOGETHER_API_KEY'],
    auth: 'api_key',
    requiredFields: ['api_key'],
    catalogId: 'togetherai',
    builtin: true,
  },
  {
    id: 'fireworks',
    name: 'Fireworks',
    type: 'openai',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    env: ['FIREWORKS_API_KEY'],
    auth: 'api_key',
    requiredFields: ['api_key'],
    catalogId: 'fireworks-ai',
    builtin: true,
  },
  {
    id: 'mistral',
    name: 'Mistral',
    type: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    env: ['MISTRAL_API_KEY'],
    auth: 'api_key',
    requiredFields: ['api_key'],
    catalogId: 'mistral',
    builtin: true,
  },
  {
    id: 'xai',
    name: 'xAI',
    type: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    env: ['XAI_API_KEY'],
    auth: 'api_key',
    requiredFields: ['api_key'],
    catalogId: 'xai',
    builtin: true,
  },
  {
    id: 'moonshot',
    name: 'Moonshot',
    type: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    env: ['MOONSHOT_API_KEY'],
    auth: 'api_key',
    requiredFields: ['api_key'],
    catalogId: 'moonshotai-cn',
    builtin: true,
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    type: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    env: ['SILICONFLOW_API_KEY'],
    auth: 'api_key',
    requiredFields: ['api_key'],
    catalogId: 'siliconflow',
    builtin: true,
  },
  {
    id: 'zhipu',
    name: 'Zhipu GLM',
    type: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    env: ['ZHIPU_API_KEY'],
    auth: 'api_key',
    requiredFields: ['api_key'],
    catalogId: 'zhipuai',
    builtin: true,
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    type: 'openai',
    baseUrl: 'https://api.minimax.chat/v1',
    env: ['MINIMAX_API_KEY'],
    auth: 'api_key',
    requiredFields: ['api_key'],
    catalogId: 'minimax',
    builtin: true,
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    type: 'openai',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    env: ['NVIDIA_API_KEY'],
    auth: 'api_key',
    requiredFields: ['api_key'],
    catalogId: 'nvidia',
    builtin: true,
  },
  {
    id: 'dashscope',
    name: 'DashScope',
    type: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    env: ['DASHSCOPE_API_KEY'],
    auth: 'api_key',
    requiredFields: ['api_key'],
    catalogId: 'alibaba',
    builtin: true,
  },
  {
    id: 'ollama',
    name: 'Ollama',
    type: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    env: [],
    auth: 'none',
    requiredFields: [],
    catalogId: 'ollama',
    builtin: true,
  },
];

export interface WireProviderPreset {
  readonly id: string;
  readonly name: string;
  readonly type: BuiltinProviderType;
  readonly base_url?: string;
  readonly env: readonly string[];
  readonly model_count: number;
  readonly builtin?: boolean;
  readonly auth?: BuiltinProviderAuth;
  readonly required_fields?: readonly string[];
  readonly default_model?: string;
  readonly catalog_id?: string;
}

export function toWireProviderPreset(
  preset: BuiltinProviderPreset,
  modelCount = 0,
): WireProviderPreset {
  return {
    id: preset.id,
    name: preset.name,
    type: preset.type,
    ...(preset.baseUrl !== undefined ? { base_url: preset.baseUrl } : {}),
    env: [...preset.env],
    model_count: modelCount,
    builtin: true,
    auth: preset.auth,
    required_fields: [...preset.requiredFields],
    ...(preset.defaultModel !== undefined ? { default_model: preset.defaultModel } : {}),
    ...(preset.catalogId !== undefined ? { catalog_id: preset.catalogId } : {}),
  };
}

export function mergeProviderPresetLists(
  builtin: readonly WireProviderPreset[],
  online: readonly WireProviderPreset[],
): WireProviderPreset[] {
  const seen = new Set(builtin.map(item => item.id));
  const extras = online.filter(item => !seen.has(item.id));
  return [...builtin, ...extras];
}

export function uniqueCopiedProviderId(baseId: string, existingIds: readonly string[]): string {
  const normalized = baseId.trim() || 'provider';
  if (!existingIds.includes(normalized)) return normalized;
  let suffix = 2;
  while (existingIds.includes(`${normalized}-${String(suffix)}`)) suffix += 1;
  return `${normalized}-${String(suffix)}`;
}
