import { useVaultNotes } from '../hooks/useApi';
import { useI18n } from '../i18n';
import type { ModelCatalogItem, Session } from '../api/client';
import { UsageOverview } from './UsageOverview';

export function Dashboard({ sessions, models }: { sessions: Session[]; models: ModelCatalogItem[] }) {
  const { tr } = useI18n();
  const { notes: vaultNotes } = useVaultNotes();

  const vaultCounts = { analysis: 0, decision: 0, review: 0, task: 0 };
  for (const n of vaultNotes) {
    if (n.type in vaultCounts) vaultCounts[n.type as keyof typeof vaultCounts]++;
  }

  return (
    <div className="dashboard-layout">
      <div className="dashboard-main">
      {/* Vault stats */}
      <div className="card">
        <div className="card-header">{tr('Vault', '知识库')}</div>
        <div className="dashboard-vault-grid">
          {Object.entries(vaultCounts).map(([key, count]) => (
            <div key={key}>
              <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--nori-cyan)' }}>{count}</div>
              <div style={{ fontSize: 11, color: 'var(--nori-text-muted)', textTransform: 'capitalize' }}>{tr(key, key === 'analysis' ? '分析' : key === 'decision' ? '决策' : key === 'review' ? '评审' : '任务')}</div>
            </div>
          ))}
        </div>
      </div>

      </div>
      <aside className="dashboard-usage">
        <UsageOverview sessions={sessions} models={models}/>
      </aside>
    </div>
  );
}
