import { useEffect, useRef, useState } from 'react';
import { Dashboard } from './components/Dashboard';
import { SwarmPanel, runningSwarmAgents, swarmRunProgress, swarmRunTokens, useBackgroundTasks } from './components/SwarmPanel';
import { CronJobPanel } from './components/CronJobPanel';
import { AccountCenter } from './components/AccountCenter';
import { CodeView } from './components/CodeView';
import { Icon, type IconName } from './components/Icon';
import { useSessions, usePhaseStatus, useSwarmWebSocket, useServerStatus } from './hooks/useApi';
import { useChatMessages } from './hooks/useChatMessages';
import { api, type BackgroundTask, type FsEntry, type Message, type ModelCatalogItem, type PromptAttachment, type PromptExecutionOptions, type Session, type SessionAgentConfig, type SwarmStatus } from './api/client';
import { FileTree } from './components/FileTree';
import { ProjectFolderPicker } from './components/ProjectFolderPicker';
import { useI18n } from './i18n';
import { modelThinkingOptions } from './utils/model-thinking';
import { loadRewindLimit } from './rewindPreferences';
import type { ChatSlashCommandName } from './utils/chat-slash-commands';
import { installSoundUnlock, playNotificationSound } from './notificationSounds';

type View = 'chat' | 'dashboard' | 'swarm' | 'cron' | 'account';
type SidebarTab = 'sessions' | 'files';
type InitialMessage = { text: string; attachments: PromptAttachment[]; options?: PromptExecutionOptions };

const NAV_ITEMS: { key: View; icon: IconName; label: string }[] = [
  { key: 'chat', icon: 'chat', label: 'Chat' },
  { key: 'dashboard', icon: 'dashboard', label: 'Overview' },
  { key: 'swarm', icon: 'swarm', label: 'Swarm' },
  { key: 'cron', icon: 'clock', label: 'Cron Job' },
];

const SIDEBAR_TABS: { key: SidebarTab; icon: IconName; label: string }[] = [
  { key: 'sessions', icon: 'sessions', label: 'Sessions' },
  { key: 'files', icon: 'files', label: 'Files' },
];

const SIDEBAR_EXPANDED_STORAGE_KEY = 'nori-sidebar-expanded';

function loadSidebarExpanded(): boolean {
  try {
    const saved = window.localStorage.getItem(SIDEBAR_EXPANDED_STORAGE_KEY);
    if (saved === 'true') return true;
    if (saved === 'false') return false;
  } catch {
    // Use the expanded default when storage is unavailable.
  }
  return true;
}

function persistSidebarExpanded(expanded: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_EXPANDED_STORAGE_KEY, String(expanded));
  } catch {
    // Keep the state in memory when storage is unavailable.
  }
}

