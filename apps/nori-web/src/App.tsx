import { useEffect, useState } from 'react';
import { ChatView } from './components/ChatView';
import { Dashboard } from './components/Dashboard';
import { SwarmPanel, runningSwarmAgents, swarmRunTokens } from './components/SwarmPanel';
import { VaultBrowser } from './components/VaultBrowser';
import { SettingsPanel } from './components/SettingsPanel';
import { CodeView } from './components/CodeView';
import { Icon, type IconName } from './components/Icon';
import { useSessions, usePhaseStatus, useSwarmWebSocket, useServerStatus } from './hooks/useApi';
import { useChatMessages } from './hooks/useChatMessages';
import { api, type FsEntry, type Message, type ModelCatalogItem, type PromptAttachment, type Session, type SessionAgentConfig } from './api/client';
import { FileTree } from './components/FileTree';
import { ProjectFolderPicker } from './components/ProjectFolderPicker';
import { useI18n } from './i18n';
import { loadRewindLimit } from './rewindPreferences';
import type { ChatSlashCommandName } from './utils/chat-slash-commands';

type View = 'chat' | 'dashboard' | 'swarm' | 'vault' | 'settings';
type SidebarTab = 'sessions' | 'vault' | 'files';
type WorkspaceMode = 'work' | 'code';
type VaultMode = 'list' | 'graph';

const NAV_ITEMS: { key: View; icon: IconName; label: string }[] = [
  { key: 'chat', icon: 'chat', label: 'Chat' },
  { key: 'dashboard', icon: 'dashboard', label: 'Overview' },
  { key: 'swarm', icon: 'swarm', label: 'Swarm' },
  { key: 'settings', icon: 'settings', label: 'Settings' },
];

const SIDEBAR_TABS: { key: SidebarTab; icon: IconName; label: string }[] = [
  { key: 'sessions', icon: 'sessions', label: 'Sessions' },
  { key: 'vault', icon: 'vault', label: 'Vault' },
  { key: 'files', icon: 'files', label: 'Files' },
];

function loadWorkspaceMode(): WorkspaceMode {
  try {
    return localStorage.getItem('nori-ui-mode') === 'code' ? 'code' : 'work';
  } catch {
    return 'work';
  }
}

