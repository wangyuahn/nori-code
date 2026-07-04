import React, { useState, useEffect } from 'react';
import { api } from '../api/client';

const THEME_KEY = 'nori-theme-color';
const THEME_MODE_KEY = 'nori-theme';

function loadThemeColor(): string {
  try {
    return localStorage.getItem(THEME_KEY) ?? '#00BCD4';
  } catch {
    return '#00BCD4';
  }
}

function applyThemeColor(color: string) {
  try {
    localStorage.setItem(THEME_KEY, color);
    document.documentElement.style.setProperty('--nori-cyan', color);
    document.documentElement.style.setProperty('--nori-border-active', color);
    document.documentElement.style.setProperty('--nori-cyan-dim', `${color}26`);
  } catch {
    // localStorage unavailable — ignore
  }
}

function loadThemeMode(): 'dark' | 'light' {
  try {
    const v = localStorage.getItem(THEME_MODE_KEY);
    if (v === 'dark' || v === 'light') return v;
  } catch {
    // ignore
  }
  return 'dark';
}

function applyThemeMode(mode: 'dark' | 'light') {
  try {
    localStorage.setItem(THEME_MODE_KEY, mode);
    document.documentElement.setAttribute('data-theme', mode);
  } catch {
    // ignore
  }
}

export function SettingsPanel() {
  const [permissionMode, setPermissionMode] = useState('auto');
  const [defaultModel, setDefaultModel] = useState('');
  const [themeColor, setThemeColor] = useState(loadThemeColor);
  const [theme, setTheme] = useState<'dark' | 'light'>(loadThemeMode);
  const [planMode, setPlanMode] = useState(false);
  const [autoUpdate, setAutoUpdate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [saveMessage, setSaveMessage] = useState('');

  // Load config on mount
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const config = await api.getConfig();
        if (cancelled) return;
        if (typeof config.default_permission_mode === 'string') {
          setPermissionMode(config.default_permission_mode);
        }
        if (typeof config.default_model === 'string') {
          setDefaultModel(config.default_model);
        }
        if (typeof config.default_plan_mode === 'boolean') {
          setPlanMode(config.default_plan_mode);
        }
        if (
          typeof config.experimental === 'object' &&
          config.experimental !== null &&
          typeof (config.experimental as Record<string, unknown>).auto_update === 'boolean'
        ) {
          setAutoUpdate((config.experimental as Record<string, unknown>).auto_update as boolean);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load settings');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  // Apply theme on mount
  useEffect(() => {
    applyThemeColor(themeColor);
    applyThemeMode(theme);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleTheme = (t: 'dark' | 'light') => {
    setTheme(t);
    applyThemeMode(t);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveStatus('idle');
    setSaveMessage('');
    try {
      await api.updateConfig({
        default_permission_mode: permissionMode,
        default_model: defaultModel || undefined,
        default_plan_mode: planMode,
        experimental: {
          auto_update: autoUpdate,
        },
      });
      setSaveStatus('success');
      setSaveMessage('Settings saved');
    } catch (e) {
      setSaveStatus('error');
      setSaveMessage(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
      // Clear status after 3s
      setTimeout(() => setSaveStatus('idle'), 3000);
    }
  };

  const handleThemeChange = (value: string) => {
    setThemeColor(value);
    applyThemeColor(value);
  };

  if (loading) {
    return (
      <div style={{ maxWidth: 640 }}>
        <div className="empty-state">
          <div className="spinner" />
          <div className="empty-state-desc">Loading settings...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ maxWidth: 640 }}>
        <div className="empty-state">
          <div className="empty-state-icon">!</div>
          <div className="empty-state-title">Failed to load settings</div>
          <div className="empty-state-desc">{error}</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Permission */}
      <div className="card">
        <div className="card-header">Permission</div>
        <SettingRow
          label="Default Permission Mode"
          desc="Auto: agent asks for approval on writes. Manual: explicit approval required. YOLO: agent auto-approves all actions."
        >
          <select
            className="input"
            value={permissionMode}
            onChange={e => setPermissionMode(e.target.value)}
            style={{ width: 140, cursor: 'pointer' }}
          >
            <option value="auto">Auto</option>
            <option value="manual">Manual</option>
            <option value="yolo">YOLO</option>
          </select>
        </SettingRow>
      </div>

      {/* Model */}
      <div className="card">
        <div className="card-header">Model</div>
        <SettingRow
          label="Default Model"
          desc="Model used for orchestration. Leave blank for auto-detect."
        >
          <input
            className="input"
            value={defaultModel}
            onChange={e => setDefaultModel(e.target.value)}
            placeholder="e.g. claude-sonnet-4"
            style={{ width: 220 }}
          />
        </SettingRow>
      </div>

      {/* General */}
      <div className="card">
        <div className="card-header">General</div>
        <SettingRow
          label="Plan Mode"
          desc="Require a plan before making code changes."
        >
          <label className="toggle">
            <input
              type="checkbox"
              checked={planMode}
              onChange={e => setPlanMode(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </SettingRow>
        <SettingRow
          label="Auto Update"
          desc="Automatically check for and apply updates."
        >
          <label className="toggle">
            <input
              type="checkbox"
              checked={autoUpdate}
              onChange={e => setAutoUpdate(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </SettingRow>
      </div>

      {/* Theme */}
      <div className="card">
        <div className="card-header">Theme</div>
        <SettingRow
          label="Color Mode"
          desc="Dark or light appearance (stored locally, applies immediately)."
        >
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => toggleTheme('dark')}
              className={theme === 'dark' ? 'btn btn-primary' : 'btn btn-secondary'}
            >
              Dark
            </button>
            <button
              onClick={() => toggleTheme('light')}
              className={theme === 'light' ? 'btn btn-primary' : 'btn btn-secondary'}
            >
              Light
            </button>
          </div>
        </SettingRow>
        <SettingRow
          label="Accent Color"
          desc="UI accent color (stored locally, applies immediately)."
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="color"
              value={themeColor}
              onChange={e => handleThemeChange(e.target.value)}
              style={{
                width: 28,
                height: 28,
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
                background: 'none',
              }}
            />
            <input
              className="input"
              value={themeColor}
              onChange={e => handleThemeChange(e.target.value)}
              style={{ width: 100, fontFamily: 'var(--nori-font)' }}
            />
          </div>
        </SettingRow>
      </div>

      {/* Save button + status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? (
            <>
              <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
              Saving...
            </>
          ) : (
            'Save Settings'
          )}
        </button>
        {saveStatus === 'success' && (
          <span style={{ color: 'var(--nori-success)', fontSize: 13 }}>
            ✓ {saveMessage}
          </span>
        )}
        {saveStatus === 'error' && (
          <span style={{ color: 'var(--nori-danger)', fontSize: 13 }}>
            ✗ {saveMessage}
          </span>
        )}
      </div>
    </div>
  );
}

function SettingRow({
  label,
  desc,
  children,
}: {
  label: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '12px 0',
        borderBottom: '1px solid var(--nori-border)',
      }}
    >
      <div style={{ flex: 1, marginRight: 16 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{label}</div>
        <div style={{ fontSize: 11, color: 'var(--nori-text-muted)', marginTop: 2 }}>{desc}</div>
      </div>
      {children}
    </div>
  );
}