export function App() {
  const { tr } = useI18n();
  const [activeView, setActiveView] = useState<View>('chat');
  const [sidebarExpanded, setSidebarExpanded] = useState(loadSidebarExpanded);
  const [sidebarWidth, setSidebarWidth] = useState(() => Math.max(220, Math.min(480, Number(localStorage.getItem('nori-sidebar-width')) || 256)));
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('sessions');
  const [models, setModels] = useState<ModelCatalogItem[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelError, setModelError] = useState<string | null>(null);
  const [selectedProjectFile, setSelectedProjectFile] = useState<FsEntry | null>(null);
  const [selectedProjectRoot, setSelectedProjectRoot] = useState<string | null>(null);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [pendingInitialMessage, setPendingInitialMessage] = useState<InitialMessage | null>(null);
  const [queuedFirstMessage, setQueuedFirstMessage] = useState<(InitialMessage & { sessionId: string }) | null>(null);
  const [draftAgentConfig, setDraftAgentConfig] = useState<SessionAgentConfig>({
    model: '',
    thinking: 'off',
    permission_mode: 'manual',
    plan_mode: false,
    main_write_enabled: true,
  });
  const [rewindLimit, setRewindLimit] = useState(loadRewindLimit);
  const [cronJobCount, setCronJobCount] = useState(0);
  const cronCountRequestRef = useRef(0);
  const swarm = useSwarmWebSocket();
  const swarmSoundStateRef = useRef<Map<string, SwarmStatus['status']> | null>(null);

  useEffect(() => installSoundUnlock(), []);

  useEffect(() => {
    persistSidebarExpanded(sidebarExpanded);
  }, [sidebarExpanded]);

  useEffect(() => {
    const roots = Array.from(swarm.swarmStatuses.values()).filter(run => !run.parent_swarm_id);
    if (swarmSoundStateRef.current === null) {
      if (roots.length > 0) swarmSoundStateRef.current = new Map(roots.map(run => [run.swarm_id, run.status]));
      return;
    }
    const previous = swarmSoundStateRef.current;
    for (const run of roots) {
      const before = previous.get(run.swarm_id);
      const wasActive = before === 'pending' || before === 'running' || before === 'paused';
      if (wasActive && run.status === 'done') playNotificationSound('agent-complete');
      if (wasActive && run.status === 'failed') playNotificationSound('error');
      previous.set(run.swarm_id, run.status);
    }
  }, [swarm.swarmStatuses]);

  const {
    sessions,
    sessionId,
    isLoading: sessionsLoading,
    error: sessionsError,
    creating: sessionsCreating,
    createNewSession,
    switchSession,
    archiveSession,
    deleteSession,
    renameSession,
    forkSession,
    updateSessionProfile,
    refresh: refreshSessions,
  } = useSessions();
  const activeSession: Session | null = sessions.find(session => session.id === sessionId) ?? null;
  const backgroundTasks = useBackgroundTasks(sessionId);
  useEffect(() => {
    const requestId = ++cronCountRequestRef.current;
    if (!sessionId) {
      setCronJobCount(0);
      return;
    }
    setCronJobCount(0);
    const refresh = async () => {
      try {
        const result = await api.sessions.cron.list(sessionId);
        if (cronCountRequestRef.current === requestId) setCronJobCount(result.items.length);
      } catch {
        if (cronCountRequestRef.current === requestId) setCronJobCount(0);
      }
    };
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 30_000);
    return () => { window.clearInterval(interval); };
  }, [sessionId]);
  const sessionSwarmRuns = Array.from(swarm.swarmStatuses.values()).filter(status =>
    status.session_id === sessionId,
  );
  const activeSwarmRuns = sessionSwarmRuns.filter(status => {
    const progress = swarmRunProgress(status);
    return progress.running || progress.status === 'paused';
  });
  const activeAgentTokens = activeSwarmRuns.reduce((total, run) => total + swarmRunTokens(run), 0);
  useEffect(() => { setSelectedProjectFile(null); }, [sessionId]);
  useEffect(() => {
    if (activeSession?.metadata?.cwd) setSelectedProjectRoot(activeSession.metadata.cwd);
  }, [activeSession?.metadata?.cwd]);
  const viewLabels: Record<View, string> = {
    chat: tr('Chat', '对话'),
    dashboard: tr('Dashboard', '仪表盘'),
    swarm: tr('Swarm', '智能体协作'),
    cron: tr('Cron Job', '定时任务'),
    account: tr('My profile', '我的'),
  };
  const sidebarLabels: Record<SidebarTab, string> = {
    sessions: tr('Sessions', '会话'),
    files: tr('Files', '文件'),
  };
  const { messages, messagesLoading, isStreaming, currentStreaming, currentThinking, currentWorkBlocks, sessionStatus, compacting, pendingApprovals, pendingQuestions, queuedPrompts, todos, activeSubagentIds, codeChanges, resolveApproval, resolveQuestion, dismissQuestion, sendMessage, cancelQueuedPrompt, rewindToPrompt, refreshMessages, abort } = useChatMessages(sessionId, activeSession?.title);
  const activeAgentCount = countActiveAgents(activeSubagentIds, sessionSwarmRuns, backgroundTasks.tasks);
  const hasSwarmActivity = activeSwarmRuns.length > 0;

  useEffect(() => {
    const onLimitChanged = (event: Event) => {
      const value = (event as CustomEvent<number>).detail;
      if (Number.isFinite(value)) setRewindLimit(value);
    };
    window.addEventListener('nori:rewind-limit-changed', onLimitChanged);
    return () => window.removeEventListener('nori:rewind-limit-changed', onLimitChanged);
  }, []);

  useEffect(() => {
    if (!queuedFirstMessage || queuedFirstMessage.sessionId !== sessionId) return;
    const queued = queuedFirstMessage;
    setQueuedFirstMessage(null);
    void sendMessage(queued.text, queued.attachments, 'queue', queued.options);
  }, [queuedFirstMessage, sendMessage, sessionId]);

  const refreshModels = async () => {
    setModelsLoading(true);
    setModelError(null);
    try {
      const result = await api.models.list();
      setModels(result.items);
    } catch (error) {
      setModelError(error instanceof Error ? error.message : tr('Failed to load models', '加载模型失败'));
    } finally {
      setModelsLoading(false);
    }
  };

  useEffect(() => {
    void refreshModels();
    const onCatalogChanged = () => { void refreshModels(); };
    window.addEventListener('nori:model-catalog-changed', onCatalogChanged);
    return () => window.removeEventListener('nori:model-catalog-changed', onCatalogChanged);
  }, []);

  const changeModel = async (modelId: string) => {
    const model = models.find(item => item.model === modelId);
    const effort = modelThinkingOptions(model).defaultValue;
    if (!activeSession) {
      setDraftAgentConfig(previous => ({ ...previous, model: modelId, thinking: effort }));
      return;
    }
    await updateSessionProfile(activeSession.id, { agent_config: { model: modelId, thinking: effort } });
  };

  const changeThinking = async (effort: string) => {
    if (!activeSession) {
      setDraftAgentConfig(previous => ({ ...previous, thinking: effort }));
      return;
    }
    await updateSessionProfile(activeSession.id, { agent_config: { thinking: effort } });
  };

  const changePermission = async (permissionMode: 'auto' | 'yolo' | 'manual') => {
    if (!activeSession) {
      setDraftAgentConfig(previous => ({ ...previous, permission_mode: permissionMode }));
      return;
    }
    await updateSessionProfile(activeSession.id, { agent_config: { permission_mode: permissionMode } });
  };

  const changeTaskMode = async (taskMode: 'plan' | 'code') => {
    const planMode = taskMode === 'plan';
    if (!activeSession) {
      setDraftAgentConfig(previous => ({ ...previous, plan_mode: planMode }));
      return;
    }
    await updateSessionProfile(activeSession.id, { agent_config: { plan_mode: planMode } });
  };

  const changeMainWrite = async (enabled: boolean) => {
    if (!activeSession) {
      setDraftAgentConfig(previous => ({ ...previous, main_write_enabled: enabled }));
      return;
    }
    await updateSessionProfile(activeSession.id, { agent_config: { main_write_enabled: enabled } });
  };

  const controlGoal = async (action: 'pause' | 'resume' | 'cancel') => {
    if (!activeSession) return;
    await updateSessionProfile(activeSession.id, { agent_config: { goal_control: action } });
  };

  const createConversation = async (cwd: string, firstMessage?: InitialMessage) => {
    setSelectedProjectRoot(cwd);
    const createdId = await createNewSession({
      cwd,
      smart_title: true,
      agent_config: {
        model: draftAgentConfig.model,
        thinking: draftAgentConfig.thinking,
        permission_mode: draftAgentConfig.permission_mode,
        plan_mode: draftAgentConfig.plan_mode,
        main_write_enabled: draftAgentConfig.main_write_enabled,
      },
    });
    if (createdId && firstMessage) setQueuedFirstMessage({ sessionId: createdId, ...firstMessage });
    return createdId !== null;
  };

  const chooseProject = async (firstMessage?: InitialMessage) => {
    if (window.noriDesktop?.selectProjectDirectory) {
      const cwd = await window.noriDesktop.selectProjectDirectory();
      if (!cwd) return false;
      if (firstMessage) return createConversation(cwd, firstMessage);
      setSelectedProjectRoot(cwd);
      switchSession(null);
      return true;
    }
    setPendingInitialMessage(firstMessage ?? null);
    setFolderPickerOpen(true);
    return true;
  };

  const startNewConversation = () => {
    if (activeSession?.agent_config) {
      setDraftAgentConfig(previous => ({ ...previous, ...activeSession.agent_config }));
    }
    setSelectedProjectRoot(null);
    switchSession(null);
    setActiveView('chat');
  };

  const handleSendMessage = async (text: string, attachments: PromptAttachment[] = [], behavior: 'queue' | 'steer' = 'queue', options?: PromptExecutionOptions) => {
    if (activeSession) {
      await sendMessage(text, attachments, behavior, options);
      return true;
    }
    const firstMessage = { text, attachments, options };
    if (selectedProjectRoot) return createConversation(selectedProjectRoot, firstMessage);
    return chooseProject(firstMessage);
  };

  const handleRunSlashCommand = async (command: ChatSlashCommandName, args: string) => {
    if (!activeSession) return false;
    if (command === 'compact') {
      await api.sessions.compact(activeSession.id, args);
      return true;
    }
    if (command === 'goal') {
      return sendMessage(args, [], 'queue', { goalObjective: args });
    }
    return sendMessage(args, [], 'queue', { swarmMode: true });
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        setSidebarExpanded(previous => !previous);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const selectSidebarTab = (tab: SidebarTab) => {
    setSidebarTab(tab);
    setActiveView('chat');
  };

  const closeSidebarOnNarrowViewport = () => {
    if (window.innerWidth <= 760) setSidebarExpanded(false);
  };

  const renderContent = () => {
    switch (activeView) {
      case 'dashboard':
        return (
          <div className="view-page view-page-wide">
            <div className="view-stack">
              <ViewHeader eyebrow={tr('Workspace', '工作区')} title={tr('Overview', '概览')} description={tr('Track the current phase, swarm activity, and knowledge captured by Nori.', '跟踪当前阶段、智能体协作动态以及 Nori 沉淀的知识。')} />
              <Dashboard swarm={swarm} sessions={sessions} models={models} />
            </div>
          </div>
        );
      case 'swarm':
        return (
          <div className="view-page">
            <div className="view-stack">
              <ViewHeader eyebrow={tr('Coordination', '协作')} title={tr('Swarm', '智能体协作')} description={tr('See every active agent and follow task progress in real time.', '查看所有活动智能体并实时跟踪任务进度。')} />
              <SwarmPanel swarm={swarm} sessionId={sessionId} sessions={sessions} models={models} backgroundState={backgroundTasks} />
            </div>
          </div>
        );
      case 'cron':
        return (
          <div className="view-page">
            <div className="view-stack">
              <ViewHeader eyebrow={tr('Automation', '自动化')} title={tr('Cron Job', '定时任务')} description={tr('Schedule prompts for the main agent in a selected session.', '为指定会话的主 Agent 安排定时任务。')} />
              <CronJobPanel sessions={sessions} sessionId={sessionId} onCountChange={(targetSessionId, count) => {
                if (targetSessionId === sessionId) setCronJobCount(count);
              }} />
            </div>
          </div>
        );
      case 'account':
        return (
          <div className="view-page view-page-wide account-page">
            <div className="view-stack">
              <AccountCenter />
            </div>
          </div>
        );
      case 'chat':
      default:
        return (
          <CodeView
            session={activeSession}
            allSessions={sessions}
            messages={messages}
            messagesLoading={messagesLoading}
            streaming={currentStreaming}
            thinking={currentThinking}
            workBlocks={currentWorkBlocks}
            isStreaming={isStreaming}
            activeAgentCount={activeAgentCount}
            activeAgentTokens={activeAgentTokens}
            sessionStatus={sessionStatus}
            compacting={compacting}
            models={models}
            modelsLoading={modelsLoading}
            modelError={modelError}
            onRefreshModels={() => void refreshModels()}
            onModelChange={changeModel}
            onThinkingChange={changeThinking}
            onPermissionChange={changePermission}
            onTaskModeChange={changeTaskMode}
            onRunSlashCommand={handleRunSlashCommand}
            onMainWriteChange={changeMainWrite}
            onGoalControl={controlGoal}
            onSendMessage={handleSendMessage}
            onAbort={abort}
            pendingApprovals={pendingApprovals}
            onResolveApproval={resolveApproval}
            pendingQuestions={pendingQuestions}
            onResolveQuestion={resolveQuestion}
            onDismissQuestion={dismissQuestion}
            queuedPrompts={queuedPrompts}
            todos={todos}
            onCancelQueuedPrompt={cancelQueuedPrompt}
            selectedFile={selectedProjectFile}
            codeChanges={codeChanges}
            draftAgentConfig={draftAgentConfig}
            rewindLimit={rewindLimit}
            onRewind={rewindToPrompt}
            onRefreshMessages={refreshMessages}
            onSelectFilePath={path => setSelectedProjectFile({ path, name: path.replaceAll('\\', '/').split('/').at(-1) ?? path, kind: 'file', modified_at: '' })}
          />
        );
    }
  };

  return (
    <div className={`app-container codex-layout${sidebarExpanded ? ' sidebar-is-expanded' : ''}`}>
      <aside className={`sidebar${sidebarExpanded ? ' expanded' : ''}`} style={sidebarExpanded ? { width: sidebarWidth, minWidth: sidebarWidth } : undefined} aria-label={tr('Nori workspace', 'Nori 工作区')}>
        <div className="sidebar-brand">
          <span className="app-logo" aria-hidden="true"><span>N</span></span>
          <span className="sidebar-brand-copy"><strong>Nori Work</strong><small>{tr('Independent workspace', '独立工作区')}</small></span>
        </div>

        <div className="sidebar-tabs sidebar-workspace-switch" role="tablist" aria-label={tr('Workspace panels', '工作区面板')}>
          {SIDEBAR_TABS.map(tab => (
            <button key={tab.key} className={`sidebar-tab${sidebarTab === tab.key ? ' active' : ''}`} onClick={() => selectSidebarTab(tab.key)} title={sidebarLabels[tab.key]} role="tab" aria-selected={sidebarTab === tab.key}>
              <Icon name={tab.icon} size={16} /><span className="sidebar-tab-label">{sidebarLabels[tab.key]}</span>
            </button>
          ))}
        </div>

        {sidebarTab === 'sessions' && <PrimaryNavigation
          activeView={activeView}
          labels={viewLabels}
          activeAgentCount={activeAgentCount}
          cronJobCount={cronJobCount}
          onSelect={itemKey => {
            setActiveView(itemKey);
            if (itemKey === 'chat') setSidebarTab('sessions');
            closeSidebarOnNarrowViewport();
          }}
        />}

        <div className="sidebar-content">
          {sidebarTab === 'sessions' && (
            <SessionsList sessions={sessions} sessionId={sessionId} sessionsLoading={sessionsLoading} sessionsError={sessionsError} sessionsCreating={sessionsCreating} onRefresh={refreshSessions} onCreateSession={() => void startNewConversation()} onSwitchSession={id => { switchSession(id); setActiveView('chat'); closeSidebarOnNarrowViewport(); }} onArchiveSession={archiveSession} onDeleteSession={deleteSession} onRenameSession={renameSession} onForkSession={async (id, title) => { await forkSession(id, title); setActiveView('chat'); closeSidebarOnNarrowViewport(); }} />
          )}
          {sidebarTab === 'files' && <FilesSidebar session={activeSession} selectedFile={selectedProjectFile} onSelectFile={setSelectedProjectFile} />}
        </div>

        <div className="sidebar-footer-nav">
          <button className={`sidebar-nav-item sidebar-account${activeView === 'account' ? ' active' : ''}`} onClick={() => {
            setActiveView('account');
          }} title={tr('My memory and settings', '我的记忆和设置')}>
            <span className="sidebar-account-avatar"><Icon name="user" size={13}/></span><span className="sidebar-account-copy"><strong>{tr('My profile', '我的')}</strong><small>{tr('Memory and settings', '记忆和设置')}</small></span>
          </button>
          <button className="sidebar-nav-item sidebar-collapse-row" onClick={() => setSidebarExpanded(previous => !previous)} title={tr('Toggle sidebar (Ctrl+B)', '切换侧栏 (Ctrl+B)')}>
            <Icon name="panel-left" size={17} /><span>{tr('Collapse sidebar', '收起侧栏')}</span><kbd>Ctrl B</kbd>
          </button>
        </div>
        {sidebarExpanded && <div className="sidebar-resizer" onPointerMove={event => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const y = Math.max(0, Math.min(bounds.height, event.clientY - bounds.top));
          event.currentTarget.style.setProperty('--resize-highlight-y', `${y}px`);
        }} onPointerDown={event => {
          event.currentTarget.setPointerCapture(event.pointerId);
          const startX = event.clientX;
          const startWidth = sidebarWidth;
          const move = (moveEvent: PointerEvent) => setSidebarWidth(Math.max(220, Math.min(480, startWidth + moveEvent.clientX - startX)));
          const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            setSidebarWidth(current => { localStorage.setItem('nori-sidebar-width', String(current)); return current; });
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up, { once: true });
        }} />}
      </aside>

      <div className="main-area">
        <header className="top-bar">
          <div className="workspace-breadcrumb"><span>Nori Work</span><Icon name="chevron-right" size={13} /><strong>{viewLabels[activeView]}</strong></div>
          <div className="top-bar-actions">
            <div className="session-chip" title={activeSession?.id ?? tr('No active session', '无活动会话')}><span className={`status-dot${activeSession ? ' active' : ' idle'}`} /><span>{activeSession?.title || tr('No session', '无会话')}</span></div>
          </div>
          <WindowControls />
        </header>
        <main className={`content-area content-area-${activeView}`}>{renderContent()}</main>
        <StatusBar sending={isStreaming} activeAgentCount={activeAgentCount} hasSwarmActivity={hasSwarmActivity} />
      </div>
      <ProjectFolderPicker
        open={folderPickerOpen}
        onClose={() => { setFolderPickerOpen(false); setPendingInitialMessage(null); }}
        onSelect={cwd => {
          const firstMessage = pendingInitialMessage ?? undefined;
          setFolderPickerOpen(false);
          setPendingInitialMessage(null);
          if (firstMessage) {
            void createConversation(cwd, firstMessage);
          } else {
            setSelectedProjectRoot(cwd);
            switchSession(null);
            setActiveView('chat');
          }
        }}
      />
    </div>
  );
}

