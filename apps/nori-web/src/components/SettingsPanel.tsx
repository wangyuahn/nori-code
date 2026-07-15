import React, { useCallback, useEffect, useState } from 'react';
import { api, type ProviderCatalogItem, type ProviderPreset } from '../api/client';
import { useI18n, type Locale } from '../i18n';
import {
  DEFAULT_ACCENT,
  applyThemeColor,
  applyThemeMode,
  isHexColor,
  loadThemeColor,
  loadThemeMode,
  type ThemeMode,
} from '../theme';
import { Icon } from './Icon';
import { loadRewindLimit, MAX_REWIND_LIMIT, saveRewindLimit } from '../rewindPreferences';

type ProviderType = ProviderPreset['type'];

const API_FORMATS: Array<{ value: ProviderType; label: string }> = [
  { value: 'openai', label: 'OpenAI Chat Completions' },
  { value: 'openai_responses', label: 'OpenAI Responses' },
  { value: 'anthropic', label: 'Anthropic Messages' },
  { value: 'google-genai', label: 'Google Gemini' },
  { value: 'vertexai', label: 'Vertex AI' },
];

export function SettingsPanel() {
  const { locale, setLocale, tr } = useI18n();
  const [permissionMode, setPermissionMode] = useState('auto');
  const [planMode, setPlanMode] = useState(false);
  const [autoUpdate, setAutoUpdate] = useState(false);
  const [themeColor, setThemeColor] = useState(loadThemeColor);
  const [theme, setTheme] = useState<ThemeMode>(loadThemeMode);
  const [providers, setProviders] = useState<ProviderCatalogItem[]>([]);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [presetId, setPresetId] = useState('custom');
  const [providerId, setProviderId] = useState('custom');
  const [providerType, setProviderType] = useState<ProviderType>('openai');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [apiKey, setApiKey] = useState('');
  const [apiKeyTouched, setApiKeyTouched] = useState(false);
  const [rewindLimit, setRewindLimit] = useState(loadRewindLimit);
  const [presetWarning, setPresetWarning] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState('');
  const [saveError, setSaveError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [config, providerResult, presetResult] = await Promise.all([
        api.getConfig(), api.providers.list(), api.providerPresets.list(),
      ]);
      if (typeof config.default_permission_mode === 'string') setPermissionMode(config.default_permission_mode);
      if (typeof config.default_plan_mode === 'boolean') setPlanMode(config.default_plan_mode);
      const experimental = config.experimental as Record<string, unknown> | undefined;
      if (typeof experimental?.auto_update === 'boolean') setAutoUpdate(experimental.auto_update);
      setProviders(providerResult.items);
      setPresets(presetResult.items);
      setPresetWarning(presetResult.warning ?? '');
      const first = providerResult.items[0];
      if (first) {
        setProviderId(first.id);
        if (API_FORMATS.some(item => item.value === first.type)) setProviderType(first.type as ProviderType);
        setBaseUrl(first.base_url ?? '');
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : tr('Failed to load settings', '加载设置失败'));
    } finally { setLoading(false); }
  }, [tr]);

  useEffect(() => { void load(); }, [load]);

  const selectPreset = (id: string) => {
    setPresetId(id);
    const preset = presets.find(item => item.id === id);
    if (!preset) return;
    setProviderId(preset.id);
    setProviderType(preset.type);
    setBaseUrl(preset.base_url ?? '');
  };

  const selectConfiguredProvider = (id: string) => {
    const provider = providers.find(item => item.id === id);
    if (!provider) return;
    setProviderId(provider.id);
    if (API_FORMATS.some(item => item.value === provider.type)) setProviderType(provider.type as ProviderType);
    setBaseUrl(provider.base_url ?? '');
    setApiKey('');
    setApiKeyTouched(false);
  };

  const save = async () => {
    setSaving(true); setSaveMessage(''); setSaveError(false);
    try {
      const id = providerId.trim();
      const providerPatch: Record<string, unknown> = { type: providerType };
      if (baseUrl.trim()) providerPatch.base_url = baseUrl.trim();
      if (apiKeyTouched && apiKey.trim()) providerPatch.api_key = apiKey.trim();
      const patch: Record<string, unknown> = {
        default_permission_mode: permissionMode,
        default_plan_mode: planMode,
        experimental: { auto_update: autoUpdate },
      };
      if (id) patch.providers = { [id]: providerPatch };
      await api.updateConfig(patch);
      let refreshMessage = '';
      if (id) {
        const result = await api.providers.refresh(id);
        refreshMessage = result.failed.length
          ? tr('Provider saved, but model discovery failed: ', 'Provider 已保存，但获取模型失败：') + result.failed[0]?.reason
          : tr('Provider saved and models refreshed', 'Provider 已保存并刷新模型列表');
      }
      setApiKey('');
      setApiKeyTouched(false);
      setSaveMessage(refreshMessage || tr('Settings saved', '设置已保存'));
      window.dispatchEvent(new CustomEvent('nori:model-catalog-changed'));
      const currentProviders = await api.providers.list();
      setProviders(currentProviders.items);
    } catch (error) {
      setSaveError(true);
      setSaveMessage(error instanceof Error ? error.message : tr('Failed to save', '保存失败'));
    } finally { setSaving(false); }
  };

  const changeTheme = (mode: ThemeMode) => { setTheme(mode); applyThemeMode(mode); };
  const changeAccent = (color: string) => { setThemeColor(color); applyThemeColor(color); };
  const selectedProvider = providers.find(item => item.id === providerId);
  const displayedApiKey = apiKeyTouched ? apiKey : selectedProvider?.has_api_key ? '••••••••' : '';

  return <div className="settings-panel">
    {loadError && <div className="settings-notice"><Icon name="alert" size={17} /><div><strong>{tr('Server settings are unavailable', '服务器设置不可用')}</strong><p>{loadError}</p></div><button className="btn btn-secondary btn-compact" onClick={() => void load()}>{tr('Retry', '重试')}</button></div>}

    <section className="settings-card">
      <div className="settings-card-heading"><span>Provider</span><h2>{tr('API connection', 'API 连接')}</h2><p>{tr('Configure any compatible API and fetch its models automatically.', '配置任意兼容 API，并自动获取模型列表。')}</p></div>
      <div className="settings-card-body provider-settings-grid">
        <SettingRow label={tr('Configured provider', '已配置 Provider')} desc={tr('Edit an existing connection or create a new one.', '编辑已有连接或新建连接。')}><select className="input settings-control" value={providers.some(p => p.id === providerId) ? providerId : ''} onChange={e => selectConfiguredProvider(e.target.value)}><option value="">{tr('New provider', '新建 Provider')}</option>{providers.map(p => <option key={p.id} value={p.id}>{p.id} · {p.status}</option>)}</select></SettingRow>
        <SettingRow label={tr('Online preset', '在线预设')} desc={tr('Loaded from models.dev, the same catalog used by Nori CLI.', '来自 models.dev，与 Nori CLI 使用同一目录。')}><select className="input settings-control" value={presetId} onChange={e => selectPreset(e.target.value)}><option value="custom">{tr('Custom / manual', '自定义 / 手动')}</option>{presets.map(p => <option key={p.id} value={p.id}>{p.name} ({p.model_count})</option>)}</select></SettingRow>
        {presetWarning && <div className="provider-warning">{tr('Online presets unavailable; manual configuration still works.', '在线预设暂不可用，仍可手动配置。')} {presetWarning}</div>}
        <SettingRow label="Provider ID" desc={tr('A stable local identifier, such as openrouter.', '稳定的本地标识，例如 openrouter。')}><input className="input settings-control" value={providerId} onChange={e => setProviderId(e.target.value)} /></SettingRow>
        <SettingRow label={tr('API format', 'API 格式')} desc={tr('Choose the request and response protocol.', '选择请求与响应协议。')}><select className="input settings-control" value={providerType} onChange={e => setProviderType(e.target.value as ProviderType)}>{API_FORMATS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></SettingRow>
        <SettingRow label="API Base URL" desc={tr('The model endpoint is derived from this URL.', '模型列表端点会由此地址推导。')}><input className="input settings-control settings-url-input" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" /></SettingRow>
        <SettingRow label="API Key" desc={selectedProvider?.has_api_key ? tr('A key is stored. Enter a new value only to replace it.', '密钥已保存；只有输入新值时才会替换。') : tr('Stored only in the local Nori configuration.', '仅保存在本机 Nori 配置中。')}><input type="password" className="input settings-control" value={displayedApiKey} onFocus={() => { if (!apiKeyTouched && selectedProvider?.has_api_key) { setApiKey(''); setApiKeyTouched(true); } }} onChange={e => { setApiKeyTouched(true); setApiKey(e.target.value); }} placeholder="sk-..." /></SettingRow>
      </div>
    </section>

    <section className="settings-card"><div className="settings-card-heading"><span>{tr('Behavior', '行为')}</span><h2>{tr('Agent defaults', '智能体默认设置')}</h2></div><div className="settings-card-body">
      <SettingRow label={tr('Permission mode', '权限模式')} desc={tr('Choose how tool actions are approved.', '选择工具操作的审批方式。')}><select className="input settings-control" value={permissionMode} onChange={e => setPermissionMode(e.target.value)}><option value="auto">{tr('Automatic', '自动')}</option><option value="manual">{tr('Manual', '手动')}</option><option value="yolo">YOLO</option></select></SettingRow>
      <SettingRow label={tr('Plan mode', '规划模式')} desc={tr('Ask for a plan before code changes.', '修改代码前先生成计划。')}><Toggle checked={planMode} onChange={setPlanMode} /></SettingRow>
      <SettingRow label={tr('Rewind history', '回溯轮数')} desc={tr(`Keep between 1 and ${MAX_REWIND_LIMIT} prompt checkpoints.`, `保留 1-${MAX_REWIND_LIMIT} 轮对话与代码快照。`)}><input type="number" min={1} max={MAX_REWIND_LIMIT} className="input settings-control settings-number-input" value={rewindLimit} onChange={event => { const value = saveRewindLimit(Number(event.target.value)); setRewindLimit(value); }} /></SettingRow>
      <SettingRow label={tr('Auto update', '自动更新')} desc={tr('Automatically apply available updates.', '自动应用可用更新。')}><Toggle checked={autoUpdate} onChange={setAutoUpdate} /></SettingRow>
    </div></section>

    <section className="settings-card"><div className="settings-card-heading"><span>{tr('Appearance', '外观')}</span><h2>{tr('Workspace theme', '工作区主题')}</h2></div><div className="settings-card-body">
      <SettingRow label={tr('Color mode', '颜色模式')} desc={tr('Applied to the entire application.', '应用到整个应用。')}><div className="theme-segment"><button onClick={() => changeTheme('dark')} className={theme === 'dark' ? 'active' : ''}><Icon name="moon" size={15}/>{tr('Dark', '深色')}</button><button onClick={() => changeTheme('light')} className={theme === 'light' ? 'active' : ''}><Icon name="sun" size={15}/>{tr('Light', '浅色')}</button></div></SettingRow>
      <SettingRow label={tr('Accent color', '强调色')} desc={tr('Used for focus and primary actions.', '用于焦点与主要操作。')}><div className="accent-control"><input type="color" value={isHexColor(themeColor) ? themeColor : DEFAULT_ACCENT} onChange={e => changeAccent(e.target.value)}/><input className="input accent-value" value={themeColor} onChange={e => changeAccent(e.target.value)}/></div></SettingRow>
      <SettingRow label={tr('Interface language', '界面语言')} desc={tr('Applied immediately.', '立即生效。')}><select className="input settings-control" value={locale} onChange={e => setLocale(e.target.value as Locale)}><option value="zh-CN">简体中文</option><option value="en">English</option></select></SettingRow>
    </div></section>

    <div className="settings-actions"><button className="btn btn-primary" onClick={() => void save()} disabled={saving || loading}>{saving ? tr('Saving…', '正在保存…') : tr('Save and refresh models', '保存并刷新模型')}</button>{saveMessage && <span className={'settings-save-status ' + (saveError ? 'error' : 'success')}><Icon name={saveError ? 'alert' : 'check'} size={15}/>{saveMessage}</span>}</div>
  </div>;
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) { return <label className="toggle"><input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)}/><span className="toggle-slider"/></label>; }
function SettingRow({ label, desc, children }: { label: string; desc: string; children: React.ReactNode }) { return <div className="setting-row"><div className="setting-copy"><strong>{label}</strong><span>{desc}</span></div><div className="setting-action">{children}</div></div>; }
