import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { I18nProvider } from './i18n';
import { initializeTheme } from './theme';
import { InspectorPopout } from './components/InspectorPopout';
import type { InspectorTab } from './components/WorkspaceInspector';
import './styles/nori-theme.css';

initializeTheme();

/** Avoid a silent black #root when a boot-time render throw escapes. */
class BootErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[nori-web] boot render failed', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            boxSizing: 'border-box',
            minHeight: '100%',
            padding: 24,
            fontFamily: 'system-ui, sans-serif',
            background: '#111',
            color: '#f2f2f2',
          }}
        >
          <h1 style={{ fontSize: 18, margin: '0 0 8px' }}>Nori Work failed to start</h1>
          <p style={{ margin: '0 0 12px', opacity: 0.85 }}>
            Reload the page. If this persists, check the browser console for the module that threw.
          </p>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, opacity: 0.75 }}>
            {this.state.error.message}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
const inspector = hashParams.get('inspector') as InspectorTab | null;
const content = inspector && ['preview', 'changes', 'browser', 'git', 'lsp', 'terminal'].includes(inspector)
  ? <InspectorPopout tab={inspector} sessionId={hashParams.get('session')} path={hashParams.get('path') ?? ''}/>
  : <App />;

// Surface module evaluation failures that never reach React (blank #08080a body).
window.addEventListener('error', (event) => {
  if (document.querySelector('.codex-layout, .app-container')) return;
  const root = document.getElementById('root');
  if (!root || root.childElementCount > 0) return;
  const message = event.error instanceof Error ? event.error.message : event.message;
  root.innerHTML = `<div style="padding:24px;font-family:system-ui,sans-serif;color:#f2f2f2;background:#111;min-height:100%"><h1 style="font-size:18px">Nori Work failed to load</h1><pre style="white-space:pre-wrap;font-size:12px;opacity:.75">${String(message).replace(/</g, '&lt;')}</pre></div>`;
});

// The app does not block rendering for the desktop auth token; the API client
// resolves it lazily on each request.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BootErrorBoundary>
      <I18nProvider>
        {content}
      </I18nProvider>
    </BootErrorBoundary>
  </React.StrictMode>,
);
