import { usePhaseStatus, useSwarmWebSocket, useVaultNotes } from '../hooks/useApi';

const PHASES = ['plan', 'implement', 'review'] as const;

export function Dashboard() {
  const { phase } = usePhaseStatus();
  const { swarmStatuses, connected } = useSwarmWebSocket();
  const { notes: vaultNotes } = useVaultNotes();

  const phaseIndex = phase.phase === 'idle' ? -1 : PHASES.indexOf(phase.phase as typeof PHASES[number]);
  const agents = Array.from(swarmStatuses.values());
  const activeCount = agents.filter(a => a.status === 'running').length;
  const doneCount = agents.filter(a => a.status === 'done').length;

  const vaultCounts = { analysis: 0, decision: 0, review: 0, task: 0 };
  for (const n of vaultNotes) {
    if (n.type in vaultCounts) vaultCounts[n.type as keyof typeof vaultCounts]++;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 720 }}>
      {/* Phase */}
      <div className="card">
        <div className="card-header">Phase</div>
        <div className="phase-bar">
          {PHASES.map((p, i) => {
            const isActive = i === phaseIndex;
            const isDone = i < phaseIndex;
            return (
              <div key={p} className={`phase-step ${isActive ? 'active' : ''} ${isDone ? 'done' : ''}`}>
                {isDone ? '✓' : ''} {p}
              </div>
            );
          })}
          {phaseIndex === -1 && <div className="phase-step muted">idle</div>}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--nori-text-muted)', marginTop: 8 }}>
          <span>Mode: {phase.mode || 'hybrid'}</span>
          <span>Step: {phase.step}</span>
        </div>
      </div>

      {/* Status row */}
      <div className="grid-2">
        <div className="card">
          <div className="card-header">Connection</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className={`status-dot ${connected ? 'active' : 'error'}`} />
            <span style={{ fontSize: 18, fontWeight: 600 }}>{connected ? 'Live' : 'Offline'}</span>
          </div>
        </div>
        <div className="card">
          <div className="card-header">Swarm</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--nori-cyan)' }}>
            {activeCount > 0 ? `${activeCount} active` : doneCount > 0 ? `${doneCount} done` : '—'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--nori-text-muted)' }}>{agents.length} total</div>
        </div>
      </div>

      {/* Vault stats */}
      <div className="card">
        <div className="card-header">Vault</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, textAlign: 'center' }}>
          {Object.entries(vaultCounts).map(([key, count]) => (
            <div key={key}>
              <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--nori-cyan)' }}>{count}</div>
              <div style={{ fontSize: 11, color: 'var(--nori-text-muted)', textTransform: 'capitalize' }}>{key}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Recent agents */}
      {agents.length > 0 && (
        <div className="card">
          <div className="card-header">Recent Agents</div>
          {agents.slice(0, 5).map(a => (
            <div key={a.swarm_id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--nori-border)' }}>
              <span className={`status-dot ${a.status}`} />
              <span style={{ flex: 1, fontFamily: 'var(--nori-font)', fontSize: 12 }}>{a.swarm_id.slice(0, 12)}</span>
              <span className={`badge badge-${a.status === 'done' ? 'success' : a.status === 'running' ? 'info' : a.status === 'failed' ? 'danger' : 'muted'}`}>
                {a.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
