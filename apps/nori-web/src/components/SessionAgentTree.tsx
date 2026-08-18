import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { api, type BackgroundTask, type SessionAgent } from '../api/client';
import { useI18n } from '../i18n';
import { Icon } from './Icon';

interface SessionAgentTreeProps {
  sessionId: string | null;
  selectedAgentId: string;
  backgroundTasks: readonly BackgroundTask[];
  backgroundLoading?: boolean;
  backgroundError?: string | null;
  hasGlobalActivity?: boolean;
  onSelectAgent: (agent: SessionAgent | null) => void;
  onBackgroundTaskCancelled?: (taskId: string) => void;
}

const TERMINAL_STATUSES = new Set(['completed', 'done', 'failed', 'cancelled', 'stopped', 'terminated']);
const ACTIVE_STATUSES = new Set(['running', 'active', 'pending', 'awaiting_approval', 'awaiting_question']);

function isTerminalAgent(agent: SessionAgent): boolean {
  return TERMINAL_STATUSES.has(agent.status.toLowerCase());
}

function isActiveAgent(agent: SessionAgent): boolean {
  return ACTIVE_STATUSES.has(agent.status.toLowerCase());
}

function agentLabel(agent: SessionAgent): string {
  return agent.title?.trim() || agent.name?.trim() || agent.agent_id;
}

function humanSummary(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const compact = value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!compact) return undefined;
  return compact.length <= 128 ? compact : `${compact.slice(0, 127).trimEnd()}…`;
}

function relativeTime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return 'now';
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function agentStatusClass(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === 'running' || normalized === 'active') return 'active';
  if (normalized === 'failed') return 'failed';
  if (normalized === 'paused') return 'paused';
  if (normalized === 'idle' || normalized === 'aborted') return 'idle';
  if (TERMINAL_STATUSES.has(normalized)) return 'idle';
  return 'pending';
}

function backgroundTasksOnly(tasks: readonly BackgroundTask[]): BackgroundTask[] {
  return tasks.filter(task => task.kind !== 'subagent');
}

