import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { NoriBrowserState, NoriBrowserTabState } from '../types/nori-desktop';

export type BrowserPermissionDecision = 'allow_once' | 'allow_always' | 'deny' | 'deny_always';
export type BrowserPermissionRequest = NoriBrowserState['permissions']['pending'][number];

const EMPTY_STATE: NoriBrowserState = {
  activeTabId: null,
  tabs: [],
  visible: false,
  automation: { paused: false, active: null, history: [] },
  downloads: [],
  permissions: { pending: [], rules: [] },
  dialogs: [],
};

export interface UseBrowserResult extends NoriBrowserState {
  activeTab?: NoriBrowserTabState;
  available: boolean;
  ready: boolean;
  occluded: boolean;
  occlusionPreviewDataUrl: string | null;
  navigate: (url: string) => void;
  newTab: (url?: string) => Promise<NoriBrowserState | undefined>;
  closeTab: (tabId: string) => void;
  activateTab: (tabId: string) => Promise<NoriBrowserState | undefined>;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  stop: () => void;
  openDevTools: () => void;
  openExternal: () => void;
  setAnnotationMode: (enabled: boolean) => void;
  clearAnnotations: () => void;
  updateAnnotation: (id: string, note: string) => void;
  setAutomationPaused: (paused: boolean) => void;
  chooseUploadFiles: () => void;
  resolvePermission: (id: string, decision: BrowserPermissionDecision) => void;
  resolveDialog: (id: string, accept: boolean, promptText?: string) => void;
  openDownload: (id: string) => void;
  clearNetwork: (tabId?: string) => void;
  setVisible: (visible: boolean) => void;
  setOccluded: (occluded: boolean) => void;
  setBounds: (bounds: { x: number; y: number; width: number; height: number }) => void;
}

export function useBrowser(): UseBrowserResult {
  const [state, setState] = useState<NoriBrowserState>(EMPTY_STATE);
  const [occlusion, setOcclusion] = useState({ occluded: false, previewDataUrl: null as string | null });
  const [ready, setReady] = useState(false);
  const mountedRef = useRef(true);
  const available = typeof window.noriDesktop?.browserGetState === 'function';

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!available) {
      setReady(true);
      return;
    }
    const update = (next: NoriBrowserState) => {
      if (!mountedRef.current) return;
      setState(normalizeState(next));
      setReady(true);
    };
    const unsubscribe = window.noriDesktop?.onBrowserState?.(update);
    void window.noriDesktop?.browserGetState?.().then(update);
    return () => unsubscribe?.();
  }, [available]);

  const apply = useCallback((result: Promise<NoriBrowserState> | undefined) => {
    if (result !== undefined) void result.then(next => { if (mountedRef.current) setState(normalizeState(next)); });
  }, []);
  const applyAndReturn = useCallback(async (result: Promise<NoriBrowserState> | undefined) => {
    if (result === undefined) return undefined;
    const next = normalizeState(await result);
    if (mountedRef.current) setState(next);
    return next;
  }, []);
  const navigate = useCallback((url: string) => apply(window.noriDesktop?.browserNavigate?.(url)), [apply]);
  const newTab = useCallback((url?: string) => applyAndReturn(window.noriDesktop?.browserNewTab?.(url)), [applyAndReturn]);
  const closeTab = useCallback((tabId: string) => apply(window.noriDesktop?.browserCloseTab?.(tabId)), [apply]);
  const activateTab = useCallback((tabId: string) => applyAndReturn(window.noriDesktop?.browserActivateTab?.(tabId)), [applyAndReturn]);
  const goBack = useCallback(() => window.noriDesktop?.browserGoBack?.(), []);
  const goForward = useCallback(() => window.noriDesktop?.browserGoForward?.(), []);
  const reload = useCallback(() => window.noriDesktop?.browserReload?.(), []);
  const stop = useCallback(() => window.noriDesktop?.browserStop?.(), []);
  const openDevTools = useCallback(() => window.noriDesktop?.browserOpenDevTools?.(), []);
  const openExternal = useCallback(() => { void window.noriDesktop?.browserOpenExternal?.(); }, []);
  const setAnnotationMode = useCallback((enabled: boolean) => apply(window.noriDesktop?.browserSetAnnotationMode?.(enabled)), [apply]);
  const clearAnnotations = useCallback(() => apply(window.noriDesktop?.browserClearAnnotations?.()), [apply]);
  const updateAnnotation = useCallback((id: string, note: string) => apply(window.noriDesktop?.browserUpdateAnnotation?.(id, note)), [apply]);
  const setAutomationPaused = useCallback((paused: boolean) => apply(window.noriDesktop?.browserSetAutomationPaused?.(paused)), [apply]);
  const chooseUploadFiles = useCallback(() => apply(window.noriDesktop?.browserChooseUploadFiles?.()), [apply]);
  const resolvePermission = useCallback((id: string, decision: BrowserPermissionDecision) => apply(window.noriDesktop?.browserResolvePermission?.(id, decision)), [apply]);
  const resolveDialog = useCallback((id: string, accept: boolean, promptText?: string) => apply(window.noriDesktop?.browserResolveDialog?.(id, accept, promptText)), [apply]);
  const openDownload = useCallback((id: string) => { void window.noriDesktop?.browserOpenDownload?.(id); }, []);
  const clearNetwork = useCallback((tabId?: string) => apply(window.noriDesktop?.browserClearNetwork?.(tabId)), [apply]);
  const setVisible = useCallback((visible: boolean) => apply(window.noriDesktop?.browserSetVisible?.(visible)), [apply]);
  const setOccluded = useCallback((occluded: boolean) => {
    const result = window.noriDesktop?.browserSetOccluded?.(occluded);
    if (result !== undefined) {
      void result.then(next => {
        if (mountedRef.current) setOcclusion(next);
      });
    }
  }, []);
  const setBounds = useCallback((bounds: { x: number; y: number; width: number; height: number }) => window.noriDesktop?.browserResize?.(bounds), []);
  const activeTab = useMemo(
    () => state.tabs.find(tab => tab.id === state.activeTabId),
    [state.activeTabId, state.tabs],
  );

  return {
    ...state,
    activeTab,
    available,
    ready,
    occluded: occlusion.occluded,
    occlusionPreviewDataUrl: occlusion.previewDataUrl,
    navigate,
    newTab,
    closeTab,
    activateTab,
    goBack,
    goForward,
    reload,
    stop,
    openDevTools,
    openExternal,
    setAnnotationMode,
    clearAnnotations,
    updateAnnotation,
    setAutomationPaused,
    chooseUploadFiles,
    resolvePermission,
    resolveDialog,
    openDownload,
    clearNetwork,
    setVisible,
    setOccluded,
    setBounds,
  };
}

