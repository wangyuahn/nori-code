import { useCallback, useEffect, useState } from 'react';

import { api, type ModelCatalogItem, type ProviderCatalogItem, type ProviderPreset, type ProviderRefreshResult, type ProviderTestResponse } from '../api/client';
import { useI18n } from '../i18n';
import {
  COMMON_THINKING_EFFORTS,
  customModelAliasPatch,
  customModelIds,
  emptyCustomModelDraft,
  parseCustomModelDrafts,
  validateCustomModelDrafts,
  type CustomModelDraft,
  type CustomModelThinkingMode,
} from '../utils/custom-model-effort';
import {
  draftFromProviderPreset,
  formatProviderRefreshNotice,
  providerSourcePatch,
} from '../utils/provider-presets';
import { Icon } from './Icon';

type ProviderType = ProviderPreset['type'];

const API_FORMATS: Array<{ value: ProviderType; label: string }> = [
  { value: 'openai', label: 'OpenAI Chat Completions' },
  { value: 'openai_responses', label: 'OpenAI Responses' },
  { value: 'anthropic', label: 'Anthropic Messages' },
  { value: 'google-genai', label: 'Google Gemini' },
  { value: 'vertexai', label: 'Vertex AI' },
];

interface ProviderDraft {
  originalId: string | null;
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey: string;
  autoDiscover: boolean;
  customModels: CustomModelDraft[];
  disabled: boolean;
  requiresApiKey: boolean;
  catalogId?: string;
  fromPreset: boolean;
}

const EMPTY_DRAFT: ProviderDraft = {
  originalId: null,
  id: '',
  name: '',
  type: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  autoDiscover: true,
  customModels: [emptyCustomModelDraft()],
  disabled: false,
  requiresApiKey: false,
  fromPreset: false,
};

