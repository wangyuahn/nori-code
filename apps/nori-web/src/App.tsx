import React, { useState } from 'react';
import { ChatView } from './components/ChatView';
import { Dashboard } from './components/Dashboard';
import { SwarmPanel } from './components/SwarmPanel';
import { VaultBrowser } from './components/VaultBrowser';
import { SettingsPanel } from './components/SettingsPanel';
import { useSessions, usePhaseStatus, useSwarmWebSocket, useServerStatus, useVaultNotes } from './hooks/useApi';
import { useChatMessages } from './hooks/useChatMessages';
import { type Session } from './api/client';

type View = 'chat' | 'dashboard' | 'swarm' | 'vault' | 'settings';
type SidebarTab = 'sessions' | 'vault' | 'files';

const NAV_ITEMS: { key: View; icon: string; label: string }[] = [
  { key: 'chat', icon: '💬', label: 'Chat' },
  { key: 'dashboard', icon: '◉', label: 'Dashboard' },
  { key: 'swarm', icon: '⬡', label: 'Swarm' },
  { key: 'vault', icon: '◫', label: 'Vault' },
  { key: 'settings', icon: '⚙', label: 'Settings' },
];

export function App() {
  const [activeView, setActiveView] = useState<View>('chat');
  const [sidebarExpanded, setSidebarExpanded] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('sessions');

  const {
    sessions,
    sessionId,
    isLoading: sessionsLoading,
    error: sessionsError,
    creating: sessionsCreating,
    createNewSession,
    switchSession,
  } = useSessions();

  const activeSession: Session | null =
    sessions.find(s => s.id === sessionId) ?? null;

  const {
    messages,
    isStreaming,
    currentStreaming: streaming,
    sendMessage,
    abort,
  } = useChatMessages(sessionId);

  const toggleSidebar = () => setSidebarExpanded(prev => !prev);

  return (
    <div className="app-container">
      {/* Sidebar */}
      <aside className={`sidebar${sidebarExpanded ? ' expanded' : ''}`}>
        <button
          className="sidebar-toggle"
          onClick={toggleSidebar}
          title={sidebarExpanded ? 'Collapse sidebar' : 'Expand sidebar'}
        >
          {sidebarExpanded ? '◀' : '▶'}
        </button>

        <div className="sidebar-tabs">
          <button
            className={`sidebar-tab${sidebarTab === 'sessions' ? ' active' : ''}`}
            onClick={() => setSidebarTab('sessions')}
            title="Sessions"
          >
            <span className="sidebar-icon">◉</span>
          </button>
          <button
            className={`sidebar-tab${sidebarTab === 'vault' ? ' active' : ''}`}
            onClick={() => setSidebarTab('vault')}
            title="Vault"
          >
            <span className="sidebar-icon">◫</span>
          </button>
          <button
            className={`sidebar-tab${sidebarTab === 'files' ? ' active' : ''}`}
            onClick={() => setSidebarTab('files')}
            title="Files"
          >
            <span className="sidebar-icon">▤</span>
          </button>
        </div>

        <div className="sidebar-content">
          {sidebarTab === 'sessions' && (
            <SessionsList
              sessions={sessions}
              sessionId={sessionId}
              sessionsLoading={sessionsLoading}
              sessionsError={sessionsError}
              sessionsCreating={sessionsCreating}
              onCreateSession={createNewSession}
              onSwitchSession={switchSession}
            />
          )}
          {sidebarTab === 'vault' && <VaultSidebar />}
          {sidebarTab === 'files' && <FilesSidebar />}
        </div>
      </aside>

      {/* Main Area */}
      <div className="main-area">
        {/* Top Bar */}
        <header className="top-bar">
          <div className="top-bar-left">
            <span className="app-logo">N</span>
            <span className="app-title">Nori Code</span>
          </div>
          <nav className="top-bar-nav">
            {NAV_ITEMS.map(item => (
              <button
                key={item.key}
                className={`nav-btn${activeView === item.key ? ' active' : ''}`}
                onClick={() => setActiveView(item.key)}
              >
                <span>{item.icon}</span>
                <span className="nav-label">{item.label}</span>
              </button>
            ))}
          </nav>
        </header>

        {/* Content */}
        <main className="content-area">
          {activeView === 'chat' && (
            <ChatView
              session={activeSession}
              messages={messages}
              streaming={streaming}
              isStreaming={isStreaming}
              onSendMessage={sendMessage}
              onAbort={abort}
            />
          )}
          {activeView === 'dashboard' && <Dashboard />}
          {activeView === 'swarm' && <SwarmPanel />}
          {activeView === 'vault' && <VaultBrowser />}
          {activeView === 'settings' && <SettingsPanel />}
        </main>
      </div>

      {/* Status Bar */}
      <StatusBar sending={isStreaming} />
    </div>
  );
}