export function useBrowserPermissions(): {
  pending: BrowserPermissionRequest[];
  resolvePermission: (id: string, decision: BrowserPermissionDecision) => Promise<void>;
} {
  const [pending, setPending] = useState<BrowserPermissionRequest[]>([]);
  const mountedRef = useRef(true);
  const available = typeof window.noriDesktop?.browserGetState === 'function';

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const update = useCallback((next: NoriBrowserState) => {
    if (!mountedRef.current) return;
    const nextPending = next.permissions?.pending ?? [];
    setPending(current => samePermissionRequests(current, nextPending) ? current : nextPending.map(item => ({ ...item })));
  }, []);

  useEffect(() => {
    if (!available) return;
    const unsubscribe = window.noriDesktop?.onBrowserState?.(update);
    void window.noriDesktop?.browserGetState?.().then(update);
    return () => unsubscribe?.();
  }, [available, update]);

  const resolvePermission = useCallback(async (id: string, decision: BrowserPermissionDecision) => {
    const result = window.noriDesktop?.browserResolvePermission?.(id, decision);
    if (result !== undefined) update(await result);
  }, [update]);

  return { pending, resolvePermission };
}

function normalizeState(state: NoriBrowserState): NoriBrowserState {
  return {
    ...state,
    tabs: state.tabs.map(tab => ({
      ...tab,
      annotationMode: tab.annotationMode ?? false,
      annotations: tab.annotations ?? [],
      network: tab.network ?? [],
    })),
    automation: state.automation ?? EMPTY_STATE.automation,
    downloads: state.downloads ?? [],
    permissions: state.permissions ?? EMPTY_STATE.permissions,
    dialogs: state.dialogs ?? [],
  };
}

function samePermissionRequests(
  current: readonly BrowserPermissionRequest[],
  next: readonly BrowserPermissionRequest[],
): boolean {
  return current.length === next.length && current.every((item, index) => {
    const candidate = next[index];
    return candidate !== undefined
      && item.id === candidate.id
      && item.tabId === candidate.tabId
      && item.permission === candidate.permission
      && item.origin === candidate.origin
      && item.createdAt === candidate.createdAt;
  });
}