export function ProviderSettings() {
  const { tr } = useI18n();
  const [providers, setProviders] = useState<ProviderCatalogItem[]>([]);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [presetWarning, setPresetWarning] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [secretLoaded, setSecretLoaded] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [providerResult, presetResult] = await Promise.all([
        api.providers.list(),
        api.providerPresets.list().catch(() => ({ items: [] as ProviderPreset[], source: 'builtin', warning: undefined })),
      ]);
      setProviders(providerResult.items);
      setPresets(presetResult.items);
      setPresetWarning(presetResult.warning ?? null);
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : tr('Failed to load providers', '加载 Provider 失败'), error: true });
    } finally {
      setLoading(false);
    }
  }, [tr]);

  useEffect(() => { void load(); }, [load]);

  const openProvider = async (provider: ProviderCatalogItem) => {
    setExpandedId(provider.id);
    setShowApiKey(false);
    setSecretLoaded(false);
    setNotice(null);
    let aliases: Record<string, unknown> | undefined;
    try {
      const config = await api.getConfig();
      aliases = config.models;
    } catch {
      aliases = undefined;
    }
    setDraft({
      originalId: provider.id,
      id: provider.id,
      name: provider.name === provider.id ? '' : provider.name ?? '',
      type: isProviderType(provider.type) ? provider.type : 'openai',
      baseUrl: provider.base_url ?? '',
      apiKey: '',
      autoDiscover: provider.auto_discover !== false,
      customModels: parseCustomModelDrafts(provider.custom_models ?? [], aliases, provider.id),
      disabled: provider.disabled === true,
      requiresApiKey: false,
      fromPreset: false,
    });
  };

  const openNewProvider = () => {
    setExpandedId('__new__');
    setDraft({ ...EMPTY_DRAFT, customModels: [emptyCustomModelDraft()] });
    setShowApiKey(false);
    setSecretLoaded(false);
    setNotice(null);
  };

  const openPreset = (preset: ProviderPreset) => {
    const copied = draftFromProviderPreset(preset, providers.map(item => item.id));
    setExpandedId('__new__');
    setDraft({
      originalId: null,
      ...copied,
    });
    setShowApiKey(false);
    setSecretLoaded(false);
    setNotice({
      text: copied.requiresApiKey
        ? tr(`Copied “${preset.name}”. Fill in the API key, then save to fetch models.`, `已复制“${preset.name}”。请填写 API Key，保存后会自动获取模型。`)
        : tr(`Copied “${preset.name}”. Review the Base URL, then save to fetch models.`, `已复制“${preset.name}”。请确认 Base URL，保存后会自动获取模型。`),
    });
  };

  const closeEditor = () => {
    setExpandedId(null);
    setDraft(null);
    setShowApiKey(false);
    setSecretLoaded(false);
  };

  const updateDraft = <K extends keyof ProviderDraft>(key: K, value: ProviderDraft[K]) => {
    setDraft(previous => previous === null ? previous : { ...previous, [key]: value });
  };

  const revealApiKey = async () => {
    if (!draft || draft.originalId === null || secretLoaded) {
      setShowApiKey(previous => !previous);
      return;
    }
    try {
      const result = await api.providers.secret(draft.originalId);
      updateDraft('apiKey', result.api_key);
      setSecretLoaded(true);
      setShowApiKey(true);
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : tr('Failed to read API key', '读取 API Key 失败'), error: true });
    }
  };

  const copyApiKey = async () => {
    if (!draft) return;
    if (!secretLoaded && draft.originalId !== null) {
      try {
        const result = await api.providers.secret(draft.originalId);
        updateDraft('apiKey', result.api_key);
        setSecretLoaded(true);
        await navigator.clipboard.writeText(result.api_key);
        setNotice({ text: tr('API key copied', 'API Key 已复制') });
        return;
      } catch (error) {
        setNotice({ text: error instanceof Error ? error.message : tr('Failed to copy API key', '复制 API Key 失败'), error: true });
        return;
      }
    }
    if (!draft.apiKey) return;
    await navigator.clipboard.writeText(draft.apiKey);
    setNotice({ text: tr('API key copied', 'API Key 已复制') });
  };

  const saveProvider = async () => {
    if (!draft) return;
    const id = draft.id.trim();
    const customModels = customModelIds(draft.customModels);
    if (!id) {
      setNotice({ text: tr('Provider ID is required', '必须填写 Provider ID'), error: true });
      return;
    }
    if (draft.requiresApiKey && !draft.apiKey.trim() && draft.originalId === null) {
      setNotice({ text: tr('This template needs an API key before it can fetch models.', '该模板需要先填写 API Key 才能获取模型。'), error: true });
      return;
    }
    if (!draft.autoDiscover) {
      const invalid = validateCustomModelDrafts(draft.customModels);
      if (invalid !== undefined) {
        setNotice({ text: tr(invalid, invalid === 'Add at least one custom model when automatic discovery is disabled.' ? '关闭自动获取模型后至少填写一个自定义模型。' : invalid), error: true });
        return;
      }
    }
    setSaving(true);
    setNotice(null);
    try {
      const providerPatch: Record<string, unknown> = {
        type: draft.type,
        name: draft.name.trim() || id,
        base_url: draft.baseUrl.trim(),
        disabled: draft.disabled,
        auto_discover: draft.autoDiscover,
        custom_models: providerCustomModelsForPatch(draft.autoDiscover, customModels),
      };
      if (draft.apiKey.trim()) providerPatch.api_key = draft.apiKey.trim();
      const source = providerSourcePatch(draft.catalogId);
      if (source !== undefined) providerPatch.source = source;

      const models: Record<string, unknown> = {};
      const currentConfig = await api.getConfig();
      const previousProviderId = draft.originalId ?? id;
      if (!draft.autoDiscover) {
        for (const [modelId, alias] of Object.entries(currentConfig.models ?? {})) {
          if (isModelAliasRecord(alias) && alias.provider === previousProviderId) {
            models[modelId] = null;
          }
        }
        for (const customModel of draft.customModels) {
          const aliasId = customModel.id.trim();
          if (!aliasId) continue;
          const existing = asRecord(currentConfig.models?.[`${previousProviderId}/${aliasId}`] ?? currentConfig.models?.[`${id}/${aliasId}`]);
          const patch = customModelAliasPatch(id, customModel, existing);
          if (patch !== undefined) models[`${id}/${aliasId}`] = patch;
        }
      }
      const updatedConfig = await api.updateConfig({ providers: { [id]: providerPatch }, ...(Object.keys(models).length > 0 ? { models } : {}) });
      if (draft.originalId !== null && draft.originalId !== id) await api.providers.remove(draft.originalId);
      if (draft.autoDiscover && !draft.disabled) {
        const result = await api.providers.refresh(id);
        if (isProviderRefreshResult(result)) {
          const formatted = formatProviderRefreshNotice(result);
          setNotice({
            text: formatted.error
              ? tr('Provider saved, but model discovery failed: ', 'Provider 已保存，但获取模型失败：') + (result.failed[0]?.reason ?? formatted.text)
              : tr(formatted.text, formatted.text.includes('updated') ? `Provider 已保存并刷新模型列表（${String(result.changed.length)} 个更新）。` : 'Provider 已保存并刷新模型列表'),
            error: formatted.error,
          });
        } else {
          setNotice({ text: tr('Provider saved; refresh returned no details.', 'Provider 已保存，但刷新接口没有返回详细结果。') });
        }
      } else {
        setNotice({ text: tr('Provider saved', 'Provider 已保存') });
      }
      const modelCatalog = await api.models.list();
      const fallbackDefault = defaultModelAfterProviderSave(updatedConfig.default_model, modelCatalog.items, id);
      if (fallbackDefault !== undefined) await api.models.setDefault(fallbackDefault);
      await load();
      window.dispatchEvent(new CustomEvent('nori:model-catalog-changed'));
      setExpandedId(id);
      setDraft(previous => previous ? { ...previous, originalId: id, apiKey: '', fromPreset: false, requiresApiKey: false } : previous);
      setSecretLoaded(false);
      setShowApiKey(false);
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : tr('Failed to save provider', '保存 Provider 失败'), error: true });
    } finally {
      setSaving(false);
    }
  };

  const testProvider = async (provider: ProviderCatalogItem) => {
    setBusyId(provider.id);
    setNotice(null);
    try {
      const result = await api.providers.test(provider.id);
      const message = isProviderTestResponse(result)
        ? result.message
        : refreshFailures(result)[0]?.reason ?? tr('Provider is ready', 'Provider 可用');
      setNotice({ text: message, error: isProviderTestResponse(result) ? !result.ok : refreshFailures(result).length > 0 });
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : tr('Provider test failed', 'Provider 测试失败'), error: true });
    } finally {
      setBusyId(null);
    }
  };

  const toggleDisabled = async (provider: ProviderCatalogItem) => {
    setBusyId(provider.id);
    try {
      await api.updateConfig({ providers: { [provider.id]: { disabled: provider.disabled !== true } } });
      await load();
      window.dispatchEvent(new CustomEvent('nori:model-catalog-changed'));
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : tr('Failed to update provider', '更新 Provider 失败'), error: true });
    } finally {
      setBusyId(null);
    }
  };

  const deleteProvider = async (provider: ProviderCatalogItem) => {
    if (!window.confirm(tr(`Delete provider “${provider.name ?? provider.id}”?`, `确定删除 Provider“${provider.name ?? provider.id}”吗？`))) return;
    setBusyId(provider.id);
    try {
      await api.providers.remove(provider.id);
      if (expandedId === provider.id) closeEditor();
      await load();
      window.dispatchEvent(new CustomEvent('nori:model-catalog-changed'));
      setNotice({ text: tr('Provider deleted', 'Provider 已删除') });
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : tr('Failed to delete provider', '删除 Provider 失败'), error: true });
    } finally {
      setBusyId(null);
    }
  };

  const builtinPresets = presets.filter(preset => preset.builtin === true);
  const onlinePresets = presets.filter(preset => preset.builtin !== true).slice(0, 24);

  return <div className="provider-settings">
    <header className="provider-settings-heading">
      <div><span>Provider</span><h2>{tr('Model providers', '模型供应商')}</h2><p>{tr('Manage API connections, discovery, custom models, thinking effort, and credentials in one place.', '统一管理 API 连接、模型获取、自定义模型、推理强度和凭据。')}</p></div>
      <button type="button" className="btn btn-primary btn-compact" onClick={openNewProvider}><Icon name="plus" size={14}/>{tr('Add provider', '新增供应商')}</button>
    </header>
    {notice && <div className={`settings-notice provider-notice${notice.error ? ' error' : ''}`}><Icon name={notice.error ? 'alert' : 'check'} size={16}/><span>{notice.text}</span></div>}
    {builtinPresets.length > 0 && <section className="provider-presets" aria-label={tr('Provider templates', '供应商模板')}>
      <div className="provider-presets-copy"><strong>{tr('Add from template', '从模板添加')}</strong><span>{tr('Copies a built-in preset. API key stays empty until you fill it in.', '复制内置模板，API Key 需自行填写，不会改动内置项。')}</span></div>
      <div className="provider-preset-grid">
        {builtinPresets.map(preset => <button type="button" className="provider-preset" key={preset.id} onClick={() => openPreset(preset)}>
          <strong>{preset.name}</strong>
          <small>{preset.base_url ?? preset.type}</small>
          <em>{presetRequiresKeyLabel(preset, tr)}</em>
        </button>)}
      </div>
      {presetWarning && <p className="provider-preset-warning">{tr('Online catalog unavailable: ', '在线目录不可用：')}{presetWarning}</p>}
      {onlinePresets.length > 0 && <details className="provider-preset-more">
        <summary>{tr('More from models.dev', '更多来自 models.dev')}</summary>
        <div className="provider-preset-grid">
          {onlinePresets.map(preset => <button type="button" className="provider-preset" key={preset.id} onClick={() => openPreset(preset)}>
            <strong>{preset.name}</strong>
            <small>{preset.base_url ?? preset.type}</small>
          </button>)}
        </div>
      </details>}
    </section>}
    {loading ? <div className="provider-empty"><span className="spinner"/></div> : providers.length === 0 && expandedId === null ? <div className="provider-empty"><Icon name="shield" size={22}/><strong>{tr('No providers configured', '还没有配置供应商')}</strong><span>{tr('Add a provider to make models available in chat.', '新增供应商后，模型才会出现在对话选择器中。')}</span></div> : <div className="provider-list">
      {providers.map(provider => <ProviderCard key={provider.id} provider={provider} expanded={expandedId === provider.id} busy={busyId === provider.id} onOpen={() => void openProvider(provider)} onTest={() => void testProvider(provider)} onToggle={() => void toggleDisabled(provider)} onDelete={() => void deleteProvider(provider)} />)}
    </div>}
    {expandedId === '__new__' && draft && <ProviderEditor draft={draft} saving={saving} isNew onChange={updateDraft} onSave={() => void saveProvider()} onCancel={closeEditor} showApiKey={showApiKey} onRevealApiKey={() => void revealApiKey()} onCopyApiKey={() => void copyApiKey()} tr={tr} />}
    {expandedId !== null && expandedId !== '__new__' && draft && <ProviderEditor draft={draft} saving={saving} onChange={updateDraft} onSave={() => void saveProvider()} onCancel={closeEditor} showApiKey={showApiKey} onRevealApiKey={() => void revealApiKey()} onCopyApiKey={() => void copyApiKey()} tr={tr} />}
  </div>;
}