function StatusBar({ sending }: { sending: boolean }) {
  const { phase } = usePhaseStatus();
  const { swarmStatuses } = useSwarmWebSocket();
  const { connected } = useServerStatus();

  const agents = Array.from(swarmStatuses.values());
  const activeCount = agents.filter(a => a.status === 'running').length;
  const totalCount = agents.length;

  const phaseLabel = phase.phase === 'idle' ? 'idle' : phase.phase;

  return (
    <footer className="status-bar">
      <div className="status-left">
        <span className={`status-dot${phase.phase !== 'idle' ? ' active' : ''}`} />
        <span>phase: {phaseLabel}</span>
        {sending && <span style={{ color: 'var(--nori-cyan)' }}>sending…</span>}
      </div>
      <div className="status-center">
        <span className="status-item">
          <span className={`status-dot${connected ? ' active' : ' error'}`} />
          {connected ? 'connected' : 'offline'}
        </span>
        <span className="status-item">
          ⬡ swarm: {totalCount > 0 ? `${activeCount} active, ${totalCount} total` : 'idle'}
        </span>
      </div>
      <div className="status-right">
        <span className="status-item">Nori Code v0.1.15</span>
      </div>
    </footer>
  );
}

function SessionsList({
  sessions,
  sessionId,
  sessionsLoading,
  sessionsError,
  sessionsCreating,
  onCreateSession,
  onSwitchSession,
}: {
  sessions: Session[];
  sessionId: string | null;
  sessionsLoading: boolean;
  sessionsError: string | null;
  sessionsCreating: boolean;
  onCreateSession: () => void;
  onSwitchSession: (id: string) => void;
}) {
  return (
    <div className="sidebar-panel">
      <div className="sidebar-header">
        <span>Sessions</span>
        <button
          className="btn-icon"
          title="New Session"
          onClick={onCreateSession}
          disabled={sessionsCreating}
        >
          {sessionsCreating ? '…' : '+'}
        </button>
      </div>
      <div className="sidebar-list">
        {sessionsLoading ? (
          <div className="sidebar-item">
            <span className="sidebar-item-text muted">Loading…</span>
          </div>
        ) : sessionsError ? (
          <div className="sidebar-item">
            <span className="sidebar-item-text" style={{ color: 'var(--nori-danger)' }}>Error: {sessionsError}</span>
          </div>
        ) : sessions.length === 0 ? (
          <div className="sidebar-item">
            <span className="sidebar-item-text muted">No sessions yet</span>
          </div>
        ) : (
          sessions.map(s => (
            <div
              key={s.id}
              className={`sidebar-item${s.id === sessionId ? ' active' : ''}`}
              onClick={() => onSwitchSession(s.id)}
            >
              <span className={`status-dot${s.id === sessionId ? ' active' : ''}`} />
              <span className="sidebar-item-text">{s.title || (s.id?.slice(0, 8) ?? 'unknown')}</span>
              {s.message_count != null && (
                <span className="sidebar-item-count">{s.message_count}</span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function VaultSidebar() {
  const { notes, loading } = useVaultNotes();

  const folders = [
    { key: 'analysis', label: 'Analysis' },
    { key: 'decision', label: 'Decisions' },
    { key: 'review', label: 'Reviews' },
    { key: 'task', label: 'Tasks' },
  ];

  // Count notes by type
  const counts: Record<string, number> = {};
  for (const n of notes) {
    const t = n.type;
    counts[t] = (counts[t] ?? 0) + 1;
  }

  return (
    <div className="sidebar-panel">
      <div className="sidebar-header">Vault</div>
      <div className="sidebar-list">
        {loading ? (
          <div className="sidebar-item">
            <span className="sidebar-item-text muted">Loading…</span>
          </div>
        ) : (
          folders.map(f => (
            <div key={f.key} className="sidebar-item">
              <span className="sidebar-item-text">{f.label}</span>
              <span className="sidebar-item-count">{counts[f.key] ?? 0}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function FilesSidebar() {
  return (
    <div className="sidebar-panel">
      <div className="sidebar-header">Project Files</div>
      <div className="sidebar-list">
        <div className="sidebar-item" style={{ cursor: 'default', padding: '10px 8px' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <span style={{ fontSize: 18, opacity: 0.3, lineHeight: 1 }}>▤</span>
            <div>
              <div className="sidebar-item-text">File Explorer</div>
              <div className="sidebar-item-text muted" style={{ fontSize: 10 }}>
                Coming soon
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
