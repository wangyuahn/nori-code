import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, type BackgroundTask, type SessionAgent, type SessionRealtimeStatus } from '../api/client';
import { useI18n } from '../i18n';
import { sessionAgentDisplayName } from '../utils/session-agent';
import { Icon } from './Icon';

interface SessionAgentTreeProps {
  sessionId: string | null;
  selectedAgentId: string;
  backgroundTasks: readonly BackgroundTask[];
  backgroundLoading?: boolean;
  backgroundError?: string | null;
  hasGlobalActivity?: boolean;
  sessionStatus?: SessionRealtimeStatus | null;
  agentTreeRevision?: number;
  discussionTurnAgentId?: string | null;
  onSelectAgent: (agent: SessionAgent | null) => void;
  onAgentsChange?: (agents: readonly SessionAgent[]) => void;
  onBackgroundTaskCancelled?: (taskId: string) => void;
}

const TERMINAL_STATUSES = new Set(['completed', 'done', 'failed', 'cancelled', 'stopped', 'terminated']);
const ACTIVE_STATUSES = new Set(['running', 'active', 'pending', 'awaiting_approval', 'awaiting_question']);
const EMPTY_AGENT_CHILDREN = new Map<string, readonly SessionAgent[]>();

function isTerminalAgent(agent: SessionAgent): boolean {
  return TERMINAL_STATUSES.has(agentStatus(agent));
}

function isActiveAgent(agent: SessionAgent): boolean {
  return ACTIVE_STATUSES.has(agentStatus(agent));
}

export function isActiveDiscussionAgent(agent: SessionAgent): boolean {
  const status = agentStatus(agent);
  return (agent.kind === 'discussion' || status === 'discuss')
    && !agent.archived
    && status !== 'archived'
    && !isTerminalAgent(agent);
}

export function activeDiscussionForAgent(
  agents: readonly SessionAgent[],
  selectedAgentId: string,
  _sessionStatus?: SessionRealtimeStatus | null,
): boolean {
  const byId = new Map(agents.map(agent => [agent.agent_id, agent]));
  const discussions = agents.filter(isActiveDiscussionAgent);
  if (discussions.length === 0) return false;
  if (selectedAgentId === 'main') return true;
  const isInBranch = (startId: string, targetId: string): boolean => {
    let current = byId.get(startId);
    const visited = new Set<string>();
    while (current && current.agent_id !== 'main' && !visited.has(current.agent_id)) {
      if (current.agent_id === targetId) return true;
      visited.add(current.agent_id);
      current = current.parent_agent_id ? byId.get(current.parent_agent_id) : undefined;
    }
    return false;
  };
  return discussions.some(discussion => {
    return isInBranch(selectedAgentId, discussion.agent_id)
      || isInBranch(discussion.agent_id, selectedAgentId);
  });
}

function agentStatus(agent: SessionAgent): string {
  return typeof agent.status === 'string' ? agent.status.toLowerCase() : '';
}