export function SessionAgentTree({
  sessionId,
  selectedAgentId,
  backgroundTasks,
  backgroundLoading = false,
  backgroundError = null,
  hasGlobalActivity = false,
  onSelectAgent,
  onBackgroundTaskCancelled,
}: SessionAgentTreeProps) {
  const { tr } = useI18n();
  const [agents, setAgents] = useState<SessionAgent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>();
  const requestIdRef = useRef(0);
  const treeRef = useRef<HTMLDetailsElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const loadedSessionIdRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!sessionId) {
      loadedSessionIdRef.current = null;
      setAgents([]);
      setError(null);
      return;
    }
    if (loadedSessionIdRef.current !== sessionId) {
      loadedSessionIdRef.current = sessionId;
      setAgents([]);
      setError(null);
    }
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const result = await api.sessions.getAgents(sessionId);
      if (requestId !== requestIdRef.current) return;
      const items = result.items ?? [];
      setAgents(items);
      setError(null);
      if (selectedAgentId !== 'main' && !items.some(agent => agent.agent_id === selectedAgentId)) {
        onSelectAgent(null);
      }
    } catch (caught) {
      if (requestId !== requestIdRef.current) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [onSelectAgent, selectedAgentId, sessionId]);

  useEffect(() => {
    void refresh();
    if (!sessionId) return;
    const interval = window.setInterval(() => { void refresh(); }, 4_000);
    return () => {
      window.clearInterval(interval);
      requestIdRef.current++;
    };
  }, [refresh, sessionId]);

  const { teamPartners, liveDiscussions, liveMainSubAgents, archivedAgents, childrenByParent } = useMemo(() => {
    const archived: SessionAgent[] = [];
    const active: SessionAgent[] = [];
    for (const agent of agents) {
      if (agent.kind === 'main') continue;
      const done = agent.archived
        || agent.status.toLowerCase() === 'archived'
        || (agent.kind === 'sub' && isTerminalAgent(agent))
        || (agent.kind === 'discussion' && isTerminalAgent(agent));
      if (done) archived.push(agent);
      else active.push(agent);
    }
    const children = new Map<string, SessionAgent[]>();
    const teamPartners = active.filter(agent => agent.kind === 'team');
    const liveDiscussions = active.filter(agent => agent.kind === 'discussion');
    const liveMainSubAgents: SessionAgent[] = [];
    for (const agent of active) {
      if (agent.kind !== 'sub') continue;
      const parentAgentId = agent.parent_agent_id || 'main';
      if (parentAgentId === 'main') {
        liveMainSubAgents.push(agent);
        continue;
      }
      const existing = children.get(parentAgentId) ?? [];
      existing.push(agent);
      children.set(parentAgentId, existing);
    }
    return { teamPartners, liveDiscussions, liveMainSubAgents, archivedAgents: archived, childrenByParent: children };
  }, [agents]);

  const mainAgent = useMemo<SessionAgent | null>(() => {
    if (!sessionId) return null;
    return agents.find(agent => agent.agent_id === 'main' || agent.kind === 'main') ?? {
      agent_id: 'main',
      kind: 'main',
      name: tr('Main session', '主会话'),
      status: 'idle',
    };
  }, [agents, sessionId, tr]);
  const visibleBackground = backgroundTasksOnly(backgroundTasks);
  const hasLiveTeam = teamPartners.length > 0;
  const hasLiveSubAgent = liveMainSubAgents.length > 0 || [...childrenByParent.values()].some(list => list.length > 0);
  const hasActivity = hasGlobalActivity
    || teamPartners.some(isActiveAgent)
    || liveMainSubAgents.some(isActiveAgent)
    || [...childrenByParent.values()].some(list => list.some(isActiveAgent))
    || visibleBackground.some(task => task.status === 'running');
  const triggerLabel = hasLiveTeam
    ? tr('Team', '团队')
    : hasLiveSubAgent
      ? tr('SubAgent', 'SubAgent')
      : tr('Team', '团队');
  const closeTree = useCallback(() => {
    treeRef.current?.removeAttribute('open');
    setOpen(false);
  }, []);
  const readMenuPosition = useCallback((): CSSProperties | undefined => {
    const trigger = treeRef.current?.querySelector<HTMLElement>('summary');
    if (!trigger) return undefined;
    const bounds = trigger.getBoundingClientRect();
    const viewportMargin = 16;
    const width = Math.min(504, Math.max(280, window.innerWidth - viewportMargin * 2));
    const right = Math.max(viewportMargin, window.innerWidth - bounds.right);
    return {
      top: bounds.bottom + 6,
      right,
      width,
      maxHeight: Math.max(160, Math.min(window.innerHeight - bounds.bottom - 22, window.innerHeight * 0.7)),
    };
  }, []);
  const updateMenuPosition = useCallback(() => {
    setMenuStyle(readMenuPosition());
  }, [readMenuPosition]);
  useEffect(() => {
    if (!open) return;
    updateMenuPosition();
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (treeRef.current?.contains(target) || menuRef.current?.contains(target))) return;
      closeTree();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeTree();
    };
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [closeTree, open, updateMenuPosition]);
  const selectAgent = useCallback((agent: SessionAgent | null) => {
    closeTree();
    onSelectAgent(agent);
  }, [closeTree, onSelectAgent]);

  const menu = <div ref={menuRef} className="session-agent-tree-menu" style={menuStyle} role="menu">
    {loading && agents.length === 0 && <TreeNotice text={tr('Loading team tree…', '正在加载团队树…')}/>}
    {error && <TreeNotice text={tr('Unable to load the team tree.', '无法加载团队树。')} detail={error} kind="error"/>}
    {mainAgent && <AgentNode agent={mainAgent} selectedAgentId={selectedAgentId} childrenByParent={new Map()} onSelect={selectAgent} depth={0}/>}
    {teamPartners.map(agent => <AgentNode key={agent.agent_id} agent={agent} selectedAgentId={selectedAgentId} childrenByParent={childrenByParent} onSelect={selectAgent} depth={0}/>)}
    {liveDiscussions.map(agent => <AgentNode key={agent.agent_id} agent={agent} selectedAgentId={selectedAgentId} childrenByParent={new Map()} onSelect={selectAgent} depth={0}/>)}
    {liveMainSubAgents.length > 0 && <div className="session-agent-tree-section">
      <p className="session-agent-tree-section-label">{tr('Temporary', '临时')}</p>
      {liveMainSubAgents.map(agent => <AgentNode key={agent.agent_id} agent={agent} selectedAgentId={selectedAgentId} childrenByParent={new Map()} onSelect={selectAgent} depth={1}/>)}
    </div>}
    {visibleBackground.length > 0 || backgroundLoading || backgroundError ? <div className="session-agent-tree-background-list">
      <p className="session-agent-tree-section-label">{tr('Background', '后台')}</p>
      {backgroundLoading && visibleBackground.length === 0 && <TreeNotice text={tr('Loading background tasks…', '正在加载后台任务…')}/>}
      {backgroundError && <TreeNotice text={tr('Unable to load background tasks.', '无法加载后台任务。')} detail={backgroundError} kind="error"/>}
      {visibleBackground.map(task => <BackgroundTaskNode key={task.id} sessionId={sessionId} task={task} onCancelled={onBackgroundTaskCancelled}/>)}
    </div> : null}
    {archivedAgents.length > 0 && <div className="session-agent-tree-section">
      <p className="session-agent-tree-section-label">{tr('Archive', '归档')}</p>
      {archivedAgents.map(agent => <AgentNode key={agent.agent_id} agent={agent} selectedAgentId={selectedAgentId} childrenByParent={new Map()} onSelect={selectAgent} depth={1}/>)}
    </div>}
    {!loading && !error && !mainAgent && visibleBackground.length === 0 && <TreeNotice text={tr('No team, SubAgent, or background tasks.', '暂无团队、SubAgent 或后台任务。')}/>}
  </div>;

  return <><details ref={treeRef} className={`session-agent-tree${hasActivity ? ' activity-pending' : ''}`} onToggle={event => {
    const isOpen = event.currentTarget.open;
    if (isOpen) {
      // Measure before mounting the portal so the first frame is anchored;
      // the next animation frame then tracks any layout shift.
      setMenuStyle(readMenuPosition());
      setOpen(true);
      requestAnimationFrame(updateMenuPosition);
    } else {
      setOpen(false);
    }
  }}>
    <summary title={tr('Open the team and SubAgent tree', '查看团队与 SubAgent 树')}>
      <Icon name="git-branch" size={15}/><span>{triggerLabel}</span>{hasActivity && <i aria-label={tr('Activity pending', '有活动任务')}/>}<Icon name="chevron-down" size={13}/>
    </summary>
  </details>{open && createPortal(menu, document.body)}</>;
}