export function PrimaryNavigation({ activeView, labels, activeAgentCount, cronJobCount, onSelect }: {
  activeView: View;
  labels: Record<View, string>;
  activeAgentCount: number;
  cronJobCount: number;
  onSelect: (view: View) => void;
}) {
  return <nav className="sidebar-primary-nav" aria-label="Primary navigation">
    {NAV_ITEMS.map(item => {
      const swarmActive = item.key === 'swarm' && activeAgentCount > 0;
      const cronActive = item.key === 'cron' && cronJobCount > 0;
      const count = item.key === 'swarm' ? activeAgentCount : item.key === 'cron' ? cronJobCount : 0;
      return <button
        key={item.key}
        className={`sidebar-nav-item${activeView === item.key ? ' active' : ''}${swarmActive || cronActive ? ' activity-pending' : ''}`}
        onClick={() => { onSelect(item.key); }}
        aria-current={activeView === item.key ? 'page' : undefined}
        title={labels[item.key]}
      >
        <Icon name={item.icon} size={17} /><span>{labels[item.key]}</span>{count > 0 && <i className="sidebar-activity-count">{count}</i>}
      </button>;
    })}
  </nav>;
}

export function WindowControls() {
  const { tr } = useI18n();
  const desktop = window.noriDesktop;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!desktop?.windowIsMaximized) return;
    let active = true;
    void desktop.windowIsMaximized().then(value => {
      if (active) setMaximized(value);
    });
    const unsubscribe = desktop.onWindowMaximizedChange?.(setMaximized);
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [desktop]);

  if (desktop?.usesCustomWindowControls !== true || !desktop.windowMinimize || !desktop.windowToggleMaximize || !desktop.windowClose) return null;
  return <div className="window-controls" aria-label={tr('Window controls', '窗口控制')}>
    <button type="button" onClick={() => {
      desktop.windowMinimize?.();
    }} title={tr('Minimize', '最小化')} aria-label={tr('Minimize', '最小化')}><Icon name="minimize" size={14}/></button>
    <button type="button" onClick={() => { void desktop.windowToggleMaximize?.().then(setMaximized); }} title={maximized ? tr('Restore', '还原') : tr('Maximize', '最大化')} aria-label={maximized ? tr('Restore', '还原') : tr('Maximize', '最大化')}><Icon name={maximized ? 'restore' : 'maximize'} size={12}/></button>
    <button type="button" className="window-close" onClick={() => {
      desktop.windowClose?.();
    }} title={tr('Close', '关闭')} aria-label={tr('Close', '关闭')}><Icon name="close" size={14}/></button>
  </div>;
}

