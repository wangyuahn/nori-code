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
import { loadSoundPreferences, playNotificationSound, saveSoundPreferences } from '../notificationSounds';

type ProviderType = ProviderPreset['type'];
type MemoryProviderType = Extract<ProviderType, 'openai' | 'openai_responses'>;

const API_FORMATS: Array<{ value: ProviderType; label: string }> = [
  { value: 'openai', label: 'OpenAI Chat Completions' },
  { value: 'openai_responses', label: 'OpenAI Responses' },
  { value: 'anthropic', label: 'Anthropic Messages' },
  { value: 'google-genai', label: 'Google Gemini' },
  { value: 'vertexai', label: 'Vertex AI' },
];

const MEMORY_API_FORMATS: Array<{ value: MemoryProviderType; label: string }> = [
  { value: 'openai', label: 'OpenAI compatible' },
  { value: 'openai_responses', label: 'OpenAI Responses compatible' },
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
  const [presetSource, setPresetSource] = useState('https://models.dev/api.json');
  const [presetId, setPresetId] = useState('custom');
  const [providerId, setProviderId] = useState('custom');
  const [providerType, setProviderType] = useState<ProviderType>('openai');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [apiKey, setApiKey] = useState('');
  const [apiKeyTouched, setApiKeyTouched] = useState(false);
  const [memoryVectorEnabled, setMemoryVectorEnabled] = useState(false);
  const [memoryProviderType, setMemoryProviderType] = useState<MemoryProviderType>('openai');
  const [memoryBaseUrl, setMemoryBaseUrl] = useState('');
  const [memoryModel, setMemoryModel] = useState('');
  const [memoryHasApiKey, setMemoryHasApiKey] = useState(false);
  const [memoryApiKey, setMemoryApiKey] = useState('');
  const [memoryApiKeyTouched, setMemoryApiKeyTouched] = useState(false);
  const [rewindLimit, setRewindLimit] = useState(loadRewindLimit);
  const [soundPreferences, setSoundPreferences] = useState(loadSoundPreferences);
  const [maxStepsPerTurn, setMaxStepsPerTurn] = useState(0);
  const [goalMaxTurns, setGoalMaxTurns] = useState(0);
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
      const loopControl = typeof config.loop_control === 'object' && config.loop_control !== null ? config.loop_control as Record<string, unknown> : {};
      setMaxStepsPerTurn(nonNegativeInteger(loopControl.maxStepsPerTurn ?? loopControl.max_steps_per_turn));
      setGoalMaxTurns(nonNegativeInteger(loopControl.goalMaxTurns ?? loopControl.goal_max_turns));
      const experimental = config.experimental as Record<string, unknown> | undefined;
      if (typeof experimental?.auto_update === 'boolean') setAutoUpdate(experimental.auto_update);
      const memory = typeof config.memory === 'object' && config.memory !== null
        ? config.memory as Record<string, unknown>
        : {};
      setMemoryVectorEnabled(memory.vector_enabled === true);
      if (MEMORY_API_FORMATS.some(item => item.value === memory.provider_type)) {
        setMemoryProviderType(memory.provider_type as MemoryProviderType);
      } else {
        setMemoryProviderType('openai');
      }
      setMemoryBaseUrl(typeof memory.base_url === 'string' ? memory.base_url : '');
      setMemoryModel(typeof memory.model === 'string' ? memory.model : '');
      setMemoryHasApiKey(memory.has_api_key === true);
      setMemoryApiKey('');
      setMemoryApiKeyTouched(false);
      setProviders(providerResult.items);
      setPresets(presetResult.items);
      setPresetSource(presetResult.source);
      setPresetWarning(presetResult.warning ?? '');
      const first = providerResult.items[0];
      if (first) {
        setProviderId(first.id);
        if (API_FORMATS.some(item => item.value === first.type)) setProviderType(first.type as ProviderType);
        setBaseUrl(first.base_url ?? '');
        const matchingPreset = presetResult.items.find(item =>
          item.id === first.id && (item.base_url ?? '') === (first.base_url ?? ''));
        setPresetId(matchingPreset?.id ?? 'custom');
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
    if (!id) {
      setProviderId('');
      setPresetId('custom');
      setProviderType('openai');
      setBaseUrl('');
      setApiKey('');
      setApiKeyTouched(false);
      return;
    }
    const provider = providers.find(item => item.id === id);
    if (!provider) return;
    setProviderId(provider.id);
    if (API_FORMATS.some(item => item.value === provider.type)) setProviderType(provider.type as ProviderType);
    setBaseUrl(provider.base_url ?? '');
    const matchingPreset = presets.find(item =>
      item.id === provider.id && (item.base_url ?? '') === (provider.base_url ?? ''));
    setPresetId(matchingPreset?.id ?? 'custom');
    setApiKey('');
    setApiKeyTouched(false);
  };

  const save = async () => {
    setSaveMessage(''); setSaveError(false);
    if (memoryVectorEnabled) {
      const missingFields: string[] = [];
      if (!isHttpUrl(memoryBaseUrl)) missingFields.push(tr('a valid Base URL', '有效的 Base URL'));
      if (!memoryModel.trim()) missingFields.push(tr('an embedding model', 'Embedding 模型'));
      if (!memoryHasApiKey && !memoryApiKey.trim()) missingFields.push('API Key');
      if (missingFields.length > 0) {
        setSaveError(true);
        setSaveMessage(
          tr(
            'Complete the following Memory fields before enabling vector search: ',
            '开启向量检索前请补全以下 Memory 配置：',
          ) + missingFields.join(tr(', ', '、')),
        );
        return;
      }
    }

    setSaving(true);
    try {
      const id = providerId.trim();
      const providerPatch: Record<string, unknown> = { type: providerType };
      if (baseUrl.trim()) providerPatch.base_url = baseUrl.trim();
      if (apiKeyTouched && apiKey.trim()) providerPatch.api_key = apiKey.trim();
      const selectedPreset = presets.find(item => item.id === presetId);
      providerPatch.source = selectedPreset === undefined
        ? { kind: 'manual' }
        : { kind: 'modelsDev', url: presetSource, catalog_id: selectedPreset.id };
      const memoryPatch: Record<string, unknown> = {
        vector_enabled: memoryVectorEnabled,
        provider_type: memoryProviderType,
        base_url: memoryBaseUrl.trim(),
        model: memoryModel.trim(),
      };
      if (memoryApiKeyTouched && memoryApiKey.trim()) memoryPatch.api_key = memoryApiKey.trim();
      const patch: Record<string, unknown> = {
        default_permission_mode: permissionMode,
        default_plan_mode: planMode,
        experimental: { auto_update: autoUpdate },
        memory: memoryPatch,
        loop_control: { max_steps_per_turn: maxStepsPerTurn, goal_max_turns: goalMaxTurns },
      };
      if (id) patch.providers = { [id]: providerPatch };
      await api.updateConfig(patch);
      let refreshMessage = '';
      if (id) {
        const result = await api.providers.refresh(id);
        refreshMessage = result.failed.length > 0
          ? tr('Provider saved, but model discovery failed: ', 'Provider 已保存，但获取模型失败：') + result.failed[0]?.reason
          : tr('Provider saved and models refreshed', 'Provider 已保存并刷新模型列表');
      }
      setApiKey('');
      setApiKeyTouched(false);
      if (memoryApiKeyTouched && memoryApiKey.trim()) setMemoryHasApiKey(true);
      setMemoryApiKey('');
      setMemoryApiKeyTouched(false);
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
  const changeSoundPreferences = (patch: Partial<typeof soundPreferences>) => {
    setSoundPreferences(previous => saveSoundPreferences({ ...previous, ...patch }));
  };
  const selectedProvider = providers.find(item => item.id === providerId);
  const displayedApiKey = apiKeyTouched ? apiKey : selectedProvider?.has_api_key ? '••••••••' : '';
  const displayedMemoryApiKey = memoryApiKeyTouched ? memoryApiKey : memoryHasApiKey ? '••••••••' : '';

  return <div className="settings-panel">
    <section className="settings-card"><div className="settings-card-heading"><span>{tr('Notifications', '通知')}</span><h2>{tr('Sound feedback', '声音反馈')}</h2><p>{tr('Short local cues for completion, attention, and failures.', '在完成、需要处理和失败时播放简短的本地提示音。')}</p></div><div className="settings-card-body">
      <SettingRow label={tr('Notification sounds', '通知音效')} desc={tr('Play sounds for main responses, agents, approvals, and errors.', '为主回复、智能体、授权和错误播放提示音。')}><Toggle checked={soundPreferences.enabled} onChange={enabled => changeSoundPreferences({ enabled })} ariaLabel={tr('Enable notification sounds', '启用通知音效')} /></SettingRow>
      <SettingRow label={tr('Sound volume', '音效音量')} desc={tr('Only affects Nori notification sounds.', '仅影响 Nori 的通知音效。')}><div className="sound-volume-control"><input aria-label={tr('Sound volume', '音效音量')} type="range" min="0" max="100" value={Math.round(soundPreferences.volume * 100)} disabled={!soundPreferences.enabled} onChange={event => changeSoundPreferences({ volume: Number(event.target.value) / 100 })}/><span>{Math.round(soundPreferences.volume * 100)}%</span><button type="button" className="sound-preview" disabled={!soundPreferences.enabled} onClick={() => playNotificationSound('complete', true)} title={tr('Preview sound', '试听音效')} aria-label={tr('Preview sound', '试听音效')}><Icon name="play" size={12}/></button></div></SettingRow>
    </div></section>
    <section className="settings-card"><div className="settings-card-heading"><span>Loop / Goal</span><h2>{tr('Execution limits', '执行轮次限制')}</h2><p>{tr('Control runaway tool loops and long-running goals. Enter 0 for unlimited.', '控制工具循环和长期 Goal 的轮次；填写 0 表示无限。')}</p></div><div className="settings-card-body">
      <SettingRow label={tr('Steps per turn', '单轮最大步骤')} desc={tr('Maximum model/tool steps in one turn. 0 disables the limit.', '每轮模型与工具的最大步骤数；0 表示不限制。')}><input aria-label={tr('Steps per turn', '单轮最大步骤')} type="number" min="0" step="1" className="input settings-control" value={maxStepsPerTurn} onChange={event => setMaxStepsPerTurn(nonNegativeInteger(event.target.value))}/></SettingRow>
      <SettingRow label={tr('Goal turns', 'Goal 最大轮次')} desc={tr('Default continuation-turn budget for new goals. 0 means unlimited.', '新 Goal 默认允许的连续轮次；0 表示无限。')}><input aria-label={tr('Goal turns', 'Goal 最大轮次')} type="number" min="0" step="1" className="input settings-control" value={goalMaxTurns} onChange={event => setGoalMaxTurns(nonNegativeInteger(event.target.value))}/></SettingRow>
    </div></section>
    {loadError && <div className="settings-notice"><Icon name="alert" size={17} /><div><strong>{tr('Server settings are unavailable', '服务器设置不可用')}</strong><p>{loadError}</p></div><button className="btn btn-secondary btn-compact" onClick={() => void load()}>{tr('Retry', '重试')}</button></div>}

    <section className="settings-card">
      <div className="settings-card-heading"><span>Provider</span><h2>{tr('API connection', 'API 连接')}</h2><p>{tr('Configure any compatible API and fetch its models automatically.', '配置任意兼容 API，并自动获取模型列表。')}</p></div>
      <div className="settings-card-body provider-settings-grid">
        <SettingRow label={tr('Configured provider', '已配置 Provider')} desc={tr('Edit an existing connection or create a new one.', '编辑已有连接或新建连接。')}><select aria-label={tr('Configured provider', '已配置 Provider')} className="input settings-control" value={providers.some(p => p.id === providerId) ? providerId : ''} onChange={e => { selectConfiguredProvider(e.target.value); }}><option value="">{tr('New provider', '新建 Provider')}</option>{providers.map(p => <option key={p.id} value={p.id}>{p.id} · {p.status}</option>)}</select></SettingRow>
        <SettingRow label={tr('Online preset', '在线预设')} desc={tr('Loaded from models.dev, the same catalog used by Nori CLI.', '来自 models.dev，与 Nori CLI 使用同一目录。')}><select aria-label={tr('Online preset', '在线预设')} className="input settings-control" value={presetId} onChange={e => { selectPreset(e.target.value); }}><option value="custom">{tr('Custom / manual', '自定义 / 手动')}</option>{presets.map(p => <option key={p.id} value={p.id}>{p.name} ({p.model_count})</option>)}</select></SettingRow>
        {presetWarning && <div className="provider-warning">{tr('Online presets unavailable; manual configuration still works.', '在线预设暂不可用，仍可手动配置。')} {presetWarning}</div>}
        <SettingRow label="Provider ID" desc={tr('A stable local identifier, such as openrouter.', '稳定的本地标识，例如 openrouter。')}><input aria-label="Provider ID" className="input settings-control" value={providerId} onChange={e => { setProviderId(e.target.value); }} /></SettingRow>
        <SettingRow label={tr('API format', 'API 格式')} desc={tr('Choose the request and response protocol.', '选择请求与响应协议。')}><select className="input settings-control" value={providerType} onChange={e => { setProviderType(e.target.value as ProviderType); }}>{API_FORMATS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></SettingRow>
        <SettingRow label="API Base URL" desc={tr('The model endpoint is derived from this URL.', '模型列表端点会由此地址推导。')}><input aria-label="API Base URL" className="input settings-control settings-url-input" value={baseUrl} onChange={e => { setBaseUrl(e.target.value); }} placeholder="https://api.example.com/v1" /></SettingRow>
        <SettingRow label="API Key" desc={selectedProvider?.has_api_key ? tr('A key is stored. Enter a new value only to replace it.', '密钥已保存；只有输入新值时才会替换。') : tr('Stored only in the local Nori configuration.', '仅保存在本机 Nori 配置中。')}><input type="password" className="input settings-control" value={displayedApiKey} onFocus={() => { if (!apiKeyTouched && selectedProvider?.has_api_key) { setApiKey(''); setApiKeyTouched(true); } }} onChange={e => { setApiKeyTouched(true); setApiKey(e.target.value); }} placeholder="sk-..." /></SettingRow>
      </div>
    </section>

    <section className="settings-card">
      <div className="settings-card-heading"><span>Memory</span><h2>{tr('Memory retrieval', 'Memory 检索')}</h2><p>{tr('Configure a separate embedding connection for semantic memory search.', '为语义记忆检索配置独立的 Embedding 连接。')}</p></div>
      <div className="settings-card-body">
        <SettingRow label={tr('Vector search', '向量检索')} desc={tr('Combine semantic matches with full-text results and links.', '将语义匹配与全文结果、链接结合。')}><Toggle checked={memoryVectorEnabled} onChange={setMemoryVectorEnabled} ariaLabel={tr('Enable vector search', '开启向量检索')} /></SettingRow>
        <SettingRow label={tr('Current mode', '当前模式')} desc={tr('The retrieval strategies used for Memory results.', 'Memory 结果使用的检索策略。')}><span className={'memory-mode' + (memoryVectorEnabled ? ' vector' : '')}>{memoryVectorEnabled ? tr('Vector + full text + links', '向量 + 全文 + 链接') : tr('Full text + links', '全文 + 链接')}</span></SettingRow>
        <SettingRow label={tr('API format', 'API 格式')} desc={tr('The protocol used only for embedding requests.', '仅用于 Embedding 请求的协议。')}><select aria-label={tr('Memory API format', 'Memory API 格式')} className="input settings-control settings-memory-control" value={memoryProviderType} disabled={!memoryVectorEnabled} onChange={e => { setMemoryProviderType(e.target.value as MemoryProviderType); }}>{MEMORY_API_FORMATS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></SettingRow>
        <SettingRow label="API Base URL" desc={tr('The independent endpoint for embedding requests.', '用于 Embedding 请求的独立端点。')}><input aria-label={tr('Memory Base URL', 'Memory Base URL')} className="input settings-control settings-url-input" value={memoryBaseUrl} disabled={!memoryVectorEnabled} onChange={e => { setMemoryBaseUrl(e.target.value); }} placeholder="https://api.example.com/v1" /></SettingRow>
        <SettingRow label="API Key" desc={memoryHasApiKey ? tr('A key is stored. Enter a new value only to replace it.', '密钥已保存；只有输入新值时才会替换。') : tr('Stored separately from chat provider keys.', '与聊天 Provider 密钥分开保存。')}><input aria-label={tr('Memory API Key', 'Memory API Key')} type="password" className="input settings-control settings-memory-control" value={displayedMemoryApiKey} disabled={!memoryVectorEnabled} onFocus={() => { if (!memoryApiKeyTouched && memoryHasApiKey) { setMemoryApiKey(''); setMemoryApiKeyTouched(true); } }} onChange={e => { setMemoryApiKeyTouched(true); setMemoryApiKey(e.target.value); }} placeholder="sk-..." /></SettingRow>
        <SettingRow label={tr('Embedding model', 'Embedding 模型')} desc={tr('The model used to create Memory vectors.', '用于生成 Memory 向量的模型。')}><input aria-label={tr('Embedding model', 'Embedding 模型')} className="input settings-control settings-model-input" value={memoryModel} disabled={!memoryVectorEnabled} onChange={e => { setMemoryModel(e.target.value); }} placeholder="text-embedding-3-small" /></SettingRow>
      </div>
    </section>

    <section className="settings-card"><div className="settings-card-heading"><span>{tr('Behavior', '行为')}</span><h2>{tr('Agent defaults', '智能体默认设置')}</h2></div><div className="settings-card-body">
      <SettingRow label={tr('Permission mode', '权限模式')} desc={tr('Choose how tool actions are approved.', '选择工具操作的审批方式。')}><select className="input settings-control" value={permissionMode} onChange={e => { setPermissionMode(e.target.value); }}><option value="auto">{tr('Automatic', '自动')}</option><option value="manual">{tr('Manual', '手动')}</option><option value="yolo">YOLO</option></select></SettingRow>
      <SettingRow label={tr('Plan mode', '规划模式')} desc={tr('Ask for a plan before code changes.', '修改代码前先生成计划。')}><Toggle checked={planMode} onChange={setPlanMode} /></SettingRow>
      <SettingRow label={tr('Rewind history', '回溯轮数')} desc={tr(`Keep between 1 and ${MAX_REWIND_LIMIT} prompt checkpoints.`, `保留 1-${MAX_REWIND_LIMIT} 轮对话与代码快照。`)}><input type="number" min={1} max={MAX_REWIND_LIMIT} className="input settings-control settings-number-input" value={rewindLimit} onChange={event => { const value = saveRewindLimit(Number(event.target.value)); setRewindLimit(value); }} /></SettingRow>
      <SettingRow label={tr('Auto update', '自动更新')} desc={tr('Automatically apply available updates.', '自动应用可用更新。')}><Toggle checked={autoUpdate} onChange={setAutoUpdate} /></SettingRow>
    </div></section>

    <section className="settings-card"><div className="settings-card-heading"><span>{tr('Appearance', '外观')}</span><h2>{tr('Workspace theme', '工作区主题')}</h2></div><div className="settings-card-body">
      <SettingRow label={tr('Color mode', '颜色模式')} desc={tr('Applied to the entire application.', '应用到整个应用。')}><div className="theme-segment"><button onClick={() => { changeTheme('dark'); }} className={theme === 'dark' ? 'active' : ''}><Icon name="moon" size={15}/>{tr('Dark', '深色')}</button><button onClick={() => { changeTheme('light'); }} className={theme === 'light' ? 'active' : ''}><Icon name="sun" size={15}/>{tr('Light', '浅色')}</button></div></SettingRow>
      <SettingRow label={tr('Accent color', '强调色')} desc={tr('Used for focus and primary actions.', '用于焦点与主要操作。')}><div className="accent-control"><input type="color" value={isHexColor(themeColor) ? themeColor : DEFAULT_ACCENT} onChange={e => { changeAccent(e.target.value); }}/><input className="input accent-value" value={themeColor} onChange={e => { changeAccent(e.target.value); }}/></div></SettingRow>
      <SettingRow label={tr('Interface language', '界面语言')} desc={tr('Applied immediately.', '立即生效。')}><select className="input settings-control" value={locale} onChange={e => { setLocale(e.target.value as Locale); }}><option value="zh-CN">简体中文</option><option value="en">English</option></select></SettingRow>
    </div></section>

    <div className="settings-actions"><button className="btn btn-primary" onClick={() => void save()} disabled={saving || loading}>{saving ? tr('Saving…', '正在保存…') : tr('Save and refresh models', '保存并刷新模型')}</button>{saveMessage && <span className={'settings-save-status ' + (saveError ? 'error' : 'success')}><Icon name={saveError ? 'alert' : 'check'} size={15}/>{saveMessage}</span>}</div>
  </div>;
}

function Toggle({ checked, onChange, ariaLabel }: { checked: boolean; onChange: (value: boolean) => void; ariaLabel?: string }) { return <label className="toggle"><input aria-label={ariaLabel} type="checkbox" checked={checked} onChange={e => { onChange(e.target.checked); }}/><span className="toggle-slider"/></label>; }
function SettingRow({ label, desc, children }: { label: string; desc: string; children: React.ReactNode }) { return <div className="setting-row"><div className="setting-copy"><strong>{label}</strong><span>{desc}</span></div><div className="setting-action">{children}</div></div>; }

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function nonNegativeInteger(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 0;
}