function agentLabel(agent: SessionAgent): string {
  return sessionAgentDisplayName(agent);
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

interface AgentTreeData {
  teamPartners: SessionAgent[];
  activeDiscussions: SessionAgent[];
  liveMainSubAgents: SessionAgent[];
  otherActiveRoots: SessionAgent[];
  archivedAgents: SessionAgent[];
  teamChildrenByParent: Map<string, SessionAgent[]>;
  temporaryChildrenByParent: Map<string, SessionAgent[]>;
  archivedChildrenByParent: Map<string, SessionAgent[]>;
}

function buildChildrenByParent(
  agents: readonly SessionAgent[],
  allowedIds: ReadonlySet<string>,
): Map<string, SessionAgent[]> {
  const candidateById = new Map<string, string>();
  for (const agent of agents) {
    const candidate = typeof agent.parent_agent_id === 'string' ? agent.parent_agent_id : undefined;
    if (
      candidate
      && candidate !== agent.agent_id
      && (candidate === 'main' || allowedIds.has(candidate))
    ) {
      candidateById.set(agent.agent_id, candidate);
    }
  }

  const createsCycle = (agentId: string, candidate: string): boolean => {
    const visited = new Set<string>([agentId]);
    let current: string | undefined = candidate;
    while (current && current !== 'main') {
      if (visited.has(current)) return true;
      visited.add(current);
      current = candidateById.get(current);
    }
    return false;
  };

  const childrenByParent = new Map<string, SessionAgent[]>();
  for (const agent of agents) {
    const candidate = candidateById.get(agent.agent_id);
    const parent = candidate && !createsCycle(agent.agent_id, candidate) ? candidate : 'main';
    const children = childrenByParent.get(parent) ?? [];
    children.push(agent);
    childrenByParent.set(parent, children);
  }
  return childrenByParent;
}

function buildAgentTreeData(agents: readonly SessionAgent[]): AgentTreeData {
  const uniqueAgents: SessionAgent[] = [];
  const seenIds = new Set<string>();
  for (const agent of agents) {
    if (!agent || typeof agent.agent_id !== 'string' || !agent.agent_id || seenIds.has(agent.agent_id)) continue;
    seenIds.add(agent.agent_id);
    uniqueAgents.push(agent);
  }

  const nonMainAgents = uniqueAgents.filter(agent => agent.agent_id !== 'main' && agent.kind !== 'main');
  const archived = nonMainAgents.filter(agent => (
    agent.archived
    || agentStatus(agent) === 'archived'
    || ((agent.kind === 'sub' || agent.kind === 'discussion') && isTerminalAgent(agent))
  ));
  const active = nonMainAgents.filter(agent => !archived.includes(agent));
  const activeIds = new Set(active.map(agent => agent.agent_id));
  const archivedIds = new Set(archived.map(agent => agent.agent_id));
  const activeChildrenByParent = buildChildrenByParent(active, activeIds);
  const archivedChildrenByParent = buildChildrenByParent(archived, archivedIds);
  const activeRoots = activeChildrenByParent.get('main') ?? [];
  const teamPartners = activeRoots.filter(agent => agent.kind === 'team');
  const activeDiscussions = activeRoots.filter(agent => agent.kind === 'discussion');
  const temporaryRoots = activeRoots.filter(agent => agent.kind !== 'team' && agent.kind !== 'discussion');
  const teamChildrenByParent = new Map(activeChildrenByParent);
  const temporaryChildrenByParent = new Map(activeChildrenByParent);
  teamChildrenByParent.set('main', teamPartners);
  temporaryChildrenByParent.set('main', temporaryRoots);

  return {
    teamPartners,
    activeDiscussions,
    liveMainSubAgents: temporaryRoots.filter(agent => agent.kind === 'sub'),
    otherActiveRoots: temporaryRoots.filter(agent => agent.kind !== 'sub'),
    archivedAgents: archivedChildrenByParent.get('main') ?? [],
    teamChildrenByParent,
    temporaryChildrenByParent,
    archivedChildrenByParent,
  };
}

export function SessionAgentTree({
  sessionId,
  selectedAgentId,
  backgroundTasks,
  backgroundLoading = false,
  backgroundError = null,
  hasGlobalActivity = false,
  sessionStatus: _sessionStatus = null,
  agentTreeRevision = 0,
  discussionTurnAgentId,
  onSelectAgent,
  onAgentsChange,
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
  const openRef = useRef(false);
  const refreshDeferredRef = useRef(false);
  const agentsRef = useRef<SessionAgent[]>([]);
  const [collapsedAgentIds, setCollapsedAgentIds] = useState<Set<string>>(() => new Set());
  const [sectionOpen, setSectionOpen] = useState({ team: true, discussion: true, temporary: true, background: false, archive: false });

  const refresh = useCallback(async (force = false) => {
    if (!sessionId) {
      loadedSessionIdRef.current = null;
      agentsRef.current = [];
      setAgents([]);
      setError(null);
      onAgentsChange?.([]);
      return;
    }
    if (!force && openRef.current && loadedSessionIdRef.current === sessionId) {
      refreshDeferredRef.current = true;
      return;
    }
    if (loadedSessionIdRef.current !== sessionId) {
      loadedSessionIdRef.current = sessionId;
      agentsRef.current = [];
      setAgents([]);
      setError(null);
    }
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const result = await api.sessions.getAgents(sessionId);
      if (requestId !== requestIdRef.current) return;
      const items = result.items ?? [];
      if (!sameAgentList(agentsRef.current, items)) {
        agentsRef.current = items;
        setAgents(items);
        onAgentsChange?.(items);
      }
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
  }, [onAgentsChange, onSelectAgent, selectedAgentId, sessionId]);

  useEffect(() => {
    openRef.current = false;
    refreshDeferredRef.current = false;
    setCollapsedAgentIds(new Set());
    setSectionOpen({ team: true, discussion: true, temporary: true, background: false, archive: false });
  }, [sessionId]);

  useEffect(() => {
    void refresh();
    if (!sessionId) return;
    const interval = window.setInterval(() => { void refresh(); }, 4_000);
    return () => {
      window.clearInterval(interval);
      requestIdRef.current++;
    };
  }, [refresh, sessionId]);

  useEffect(() => {
    if (!sessionId || agentTreeRevision === 0) return;
    // Surface the first lifecycle event while the tree is open; once a
    // hierarchy exists, defer refresh until close so native <details> state
    // is not rebuilt under the user's cursor.
    void refresh(agentsRef.current.length <= 1);
  }, [agentTreeRevision, refresh, sessionId]);

  const {
    teamPartners,
    activeDiscussions,
    liveMainSubAgents,
    otherActiveRoots,
    archivedAgents,
    teamChildrenByParent,
    temporaryChildrenByParent,
    archivedChildrenByParent,
  } = useMemo(() => buildAgentTreeData(agents), [agents]);

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
  const hasLiveTeam = teamPartners.length > 0 || activeDiscussions.length > 0;
  const hasLiveSubAgent = liveMainSubAgents.length > 0
    || [...temporaryChildrenByParent.values()].some(list => list.length > 0);
  const hasActivity = hasGlobalActivity
    || teamPartners.some(isActiveAgent)
    || activeDiscussions.some(isActiveAgent)
    || liveMainSubAgents.some(isActiveAgent)
    || [...teamChildrenByParent.values()].some(list => list.some(isActiveAgent))
    || [...temporaryChildrenByParent.values()].some(list => list.some(isActiveAgent))
    || visibleBackground.some(task => task.status === 'running');
  const discussionActive = activeDiscussionForAgent(agents, selectedAgentId, _sessionStatus);
  const currentDiscussionTurnAgentId = discussionTurnAgentId !== undefined
    ? discussionTurnAgentId ?? undefined
    : activeDiscussions.find(agent => agent.discussion_turn_agent_id)?.discussion_turn_agent_id;
  const currentDiscussionTurnAgent = currentDiscussionTurnAgentId === undefined
    ? undefined
    : agents.find(agent => agent.agent_id === currentDiscussionTurnAgentId);
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
    const width = Math.min(440, Math.max(280, window.innerWidth - viewportMargin * 2));
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

  const toggleAgent = useCallback((agentId: string) => {
    setCollapsedAgentIds(previous => {
      const next = new Set(previous);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }, []);
  const updateSectionOpen = useCallback((section: 'team' | 'discussion' | 'temporary' | 'background' | 'archive', nextOpen: boolean) => {
    setSectionOpen(previous => previous[section] === nextOpen ? previous : { ...previous, [section]: nextOpen });
  }, []);

  const treeCounts = {
    team: teamPartners.length,
    discussion: activeDiscussions.length,
    temporary: liveMainSubAgents.length + otherActiveRoots.length,
    background: visibleBackground.length,
    archive: archivedAgents.length,
  };
  const mainChildrenContent = (treeCounts.team > 0 || treeCounts.discussion > 0 || treeCounts.temporary > 0) ? <>
    {treeCounts.team > 0 && <TreeSection label={tr('Team partners', '团队伙伴')} count={treeCounts.team} open={sectionOpen.team} onOpenChange={nextOpen => updateSectionOpen('team', nextOpen)}>
      {teamPartners.map(agent => <AgentNode key={agent.agent_id} agent={agent} selectedAgentId={selectedAgentId} currentTurnAgentId={currentDiscussionTurnAgentId} childrenByParent={teamChildrenByParent} collapsedAgentIds={collapsedAgentIds} onToggle={toggleAgent} onSelect={selectAgent} depth={1}/>)}</TreeSection>}
    {treeCounts.discussion > 0 && <TreeSection className="session-agent-tree-discussion-list" label={tr('Discuss sessions', '讨论会话')} count={treeCounts.discussion} open={sectionOpen.discussion} onOpenChange={nextOpen => updateSectionOpen('discussion', nextOpen)}>
      {activeDiscussions.map(agent => <AgentNode key={agent.agent_id} agent={agent} selectedAgentId={selectedAgentId} currentTurnAgentId={currentDiscussionTurnAgentId} childrenByParent={temporaryChildrenByParent} collapsedAgentIds={collapsedAgentIds} onToggle={toggleAgent} onSelect={selectAgent} depth={1}/>)}</TreeSection>}
    {treeCounts.temporary > 0 && <TreeSection label={tr('Temporary', '临时')} count={treeCounts.temporary} open={sectionOpen.temporary} onOpenChange={nextOpen => updateSectionOpen('temporary', nextOpen)}>
      {[...liveMainSubAgents, ...otherActiveRoots].map(agent => <AgentNode key={agent.agent_id} agent={agent} selectedAgentId={selectedAgentId} currentTurnAgentId={currentDiscussionTurnAgentId} childrenByParent={temporaryChildrenByParent} collapsedAgentIds={collapsedAgentIds} onToggle={toggleAgent} onSelect={selectAgent} depth={1}/>)}</TreeSection>}
  </> : undefined;
  const menu = <div ref={menuRef} className="session-agent-tree-menu" style={menuStyle} role="tree" aria-label={tr('Session agent tree', '会话智能体树')}>
    <header className="session-agent-tree-menu-header">
      <div className="session-agent-tree-menu-title">
        <span className="session-agent-tree-menu-icon"><Icon name="git-branch" size={15}/></span>
        <span><strong>{tr('Session agents', '会话智能体')}</strong><small>{tr('Main session and branches', '主会话与分支')}</small></span>
      </div>
      <div className="session-agent-tree-menu-state">
        <span className={`session-agent-tree-state-chip${discussionActive ? ' discuss' : ''}`}><Icon name={discussionActive ? 'chat' : 'terminal'} size={11}/>{discussionActive ? tr('Discuss', '讨论') : tr('Code', '执行')}</span>
        {currentDiscussionTurnAgent && <span className="session-agent-tree-turn-chip"><i aria-hidden="true"/>{tr('Speaking', '正在发言')}: {sessionAgentDisplayName(currentDiscussionTurnAgent)}</span>}
        {hasActivity && <span className="session-agent-tree-live-chip"><i aria-hidden="true"/>{tr('Live', '活动中')}</span>}
      </div>
    </header>
    {loading && agents.length === 0 && <TreeNotice text={tr('Loading team tree…', '正在加载团队树…')}/>}
    {error && <TreeNotice text={tr('Unable to load the team tree.', '无法加载团队树。')} detail={error} kind="error"/>}
    {mainAgent && <AgentNode agent={mainAgent} selectedAgentId={selectedAgentId} currentTurnAgentId={currentDiscussionTurnAgentId} childrenByParent={EMPTY_AGENT_CHILDREN} childrenContent={mainChildrenContent} collapsedAgentIds={collapsedAgentIds} onToggle={toggleAgent} onSelect={selectAgent} depth={0}/>}
    {visibleBackground.length > 0 || backgroundLoading || backgroundError ? <TreeSection className="session-agent-tree-background-list" label={tr('Background', '后台')} count={treeCounts.background} open={sectionOpen.background} onOpenChange={nextOpen => updateSectionOpen('background', nextOpen)}>
      {backgroundLoading && visibleBackground.length === 0 && <TreeNotice text={tr('Loading background tasks…', '正在加载后台任务…')}/>}
      {backgroundError && <TreeNotice text={tr('Unable to load background tasks.', '无法加载后台任务。')} detail={backgroundError} kind="error"/>}
      {visibleBackground.map(task => <BackgroundTaskNode key={task.id} sessionId={sessionId} task={task} onCancelled={onBackgroundTaskCancelled}/>)}
    </TreeSection> : null}
    {archivedAgents.length > 0 && <TreeSection label={tr('Archive', '归档')} count={treeCounts.archive} open={sectionOpen.archive} onOpenChange={nextOpen => updateSectionOpen('archive', nextOpen)}>
      {archivedAgents.map(agent => <AgentNode key={agent.agent_id} agent={agent} selectedAgentId={selectedAgentId} currentTurnAgentId={currentDiscussionTurnAgentId} childrenByParent={archivedChildrenByParent} collapsedAgentIds={collapsedAgentIds} onToggle={toggleAgent} onSelect={selectAgent} depth={1}/>)}
    </TreeSection>}
    {!loading && !error && !mainAgent && visibleBackground.length === 0 && <TreeNotice text={tr('No team, SubAgent, or background tasks.', '暂无团队、SubAgent 或后台任务。')}/>}
  </div>;

  return <><details ref={treeRef} className={`session-agent-tree${hasActivity ? ' activity-pending' : ''}${discussionActive ? ' discussion-active' : ''}`} onToggle={event => {
    const isOpen = event.currentTarget.open;
    openRef.current = isOpen;
    if (isOpen) {
      // Measure before mounting the portal so the first frame is anchored;
      // the next animation frame then tracks any layout shift.
      setMenuStyle(readMenuPosition());
      setOpen(true);
      requestAnimationFrame(updateMenuPosition);
    } else {
      setOpen(false);
      if (refreshDeferredRef.current) {
        refreshDeferredRef.current = false;
        void refresh();
      }
    }
  }}>
    <summary title={tr('Open the team and SubAgent tree', '查看团队与 SubAgent 树')}>
      <Icon name="git-branch" size={15}/><span className="session-agent-tree-trigger-label">{triggerLabel}</span><span className="session-agent-tree-trigger-context">{tr('agents', '智能体')}</span>{discussionActive && <span className="session-agent-tree-mode" data-mode="discuss"><Icon name="chat" size={12}/><span>{tr('Discuss', '讨论')}</span></span>}{hasActivity && <i aria-label={tr('Activity pending', '有活动任务')}/>}<Icon name="chevron-down" size={13}/>
    </summary>
  </details>{open && menuStyle && createPortal(menu, document.body)}</>;
}

function TreeSection({ label, count, open, onOpenChange, className, children }: { label: string; count?: number; open: boolean; onOpenChange: (open: boolean) => void; className?: string; children: ReactNode }) {
  const initialOpen = useRef(open);
  const sectionRef = useCallback((node: HTMLDetailsElement | null) => {
    if (node !== null) node.open = initialOpen.current;
  }, []);
  // Keep the browser-owned open state after mount. Passing `open={open}` on
  // every parent refresh makes React race the native details toggle and causes
  // the section to visibly flash back and forth.
  return <details ref={sectionRef} className={`session-agent-tree-section${className ? ` ${className}` : ''}`} onToggle={event => {
    if (event.target !== event.currentTarget) return;
    onOpenChange(event.currentTarget.open);
  }}>
    <summary><Icon name="chevron-right" size={11}/><span className="session-agent-tree-section-label">{label}</span>{count !== undefined && <span className="session-agent-tree-section-count">{count}</span>}</summary>
    <div className="session-agent-tree-section-body">{children}</div>
  </details>;
}

function AgentNode({ agent, selectedAgentId, currentTurnAgentId, childrenByParent, childrenContent, collapsedAgentIds, onToggle, onSelect, depth = 0 }: {
  agent: SessionAgent;
  selectedAgentId: string;
  currentTurnAgentId?: string;
  childrenByParent: ReadonlyMap<string, readonly SessionAgent[]>;
  childrenContent?: ReactNode;
  collapsedAgentIds: ReadonlySet<string>;
  onToggle: (agentId: string) => void;
  onSelect: (agent: SessionAgent) => void;
  depth?: number;
}) {
  const { tr } = useI18n();
  const children = childrenByParent.get(agent.agent_id) ?? [];
  const hasChildren = children.length > 0 || (childrenContent !== undefined && childrenContent !== null);
  const label = agentLabel(agent);
  const assignment = humanSummary(agent.assigned_task);
  const reportSummary = humanSummary(agent.team_report_summary);
  const reportStatus = agent.team_report_status === undefined
    ? undefined
    : reportLabel(agent.team_report_status, agent.team_report_received, tr);
  const summary = humanSummary(agent.mandate) ?? humanSummary(agent.summary);
  const lastActive = relativeTime(agent.last_active);
  const collapsed = collapsedAgentIds.has(agent.agent_id);
  const selectable = agent.archived || !isTerminalAgent(agent) || agent.kind === 'team' || agent.kind === 'discussion' || agent.kind === 'sub';
  const identity = agentIdentity(agent, tr);
  const role = agentRole(agent, tr);
  const isDiscussion = agent.kind === 'discussion';
  const isArchivedDiscussion = isDiscussion && (agent.archived || agentStatus(agent) === 'archived');
  const isCurrentTurn = currentTurnAgentId === agent.agent_id;
  return <div data-agent-id={agent.agent_id} data-agent-kind={agent.kind} className={`session-agent-tree-node depth-${depth}${hasChildren ? ` has-children${collapsed ? ' children-collapsed' : ' children-expanded'}` : ''}${isDiscussion ? ` discussion${isArchivedDiscussion ? ' archived-discussion' : ''}` : ''}${isCurrentTurn ? ' discussion-current-turn' : ''}${selectedAgentId === agent.agent_id ? ' selected' : ''}${!selectable ? ' terminal' : ''}`} style={{ '--agent-tree-depth': depth } as CSSProperties} role="treeitem" aria-level={depth + 1} aria-expanded={hasChildren ? !collapsed : undefined} aria-current={isCurrentTurn ? 'true' : undefined}>
    <span className="session-agent-tree-branch" aria-hidden="true"/>
    {hasChildren ? <button type="button" className="session-agent-tree-toggle" aria-label={collapsed ? tr('Expand children', '展开子项') : tr('Collapse children', '折叠子项')} aria-expanded={!collapsed} onClick={event => { event.stopPropagation(); onToggle(agent.agent_id); }}><Icon name="chevron-right" size={11}/></button> : <span className="session-agent-tree-toggle-spacer" aria-hidden="true"/>}
    <button type="button" disabled={!selectable} onClick={() => onSelect(agent)} title={summary ?? label} aria-current={selectedAgentId === agent.agent_id ? 'true' : undefined}>
      <span className={`status-dot ${agentStatusClass(agent.status)}`}/><span className="session-agent-tree-copy"><span><strong>{label}</strong><span className="session-agent-tree-identity">{isDiscussion && <Icon name="chat" size={11}/>}<em>({identity})</em>{isCurrentTurn && <b>{tr('Speaking', '正在发言')}</b>}</span></span>{summary && <small>{summary}</small>}{assignment && <small>{tr('Task', '任务')}: {assignment}</small>}{reportStatus && <small>{reportStatus}{reportSummary ? `: ${reportSummary}` : ''}</small>}</span><span className="session-agent-tree-meta"><span className={`session-agent-tree-role role-${agent.kind}`}>{role}</span>{typeof agent.tokens === 'number' && agent.tokens > 0 && <small>{agent.tokens.toLocaleString()} tok</small>}{lastActive && <small title={agent.last_active}>{lastActive}</small>}</span>
    </button>
    {hasChildren && !collapsed && <div className="session-agent-tree-children" role="group">{children.map(child => <AgentNode key={child.agent_id} agent={child} selectedAgentId={selectedAgentId} currentTurnAgentId={currentTurnAgentId} childrenByParent={childrenByParent} collapsedAgentIds={collapsedAgentIds} onToggle={onToggle} onSelect={onSelect} depth={depth + 1}/>)}{childrenContent}</div>}
  </div>;
}

function agentIdentity(agent: SessionAgent, tr: (english: string, chinese: string) => string): string {
  switch (agent.kind) {
    case 'main': return tr('Main session', '主会话');
    case 'team': return agent.role?.trim() || tr('Team partner', '团队伙伴');
    case 'sub': return tr('SubAgent', 'SubAgent');
    case 'discussion': return agent.archived || agentStatus(agent) === 'archived'
      ? tr('Archived Discuss', '已归档 Discuss')
      : tr('Discuss', '讨论');
    default: return tr('Agent', '智能体');
  }
}

function agentRole(agent: SessionAgent, tr: (english: string, chinese: string) => string): string {
  switch (agent.kind) {
    case 'main': return tr('ROOT', '根节点');
    case 'team': return tr('TEAM', '团队');
    case 'discussion': return tr('DISCUSS', '讨论');
    case 'sub': return tr('SUBAGENT', '子代理');
    default: return tr('AGENT', '代理');
  }
}

function sameAgentList(previous: readonly SessionAgent[], next: readonly SessionAgent[]): boolean {
  if (previous.length !== next.length) return false;
  return previous.every((agent, index) => {
    const candidate = next[index];
    return candidate !== undefined
      && agent.agent_id === candidate.agent_id
      && agent.kind === candidate.kind
      && agent.parent_agent_id === candidate.parent_agent_id
      && agent.name === candidate.name
      && agent.role === candidate.role
      && agent.mandate === candidate.mandate
      && agent.assigned_task === candidate.assigned_task
      && agent.team_report_status === candidate.team_report_status
      && agent.team_report_summary === candidate.team_report_summary
      && agent.team_report_received === candidate.team_report_received
      && agent.status === candidate.status
      && agent.tokens === candidate.tokens
      && agent.last_active === candidate.last_active
      && agent.summary === candidate.summary
      && agent.archived === candidate.archived
      && agent.discussion_turn_agent_id === candidate.discussion_turn_agent_id;
  });
}

function reportLabel(
  status: SessionAgent['team_report_status'],
  received: boolean | undefined,
  tr: (english: string, chinese: string) => string,
): string {
  if (status === 'completed') return received ? tr('Report received', '已收到完成汇报') : tr('Completion report pending', '完成汇报待接收');
  if (status === 'blocked') return received ? tr('Blocker received', '已收到阻塞汇报') : tr('Blocker pending', '阻塞汇报待接收');
  if (status === 'needs_decision') return received ? tr('Decision request received', '已收到决策请求') : tr('Decision request pending', '决策请求待接收');
  return tr('Report pending', '待汇报');
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
