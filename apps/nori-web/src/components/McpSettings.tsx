import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  api,
  type McpConfigurationResponse,
  type McpServerConfig,
  type McpServerStatus,
} from '../api/client';
import { useI18n } from '../i18n';
import { Icon } from './Icon';

const REFRESH_INTERVAL_MS = 2_500;

interface McpDraft {
  originalName: string | null;
  name: string;
  transport: McpServerConfig['transport'];
  enabled: boolean;
  command: string;
  args: string;
  env: string;
  cwd: string;
  executor: 'local' | 'kaos';
  url: string;
  headers: string;
  bearerTokenEnvVar: string;
  startupTimeoutMs: string;
  toolTimeoutMs: string;
  enabledTools: string;
  disabledTools: string;
}

interface Notice {
  text: string;
  error?: boolean;
}

const EMPTY_DRAFT: McpDraft = {
  originalName: null,
  name: '',
  transport: 'stdio',
  enabled: true,
  command: '',
  args: '',
  env: '',
  cwd: '',
  executor: 'local',
  url: '',
  headers: '',
  bearerTokenEnvVar: '',
  startupTimeoutMs: '30000',
  toolTimeoutMs: '',
  enabledTools: '',
  disabledTools: '',
};

export function McpSettings() {
  const { tr } = useI18n();
  const [configuration, setConfiguration] = useState<McpConfigurationResponse | null>(null);
  const [servers, setServers] = useState<McpServerStatus[]>([]);
  const [expandedName, setExpandedName] = useState<string | null>(null);
  const [draft, setDraft] = useState<McpDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const loadStatus = useCallback(async (quiet = false) => {
    try {
      const result = await api.mcp.listServers();
      setServers(result.servers);
    } catch (cause) {
      if (!quiet) setNotice({ text: errorMessage(cause, tr('Unable to load MCP status.', '无法加载 MCP 状态。')), error: true });
    }
  }, [tr]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [config, status] = await Promise.all([api.mcp.getConfig(), api.mcp.listServers()]);
      setConfiguration(config);
      setServers(status.servers);
      setNotice(null);
    } catch (cause) {
      setNotice({ text: errorMessage(cause, tr('Unable to load MCP configuration.', '无法加载 MCP 配置。')), error: true });
    } finally {
      setLoading(false);
    }
  }, [tr]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void loadStatus(true), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [load, loadStatus]);

  const configuredEntries = useMemo(
    () => Object.entries(configuration?.mcp_servers ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    [configuration],
  );
  const statusByName = useMemo(() => new Map(servers.map(server => [server.name, server])), [servers]);
  const runtimeOnlyServers = useMemo(
    () => servers.filter(server => configuration?.mcp_servers[server.name] === undefined),
    [configuration, servers],
  );
  const connectedCount = servers.filter(server => server.status === 'connected').length;
  const toolCount = servers.reduce((total, server) => total + server.tool_count, 0);

  const openServer = (name: string, config: McpServerConfig) => {
    if (expandedName === name) {
      setExpandedName(null);
      setDraft(null);
      return;
    }
    setExpandedName(name);
    setDraft(toDraft(name, config));
    setNotice(null);
  };

  const openNew = () => {
    setExpandedName('__new__');
    setDraft({ ...EMPTY_DRAFT });
    setNotice(null);
  };

  const closeEditor = () => {
    setExpandedName(null);
    setDraft(null);
  };

  const updateDraft = <K extends keyof McpDraft>(key: K, value: McpDraft[K]) => {
    setDraft(previous => previous === null ? null : { ...previous, [key]: value });
  };

  const save = async () => {
    if (draft === null) return;
    const name = draft.name.trim();
    if (name.length === 0) {
      setNotice({ text: tr('Server name is required.', '必须填写服务器名称。'), error: true });
      return;
    }
    const built = buildConfig(draft, tr);
    if ('error' in built) {
      setNotice({ text: built.error, error: true });
      return;
    }

    setSaving(true);
    setNotice(null);
    try {
      const patch: Record<string, McpServerConfig | null> = { [name]: built.config };
      if (draft.originalName !== null && draft.originalName !== name) patch[draft.originalName] = null;
      const next = await api.mcp.updateConfig({ mcp_servers: patch });
      setConfiguration(next);
      setExpandedName(name);
      setDraft(toDraft(name, next.mcp_servers[name]!));
      setNotice({ text: tr('MCP configuration saved. It will load in a new session.', 'MCP 配置已保存，新建会话后加载。') });
    } catch (cause) {
      setNotice({ text: errorMessage(cause, tr('Unable to save MCP configuration.', '无法保存 MCP 配置。')), error: true });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (name: string) => {
    if (!window.confirm(tr(`Delete MCP server “${name}”?`, `确定删除 MCP 服务器“${name}”吗？`))) return;
    setSaving(true);
    setNotice(null);
    try {
      const next = await api.mcp.updateConfig({ mcp_servers: { [name]: null } });
      setConfiguration(next);
      if (expandedName === name) closeEditor();
      setNotice({ text: tr('MCP server deleted. The current session is unchanged.', 'MCP 服务器已删除，当前会话不会改变。') });
    } catch (cause) {
      setNotice({ text: errorMessage(cause, tr('Unable to delete MCP server.', '无法删除 MCP 服务器。')), error: true });
    } finally {
      setSaving(false);
    }
  };

  const restart = async (server: McpServerStatus) => {
    setRestarting(server.id);
    setNotice(null);
    try {
      await api.mcp.restartServer(server.id);
      await loadStatus();
      setNotice({ text: tr(`Restart requested for ${server.name}.`, `已请求重启 ${server.name}。`) });
    } catch (cause) {
      setNotice({ text: errorMessage(cause, tr('Unable to restart the MCP server.', '无法重启 MCP 服务器。')), error: true });
    } finally {
      setRestarting(null);
    }
  };

  return <section className="mcp-settings" aria-label={tr('MCP servers', 'MCP 服务器')}>
    <header className="mcp-settings-heading">
      <div>
        <span>MCP</span>
        <h2>{tr('Model Context Protocol', '模型上下文协议')}</h2>
        {configuration && <code title={configuration.path}>{configuration.path}</code>}
      </div>
      <div className="mcp-settings-actions">
        <div className="mcp-settings-summary" aria-label={tr('MCP summary', 'MCP 概览')}>
          <span><strong>{connectedCount}</strong>{tr('connected', '已连接')}</span>
          <span><strong>{toolCount}</strong>{tr('tools', '工具')}</span>
          <button type="button" onClick={() => void load()} disabled={loading} title={tr('Refresh MCP', '刷新 MCP')} aria-label={tr('Refresh MCP', '刷新 MCP')}><Icon name="refresh" size={14}/></button>
        </div>
        <button type="button" className="btn btn-primary btn-compact" onClick={openNew} disabled={expandedName === '__new__'}><Icon name="plus" size={14}/>{tr('Add server', '新增服务器')}</button>
      </div>
    </header>

    {notice && <div className={`settings-notice mcp-settings-notice${notice.error ? ' error' : ''}`} role={notice.error ? 'alert' : 'status'}><Icon name={notice.error ? 'alert' : 'check'} size={15}/><span>{notice.text}</span></div>}

    {loading && configuration === null ? <div className="mcp-settings-empty"><span className="spinner"/></div> : <div className="mcp-config-list">
      {expandedName === '__new__' && draft && <McpConfigCard name={null} draft={draft} status={undefined} expanded saving={saving} onOpen={() => undefined} onChange={updateDraft} onSave={() => void save()} onCancel={closeEditor} onDelete={undefined} onRestart={undefined} tr={tr}/>} 
      {configuredEntries.map(([name, config]) => {
        const expanded = expandedName === name;
        return <McpConfigCard
          key={name}
          name={name}
          draft={expanded ? draft : toDraft(name, config)}
          status={statusByName.get(name)}
          expanded={expanded}
          saving={saving}
          onOpen={() => openServer(name, config)}
          onChange={updateDraft}
          onSave={() => void save()}
          onCancel={closeEditor}
          onDelete={() => void remove(name)}
          onRestart={statusByName.has(name) ? () => void restart(statusByName.get(name)!) : undefined}
          tr={tr}
        />;
      })}
      {configuredEntries.length === 0 && expandedName !== '__new__' && <div className="mcp-settings-empty"><Icon name="swarm" size={20}/><strong>{tr('No global MCP servers', '还没有全局 MCP 服务器')}</strong></div>}
    </div>}

    {runtimeOnlyServers.length > 0 && <section className="mcp-runtime-section">
      <header><span>{tr('Current session', '当前会话')}</span><strong>{tr('Other loaded servers', '其他已加载服务器')}</strong></header>
      <div className="mcp-runtime-list">{runtimeOnlyServers.map(server => <RuntimeServerRow key={server.id} server={server} restarting={restarting === server.id} onRestart={() => void restart(server)} tr={tr}/>)}</div>
    </section>}
  </section>;
}

function McpConfigCard({ name, draft, status, expanded, saving, onOpen, onChange, onSave, onCancel, onDelete, onRestart, tr }: {
  name: string | null;
  draft: McpDraft | null;
  status: McpServerStatus | undefined;
  expanded: boolean;
  saving: boolean;
  onOpen: () => void;
  onChange: <K extends keyof McpDraft>(key: K, value: McpDraft[K]) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: (() => void) | undefined;
  onRestart: (() => void) | undefined;
  tr: (english: string, chinese: string) => string;
}) {
  const config = draft;
  const disabled = config?.enabled === false;
  const title = name ?? tr('New MCP server', '新增 MCP 服务器');
  return <article className={`mcp-config-card${expanded ? ' expanded' : ''}${disabled ? ' disabled' : ''}`}>
    <div className="mcp-config-card-heading">
      <button type="button" className="mcp-config-card-main" onClick={onOpen} aria-expanded={expanded}>
        <span className={`mcp-server-status ${status?.status ?? (disabled ? 'disconnected' : 'unloaded')}`} />
        <span className="mcp-config-card-copy"><strong>{title}</strong><small>{config ? configSummary(config, tr) : tr('Configure a transport', '配置连接方式')}{status ? ` · ${status.tool_count} ${tr('tools', '工具')}` : ''}</small></span>
        <span className={`mcp-server-state ${status?.status ?? 'unloaded'}`}>{disabled ? tr('Disabled', '已禁用') : status ? statusLabel(status.status, tr) : tr('New session', '新会话加载')}</span>
        {name !== null && <Icon name="chevron-down" size={15}/>} 
      </button>
      {name !== null && <div className="mcp-config-card-actions">
        {onRestart && <button type="button" onClick={onRestart} title={tr('Reconnect current session', '重新连接当前会话')} aria-label={`${tr('Restart server', '重启服务器')} ${name}`}><Icon name="refresh" size={14}/></button>}
        {onDelete && <button type="button" className="danger" onClick={onDelete} title={tr('Delete server', '删除服务器')} aria-label={`${tr('Delete server', '删除服务器')} ${name}`}><Icon name="trash" size={14}/></button>}
      </div>}
    </div>
    {expanded && config && <McpEditor draft={config} saving={saving} onChange={onChange} onSave={onSave} onCancel={onCancel} tr={tr}/>} 
  </article>;
}

function McpEditor({ draft, saving, onChange, onSave, onCancel, tr }: {
  draft: McpDraft;
  saving: boolean;
  onChange: <K extends keyof McpDraft>(key: K, value: McpDraft[K]) => void;
  onSave: () => void;
  onCancel: () => void;
  tr: (english: string, chinese: string) => string;
}) {
  return <div className="mcp-config-editor">
    <div className="mcp-transport-picker" role="group" aria-label={tr('Transport', '传输方式')}>
      {(['stdio', 'http', 'sse'] as const).map(transport => <button type="button" key={transport} className={draft.transport === transport ? 'active' : ''} onClick={() => onChange('transport', transport)}>{transport === 'stdio' ? <Icon name="terminal" size={13}/> : <Icon name="globe" size={13}/>}<span>{transport.toUpperCase()}</span></button>)}
    </div>
    <div className="mcp-form-grid">
      <label><span>{tr('Server name', '服务器名称')}</span><input aria-label={tr('Server name', '服务器名称')} value={draft.name} onChange={event => onChange('name', event.target.value)} placeholder="filesystem" spellCheck={false}/></label>
      <label className="mcp-switch"><input type="checkbox" checked={draft.enabled} onChange={event => onChange('enabled', event.target.checked)}/><span><strong>{tr('Enabled', '启用')}</strong><small>{tr('Load in new sessions', '在新会话中加载')}</small></span></label>

      {draft.transport === 'stdio' ? <>
        <label className="mcp-form-wide"><span>{tr('Command', '启动命令')}</span><input aria-label={tr('Command', '启动命令')} value={draft.command} onChange={event => onChange('command', event.target.value)} placeholder="npx" spellCheck={false}/></label>
        <label className="mcp-form-wide"><span>{tr('Arguments (one per line)', '参数（每行一个）')}</span><textarea aria-label={tr('Arguments (one per line)', '参数（每行一个）')} value={draft.args} onChange={event => onChange('args', event.target.value)} placeholder={'-y\n@modelcontextprotocol/server-filesystem\nC:\\workspace'} spellCheck={false}/></label>
        <label><span>{tr('Working directory', '工作目录')}</span><input aria-label={tr('Working directory', '工作目录')} value={draft.cwd} onChange={event => onChange('cwd', event.target.value)} placeholder="C:\\workspace" spellCheck={false}/></label>
        <label className="mcp-form-wide"><span>{tr('Environment variables (KEY=VALUE)', '环境变量（KEY=VALUE）')}</span><textarea aria-label={tr('Environment variables (KEY=VALUE)', '环境变量（KEY=VALUE）')} value={draft.env} onChange={event => onChange('env', event.target.value)} placeholder="API_TOKEN=..." spellCheck={false}/></label>
      </> : <>
        <label className="mcp-form-wide"><span>URL</span><input aria-label="MCP URL" value={draft.url} onChange={event => onChange('url', event.target.value)} placeholder={draft.transport === 'sse' ? 'https://example.com/sse' : 'https://example.com/mcp'} spellCheck={false}/></label>
        <label><span>{tr('Bearer token environment variable', 'Bearer Token 环境变量')}</span><input aria-label={tr('Bearer token environment variable', 'Bearer Token 环境变量')} value={draft.bearerTokenEnvVar} onChange={event => onChange('bearerTokenEnvVar', event.target.value)} placeholder="MCP_ACCESS_TOKEN" spellCheck={false}/></label>
        <label className="mcp-form-wide"><span>{tr('Headers (Name: Value)', '请求头（Name: Value）')}</span><textarea aria-label={tr('Headers (Name: Value)', '请求头（Name: Value）')} value={draft.headers} onChange={event => onChange('headers', event.target.value)} placeholder="X-Workspace: production" spellCheck={false}/></label>
      </>}

      <label><span>{tr('Startup timeout (ms)', '启动超时（毫秒）')}</span><input type="number" min="1" step="1000" value={draft.startupTimeoutMs} onChange={event => onChange('startupTimeoutMs', event.target.value)}/></label>
      <label><span>{tr('Tool timeout (ms)', '工具超时（毫秒）')}</span><input type="number" min="1" step="1000" value={draft.toolTimeoutMs} onChange={event => onChange('toolTimeoutMs', event.target.value)} placeholder={tr('Server default', '服务器默认')}/></label>
      <label><span>{tr('Enabled tools (one per line)', '启用工具（每行一个）')}</span><textarea value={draft.enabledTools} onChange={event => onChange('enabledTools', event.target.value)} placeholder={tr('All tools', '全部工具')} spellCheck={false}/></label>
      <label><span>{tr('Disabled tools (one per line)', '禁用工具（每行一个）')}</span><textarea value={draft.disabledTools} onChange={event => onChange('disabledTools', event.target.value)} placeholder="delete_file" spellCheck={false}/></label>
    </div>
    <footer><button type="button" className="btn btn-secondary btn-compact" onClick={onCancel}>{tr('Cancel', '取消')}</button><button type="button" className="btn btn-primary btn-compact" onClick={onSave} disabled={saving}>{saving ? tr('Saving...', '保存中...') : tr('Save server', '保存服务器')}</button></footer>
  </div>;
}

function RuntimeServerRow({ server, restarting, onRestart, tr }: { server: McpServerStatus; restarting: boolean; onRestart: () => void; tr: (english: string, chinese: string) => string }) {
  return <div className="mcp-runtime-row"><span className={`mcp-server-status ${server.status}`}/><span><strong>{server.name}</strong><small>{server.transport.toUpperCase()} · {server.tool_count} {tr('tools', '工具')}</small></span><span className={`mcp-server-state ${server.status}`}>{statusLabel(server.status, tr)}</span><button type="button" onClick={onRestart} disabled={restarting} title={tr('Reconnect current session', '重新连接当前会话')} aria-label={`${tr('Restart server', '重启服务器')} ${server.name}`}><Icon name="refresh" size={14}/></button></div>;
}

function toDraft(name: string, config: McpServerConfig): McpDraft {
  const common = {
    originalName: name,
    name,
    transport: config.transport,
    enabled: config.enabled !== false,
    startupTimeoutMs: config.startupTimeoutMs === undefined ? '' : String(config.startupTimeoutMs),
    toolTimeoutMs: config.toolTimeoutMs === undefined ? '' : String(config.toolTimeoutMs),
    enabledTools: config.enabledTools?.join('\n') ?? '',
    disabledTools: config.disabledTools?.join('\n') ?? '',
  };
  if (config.transport === 'stdio') {
    return {
      ...EMPTY_DRAFT,
      ...common,
      command: config.command,
      args: config.args?.join('\n') ?? '',
      env: formatPairs(config.env, '='),
      cwd: config.cwd ?? '',
      executor: config.executor ?? 'local',
    };
  }
  return {
    ...EMPTY_DRAFT,
    ...common,
    url: config.url,
    headers: formatPairs(config.headers, ': '),
    bearerTokenEnvVar: config.bearerTokenEnvVar ?? '',
  };
}

function buildConfig(draft: McpDraft, tr: (english: string, chinese: string) => string): { config: McpServerConfig } | { error: string } {
  const startupTimeout = parsePositiveInteger(draft.startupTimeoutMs);
  const toolTimeout = parsePositiveInteger(draft.toolTimeoutMs);
  if (startupTimeout === null || toolTimeout === null) return { error: tr('Timeouts must be positive whole numbers.', '超时时间必须是大于 0 的整数。') };
  const enabledTools = splitLines(draft.enabledTools);
  const disabledTools = splitLines(draft.disabledTools);
  const common = {
    enabled: draft.enabled,
    startupTimeoutMs: startupTimeout,
    toolTimeoutMs: toolTimeout,
    enabledTools: enabledTools.length > 0 ? enabledTools : undefined,
    disabledTools: disabledTools.length > 0 ? disabledTools : undefined,
  };
  if (draft.transport === 'stdio') {
    const command = draft.command.trim();
    if (command.length === 0) return { error: tr('A stdio server requires a command.', 'stdio 服务器必须填写启动命令。') };
    const env = parsePairs(draft.env, '=');
    if ('error' in env) return { error: tr(`Invalid environment variable: ${env.error}`, `环境变量格式错误：${env.error}`) };
    return { config: {
      transport: 'stdio',
      command,
      args: splitLines(draft.args),
      env: Object.keys(env.value).length > 0 ? env.value : undefined,
      cwd: draft.cwd.trim() || undefined,
      executor: draft.executor,
      ...common,
    } };
  }
  const url = draft.url.trim();
  try { new URL(url); } catch { return { error: tr('Enter a valid MCP URL.', '请输入有效的 MCP URL。') }; }
  const headers = parsePairs(draft.headers, ':');
  if ('error' in headers) return { error: tr(`Invalid header: ${headers.error}`, `请求头格式错误：${headers.error}`) };
  return { config: {
    transport: draft.transport,
    url,
    headers: Object.keys(headers.value).length > 0 ? headers.value : undefined,
    bearerTokenEnvVar: draft.bearerTokenEnvVar.trim() || undefined,
    ...common,
  } };
}

function parsePositiveInteger(value: string): number | undefined | null {
  if (value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
}

function parsePairs(value: string, separator: '=' | ':'): { value: Record<string, string> } | { error: string } {
  const result: Record<string, string> = {};
  for (const line of splitLines(value)) {
    const index = line.indexOf(separator);
    if (index <= 0) return { error: line };
    const key = line.slice(0, index).trim();
    const entryValue = line.slice(index + 1).trim();
    if (key.length === 0) return { error: line };
    result[key] = entryValue;
  }
  return { value: result };
}

function formatPairs(value: Record<string, string> | undefined, separator: string): string {
  return Object.entries(value ?? {}).map(([key, item]) => `${key}${separator}${item}`).join('\n');
}

function configSummary(draft: McpDraft, tr: (english: string, chinese: string) => string): string {
  if (draft.transport === 'stdio') return `${draft.transport.toUpperCase()} · ${draft.command || tr('No command', '未填写命令')}`;
  return `${draft.transport.toUpperCase()} · ${draft.url || tr('No URL', '未填写 URL')}`;
}

function statusLabel(status: McpServerStatus['status'], tr: (english: string, chinese: string) => string) {
  switch (status) {
    case 'connected': return tr('Connected', '已连接');
    case 'connecting': return tr('Connecting', '连接中');
    case 'disconnected': return tr('Disconnected', '未连接');
    case 'error': return tr('Error', '错误');
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
