import { usePhaseStatus, useVaultNotes, type SwarmConnectionState } from '../hooks/useApi';
import { useI18n } from '../i18n';

const PHASES = ['plan', 'implement', 'review'] as const;

export function Dashboard({ swarm }: { swarm: SwarmConnectionState }) {
  const { tr } = useI18n();
  const { phase } = usePhaseStatus();
  const { swarmStatuses, connected } = swarm;
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
        <div className="card-header">{tr('Phase', '阶段')}</div>
        <div className="phase-bar">
          {PHASES.map((p, i) => {
            const isActive = i === phaseIndex;
            const isDone = i < phaseIndex;
            return (
              <div key={p} className={`phase-step ${isActive ? 'active' : ''} ${isDone ? 'done' : ''}`}>
                {isDone ? '✓ ' : ''}{tr(p, p === 'plan' ? '规划' : p === 'implement' ? '实现' : '评审')}
              </div>
            );
          })}
          {phaseIndex === -1 && <div className="phase-step muted">{tr('Idle', '空闲')}</div>}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--nori-text-muted)', marginTop: 8 }}>
          <span>{tr('Mode', '模式')}: {phase.mode || 'hybrid'}</span>
          <span>{tr('Step', '步骤')}: {phase.step}</span>
        </div>
      </div>

      {/* Status row */}
      <div className="grid-2">
        <div className="card">
          <div className="card-header">{tr('Connection', '连接')}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className={`status-dot ${connected ? 'active' : 'error'}`} />
            <span style={{ fontSize: 18, fontWeight: 600 }}>{connected ? tr('Live', '已连接') : tr('Offline', '离线')}</span>
          </div>
        </div>
        <div className="card">
          <div className="card-header">{tr('Swarm', '智能体协作')}</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--nori-cyan)' }}>
            {activeCount > 0 ? tr(`${activeCount} active`, `${activeCount} 个活动中`) : doneCount > 0 ? tr(`${doneCount} done`, `${doneCount} 个已完成`) : '—'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--nori-text-muted)' }}>{tr(`${agents.length} total`, `共 ${agents.length} 个`)}</div>
        </div>
      </div>

      {/* Vault stats */}
      <div className="card">
        <div className="card-header">{tr('Vault', '知识库')}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, textAlign: 'center' }}>
          {Object.entries(vaultCounts).map(([key, count]) => (
            <div key={key}>
              <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--nori-cyan)' }}>{count}</div>
              <div style={{ fontSize: 11, color: 'var(--nori-text-muted)', textTransform: 'capitalize' }}>{tr(key, key === 'analysis' ? '分析' : key === 'decision' ? '决策' : key === 'review' ? '评审' : '任务')}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Recent agents */}
      {agents.length > 0 && (
        <div className="card">
          <div className="card-header">{tr('Recent agents', '最近智能体')}</div>
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