export function countActiveAgents(
  activeSubagentIds: readonly string[],
  sessionSwarmRuns: readonly SwarmStatus[],
  backgroundTasks: readonly BackgroundTask[],
): number {
  const knownSwarmAgentIds = new Set(sessionSwarmRuns.flatMap(run =>
    run.tasks?.flatMap(task => [task.id, ...(task.agent_id ? [task.agent_id] : [])]) ?? [],
  ));
  const liveNonSwarmCount = new Set(activeSubagentIds.filter(id => !knownSwarmAgentIds.has(id))).size;
  const polledNonSwarmCount = backgroundTasks.filter(task =>
    task.kind === 'subagent' && task.status === 'running' && !knownSwarmAgentIds.has(task.id),
  ).length;
  const activeSwarmRuns = sessionSwarmRuns.filter(run => {
    const progress = swarmRunProgress(run);
    return progress.running || progress.status === 'paused';
  });
  const runningSwarm = runningSwarmAgents(activeSwarmRuns);
  return runningSwarm.ids.size + runningSwarm.untracked + Math.max(liveNonSwarmCount, polledNonSwarmCount);
}

function ViewHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <header className="view-header">
      <span className="view-eyebrow">{eyebrow}</span>
      <h1>{title}</h1>
      <p>{description}</p>
    </header>
  );
}