function ProviderCard({ provider, expanded, busy, onOpen, onTest, onToggle, onDelete }: { provider: ProviderCatalogItem; expanded: boolean; busy: boolean; onOpen: () => void; onTest: () => void; onToggle: () => void; onDelete: () => void }) {
  const { tr } = useI18n();
  const modelCount = providerModelCount(provider);
  return <article className={`provider-card${expanded ? ' expanded' : ''}${provider.disabled ? ' disabled' : ''}`}>
    <button type="button" className="provider-card-main" onClick={onOpen} aria-expanded={expanded}>
      <span className="provider-card-mark"><Icon name="shield" size={17}/></span>
      <span className="provider-card-copy"><strong>{provider.name ?? provider.id}</strong><small>{provider.id} · {provider.type}{modelCount > 0 ? ` · ${String(modelCount)} ${tr('models', '个模型')}` : ''}</small></span>
      <span className={`provider-status provider-status-${provider.disabled ? 'disabled' : provider.status}`} />
      <Icon name="chevron-down" size={15}/>
    </button>
    <div className="provider-card-actions">
      <button type="button" title={tr('Test provider', '测试供应商')} aria-label={tr('Test provider', '测试供应商')} onClick={onTest} disabled={busy}><Icon name="refresh" size={14}/></button>
      <button type="button" title={provider.disabled ? tr('Enable provider', '启用供应商') : tr('Disable provider', '禁用供应商')} aria-label={provider.disabled ? tr('Enable provider', '启用供应商') : tr('Disable provider', '禁用供应商')} onClick={onToggle} disabled={busy}><Icon name="shield" size={14}/></button>
      <button type="button" className="danger" title={tr('Delete provider', '删除供应商')} aria-label={tr('Delete provider', '删除供应商')} onClick={onDelete} disabled={busy}><Icon name="trash" size={14}/></button>
    </div>
  </article>;
}