export function App() {
  const { tr } = useI18n();
  const [activeView, setActiveView] = useState<View>('chat');
  const [sidebarExpanded, setSidebarExpanded] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('sessions');
  const [mode, setMode] = useState<WorkspaceMode>(loadWorkspaceMode);
  const [models, setModels] = useState<ModelCatalogItem[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelError, setModelError] = useState<string | null>(null);
  const [vaultMode, setVaultMode] = useState<VaultMode>('list');
  const [selectedProjectFile, setSelectedProjectFile] = useState<FsEntry | null>(null);
  const [selectedProjectRoot, setSelectedProjectRoot] = useState<string | null>(null);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [pendingInitialMessage, setPendingInitialMessage] = useState<{ text: string; attachments: PromptAttachment[] } | null>(null);
  const [queuedFirstMessage, setQueuedFirstMessage] = useState<{ sessionId: string; text: string; attachments: PromptAttachment[] } | null>(null);
  const [draftAgentConfig, setDraftAgentConfig] = useState<SessionAgentConfig>({
    model: '',
    thinking: 'off',
    permission_mode: 'manual',
    plan_mode: false,
    main_write_enabled: true,
  });
  const [rewindLimit, setRewindLimit] = useState(loadRewindLimit);
  const swarm = useSwarmWebSocket();

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
  } = useSessions();
  const activeSession: Session | null = sessions.find(session => session.id === sessionId) ?? null;
  const activeSwarmRuns = Array.from(swarm.swarmStatuses.values()).filter(status =>
    status.session_id === sessionId
    && (status.status === 'running' || status.status === 'pending' || status.status === 'paused'),
  );
  const activeAgentTokens = activeSwarmRuns.reduce((total, run) => total + swarmRunTokens(run), 0);
  useEffect(() => { setSelectedProjectFile(null); }, [sessionId]);
  useEffect(() => {
    if (activeSession?.metadata?.cwd) setSelectedProjectRoot(activeSession.metadata.cwd);
  }, [activeSession?.metadata?.cwd]);
  const viewLabels: Record<View, string> = {
    chat: tr('Chat', '对话'),
    dashboard: tr('Dashboard', '仪表盘'),
    swarm: tr('Swarm', '智能体协作'),
    vault: tr('Vault', '知识库'),
    settings: tr('Settings', '设置'),
  };
  const sidebarLabels: Record<SidebarTab, string> = {
    sessions: tr('Sessions', '会话'),
    vault: tr('Vault', '知识库'),
    files: tr('Files', '文件'),
  };
  const { messages, messagesLoading, isStreaming, currentStreaming, currentThinking, currentWorkBlocks, sessionStatus, compacting, pendingApprovals, pendingQuestions, queuedPrompts, todos, activeSubagentIds, codeChanges, resolveApproval, resolveQuestion, dismissQuestion, sendMessage, cancelQueuedPrompt, rewindToPrompt, abort } = useChatMessages(sessionId);
  const runningSwarm = runningSwarmAgents(activeSwarmRuns);
  const activeAgentIds = new Set([...activeSubagentIds, ...runningSwarm.ids]);
  const activeAgentCount = activeAgentIds.size + runningSwarm.untracked;
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
    void sendMessage(queued.text, queued.attachments);
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
    const effort = model?.default_effort ?? (model?.capabilities?.includes('thinking') ? 'medium' : 'off');
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

  const createConversation = async (cwd: string, firstMessage?: { text: string; attachments: PromptAttachment[] }) => {
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

  const chooseProject = async (firstMessage?: { text: string; attachments: PromptAttachment[] }) => {
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

  const startNewConversation = async () => {
    const cwd = activeSession?.metadata?.cwd ?? selectedProjectRoot;
    if (activeSession?.agent_config) {
      setDraftAgentConfig(previous => ({ ...previous, ...activeSession.agent_config }));
    }
    if (cwd) {
      setSelectedProjectRoot(cwd);
      switchSession(null);
    } else {
      await chooseProject();
    }
    setActiveView('chat');
  };

  const handleSendMessage = async (text: string, attachments: PromptAttachment[] = [], behavior: 'queue' | 'steer' = 'queue') => {
    if (activeSession) {
      await sendMessage(text, attachments, behavior);
      return true;
    }
    const firstMessage = { text, attachments };
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
    try {
      localStorage.setItem('nori-ui-mode', mode);
    } catch {
      // Local storage can be disabled in hardened browser contexts.
    }
  }, [mode]);

  useEffect(() => {
    const unsubscribe = window.noriDesktop?.onToggleMode?.((receivedMode: string) => {
      if (receivedMode === 'work' || receivedMode === 'code') {
        setMode(receivedMode);
      } else {
        setMode(previous => previous === 'work' ? 'code' : 'work');
      }
      setActiveView('chat');
    });
    return () => unsubscribe?.();
  }, []);

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
    setSidebarExpanded(true);
    if (tab === 'vault') setActiveView('vault');
    if (tab === 'files') {
      setMode('code');
      setActiveView('chat');
    }
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
              <SwarmPanel swarm={swarm} sessionId={sessionId} sessions={sessions} />
            </div>
          </div>
        );
      case 'vault':
        return (
          <div className="view-page view-page-wide">
            <div className="view-stack">
              <ViewHeader eyebrow={tr('Knowledge', '知识')} title={tr('Vault', '知识库')} description={tr('Browse durable analysis, decisions, reviews, and task notes.', '浏览长期保存的分析、决策、评审和任务笔记。')} />
              <VaultBrowser mode={vaultMode} />
            </div>
          </div>
        );
      case 'settings':
        return (
          <div className="view-page">
            <div className="view-stack">
              <ViewHeader eyebrow={tr('Preferences', '偏好设置')} title={tr('Settings', '设置')} description={tr('Tune how Nori works and make the workspace feel like yours.', '调整 Nori 的工作方式和工作区体验。')} />
              <SettingsPanel />
            </div>
          </div>
        );
      case 'chat':
      default:
        if (mode === 'code') {
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
            />
          );
        }
        return (
          <ChatView
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
            draftAgentConfig={draftAgentConfig}
            rewindLimit={rewindLimit}
            onRewind={rewindToPrompt}
          />
        );
    }
  };

  return (
    <div className={`app-container codex-layout${sidebarExpanded ? ' sidebar-is-expanded' : ''}`}>
      <aside className={`sidebar${sidebarExpanded ? ' expanded' : ''}`} aria-label={tr('Nori workspace', 'Nori 工作区')}>
        <div className="sidebar-brand">
          <span className="app-logo" aria-hidden="true"><span>N</span></span>
          <span className="sidebar-brand-copy"><strong>Nori Work</strong><small>{tr('Independent workspace', '独立工作区')}</small></span>
          <button className="brand-collapse" onClick={() => setSidebarExpanded(previous => !previous)} title={tr('Toggle sidebar (Ctrl+B)', '切换侧栏 (Ctrl+B)')}><Icon name="panel-left" size={16} /></button>
        </div>

        <button className="new-task-button" onClick={() => void startNewConversation()} disabled={sessionsCreating}>
          {sessionsCreating ? <span className="spinner spinner-small" /> : <Icon name="plus" size={16} />}
          <span>{tr('New task', '新建任务')}</span><kbd>Ctrl N</kbd>
        </button>

        <nav className="sidebar-primary-nav" aria-label={tr('Primary navigation', '主导航')}>
          {NAV_ITEMS.filter(item => item.key !== 'settings').map(item => (
            <button key={item.key} className={`sidebar-nav-item${activeView === item.key ? ' active' : ''}${item.key === 'swarm' && activeView === 'swarm' ? ' swarm-active' : ''}${item.key === 'swarm' && hasSwarmActivity && activeView !== 'swarm' ? ' activity-pending' : ''}`} onClick={() => setActiveView(item.key)} aria-current={activeView === item.key ? 'page' : undefined} title={viewLabels[item.key]}>
              <Icon name={item.icon} size={17} /><span>{viewLabels[item.key]}</span>{item.key === 'swarm' && activeAgentCount > 0 && <i className="sidebar-activity-count">{activeAgentCount}</i>}
            </button>
          ))}
        </nav>

        <div className="sidebar-section-label"><span>{tr('Workspace', '工作区')}</span></div>
        <div className="sidebar-tabs" role="tablist" aria-label={tr('Workspace panels', '工作区面板')}>
          {SIDEBAR_TABS.map(tab => (
            <button key={tab.key} className={`sidebar-tab${sidebarTab === tab.key ? ' active' : ''}`} onClick={() => selectSidebarTab(tab.key)} title={sidebarLabels[tab.key]} role="tab" aria-selected={sidebarTab === tab.key}>
              <Icon name={tab.icon} size={16} /><span className="sidebar-tab-label">{sidebarLabels[tab.key]}</span>
            </button>
          ))}
        </div>

        <div className="sidebar-content">
          {sidebarTab === 'sessions' && (
            <SessionsList sessions={sessions} sessionId={sessionId} sessionsLoading={sessionsLoading} sessionsError={sessionsError} sessionsCreating={sessionsCreating} onCreateSession={() => void startNewConversation()} onSwitchSession={id => { switchSession(id); setActiveView('chat'); }} onArchiveSession={archiveSession} onDeleteSession={deleteSession} onRenameSession={renameSession} onForkSession={async (id, title) => { await forkSession(id, title); setActiveView('chat'); }} />
          )}
          {sidebarTab === 'vault' && <VaultSidebar mode={vaultMode} onModeChange={setVaultMode} />}
          {sidebarTab === 'files' && <FilesSidebar session={activeSession} selectedFile={selectedProjectFile} onSelectFile={setSelectedProjectFile} />}
        </div>

        <div className="sidebar-footer-nav">
          <button className={`sidebar-nav-item${activeView === 'settings' ? ' active' : ''}`} onClick={() => setActiveView('settings')} title={tr('Settings', '设置')}>
            <Icon name="settings" size={17} /><span>{tr('Settings', '设置')}</span>
          </button>
          <button className="sidebar-nav-item sidebar-collapse-row" onClick={() => setSidebarExpanded(previous => !previous)} title={tr('Toggle sidebar (Ctrl+B)', '切换侧栏 (Ctrl+B)')}>
            <Icon name="panel-left" size={17} /><span>{tr('Collapse sidebar', '收起侧栏')}</span><kbd>Ctrl B</kbd>
          </button>
        </div>
      </aside>

      <div className="main-area">
        <header className="top-bar">
          <div className="workspace-breadcrumb"><span>Nori Work</span><Icon name="chevron-right" size={13} /><strong>{viewLabels[activeView]}</strong></div>
          <div className="top-bar-actions">
            {activeView === 'chat' && (
              <div className="mode-toggle-bar" aria-label={tr('Workspace layout', '工作区布局')}>
                <button className={`mode-toggle-btn${mode === 'work' ? ' active' : ''}`} onClick={() => setMode('work')}>{tr('Focus', '专注')}</button>
                <button className={`mode-toggle-btn${mode === 'code' ? ' active' : ''}`} onClick={() => setMode('code')}>{tr('Code', '代码')}</button>
              </div>
            )}
            <div className="session-chip" title={activeSession?.id ?? tr('No active session', '无活动会话')}><span className={`status-dot${activeSession ? ' active' : ' idle'}`} /><span>{activeSession?.title || tr('No session', '无会话')}</span></div>
          </div>
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
        // The collapse state can remain in memory when storage is unavailable.
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
    try {
      if (action === 'export') {
        const exported = await exportSessionMarkdown(session);
        if (exported) setActionNotice(tr('Markdown exported.', 'Markdown 已导出。'));
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
              <span className="sidebar-item-copy"><strong>{session.title || session.id.slice(0, 8)}</strong><small>{archived ? tr('Archived', '已归档') : session.status || 'ready'}</small></span>
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
        <button className="btn-icon" title={tr('New session', '新建会话')} onClick={onCreateSession} disabled={sessionsCreating}>
          {sessionsCreating ? <span className="spinner spinner-small" /> : <Icon name="plus" size={15} />}
        </button>
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
              <span className="session-project-count">{sessions.filter(session => session.archived).length}</span>
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
      {(actionError || actionNotice) && <div className={`session-action-notice${actionError ? ' error' : ''}`} role="status">{actionError ?? actionNotice}</div>}
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
    const text = message.content.filter(part => part.type === 'text').map(part => part.text ?? '').join('').trim();
    const thinking = message.content.filter(part => part.type === 'thinking').map(part => part.thinking ?? part.text ?? '').join('\n').trim();
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

function VaultSidebar({ mode, onModeChange }: { mode: VaultMode; onModeChange: (mode: VaultMode) => void }) {
  const { tr } = useI18n();
  const modes: Array<{ key: VaultMode; label: string; description: string; icon: IconName }> = [
    { key: 'list', label: tr('Note list', '笔记列表'), description: tr('Browse and search notes', '浏览和搜索笔记'), icon: 'list' },
    { key: 'graph', label: tr('Linked graph', '双向链接图'), description: tr('Explore relationships', '查看笔记关系'), icon: 'graph' },
  ];

  return (
    <div className="sidebar-panel">
      <div className="sidebar-header">{tr('Knowledge vault', '知识库')}</div>
      <div className="sidebar-list">
        {modes.map(item => (
          <button key={item.key} className={`sidebar-item${mode === item.key ? ' active' : ''}`} onClick={() => onModeChange(item.key)}>
            <Icon name={item.icon} size={15} />
            <span className="sidebar-item-copy"><strong>{item.label}</strong><small>{item.description}</small></span>
          </button>
        ))}
      </div>
    </div>
  );
}

function FilesSidebar({ session, selectedFile, onSelectFile }: { session: Session | null; selectedFile: FsEntry | null; onSelectFile: (file: FsEntry) => void }) {
  return <div className="sidebar-panel sidebar-files-panel">
    <FileTree sessionId={session?.id ?? null} projectPath={session?.metadata?.cwd} selectedPath={selectedFile?.path} onSelectFile={onSelectFile} />
  </div>;
}