function StatusBar({ sending, activeAgentCount, hasSwarmActivity }: { sending: boolean; activeAgentCount: number; hasSwarmActivity: boolean }) {
  const { tr } = useI18n();
  const { phase } = usePhaseStatus();
  const { connected } = useServerStatus();
  return (
    <footer className="status-bar">
      <div className="status-left">
        <span className={`status-dot${phase.phase !== 'idle' ? ' active' : ' idle'}`} />
        <span>{phase.phase === 'idle' ? tr('Ready', '就绪') : phase.phase}</span>
        {sending && <span className="status-accent">{tr('Nori is working...', 'Nori 正在工作...')}</span>}
      </div>
      <div className="status-right">
        <span className="status-item"><span className={`status-dot${connected ? ' success' : ' error'}`} />{connected ? tr('Local server', '本地服务') : tr('Offline', '离线')}</span>
        <span className="status-item"><Icon name="swarm" size={13} />{activeAgentCount > 0 ? tr(`${activeAgentCount} agents active`, `${activeAgentCount} 个智能体活动中`) : hasSwarmActivity ? tr('Swarm queued', '协作排队中') : tr('Swarm idle', '协作空闲')}</span>
      </div>
    </footer>
  );
}

const COLLAPSED_SESSION_GROUPS_KEY = 'nori-collapsed-session-groups';

