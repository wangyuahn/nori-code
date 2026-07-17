import { useEffect, useState } from 'react';
import type { SwarmConnectionState } from '../hooks/useApi';
import { api, type BackgroundTask, type ModelCatalogItem, type Session, type SwarmStatus } from '../api/client';
import { useI18n } from '../i18n';
import { MarkdownView } from './MarkdownView';
import { Icon } from './Icon';

export function SwarmPanel({
  swarm,
  sessionId,
  sessions,
  models = [],
  backgroundState,
}: {
  swarm: SwarmConnectionState;
  sessionId?: string | null;
  sessions: Session[];
  models?: ModelCatalogItem[];
  backgroundState?: BackgroundTasksState;
}) {
  const { tr } = useI18n();
  const { swarmStatuses, connected, error } = swarm;
  const localBackground = useBackgroundTasks(backgroundState === undefined ? sessionId : null);
  const background = backgroundState ?? localBackground;
  const runs = Array.from(swarmStatuses.values())
    .sort((left, right) => {
      const timeDifference = Date.parse(right.started_at ?? '') - Date.parse(left.started_at ?? '');
      return Number.isNaN(timeDifference) || timeDifference === 0
        ? (right.round ?? 0) - (left.round ?? 0)
        : timeDifference;
    });
  const currentRuns = runs.filter(run => run.session_id === sessionId);
  const swarmTaskIds = swarmTaskIdsForRuns(currentRuns);
  const backgroundTasks = background.tasks.filter(task => !swarmTaskIds.has(task.id));
  const hasCurrentBackground = background.loading || background.error !== null || backgroundTasks.length > 0;
  const projectGroups = ensureCurrentSessionGroup(
    groupSwarmRunsByProject(runs, sessions),
    sessions,
    sessionId,
    hasCurrentBackground,
  );
  const hasActivity = projectGroups.length > 0;

  return (
    <div className="swarm-panel">
      <header className="swarm-panel-header">
        <div>
          <strong>{tr('Agent activity', '智能体活动')}</strong>
          <span>{tr('Live agents grouped by project and conversation', '按项目与会话查看智能体、实时输出和 token 消耗')}</span>
        </div>
        <div className="live-indicator">
          <span className={`status-dot ${connected ? 'active' : 'error'}`} />
          {connected ? tr('Live', '已连接') : tr('Offline', '离线')}
        </div>
      </header>
      <CustomAgentsPanel models={models} />

      {!hasActivity ? (
        <div className="empty-state">
          <div className="empty-state-icon">◇</div>
          <div>
            {error
              ? tr('Unable to receive swarm updates', '无法接收智能体协作更新')
              : tr('No agent activity', '暂无智能体活动')}
          </div>
          <div style={{ color: 'var(--nori-text-muted)', fontSize: 12, marginTop: 4 }}>
            {error
              ? tr('Reconnect to the server to resume live updates.', '请重新连接服务器以恢复实时更新。')
              : tr('Regular agents and swarm agents appear here when they are launched.', '普通 Agent 与 Swarm Agent 启动后都会显示在这里。')}
          </div>
        </div>
      ) : (
        <div className="swarm-project-list">
          {projectGroups.map(project => (
            <SwarmProject
              key={project.key}
              project={project}
              currentSessionId={sessionId}
              background={background}
              backgroundTasks={backgroundTasks}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface CustomAgentDraft {
  name: string;
  description: string;
  role: string;
  base_profile: 'orchestrator' | 'coder' | 'explore' | 'plan';
  model: string;
  permissions: Record<'read' | 'write' | 'shell' | 'web' | 'delegate', boolean>;
}

const DEFAULT_CUSTOM_AGENT_PERMISSIONS: CustomAgentDraft['permissions'] = { read: true, write: true, shell: true, web: false, delegate: false };

function CustomAgentsPanel({ models }: { models: ModelCatalogItem[] }) {
  const { tr } = useI18n();
  const [agents, setAgents] = useState<CustomAgentDraft[]>([]);
  const [draft, setDraft] = useState<CustomAgentDraft>({ name: '', description: '', role: '', base_profile: 'coder', model: '', permissions: { ...DEFAULT_CUSTOM_AGENT_PERMISSIONS } });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let cancelled = false;
    void api.getConfig().then(config => {
      if (cancelled) return;
      const configured = typeof config.custom_agents === 'object' && config.custom_agents !== null ? config.custom_agents as Record<string, Record<string, unknown>> : {};
      setAgents(Object.entries(configured).flatMap(([name, value]) => value.enabled === false ? [] : [{
        name,
        description: typeof value.description === 'string' ? value.description : '',
        role: typeof value.role === 'string' ? value.role : '',
        base_profile: isBaseProfile(value.baseProfile ?? value.base_profile) ? (value.baseProfile ?? value.base_profile) as CustomAgentDraft['base_profile'] : 'coder',
        model: typeof value.model === 'string' ? value.model : '',
        permissions: parseAgentPermissions(value.permissions),
      }]));
    }).catch(error => setNotice(error instanceof Error ? error.message : String(error)));
    return () => { cancelled = true; };
  }, []);

  const saveAgents = async (next: CustomAgentDraft[], disabledName?: string) => {
    setSaving(true); setNotice('');
    try {
      const custom_agents = Object.fromEntries(next.map(agent => [agent.name, {
        description: agent.description,
        role: agent.role,
        base_profile: agent.base_profile,
        model: agent.model.length > 0 ? agent.model : undefined,
        enabled: true,
        permissions: agent.permissions,
      }]));
      if (disabledName) custom_agents[disabledName] = { description: 'Disabled custom agent', role: 'Disabled', base_profile: 'coder', model: undefined, enabled: false, permissions: DEFAULT_CUSTOM_AGENT_PERMISSIONS };
      await api.updateConfig({ custom_agents });
      setAgents(next);
      setNotice(tr('Custom agents saved. Active sessions now use the updated roles.', '自定义 Agent 已保存，当前会话已使用更新后的角色。'));
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  };

  const add = () => {
    const normalized = { ...draft, name: draft.name.trim(), description: draft.description.trim(), role: draft.role.trim() };
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(normalized.name) || !normalized.description || !normalized.role) {
      setNotice(tr('Use a 2-32 character lowercase ID and complete the description and role.', '请使用 2-32 位小写 ID，并填写描述与角色。'));
      return;
    }
    const next = [...agents.filter(agent => agent.name !== normalized.name), normalized];
    void saveAgents(next);
    setDraft({ name: '', description: '', role: '', base_profile: 'coder', model: '', permissions: { ...DEFAULT_CUSTOM_AGENT_PERMISSIONS } });
  };

  return <section className="custom-agents-panel"><header><div><strong>{tr('Custom agents', '自定义 Agent')}</strong><span>{tr('Roles available to Agent and AgentSwarm through subagent_type.', '主模型可通过 subagent_type 在 Agent 与 AgentSwarm 中指定这些角色。')}</span></div></header>
    <div className="custom-agent-list">{agents.map(agent => <article key={agent.name}><div><strong>{agent.name}</strong><small>{agent.base_profile} · {agent.description}</small></div><span className="custom-agent-model-preview" title={agent.model.length > 0 ? agent.model : tr('Inherits the parent Agent model', '继承父 Agent 模型')}>{customAgentModelLabel(agent.model, models, tr)}</span><span className="custom-agent-permission-preview" title={permissionSummary(agent.permissions, tr)}>{tr('Permissions', '权限')}</span><button type="button" onClick={() => void saveAgents(agents.filter(item => item.name !== agent.name), agent.name)} disabled={saving} title={tr('Remove agent', '删除 Agent')}><Icon name="trash" size={13}/></button></article>)}</div>
    <div className="custom-agent-form"><input value={draft.name} onChange={event => setDraft(value => ({ ...value, name: event.target.value }))} placeholder="reviewer" aria-label={tr('Agent ID', 'Agent ID')}/><select value={draft.base_profile} title={baseProfileSummary(draft.base_profile, tr)} aria-label={tr('Base profile', '基础角色')} onChange={event => { const base_profile = event.target.value as CustomAgentDraft['base_profile']; setDraft(value => ({ ...value, base_profile, permissions: defaultPermissionsForBase(base_profile) })); }}><option value="coder">coder</option><option value="explore">explore</option><option value="plan">plan</option><option value="orchestrator">orchestrator</option></select><select value={draft.model} aria-label={tr('Agent model', 'Agent 模型')} title={tr('Choose a model for this Agent or inherit the parent Agent model.', '为这个 Agent 指定模型，或继承父 Agent 模型。')} onChange={event => setDraft(value => ({ ...value, model: event.target.value }))}><option value="">{tr('Inherit parent model', '继承父 Agent 模型')}</option>{draft.model && !models.some(model => model.model === draft.model) && <option value={draft.model}>{draft.model} · {tr('Unavailable', '不可用')}</option>}{models.map(model => <option key={model.model} value={model.model}>{modelDisplayName(model)} · {model.provider}</option>)}</select><input value={draft.description} onChange={event => setDraft(value => ({ ...value, description: event.target.value }))} placeholder={tr('When should the main model use it?', '主模型什么时候使用它？')}/><textarea value={draft.role} onChange={event => setDraft(value => ({ ...value, role: event.target.value }))} placeholder={tr('Role, constraints, and expected output', '角色、约束和预期输出')}/><div className="custom-agent-permissions">{(Object.keys(draft.permissions) as Array<keyof CustomAgentDraft['permissions']>).map(key => <label key={key} title={permissionLabel(key, tr).description}><input type="checkbox" checked={draft.permissions[key]} onChange={event => setDraft(value => ({ ...value, permissions: { ...value.permissions, [key]: event.target.checked } }))}/><span>{permissionLabel(key, tr).label}</span></label>)}</div><button type="button" onClick={add} disabled={saving}>{saving ? tr('Saving...', '保存中...') : tr('Add agent', '添加 Agent')}</button></div>
    {notice && <p className="custom-agent-notice">{notice}</p>}
  </section>;
}

function isBaseProfile(value: unknown): value is CustomAgentDraft['base_profile'] {
  return value === 'orchestrator' || value === 'coder' || value === 'explore' || value === 'plan';
}

function modelDisplayName(model: ModelCatalogItem): string {
  const displayName = model.display_name?.trim();
  return displayName && displayName.length > 0 ? displayName : model.model;
}

function customAgentModelLabel(
  modelAlias: string,
  models: ModelCatalogItem[],
  tr: (en: string, zh: string) => string,
): string {
  if (!modelAlias) return tr('Inherited model', '继承模型');
  const model = models.find(item => item.model === modelAlias);
  return model === undefined
    ? modelAlias
    : `${modelDisplayName(model)} · ${model.provider}`;
}

function parseAgentPermissions(value: unknown): CustomAgentDraft['permissions'] {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return Object.fromEntries(Object.entries(DEFAULT_CUSTOM_AGENT_PERMISSIONS).map(([key, fallback]) => [key, typeof record[key] === 'boolean' ? record[key] : fallback])) as CustomAgentDraft['permissions'];
}

function permissionLabel(key: keyof CustomAgentDraft['permissions'], tr: (en: string, zh: string) => string) {
  return {
    read: { label: tr('Read', '读取'), description: tr('Read, search, media, and memory lookup.', '读取、搜索、媒体与记忆检索。') },
    write: { label: tr('Write', '写入'), description: tr('Edit files and write project memory or plans.', '编辑文件并写入项目记忆或计划。') },
    shell: { label: tr('Terminal', '终端'), description: tr('Run shell commands and inspect background tasks.', '运行终端命令并查看后台任务。') },
    web: { label: tr('Web', '联网'), description: tr('Search the web and fetch URLs.', '联网搜索并读取 URL。') },
    delegate: { label: tr('Delegate', '委派'), description: tr('Launch Agent or AgentSwarm children.', '继续调用 Agent 或 AgentSwarm。') },
  }[key];
}

function permissionSummary(permissions: CustomAgentDraft['permissions'], tr: (en: string, zh: string) => string): string {
  return (Object.keys(permissions) as Array<keyof typeof permissions>).filter(key => permissions[key]).map(key => permissionLabel(key, tr).label).join(' · ') || tr('No tool permissions', '无工具权限');
}

function baseProfileSummary(profile: CustomAgentDraft['base_profile'], tr: (en: string, zh: string) => string): string {
  if (profile === 'orchestrator') return tr('Read-only planner that can delegate work to other agents.', '只读规划与任务拆分，可继续委派给其他 Agent。');
  if (profile === 'coder') return tr('Direct implementation worker with code and terminal tools.', '直接实现任务，默认具备代码与终端工具。');
  if (profile === 'explore') return tr('Read-only codebase explorer.', '只读代码库探索角色。');
  return tr('Read-only planning role without terminal access.', '只读规划角色，不使用终端。');
}

function defaultPermissionsForBase(profile: CustomAgentDraft['base_profile']): CustomAgentDraft['permissions'] {
  if (profile === 'orchestrator') return { read: true, write: false, shell: false, web: true, delegate: true };
  if (profile === 'explore') return { read: true, write: false, shell: false, web: true, delegate: false };
  if (profile === 'plan') return { read: true, write: false, shell: false, web: false, delegate: false };
  return { ...DEFAULT_CUSTOM_AGENT_PERMISSIONS };
}

export interface SwarmSessionGroup {
  key: string;
  sessionId?: string;
  title: string;
  runs: SwarmStatus[];
}

export interface SwarmProjectGroup {
  key: string;
  path?: string;
  sessions: SwarmSessionGroup[];
}

export interface BackgroundTasksState {
  tasks: BackgroundTask[];
  loading: boolean;
  error: string | null;
  markCancelled: (taskId: string) => void;
}

export function groupSwarmRunsByProject(
  runs: SwarmStatus[],
  sessions: Session[],
): SwarmProjectGroup[] {
  const sessionById = new Map(sessions.map(session => [session.id, session]));
  const projects = new Map<string, SwarmProjectGroup>();
  const sessionGroups = new Map<string, SwarmSessionGroup>();

  for (const run of runs) {
    const session = run.session_id ? sessionById.get(run.session_id) : undefined;
    const cwd = session?.metadata?.cwd?.trim().replaceAll('\\', '/').replace(/\/+$/, '');
    const projectKey = cwd || '__unassigned__';
    let project = projects.get(projectKey);
    if (project === undefined) {
      project = { key: projectKey, path: cwd, sessions: [] };
      projects.set(projectKey, project);
    }

    const sessionKey = `${projectKey}:${run.session_id ?? '__unknown__'}`;
    let sessionGroup = sessionGroups.get(sessionKey);
    if (sessionGroup === undefined) {
      sessionGroup = {
        key: sessionKey,
        sessionId: run.session_id,
        title: session?.title || run.session_id?.slice(0, 8) || 'Unknown conversation',
        runs: [],
      };
      sessionGroups.set(sessionKey, sessionGroup);
      project.sessions.push(sessionGroup);
    }
    sessionGroup.runs.push(run);
  }

  return [...projects.values()];
}

export function ensureCurrentSessionGroup(
  groups: SwarmProjectGroup[],
  sessions: Session[],
  sessionId: string | null | undefined,
  required: boolean,
): SwarmProjectGroup[] {
  if (!required || !sessionId || groups.some(project => project.sessions.some(group => group.sessionId === sessionId))) {
    return groups;
  }
  const session = sessions.find(item => item.id === sessionId);
  const path = session?.metadata?.cwd?.trim().replaceAll('\\', '/').replace(/\/+$/, '');
  const projectKey = path || '__unassigned__';
  const result = groups.map(project => ({ ...project, sessions: [...project.sessions] }));
  let project = result.find(item => item.key === projectKey);
  if (project === undefined) {
    project = { key: projectKey, path, sessions: [] };
    result.push(project);
  }
  project.sessions.push({
    key: `${projectKey}:${sessionId}`,
    sessionId,
    title: session?.title || sessionId.slice(0, 8),
    runs: [],
  });
  return result;
}

function SwarmProject({
  project,
  currentSessionId,
  background,
  backgroundTasks,
}: {
  project: SwarmProjectGroup;
  currentSessionId?: string | null;
  background: BackgroundTasksState;
  backgroundTasks: BackgroundTask[];
}) {
  const { tr } = useI18n();
  const name = project.path?.split('/').filter(Boolean).at(-1)
    ?? tr('Unassigned project', '未指定项目');
  const path = project.path ?? tr('Project information unavailable', '项目路径不可用');

  return <section className="swarm-project-group">
    <header className="swarm-project-heading" title={path}>
      <span><strong>{name}</strong><small>{path}</small></span>
      <small>{project.sessions.length} {tr('conversations', '个会话')}</small>
    </header>
    <div className="swarm-session-list">
      {project.sessions.map(group => (
        <SwarmSession
          key={group.key}
          group={group}
          current={group.sessionId === currentSessionId}
          background={group.sessionId === currentSessionId ? background : undefined}
          backgroundTasks={group.sessionId === currentSessionId ? backgroundTasks : []}
        />
      ))}
    </div>
  </section>;
}

function SwarmSession({
  group,
  current,
  background,
  backgroundTasks,
}: {
  group: SwarmSessionGroup;
  current: boolean;
  background?: BackgroundTasksState;
  backgroundTasks: BackgroundTask[];
}) {
  const { tr } = useI18n();
  const rounds = groupSwarmRuns(group.runs);
  const treeRuns = collectSwarmTreeRuns([...rounds.values()].flat(), group.runs);
  const progress = treeRuns.map(swarmRunProgress);
  const backgroundStatuses = backgroundTasks.map(task => backgroundTaskSwarmStatus(task.status));
  const statuses = [...progress.map(item => item.status), ...backgroundStatuses];
  const status = statuses.length > 0
    ? aggregateSwarmStatus(statuses)
    : background?.error ? 'failed' : background?.loading ? 'pending' : 'done';
  const running = status === 'running' || status === 'pending';
  const [open, setOpen] = useState(current || running);

  useEffect(() => {
    if (current || running) setOpen(true);
  }, [current, running]);

  return <details
    className={`swarm-session-group${current ? ' current' : ''}`}
    open={open}
    onToggle={event => setOpen(event.currentTarget.open)}
  >
    <summary>
      <span className={`status-dot ${status}`}/>
      <span><strong>{group.title}</strong><small>{group.sessionId ?? tr('Unknown conversation', '未知会话')}</small></span>
      <span className={`badge badge-${swarmStatusBadge(status)}`}>{swarmStatusLabel(status, tr)}</span>
    </summary>
    <div className="swarm-session-body">
      {rounds.size > 0 && <div className="swarm-round-list">
        {Array.from(rounds.entries()).map(([round, roundRuns]) => (
          <SwarmRound key={round} round={round} runs={roundRuns} allRuns={group.runs}/>
        ))}
      </div>}
      {current && group.sessionId && background && (
        <BackgroundTasksPanel sessionId={group.sessionId} state={background} tasks={backgroundTasks}/>
      )}
    </div>
  </details>;
}

export function groupSwarmRuns(runs: SwarmStatus[]): Map<number, SwarmStatus[]> {
  const rounds = new Map<number, SwarmStatus[]>();
  const runIds = new Set(runs.map(run => run.swarm_id));
  for (const run of runs.filter(item => !item.parent_swarm_id || !runIds.has(item.parent_swarm_id))) {
    const round = run.round ?? 1;
    rounds.set(round, [...(rounds.get(round) ?? []), run]);
  }
  return rounds;
}

export function collectSwarmTreeRuns(roots: SwarmStatus[], allRuns: SwarmStatus[]): SwarmStatus[] {
  const children = new Map<string, SwarmStatus[]>();
  for (const run of allRuns) {
    if (!run.parent_swarm_id) continue;
    children.set(run.parent_swarm_id, [...(children.get(run.parent_swarm_id) ?? []), run]);
  }
  const result: SwarmStatus[] = [];
  const visited = new Set<string>();
  const visit = (run: SwarmStatus) => {
    if (visited.has(run.swarm_id)) return;
    visited.add(run.swarm_id);
    result.push(run);
    for (const child of children.get(run.swarm_id) ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  return result;
}

export function swarmTaskIdsForRuns(runs: readonly SwarmStatus[]): Set<string> {
  return new Set(runs.flatMap(run => [
    ...(run.task_id ? [run.task_id] : []),
    ...(run.tasks?.flatMap(task => [task.id, ...(task.agent_id ? [task.agent_id] : [])]) ?? []),
  ]));
}

export function runningSwarmAgents(runs: readonly SwarmStatus[]): { ids: Set<string>; untracked: number } {
  const ids = new Set<string>();
  let untracked = 0;
  for (const run of runs) {
    if (!run.tasks) {
      if (swarmRunProgress(run).running) untracked++;
      continue;
    }
    for (const task of run.tasks) {
      if (task.status === 'running') ids.add(task.agent_id ?? task.id);
    }
  }
  return { ids, untracked };
}

export function swarmRunProgress(run: SwarmStatus): {
  total: number;
  completed: number;
  running: boolean;
  status: SwarmStatus['status'];
} {
  const tasks = run.tasks ?? [];
  const total = Math.max(run.task_count, tasks.length, 1);
  const completedFromTasks = tasks.filter(task => isTaskFinished(task.status)).length;
  const explicitlyFinished = run.status === 'done' || run.status === 'failed' || run.status === 'stopped';
  const tasksFinished = tasks.length >= total && completedFromTasks >= total;
  const completed = explicitlyFinished
    ? total
    : Math.min(total, Math.max(run.completed_count, completedFromTasks));
  const failed = run.status === 'failed' || tasks.some(task => task.status === 'failed');
  const stopped = run.status === 'stopped'
    || (!failed && tasks.some(task => task.status === 'cancelled' || task.status === 'stopped'));
  const status = explicitlyFinished || tasksFinished
    ? (stopped ? 'stopped' : failed ? 'failed' : 'done')
    : run.status;
  return { total, completed, running: status === 'running' || status === 'pending', status };
}

export function aggregateSwarmStatus(
  statuses: readonly SwarmStatus['status'][],
): SwarmStatus['status'] {
  if (statuses.some(status => status === 'running')) return 'running';
  if (statuses.some(status => status === 'pending')) return 'pending';
  if (statuses.some(status => status === 'paused')) return 'paused';
  if (statuses.some(status => status === 'failed')) return 'failed';
  if (statuses.some(status => status === 'stopped')) return 'stopped';
  return 'done';
}

function SwarmRound({ round, runs, allRuns }: { round: number; runs: SwarmStatus[]; allRuns: SwarmStatus[] }) {
  const { tr } = useI18n();
  const treeRuns = collectSwarmTreeRuns(runs, allRuns);
  const progressByRun = treeRuns.map(swarmRunProgress);
  const status = aggregateSwarmStatus(progressByRun.map(progress => progress.status));
  const running = status === 'running' || status === 'pending';
  const [open, setOpen] = useState(running);
  const agentCount = progressByRun.reduce((total, progress) => total + progress.total, 0);
  const completedCount = progressByRun.reduce((total, progress) => total + progress.completed, 0);
  const tokens = treeRuns.reduce((total, run) => total + swarmRunTokens(run), 0);
  const hasLiveTokens = treeRuns.some(run => run.tasks?.some(task => (task.live_output_tokens ?? 0) > 0));

  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);

  return <details className={`swarm-round swarm-round-${status}${running ? ' running' : ''}`} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>
      <span className={`status-dot ${status}`}/>
      <span className="swarm-round-copy"><strong>{tr(`Round ${round}`, `第 ${round} 轮`)}</strong><small>{completedCount}/{agentCount} {tr('agents finished', '个智能体已结束')}</small></span>
      <span className="swarm-round-meta">{tokens > 0 && <small>{hasLiveTokens ? '~' : ''}{tokens.toLocaleString()} tokens</small>}<span className={`badge badge-${swarmStatusBadge(status)}`}>{swarmStatusLabel(status, tr)}</span></span>
    </summary>
    <div className="swarm-round-body">{runs.map(run => <SwarmRun key={run.swarm_id} run={run} allRuns={allRuns}/>)}</div>
  </details>;
}

function SwarmRun({ run, allRuns }: { run: SwarmStatus; allRuns: SwarmStatus[] }) {
  const { tr } = useI18n();
  const runProgress = swarmRunProgress(run);
  const progress = Math.round((runProgress.completed / runProgress.total) * 100);
  const tasks = run.tasks ?? [];
  const childRuns = allRuns.filter(child => child.parent_swarm_id === run.swarm_id);
  const taskAgentIds = new Set(tasks.flatMap(task => task.agent_id ? [task.agent_id] : []));
  const unattachedChildren = childRuns.filter(child => !child.owner_agent_id || !taskAgentIds.has(child.owner_agent_id));
  const tokens = swarmRunTokens(run);
  const hasLiveTokens = tasks.some(task => (task.live_output_tokens ?? 0) > 0);
  const [guidance, setGuidance] = useState('');
  const [busy, setBusy] = useState<'stop' | 'pause' | 'guide' | 'resume' | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const controllable = runProgress.status === 'running'
    || runProgress.status === 'pending'
    || runProgress.status === 'paused';

  const control = async (action: 'stop' | 'pause' | 'guide' | 'resume') => {
    if (busy !== null) return;
    if (action === 'stop' && !window.confirm(tr('Stop this swarm?', '停止这个智能体协作任务吗？'))) return;
    setBusy(action);
    setControlError(null);
    try {
      await api.swarm.control(run.swarm_id, action, guidance);
      if (action === 'guide' || action === 'resume') setGuidance('');
    } catch (error) {
      setControlError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return <section className={`swarm-run swarm-run-${runProgress.status}`}>
    <header>
      <span className={`status-dot ${runProgress.status}`}/>
      <span><strong>{run.description || run.swarm_id}</strong><small>{run.owner_agent_id === 'main' ? tr('Started by Nori', '由 Nori 发起') : tr('Started by an agent', '由智能体发起')}</small></span>
      <span className="swarm-run-stats">
        <small>{runProgress.completed}/{runProgress.total}</small>
        {tokens > 0 && <small>{hasLiveTokens ? '~' : ''}{tokens.toLocaleString()} tokens</small>}
        {controllable && <span className="swarm-run-controls">
          {runProgress.status === 'paused'
            ? <button type="button" onClick={() => void control('resume')} disabled={busy !== null} title={tr('Resume swarm', '恢复协作')}><Icon name="play" size={12}/></button>
            : <button type="button" onClick={() => void control('pause')} disabled={busy !== null} title={tr('Pause swarm', '暂停协作')}><Icon name="pause" size={12}/></button>}
          <button type="button" className="danger" onClick={() => void control('stop')} disabled={busy !== null} title={tr('Stop swarm', '停止协作')}><Icon name="stop" size={11}/></button>
        </span>}
      </span>
    </header>
    <div className="swarm-run-progress"><i style={{ width: `${progress}%` }}/></div>
    {runProgress.status === 'paused' && <div className="swarm-guidance">
      <input value={guidance} onChange={event => setGuidance(event.target.value)} placeholder={tr('Add guidance before resuming', '在恢复前追加引导指令')} disabled={busy !== null}/>
      <button type="button" onClick={() => void control('guide')} disabled={!guidance.trim() || busy !== null}>{busy === 'guide' ? tr('Adding…', '添加中…') : tr('Add', '追加')}</button>
    </div>}
    {controlError && <div className="swarm-control-error">{controlError}</div>}
    <div className="swarm-task-items">
      {tasks.length > 0
        ? tasks.map(task => {
          const children = childRuns.filter(child => child.owner_agent_id === task.agent_id);
          return <div className="swarm-task-branch" key={task.id}><TaskPreview task={task}/>{children.length > 0 && <div className="swarm-child-runs">{children.map(child => <SwarmRun key={child.swarm_id} run={child} allRuns={allRuns}/>)}</div>}</div>;
        })
        : <PreviewNotice kind="loading" text={tr('Waiting for agents to start…', '正在等待智能体启动…')}/>}
      {unattachedChildren.length > 0 && <div className="swarm-child-runs swarm-child-runs-unattached">{unattachedChildren.map(child => <SwarmRun key={child.swarm_id} run={child} allRuns={allRuns}/>)}</div>}
    </div>
  </section>;
}

export function useBackgroundTasks(sessionId: string | null | undefined): BackgroundTasksState {
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  const [loading, setLoading] = useState(Boolean(sessionId));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setTasks([]);
    setError(null);
    setLoading(Boolean(sessionId));
    if (!sessionId) return () => { cancelled = true; };

    const refresh = async () => {
      try {
        const result = await api.sessions.tasks.list(sessionId);
        if (!cancelled) {
          setTasks(result.items);
          setError(null);
        }
      } catch (error) {
        if (!cancelled) setError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(() => void refresh(), 2_000);
        }
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId]);

  return {
    tasks,
    loading,
    error,
    markCancelled: (taskId) => setTasks(previous => previous.map(item =>
      item.id === taskId ? { ...item, status: 'cancelled' } : item,
    )),
  };
}

function BackgroundTasksPanel({
  sessionId,
  state,
  tasks,
}: {
  sessionId: string;
  state: BackgroundTasksState;
  tasks: BackgroundTask[];
}) {
  const { tr } = useI18n();
  if (!state.loading && !state.error && tasks.length === 0) return null;
  return <section className="background-tasks-panel"><header><div><strong>{tr('Agents and background tasks', 'Agent 与后台任务')}</strong><span>{tr('Regular agents and non-swarm tool jobs', '普通 Agent 与非 Swarm 工具任务')}</span></div><small>{tasks.filter(task => task.status === 'running').length} {tr('running', '运行中')}</small></header>{state.loading && <PreviewNotice kind="loading" text={tr('Loading background agents…', '正在加载后台 Agent…')}/>} {state.error && <PreviewNotice kind="error" text={tr('Unable to load background tasks.', '无法加载后台任务。')} detail={state.error}/>}<div className="background-task-list">{tasks.map(task => <BackgroundTaskRow key={task.id} sessionId={sessionId} task={task} onCancelled={() => state.markCancelled(task.id)}/>)}</div></section>;
}

function BackgroundTaskRow({ sessionId, task, onCancelled }: { sessionId: string; task: BackgroundTask; onCancelled: () => void }) {
  const { tr } = useI18n();
  const [detail, setDetail] = useState<BackgroundTask | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    if (detail || loading) return;
    setLoading(true);
    try { setDetail(await api.sessions.tasks.get(sessionId, task.id)); } finally { setLoading(false); }
  };
  const cancel = async () => {
    if (!window.confirm(tr('Stop this background task?', '停止这个后台任务吗？'))) return;
    await api.sessions.tasks.cancel(sessionId, task.id);
    onCancelled();
  };
  return <details className={`background-task-row task-${task.status}`} onToggle={event => { if (event.currentTarget.open) void load(); }}><summary><span className={`status-dot ${task.status}`}/><span><strong>{task.description || task.id}</strong><small>{task.kind} · {task.id}</small></span><span className={`badge badge-${taskStatusBadge(task.status)}`}>{taskStatusLabel(task.status, tr)}</span></summary><div className="background-task-detail">{task.command && <code>{task.command}</code>}{loading ? <PreviewNotice kind="loading" text={tr('Loading output…', '正在加载输出…')}/> : (detail?.output_preview || task.output_preview) ? <MarkdownView content={detail?.output_preview || task.output_preview || ''}/> : <PreviewNotice kind="empty" text={tr('No output captured yet.', '尚未捕获输出。')}/>} {task.status === 'running' && <button type="button" onClick={() => void cancel()}>{tr('Stop task', '停止任务')}</button>}</div></details>;
}

type SwarmTask = NonNullable<SwarmStatus['tasks']>[number];

function TaskPreview({ task }: { task: SwarmTask }) {
  const { tr } = useI18n();
  const output = task.output?.trim() ?? '';
  const tokenTotal = (task.usage?.total ?? 0) + (task.live_output_tokens ?? 0);

  return (
    <details className={`swarm-task-preview swarm-task-preview-${task.status}`}>
      <summary className="swarm-task-summary">
        <span className={`status-dot ${task.status}`} />
        <span className="swarm-task-identity">
          <strong>{task.label || tr('Unnamed task', '未命名任务')}</strong>
          <small>{task.profile ? `${task.profile} · ` : ''}{task.id}</small>
        </span>
        <span className="swarm-task-meta">
          {tokenTotal > 0 ? <small>{(task.live_output_tokens ?? 0) > 0 ? '~' : ''}{tokenTotal.toLocaleString()} tokens</small> : null}
          {typeof task.output_bytes === 'number' ? <small>{formatBytes(task.output_bytes)}</small> : null}
          <span className={`badge badge-${taskStatusBadge(task.status)}`}>
            {taskStatusLabel(task.status, tr)}
          </span>
        </span>
      </summary>

      <div className="swarm-task-output">
        {output ? (
          <MarkdownView content={output} className="swarm-task-output-markdown" />
        ) : (
          <PreviewNotice
            kind="empty"
            text={isTaskFinished(task.status)
              ? tr('This agent did not return output.', '此智能体未返回输出。')
              : tr('Waiting for this agent to produce output…', '正在等待此智能体生成输出…')}
          />
        )}
      </div>
    </details>
  );
}

export function swarmRunTokens(run: SwarmStatus): number {
  const exact = run.usage?.total ?? run.tasks?.reduce((total, task) => total + (task.usage?.total ?? 0), 0) ?? 0;
  const live = run.tasks?.reduce((total, task) => total + (task.live_output_tokens ?? 0), 0) ?? 0;
  return exact + live;
}

function PreviewNotice({
  kind,
  text,
  detail,
}: {
  kind: 'loading' | 'empty' | 'error';
  text: string;
  detail?: string;
}) {
  return (
    <div className={`swarm-preview-notice ${kind}`}>
      {kind === 'loading' ? <span className="swarm-preview-spinner" /> : null}
      <span>{text}</span>
      {detail ? <small title={detail}>{detail}</small> : null}
    </div>
  );
}

function taskStatusBadge(status: string): string {
  if (status === 'done' || status === 'completed') return 'success';
  if (status === 'running') return 'info';
  if (status === 'paused') return 'warning';
  if (status === 'failed' || status === 'cancelled') return 'danger';
  return 'muted';
}

function swarmStatusBadge(status: SwarmStatus['status']): string {
  if (status === 'done') return 'success';
  if (status === 'running') return 'info';
  if (status === 'paused') return 'warning';
  if (status === 'failed') return 'danger';
  return 'muted';
}

function swarmStatusLabel(
  status: SwarmStatus['status'],
  tr: (english: string, chinese: string) => string,
): string {
  if (status === 'done') return tr('Done', '已完成');
  if (status === 'running') return tr('Running', '运行中');
  if (status === 'paused') return tr('Paused', '已暂停');
  if (status === 'failed') return tr('Failed', '失败');
  if (status === 'stopped') return tr('Stopped', '已终止');
  return tr('Pending', '等待中');
}

function taskStatusLabel(
  status: string,
  tr: (english: string, chinese: string) => string,
): string {
  if (status === 'done' || status === 'completed') return tr('Done', '已完成');
  if (status === 'running') return tr('Running', '运行中');
  if (status === 'paused') return tr('Paused', '已暂停');
  if (status === 'failed') return tr('Failed', '失败');
  if (status === 'cancelled' || status === 'stopped') return tr('Stopped', '已终止');
  if (status === 'pending' || status === 'queued') return tr('Pending', '等待中');
  return status;
}

function isTaskFinished(status: string): boolean {
  return status === 'done' || status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'stopped';
}

function backgroundTaskSwarmStatus(status: BackgroundTask['status']): SwarmStatus['status'] {
  if (status === 'running') return 'running';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'stopped';
  return 'done';
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
