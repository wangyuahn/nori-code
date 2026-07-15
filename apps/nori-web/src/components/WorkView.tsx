import { Dashboard } from './Dashboard';
import { SwarmPanel } from './SwarmPanel';
import { VaultBrowser } from './VaultBrowser';
import { SplitPane } from './SplitPane';
import { useSwarmWebSocket } from '../hooks/useApi';

interface WorkViewProps {
  onModeChange?: (mode: 'code') => void;
}

export function WorkView({ onModeChange }: WorkViewProps) {
  const swarm = useSwarmWebSocket();
  return (
    <SplitPane direction="horizontal" defaultSize={65} minSize={30} maxSize={80}>
      <Dashboard swarm={swarm} />
      <SplitPane direction="vertical" defaultSize={50} minSize={20} maxSize={80}>
        <SwarmPanel swarm={swarm} sessionId={null} />
        <VaultBrowser />
      </SplitPane>
    </SplitPane>
  );
}