function loadCollapsedSessionGroups(): Set<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(COLLAPSED_SESSION_GROUPS_KEY) ?? '[]');
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
  } catch {
    return new Set();
  }
}

function sessionProjectKey(session: Session): string {
  const cwd = session.metadata?.cwd?.trim();
  return cwd ? cwd.replaceAll('\\', '/').replace(/\/+$/, '') : '__unassigned__';
}

function SessionsList({
  sessions,
  sessionId,
  sessionsLoading,
  sessionsError,
  sessionsCreating,
  onRefresh,
  onCreateSession,
  onSwitchSession,
  onArchiveSession,
  onDeleteSession,
  onRenameSession,
  onForkSession,
}: {
  sessions: Session[];
  sessionId: string | null;
  sessionsLoading: boolean;
  sessionsError: string | null;
  sessionsCreating: boolean;
  onRefresh: () => Promise<void>;
  onCreateSession: () => void;
  onSwitchSession: (id: string) => void;
  onArchiveSession: (id: string) => Promise<void>;
  onDeleteSession: (id: string) => Promise<void>;
  onRenameSession: (id: string, title: string) => Promise<void>;
  onForkSession: (id: string, title?: string) => Promise<void>;
}) {
  const { tr } = useI18n();
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(loadCollapsedSessionGroups);
  const [archiveCollapsed, setArchiveCollapsed] = useState(true);
  const [contextMenu, setContextMenu] = useState<{ session: Session; x: number; y: number } | null>(null);
  const [actionSessionId, setActionSessionId] = useState<string | null>(null);
  const [actionDialog, setActionDialog] = useState<{ action: 'rename' | 'fork'; session: Session; value: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!actionNotice || actionSessionId !== null) return;
    const timer = window.setTimeout(() => setActionNotice(null), 3_500);
    return () => window.clearTimeout(timer);
  }, [actionNotice, actionSessionId]);

  const groupSessions = (items: Session[]) => Array.from(
    items.reduce((groups, session) => {
      const key = sessionProjectKey(session);
      const group = groups.get(key);
      if (group) group.push(session);
      else groups.set(key, [session]);
      return groups;
    }, new Map<string, Session[]>()),
  );
  const activeGroups = groupSessions(sessions.filter(session => !session.archived));
  const archivedGroups = groupSessions(sessions.filter(session => session.archived));

  const toggleGroup = (key: string) => {
    setCollapsedGroups(previous => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(COLLAPSED_SESSION_GROUPS_KEY, JSON.stringify([...next]));
      } catch {
        // Keep the collapse state in memory when storage is unavailable.
      }
      return next;
    });
  };

  const runSessionAction = async (action: 'archive' | 'delete' | 'rename' | 'fork' | 'export', session: Session) => {
    setContextMenu(null);
    setActionError(null);
    setActionNotice(null);
    if (action === 'delete' && !window.confirm(tr(
      `Delete "${session.title || session.id}" permanently?`,
      `确定永久删除“${session.title || session.id}”吗？`,
    ))) return;
    if (action === 'rename') {
      setActionDialog({ action, session, value: session.title || '' });
      return;
    }
    if (action === 'fork') {
      setActionDialog({ action, session, value: `${tr('Fork', '分支')}: ${session.title || session.id.slice(0, 8)}` });
      return;
    }
    setActionSessionId(session.id);
    if (action === 'export') setActionNotice(tr('Exporting Markdown…', '正在导出 Markdown…'));
    try {
      if (action === 'export') {
        const exported = await exportSessionMarkdown(session);
        setActionNotice(exported
          ? tr('Markdown exported.', 'Markdown 已导出。')
          : tr('Markdown export cancelled.', '已取消导出 Markdown。'));
      } else if (action === 'archive') {
        await onArchiveSession(session.id);
      } else {
        await onDeleteSession(session.id);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : tr('Session action failed.', '会话操作失败。'));
    } finally {
      setActionSessionId(null);
    }
  };

  const submitActionDialog = async () => {
    if (!actionDialog) return;
    const value = actionDialog.value.trim();
    if (actionDialog.action === 'rename' && (!value || value === actionDialog.session.title)) {
      setActionDialog(null);
      return;
    }
    setActionError(null);
    setActionNotice(null);
    setActionSessionId(actionDialog.session.id);
    try {
      if (actionDialog.action === 'rename') {
        await onRenameSession(actionDialog.session.id, value);
        setActionNotice(tr('Conversation renamed.', '会话已重命名。'));
      } else {
        await onForkSession(actionDialog.session.id, value || undefined);
        setActionNotice(tr('Conversation forked.', '会话分支已创建。'));
      }
      setActionDialog(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : tr('Session action failed.', '会话操作失败。'));
    } finally {
      setActionSessionId(null);
    }
  };

  const renderGroups = (groups: Array<[string, Session[]]>, archived: boolean) => groups.map(([projectKey, projectSessions]) => {
    const groupKey = `${archived ? 'archive:' : 'active:'}${projectKey}`;
    const collapsed = collapsedGroups.has(groupKey);
    const normalized = projectKey.replace(/[\\/]+$/, '');
    const pathParts = normalized.split(/[\\/]/).filter(Boolean);
    const projectName = projectKey === '__unassigned__'
      ? tr('Unassigned project', '未指定项目')
      : pathParts.at(-1) || projectKey;
    const projectPath = projectKey === '__unassigned__'
      ? tr('Sessions without a working folder', '没有工作目录的会话')
      : projectKey;

    return (
      <section className="session-project-group" key={groupKey}>
        <button className="session-project-header" onClick={() => toggleGroup(groupKey)} aria-expanded={!collapsed} title={projectPath}>
          <Icon name="files" size={15} />
          <span className="session-project-copy"><strong>{projectName}</strong><small>{projectPath}</small></span>
          <span className="session-project-count">{projectSessions.length}</span>
          <Icon name="chevron-right" size={14} />
        </button>
        {!collapsed && <div className="session-project-items">
          {projectSessions.map(session => (
            <button
              key={session.id}
              className={'sidebar-item' + (session.id === sessionId ? ' active' : '')}
              onClick={() => onSwitchSession(session.id)}
              onContextMenu={event => {
                event.preventDefault();
                setContextMenu({ session, x: event.clientX, y: event.clientY });
              }}
              disabled={actionSessionId === session.id}
            >
              <span className={'status-dot' + (session.id === sessionId ? ' active' : ' idle')} />
              <span className="sidebar-item-copy"><strong title={session.title || tr('Untitled conversation', '未命名会话')}>{session.title || tr('Untitled conversation', '未命名会话')}</strong><small>{archived ? tr('Archived', '已归档') : session.status || 'ready'}</small></span>
              {session.message_count !== undefined && session.message_count !== null && <span className="sidebar-item-count">{session.message_count}</span>}
            </button>
          ))}
        </div>}
      </section>
    );
  });

  return (
    <div className="sidebar-panel">
      <div className="sidebar-header">
        <span>{tr('Projects', '项目')}</span>
        <span className="sidebar-header-actions"><button className="btn-icon" title={tr('Refresh sessions', '刷新会话')} aria-label={tr('Refresh sessions', '刷新会话')} onClick={() => void onRefresh()} disabled={sessionsLoading}><Icon name="refresh" size={14}/></button><button className="btn-icon" title={tr('New session', '新建会话')} onClick={onCreateSession} disabled={sessionsCreating}>
          {sessionsCreating ? <span className="spinner spinner-small" /> : <Icon name="plus" size={15} />}
        </button></span>
      </div>
      <div className="sidebar-list">
        {sessionsLoading ? (
          <div className="sidebar-placeholder"><span className="spinner spinner-small" /> {tr('Loading sessions', '正在加载会话')}</div>
        ) : sessionsError ? (
          <div className="sidebar-placeholder error"><Icon name="alert" size={15} /> {sessionsError}</div>
        ) : sessions.length === 0 ? (
          <div className="sidebar-empty">
            <Icon name="sparkles" size={22} />
            <strong>{tr('Start something new', '开始新任务')}</strong>
            <span>{tr('Create a session to plan, code, and review with Nori.', '创建会话，与 Nori 一起规划、编码和评审。')}</span>
            <button className="btn btn-primary btn-compact" onClick={onCreateSession}>{tr('New session', '新建会话')}</button>
          </div>
        ) : <>
          {renderGroups(activeGroups, false)}
          {archivedGroups.length > 0 && <section className="session-archive-root">
            <button className="session-project-header session-archive-header" onClick={() => setArchiveCollapsed(previous => !previous)} aria-expanded={!archiveCollapsed}>
              <Icon name="archive" size={15} />
              <span className="session-project-copy"><strong>{tr('Archive', '归档')}</strong><small>{tr('Archived conversations', '已归档会话')}</small></span>
              <span className="session-project-count">{archivedGroups.reduce((count, [, group]) => count + group.length, 0)}</span>
              <Icon name="chevron-right" size={14} />
            </button>
            {!archiveCollapsed && <div className="session-archive-groups">{renderGroups(archivedGroups, true)}</div>}
          </section>}
        </>}
      </div>
      {contextMenu && <div className="session-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onPointerDown={event => event.stopPropagation()} role="menu">
        <button role="menuitem" onClick={() => void runSessionAction('rename', contextMenu.session)}><Icon name="chat" size={14}/>{tr('Rename session', '重命名会话')}</button>
        <button role="menuitem" onClick={() => void runSessionAction('fork', contextMenu.session)}><Icon name="plus" size={14}/>{tr('Fork session', 'Fork 会话')}</button>
        <button role="menuitem" onClick={() => void runSessionAction('export', contextMenu.session)}><Icon name="upload" size={14}/>{tr('Export Markdown', '导出 Markdown')}</button>
        {!contextMenu.session.archived && <button role="menuitem" onClick={() => void runSessionAction('archive', contextMenu.session)}><Icon name="archive" size={14} />{tr('Archive session', '归档会话')}</button>}
        <button className="danger" role="menuitem" onClick={() => void runSessionAction('delete', contextMenu.session)}><Icon name="trash" size={14} />{tr('Delete session', '删除会话')}</button>
      </div>}
      {(actionError || actionNotice) && <div className={`session-action-notice${actionError ? ' error' : ' success'}`} role="status" aria-live="polite"><Icon name={actionError ? 'alert' : 'check'} size={14}/><span>{actionError ?? actionNotice}</span></div>}
      {actionDialog && <div className="session-action-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && actionSessionId === null) setActionDialog(null); }}>
        <form className="session-action-dialog" role="dialog" aria-modal="true" aria-labelledby="session-action-title" onSubmit={event => { event.preventDefault(); void submitActionDialog(); }}>
          <header><div><span>{tr('Conversation', '会话')}</span><h2 id="session-action-title">{actionDialog.action === 'rename' ? tr('Rename conversation', '重命名会话') : tr('Fork conversation', '创建会话分支')}</h2></div><button type="button" onClick={() => setActionDialog(null)} disabled={actionSessionId !== null} aria-label={tr('Close', '关闭')}><Icon name="close" size={14}/></button></header>
          <label><span>{actionDialog.action === 'rename' ? tr('New title', '新标题') : tr('Fork title', '分支标题')}</span><input autoFocus value={actionDialog.value} onChange={event => setActionDialog(previous => previous ? { ...previous, value: event.target.value } : previous)} placeholder={tr('Conversation title', '会话标题')}/></label>
          {actionError && <p className="error">{actionError}</p>}
          <footer><button type="button" onClick={() => setActionDialog(null)} disabled={actionSessionId !== null}>{tr('Cancel', '取消')}</button><button type="submit" className="primary" disabled={actionSessionId !== null || (actionDialog.action === 'rename' && !actionDialog.value.trim())}>{actionSessionId !== null ? <span className="spinner spinner-small"/> : actionDialog.action === 'rename' ? tr('Rename', '重命名') : tr('Create fork', '创建分支')}</button></footer>
        </form>
      </div>}
    </div>
  );
}

