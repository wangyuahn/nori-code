import { useSwarmWebSocket } from '../hooks/useApi';
import type { SwarmStatus } from '../api/client';

export function SwarmPanel() {
  const { swarmStatuses, connected } = useSwarmWebSocket();
  const agents = Array.from(swarmStatuses.values());

  return (
    <div className="swarm-panel">
      {/* Header */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="card-header" style={{ marginBottom: 0 }}>Swarm Agents</div>
          <div className="live-indicator">
            <span className={`status-dot ${connected ? 'active' : 'error'}`} />
            {connected ? 'Live' : 'Offline'}
          </div>
        </div>
      </div>

      {/* Agents */}
      {agents.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">⬡</div>
          <div>No active swarm agents</div>
          <div style={{ color: 'var(--nori-text-muted)', fontSize: 12, marginTop: 4 }}>
            Agents appear here when a swarm is launched
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {agents.map(agent => (
            <AgentCard key={agent.swarm_id} agent={agent} />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentCard({ agent }: { agent: SwarmStatus }) {
  const progress = agent.task_count > 0
    ? Math.round((agent.completed_count / agent.task_count) * 100)
    : 0;

  return (
    <div className="card agent-card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <span className={`status-dot ${agent.status}`} />
        <span style={{ fontWeight: 600, flex: 1 }}>
          {agent.swarm_id.slice(0, 8)}
        </span>
        <span className={`badge badge-${agent.status === 'done' ? 'success' : agent.status === 'running' ? 'info' : agent.status === 'failed' ? 'danger' : 'muted'}`}>
          {agent.status}
        </span>
      </div>

      {/* Progress bar */}
      {agent.task_count > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--nori-text-muted)', marginBottom: 4 }}>
            <span>Progress</span>
            <span>{agent.completed_count}/{agent.task_count} tasks</span>
          </div>
          <div style={{ height: 3, background: 'var(--nori-border)', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{
              height: '100%',
              width: `${progress}%`,
              background: agent.status === 'done' ? 'var(--nori-success)' : 'var(--nori-cyan)',
              transition: 'width 0.3s ease',
              borderRadius: 2,
            }} />
          </div>
        </div>
      )}

      <div style={{ fontSize: 11, color: 'var(--nori-text-muted)' }}>
        {agent.status === 'running' && 'Executing tasks...'}
        {agent.status === 'done' && 'All tasks completed'}
        {agent.status === 'failed' && 'Execution failed'}
        {agent.status === 'pending' && 'Waiting to start...'}
        {!['running', 'done', 'failed', 'pending'].includes(agent.status) && agent.status}
      </div>
    </div>
  );
}
