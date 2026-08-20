import { Route, Routes } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { SessionListPage } from './pages/SessionListPage';
import { SessionDetailPage } from './pages/SessionDetailPage';
import { AgentDetailPage } from './pages/AgentDetailPage';

export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<SessionListPage />} />
        <Route path="/sessions/:sessionId" element={<SessionDetailPage />} />
        <Route
          path="/sessions/:sessionId/agents/:agentId"
          element={<AgentDetailPage />}
        />
      </Routes>
    </AppShell>
  );
}
