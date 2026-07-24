import { useCallback, useEffect, useState } from 'react';

import { api, type ProviderCatalogItem, type ProviderPreset, type ProviderRefreshResult, type ProviderTestResponse } from '../api/client';
import { useI18n } from '../i18n';
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
  customModels: string;
  disabled: boolean;
}

const EMPTY_DRAFT: ProviderDraft = {
  originalId: null,
  id: '',
  name: '',
  type: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  autoDiscover: true,
  customModels: '',
  disabled: false,
};

export function ProviderSettings() {
  const { tr } = useI18n();
  const [providers, setProviders] = useState<ProviderCatalogItem[]>([]);
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
      const result = await api.providers.list();
      setProviders(result.items);
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : tr('Failed to load providers', '加载 Provider 失败'), error: true });
    } finally {
      setLoading(false);
    }
  }, [tr]);

  useEffect(() => { void load(); }, [load]);

  const openProvider = (provider: ProviderCatalogItem) => {
    setExpandedId(provider.id);
    setDraft({
      originalId: provider.id,
      id: provider.id,
      name: provider.name === provider.id ? '' : provider.name ?? '',
      type: isProviderType(provider.type) ? provider.type : 'openai',
      baseUrl: provider.base_url ?? '',
      apiKey: '',
      autoDiscover: provider.auto_discover !== false,
      customModels: (provider.custom_models ?? []).join('\n'),
      disabled: provider.disabled === true,
    });
    setShowApiKey(false);
    setSecretLoaded(false);
    setNotice(null);
  };

  const openNewProvider = () => {
    setExpandedId('__new__');
    setDraft({ ...EMPTY_DRAFT });
    setShowApiKey(false);
    setSecretLoaded(false);
    setNotice(null);
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
    const customModels = uniqueLines(draft.customModels);
    if (!id) {
      setNotice({ text: tr('Provider ID is required', '必须填写 Provider ID'), error: true });
      return;
    }
    if (!draft.autoDiscover && customModels.length === 0) {
      setNotice({ text: tr('Add at least one custom model when automatic discovery is disabled.', '关闭自动获取模型后至少填写一个自定义模型。'), error: true });
      return;
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
        // A null value clears a previous manual model list. Sending an empty
        // array here would leave auto-discovery with an explicit empty list.
        custom_models: draft.autoDiscover ? null : customModels,
      };
      if (draft.apiKey.trim()) providerPatch.api_key = draft.apiKey.trim();

      const models: Record<string, unknown> = {};
      const currentConfig = await api.getConfig();
      const previousProviderId = draft.originalId ?? id;
      for (const [modelId, alias] of Object.entries(currentConfig.models ?? {})) {
        if (isModelAliasRecord(alias) && alias.provider === previousProviderId) {
          models[modelId] = null;
        }
      }
      for (const model of customModels) {
        models[`${id}/${model}`] = {
          provider: id,
          model,
          max_context_size: 128000,
          capabilities: ['tool_use'],
          display_name: model,
        };
      }
      await api.updateConfig({ providers: { [id]: providerPatch }, ...(Object.keys(models).length > 0 ? { models } : {}) });
      if (draft.originalId !== null && draft.originalId !== id) await api.providers.remove(draft.originalId);
      if (draft.autoDiscover && !draft.disabled) {
        const result = await api.providers.refresh(id);
        const failures = refreshFailures(result);
        if (failures.length > 0) {
          setNotice({ text: tr('Provider saved, but model discovery failed: ', 'Provider 已保存，但获取模型失败：') + failures[0]?.reason, error: true });
        } else if (!isProviderRefreshResult(result)) {
          setNotice({ text: tr('Provider saved; refresh returned no details.', 'Provider 已保存，但刷新接口没有返回详细结果。') });
        } else {
          setNotice({ text: tr('Provider saved and models refreshed', 'Provider 已保存并刷新模型列表') });
        }
      } else {
        setNotice({ text: tr('Provider saved', 'Provider 已保存') });
      }
      await load();
      window.dispatchEvent(new CustomEvent('nori:model-catalog-changed'));
      setExpandedId(id);
      setDraft(previous => previous ? { ...previous, originalId: id, apiKey: '', customModels: customModels.join('\n') } : previous);
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

  return <div className="provider-settings">
    <header className="provider-settings-heading">
      <div><span>Provider</span><h2>{tr('Model providers', '模型供应商')}</h2><p>{tr('Manage API connections, discovery, custom models, and credentials in one place.', '统一管理 API 连接、模型获取、自定义模型和凭据。')}</p></div>
      <button type="button" className="btn btn-primary btn-compact" onClick={openNewProvider}><Icon name="plus" size={14}/>{tr('Add provider', '新增供应商')}</button>
    </header>
    {notice && <div className={`settings-notice provider-notice${notice.error ? ' error' : ''}`}><Icon name={notice.error ? 'alert' : 'check'} size={16}/><span>{notice.text}</span></div>}
    {loading ? <div className="provider-empty"><span className="spinner"/></div> : providers.length === 0 && expandedId === null ? <div className="provider-empty"><Icon name="shield" size={22}/><strong>{tr('No providers configured', '还没有配置供应商')}</strong><span>{tr('Add a provider to make models available in chat.', '新增供应商后，模型才会出现在对话选择器中。')}</span></div> : <div className="provider-list">
      {providers.map(provider => <ProviderCard key={provider.id} provider={provider} expanded={expandedId === provider.id} busy={busyId === provider.id} onOpen={() => openProvider(provider)} onTest={() => void testProvider(provider)} onToggle={() => void toggleDisabled(provider)} onDelete={() => void deleteProvider(provider)} />)}
    </div>}
    {expandedId === '__new__' && draft && <ProviderEditor draft={draft} saving={saving} isNew onChange={updateDraft} onSave={() => void saveProvider()} onCancel={closeEditor} showApiKey={showApiKey} onRevealApiKey={() => void revealApiKey()} onCopyApiKey={() => void copyApiKey()} tr={tr} />}
    {expandedId !== null && expandedId !== '__new__' && draft && <ProviderEditor draft={draft} saving={saving} onChange={updateDraft} onSave={() => void saveProvider()} onCancel={closeEditor} showApiKey={showApiKey} onRevealApiKey={() => void revealApiKey()} onCopyApiKey={() => void copyApiKey()} tr={tr} />}
  </div>;
}