async function exportSessionMarkdown(session: Session): Promise<boolean> {
  const response = await api.sessions.getMessages(session.id, { page_size: 100 });
  const lines = [`# ${session.title || session.id}`, '', `> ${session.metadata?.cwd ?? ''}`, ''];
  for (const message of response.items as Message[]) {
    const originKind = message.metadata?.origin?.kind;
    if (message.role === 'user' && originKind && originKind !== 'user') continue;
    const parts = Array.isArray(message.content) ? message.content : [];
    const text = parts.filter(part => part.type === 'text').map(part => part.text ?? '').join('').trim();
    const thinking = parts.filter(part => part.type === 'thinking').map(part => part.thinking ?? part.text ?? '').join('\n').trim() || message.thinking?.trim() || '';
    const role = message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Nori' : 'System';
    if (!text && !thinking) continue;
    lines.push(`## ${role}`, '');
    if (thinking) lines.push('<details>', '<summary>Work process</summary>', '', thinking, '', '</details>', '');
    if (text) lines.push(text, '');
  }
  const content = lines.join('\n');
  const suggestedName = `${safeDownloadName(session.title || session.id)}.md`;
  if (window.noriDesktop?.saveMarkdown) {
    return (await window.noriDesktop.saveMarkdown({ suggestedName, content })) !== undefined;
  }
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = suggestedName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  return true;
}

function safeDownloadName(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'nori-session';
}

function FilesSidebar({ session, selectedFile, onSelectFile }: { session: Session | null; selectedFile: FsEntry | null; onSelectFile: (file: FsEntry) => void }) {
  return <div className="sidebar-panel sidebar-files-panel">
    <FileTree sessionId={session?.id ?? null} projectPath={session?.metadata?.cwd} selectedPath={selectedFile?.path} onSelectFile={onSelectFile} />
  </div>;
}
