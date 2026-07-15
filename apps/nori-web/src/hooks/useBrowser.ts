import { useState, useEffect, useCallback } from 'react';

export interface BrowserState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  visible: boolean;
}

export interface UseBrowserResult extends BrowserState {
  navigate: (url: string) => void;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  openDevTools: () => void;
  setVisible: (visible: boolean) => void;
}

export function useBrowser(): UseBrowserResult {
  const [url, setUrl] = useState('about:blank');
  const [title, setTitle] = useState('');
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState(false);

  // Subscribe to browser state updates from Electron runtime
  useEffect(() => {
    const unsubscribe = window.noriDesktop?.onBrowserState?.((state) => {
      setUrl(state.url);
      setTitle(state.title);
      setCanGoBack(state.canGoBack);
      setCanGoForward(state.canGoForward);
      setLoading(state.loading);
    });

    return () => {
      unsubscribe?.();
    };
  }, []);

  const navigate = useCallback((nextUrl: string) => {
    setUrl(nextUrl);
    window.noriDesktop?.browserNavigate?.(nextUrl);
  }, []);

  const goBack = useCallback(() => {
    window.noriDesktop?.browserGoBack?.();
  }, []);

  const goForward = useCallback(() => {
    window.noriDesktop?.browserGoForward?.();
  }, []);

  const reload = useCallback(() => {
    window.noriDesktop?.browserReload?.();
  }, []);

  const openDevTools = useCallback(() => {
    window.noriDesktop?.browserOpenDevTools?.();
  }, []);

  const setVisibleState = useCallback((v: boolean) => {
    setVisible(v);
    window.noriDesktop?.browserSetVisible?.(v);
  }, []);

  return {
    url,
    title,
    canGoBack,
    canGoForward,
    loading,
    visible,
    navigate,
    goBack,
    goForward,
    reload,
    openDevTools,
    setVisible: setVisibleState,
  };
}