function ProviderCard({ provider, expanded, busy, onOpen, onTest, onToggle, onDelete }: { provider: ProviderCatalogItem; expanded: boolean; busy: boolean; onOpen: () => void; onTest: () => void; onToggle: () => void; onDelete: () => void }) {
  const { tr } = useI18n();
  const modelCount = provider.custom_models?.length ?? provider.models?.length ?? 0;
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
  return <section className="provider-editor">
    <div className="provider-editor-heading"><div><span>{isNew ? tr('New provider', '新增供应商') : tr('Provider settings', '供应商设置')}</span><strong>{draft.name || draft.id || tr('Unnamed provider', '未命名供应商')}</strong></div><button type="button" className="icon-button" onClick={onCancel} title={tr('Close editor', '关闭编辑')} aria-label={tr('Close editor', '关闭编辑')}><Icon name="close" size={15}/></button></div>
    <div className="provider-form-grid">
      <label><span>{tr('Display name', '显示名称')}</span><input value={draft.name} onChange={event => onChange('name', event.target.value)} placeholder={tr('e.g. Work OpenAI', '例如：工作 OpenAI')} /></label>
      <label><span>Provider ID</span><input value={draft.id} onChange={event => onChange('id', event.target.value.trim())} placeholder="openrouter" /></label>
      <label><span>{tr('API format', 'API 格式')}</span><select value={draft.type} onChange={event => onChange('type', event.target.value as ProviderType)}>{API_FORMATS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <label className="provider-form-wide"><span>Base URL</span><input value={draft.baseUrl} onChange={event => onChange('baseUrl', event.target.value)} placeholder="https://api.example.com/v1" /></label>
      <label className="provider-form-wide"><span>API Key</span><div className="provider-secret-input"><input type={showApiKey ? 'text' : 'password'} value={draft.apiKey || (draft.originalId ? '••••••••' : '')} onFocus={event => { if (event.currentTarget.value === '••••••••') onRevealApiKey(); }} onChange={event => onChange('apiKey', event.target.value)} placeholder="sk-..."/><button type="button" onClick={onRevealApiKey} title={showApiKey ? tr('Hide API key', '隐藏 API Key') : tr('Show API key', '显示 API Key')} aria-label={showApiKey ? tr('Hide API key', '隐藏 API Key') : tr('Show API key', '显示 API Key')}><Icon name="eye" size={14}/></button><button type="button" onClick={onCopyApiKey} title={tr('Copy API key', '复制 API Key')} aria-label={tr('Copy API key', '复制 API Key')}><Icon name="copy" size={14}/></button></div></label>
      <label className="provider-switch"><input type="checkbox" checked={draft.autoDiscover} onChange={event => onChange('autoDiscover', event.target.checked)}/><span><strong>{tr('Automatically fetch models', '自动获取模型')}</strong><small>{tr('When off, only custom model IDs are shown.', '关闭后只显示自定义模型 ID。')}</small></span></label>
      <label className="provider-switch"><input type="checkbox" checked={draft.disabled} onChange={event => onChange('disabled', event.target.checked)}/><span><strong>{tr('Disabled', '禁用')}</strong><small>{tr('Disabled providers disappear from model selection.', '禁用后不会出现在模型选择器中。')}</small></span></label>
      {!draft.autoDiscover && <label className="provider-form-wide"><span>{tr('Custom model IDs', '自定义模型 ID')}</span><textarea value={draft.customModels} onChange={event => onChange('customModels', event.target.value)} placeholder={'gpt-4o\nclaude-3-5-sonnet'} rows={4}/></label>}
    </div>
    <footer><button type="button" className="btn btn-secondary btn-compact" onClick={onCancel}>{tr('Cancel', '取消')}</button><button type="button" className="btn btn-primary btn-compact" onClick={onSave} disabled={saving}>{saving ? tr('Saving…', '保存中…') : tr('Save provider', '保存供应商')}</button></footer>
  </section>;
}

function uniqueLines(value: string): string[] {
  return [...new Set(value.split(/[\n,]+/).map(item => item.trim()).filter(Boolean))];
}

function isProviderType(value: string): value is ProviderType {
  return API_FORMATS.some(item => item.value === value);
}

function isModelAliasRecord(value: unknown): value is { provider?: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