function ProviderEditor({ draft, saving, isNew = false, onChange, onSave, onCancel, showApiKey, onRevealApiKey, onCopyApiKey, tr }: { draft: ProviderDraft; saving: boolean; isNew?: boolean; onChange: <K extends keyof ProviderDraft>(key: K, value: ProviderDraft[K]) => void; onSave: () => void; onCancel: () => void; showApiKey: boolean; onRevealApiKey: () => void; onCopyApiKey: () => void; tr: (english: string, chinese: string) => string }) {
  const updateCustomModel = (index: number, patch: Partial<CustomModelDraft>) => {
    onChange('customModels', draft.customModels.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  };
  return <section className="provider-editor">
    <div className="provider-editor-heading"><div><span>{isNew ? tr('New provider', '新增供应商') : tr('Provider settings', '供应商设置')}</span><strong>{draft.name || draft.id || tr('Unnamed provider', '未命名供应商')}</strong></div><button type="button" className="icon-button" onClick={onCancel} title={tr('Close editor', '关闭编辑')} aria-label={tr('Close editor', '关闭编辑')}><Icon name="close" size={15}/></button></div>
    {draft.fromPreset && <p className="provider-preset-hint">{draft.requiresApiKey ? tr('Copied from a template. Prefills name, API format, and Base URL. API key is required.', '已从模板复制。名称、API 格式和 Base URL 已预填，API Key 必填。') : tr('Copied from a template. Prefills name, API format, and Base URL.', '已从模板复制。名称、API 格式和 Base URL 已预填。')}</p>}
    <div className="provider-form-grid">
      <label><span>{tr('Display name', '显示名称')}</span><input value={draft.name} onChange={event => onChange('name', event.target.value)} placeholder={tr('e.g. Work OpenAI', '例如：工作 OpenAI')} /></label>
      <label><span>Provider ID</span><input value={draft.id} onChange={event => onChange('id', event.target.value.trim())} placeholder="openrouter" /></label>
      <label><span>{tr('API format', 'API 格式')}</span><select value={draft.type} onChange={event => onChange('type', event.target.value as ProviderType)}>{API_FORMATS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <label className="provider-form-wide"><span>Base URL</span><input value={draft.baseUrl} onChange={event => onChange('baseUrl', event.target.value)} placeholder="https://api.example.com/v1" /></label>
      <label className="provider-form-wide"><span>API Key{draft.requiresApiKey ? ` (${tr('required', '必填')})` : ''}</span><div className="provider-secret-input"><input type={showApiKey ? 'text' : 'password'} value={draft.apiKey || (draft.originalId ? '••••••••' : '')} onFocus={event => { if (event.currentTarget.value === '••••••••') onRevealApiKey(); }} onChange={event => onChange('apiKey', event.target.value)} placeholder="sk-..." aria-required={draft.requiresApiKey}/><button type="button" onClick={onRevealApiKey} title={showApiKey ? tr('Hide API key', '隐藏 API Key') : tr('Show API key', '显示 API Key')} aria-label={showApiKey ? tr('Hide API key', '隐藏 API Key') : tr('Show API key', '显示 API Key')}><Icon name="eye" size={14}/></button><button type="button" onClick={onCopyApiKey} title={tr('Copy API key', '复制 API Key')} aria-label={tr('Copy API key', '复制 API Key')}><Icon name="copy" size={14}/></button></div></label>
      <label className="provider-switch"><input type="checkbox" checked={draft.autoDiscover} onChange={event => onChange('autoDiscover', event.target.checked)}/><span><strong>{tr('Automatically fetch models', '自动获取模型')}</strong><small>{tr('When off, only custom models are shown. Configure thinking effort for each custom model.', '关闭后只显示自定义模型，并为每个模型设置推理强度。')}</small></span></label>
      <label className="provider-switch"><input type="checkbox" checked={draft.disabled} onChange={event => onChange('disabled', event.target.checked)}/><span><strong>{tr('Disabled', '禁用')}</strong><small>{tr('Disabled providers disappear from model selection.', '禁用后不会出现在模型选择器中。')}</small></span></label>
      {!draft.autoDiscover && <div className="provider-form-wide custom-model-editor">
        <div className="custom-model-editor-heading"><span>{tr('Custom models', '自定义模型')}</span><small>{tr('Set supported thinking efforts and a default. Unsupported models hide the chat effort picker.', '设置支持的推理档位和默认档位。不支持思考的模型不会显示聊天页强度选择器。')}</small></div>
        {draft.customModels.map((model, index) => <CustomModelRow key={`custom-model-${String(index)}`} model={model} tr={tr} onChange={patch => updateCustomModel(index, patch)} onRemove={() => onChange('customModels', draft.customModels.length === 1 ? [emptyCustomModelDraft()] : draft.customModels.filter((_, itemIndex) => itemIndex !== index))} />)}
        <button type="button" className="btn btn-secondary btn-compact" onClick={() => onChange('customModels', [...draft.customModels, emptyCustomModelDraft()])}><Icon name="plus" size={13}/>{tr('Add custom model', '添加自定义模型')}</button>
      </div>}
    </div>
    <footer><button type="button" className="btn btn-secondary btn-compact" onClick={onCancel}>{tr('Cancel', '取消')}</button><button type="button" className="btn btn-primary btn-compact" onClick={onSave} disabled={saving}>{saving ? tr('Saving…', '保存中…') : tr('Save provider', '保存供应商')}</button></footer>
  </section>;
}

function CustomModelRow({ model, tr, onChange, onRemove }: { model: CustomModelDraft; tr: (english: string, chinese: string) => string; onChange: (patch: Partial<CustomModelDraft>) => void; onRemove: () => void }) {
  const toggleEffort = (effort: string) => {
    const selected = model.supportEfforts.includes(effort)
      ? model.supportEfforts.filter(item => item !== effort)
      : [...model.supportEfforts, effort];
    onChange({
      supportEfforts: selected,
      defaultEffort: selected.includes(model.defaultEffort) ? model.defaultEffort : selected[Math.floor(selected.length / 2)] ?? '',
    });
  };
  return <div className="custom-model-row">
    <label><span>{tr('Model ID', '模型 ID')}</span><input value={model.id} onChange={event => onChange({ id: event.target.value })} placeholder="gpt-4o" aria-label={tr('Custom model ID', '自定义模型 ID')} /></label>
    <label><span>{tr('Thinking', '思考')}</span><select value={model.thinking} aria-label={tr('Thinking mode', '思考模式')} onChange={event => onChange({ thinking: event.target.value as CustomModelThinkingMode })}>
      <option value="unsupported">{tr('Not supported', '不支持')}</option>
      <option value="toggle">{tr('On / off', '开 / 关')}</option>
      <option value="efforts">{tr('Adjustable efforts', '可调档位')}</option>
    </select></label>
    <button type="button" className="icon-button" onClick={onRemove} title={tr('Remove custom model', '删除自定义模型')} aria-label={tr('Remove custom model', '删除自定义模型')}><Icon name="trash" size={14}/></button>
    {model.thinking === 'efforts' && <div className="custom-model-efforts">
      <span>{tr('Supported efforts', '支持的档位')}</span>
      <div className="custom-model-effort-options">
        {COMMON_THINKING_EFFORTS.map(effort => <label key={effort}><input type="checkbox" checked={model.supportEfforts.includes(effort)} onChange={() => toggleEffort(effort)} />{effort}</label>)}
      </div>
      <label><span>{tr('Default effort', '默认档位')}</span><select value={model.defaultEffort} aria-label={tr('Default effort', '默认档位')} onChange={event => onChange({ defaultEffort: event.target.value })} disabled={model.supportEfforts.length === 0}>
        <option value="">{tr('Select default', '选择默认')}</option>
        {model.supportEfforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
      </select></label>
    </div>}
  </div>;
}

export function providerCustomModelsForPatch(autoDiscover: boolean, customModels: string[]): string[] {
  return autoDiscover ? [] : customModels;
}

export function defaultModelAfterProviderSave(
  currentDefault: string | undefined,
  models: readonly ModelCatalogItem[],
  preferredProviderId: string,
): string | undefined {
  const normalizedDefault = currentDefault?.trim();
  if (normalizedDefault && models.some(model => model.model === normalizedDefault)) return undefined;
  return models.find(model => model.provider === preferredProviderId)?.model ?? models[0]?.model;
}

export function providerModelCount(provider: ProviderCatalogItem): number {
  const customModelCount = provider.custom_models?.length ?? 0;
  if (provider.auto_discover === false || customModelCount > 0) return customModelCount;
  return provider.models?.length ?? 0;
}

function presetRequiresKeyLabel(preset: ProviderPreset, tr: (english: string, chinese: string) => string): string {
  if (preset.auth === 'none') return tr('No API key', '无需 API Key');
  return tr('API key required', '需要 API Key');
}

function isProviderType(value: string): value is ProviderType {
  return API_FORMATS.some(item => item.value === value);
}

function isModelAliasRecord(value: unknown): value is { provider?: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isModelAliasRecord(value) ? value as Record<string, unknown> : undefined;
}

function isProviderTestResponse(value: unknown): value is ProviderTestResponse {
  return typeof value === 'object' && value !== null && 'ok' in value && typeof value.ok === 'boolean';
}

function isProviderRefreshResult(value: unknown): value is ProviderRefreshResult {
  return typeof value === 'object'
    && value !== null
    && Array.isArray((value as { failed?: unknown }).failed);
}

function refreshFailures(value: unknown): ProviderRefreshResult['failed'] {
  return isProviderRefreshResult(value) ? value.failed : [];
}
