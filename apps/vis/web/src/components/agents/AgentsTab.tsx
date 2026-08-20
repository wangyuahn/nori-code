import { useAgentTree } from '../../hooks/useAgentTree';
import { AgentTree } from './AgentTree';

interface AgentsTabProps {
  sessionId: string;
}

export function AgentsTab({ sessionId }: AgentsTabProps) {
  const { data, isLoading, error } = useAgentTree(sessionId);

  if (isLoading) {
    return <div className="p-6 font-mono text-[12px] text-fg-3">loading agents…</div>;
  }
  if (error) {
    return (
      <div className="p-6 font-mono text-[12px] text-[var(--color-sev-error)]">
        {(error as Error).message}
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <AgentTree tree={data.tree} sessionId={sessionId} />
    </div>
  );
}
