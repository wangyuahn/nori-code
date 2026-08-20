import type { AgentNode } from '../../types';
import { AgentTreeNode } from './AgentTreeNode';

interface AgentTreeProps {
  tree: AgentNode[];
  sessionId: string;
}

export function AgentTree({ tree, sessionId }: AgentTreeProps) {
  if (tree.length === 0) {
    return (
      <div className="p-6 font-mono text-[12px] text-fg-3">
        no agents found in state.json
      </div>
    );
  }
  return (
    <div className="p-3">
      {tree.map((node) => (
        <AgentTreeNode key={node.agentId} node={node} sessionId={sessionId} />
      ))}
    </div>
  );
}