function AgentNode({ agent, selectedAgentId, childrenByParent, onSelect, depth = 0 }: {
  agent: SessionAgent;
  selectedAgentId: string;
  childrenByParent: ReadonlyMap<string, readonly SessionAgent[]>;
  onSelect: (agent: SessionAgent) => void;
  depth?: number;
}) {
  const { tr } = useI18n();
  const children = childrenByParent.get(agent.agent_id) ?? [];
  const label = agentLabel(agent);
  const summary = humanSummary(agent.summary) ?? humanSummary(agent.intro);
  const lastActive = relativeTime(agent.last_active);
  const selectable = agent.archived || !isTerminalAgent(agent) || agent.kind === 'team' || agent.kind === 'discussion' || agent.kind === 'sub';
  const identity = agentIdentity(agent, tr);
  return <div className={`session-agent-tree-node depth-${depth}${selectedAgentId === agent.agent_id ? ' selected' : ''}${!selectable ? ' terminal' : ''}`} style={{ '--agent-tree-depth': depth } as CSSProperties}>
    <button type="button" role="menuitem" disabled={!selectable} onClick={() => onSelect(agent)} title={summary ?? label}>
      <span className={`status-dot ${agentStatusClass(agent.status)}`}/><span className="session-agent-tree-copy"><span><strong>{label}</strong><em>({identity})</em></span>{summary && <small>{summary}</small>}</span><span className="session-agent-tree-meta">{typeof agent.tokens === 'number' && agent.tokens > 0 && <small>{agent.tokens.toLocaleString()} tok</small>}{lastActive && <small title={agent.last_active}>{lastActive}</small>}</span>
    </button>
    {children.length > 0 && <div className="session-agent-tree-children">{children.map(child => <AgentNode key={child.agent_id} agent={child} selectedAgentId={selectedAgentId} childrenByParent={childrenByParent} onSelect={onSelect} depth={depth + 1}/>)}</div>}
  </div>;
}

