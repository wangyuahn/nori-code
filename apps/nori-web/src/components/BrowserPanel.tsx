import { useBrowser } from '../hooks/useBrowser';
import { useI18n } from '../i18n';
import { BrowserToolbar } from './BrowserToolbar';

export function BrowserPanel() {
  const { tr } = useI18n();
  const browser = useBrowser();

  if (!browser.visible) {
    return null;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', borderBottom: '1px solid #1e1e22' }}>
      <BrowserToolbar
        url={browser.url}
        canGoBack={browser.canGoBack}
        canGoForward={browser.canGoForward}
        loading={browser.loading}
        visible={browser.visible}
        onNavigate={browser.navigate}
        onGoBack={browser.goBack}
        onGoForward={browser.goForward}
        onReload={browser.reload}
        onOpenDevTools={browser.openDevTools}
        onToggleVisible={() => browser.setVisible(!browser.visible)}
      />
      <div
        style={{
          background: '#1a1a1e',
          minHeight: 200,
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <p style={{ color: '#71717a', fontSize: 12, textAlign: 'center', padding: 16 }}>
          Browser viewport — the page renders in an Electron overlay above this region.
        </p>
      </div>
    </div>
  );
}
