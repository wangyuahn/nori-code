import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { I18nProvider } from './i18n';
import { initializeTheme } from './theme';
import { InspectorPopout } from './components/InspectorPopout';
import type { InspectorTab } from './components/WorkspaceInspector';
import './styles/nori-theme.css';

initializeTheme();
const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
const inspector = hashParams.get('inspector') as InspectorTab | null;
const content = inspector && ['preview', 'changes', 'browser', 'git', 'lsp', 'terminal'].includes(inspector)
  ? <InspectorPopout tab={inspector} sessionId={hashParams.get('session')} path={hashParams.get('path') ?? ''}/>
  : <App />;

// The app does not block rendering for the desktop auth token; the API client
// resolves it lazily on each request.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      {content}
    </I18nProvider>
  </React.StrictMode>,
);