function agentIdentity(agent: SessionAgent, tr: (english: string, chinese: string) => string): string {
  switch (agent.kind) {
    case 'main': return tr('Main session', '主会话');
    case 'team': return tr('Team partner', '团队伙伴');
    case 'sub': return tr('SubAgent', 'SubAgent');
    case 'discussion': return agent.archived || agent.status.toLowerCase() === 'archived'
      ? tr('Archived Discuss', '已归档 Discuss')
      : tr('Discuss', '讨论');
    default: return tr('Agent', '智能体');
  }
}

function BackgroundTaskNode({ sessionId, task, onCancelled }: { sessionId: string | null; task: BackgroundTask; onCancelled?: (taskId: string) => void }) {
  const { tr } = useI18n();
  const [detail, setDetail] = useState<BackgroundTask | null>(null);
  const [loading, setLoading] = useState(false);
  const [stopping, setStopping] = useState(false);
  const load = async () => {
    if (!sessionId || detail || loading) return;
    setLoading(true);
    try { setDetail(await api.sessions.tasks.get(sessionId, task.id, 24_000)); } finally { setLoading(false); }
  };
  const stop = async () => {
    if (!sessionId || stopping) return;
    if (!window.confirm(tr('Stop this background task?', '停止这个后台任务吗？'))) return;
    setStopping(true);
    try {
      await api.sessions.tasks.cancel(sessionId, task.id);
      onCancelled?.(task.id);
    } finally { setStopping(false); }
  };
  const output = detail?.output_preview ?? task.output_preview;
  return <details className={`session-agent-background task-${task.status}`} onToggle={event => { if (event.currentTarget.open) void load(); }}>
    <summary><span className={`status-dot ${task.status === 'running' ? 'active' : task.status === 'failed' ? 'failed' : 'idle'}`}/><span><strong>{task.description || task.id}</strong><small>{task.kind} · {task.id}</small></span><small>{task.status}</small></summary>
    <div>{task.command && <code>{task.command}</code>}{loading ? <TreeNotice text={tr('Loading output…', '正在加载输出…')}/> : output ? <pre>{output}</pre> : <TreeNotice text={tr('No output captured yet.', '尚未捕获输出。')}/>} {task.status === 'running' && <button type="button" onClick={() => void stop()} disabled={stopping}><Icon name="stop" size={12}/><span>{stopping ? tr('Stopping…', '正在停止…') : tr('Stop', '停止')}</span></button>}</div>
  </details>;
}

function TreeNotice({ text, detail, kind = 'neutral' }: { text: string; detail?: string; kind?: 'neutral' | 'error' }) {
  return <p className={`session-agent-tree-notice ${kind}`}>{text}{detail && <small title={detail}>{detail}</small>}</p>;
}
