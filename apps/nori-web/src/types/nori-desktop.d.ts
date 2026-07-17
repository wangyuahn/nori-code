export interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
}

export interface NoriBrowserTabState {
  id: string;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  error?: string;
  annotationMode: boolean;
  annotations: Array<{
    id: string;
    ref: string;
    text: string;
    tag: string;
    url: string;
    createdAt: string;
    note?: string;
  }>;
  network: Array<{
    id: string;
    method: string;
    url: string;
    resourceType: string;
    startedAt: string;
    status?: number;
    mimeType?: string;
    durationMs?: number;
    error?: string;
    state: 'pending' | 'completed' | 'failed';
  }>;
}

export interface NoriBrowserState {
  activeTabId: string | null;
  tabs: NoriBrowserTabState[];
  visible: boolean;
  automation: {
    paused: boolean;
    active: { id: string; agentId: string; sessionId: string; action: string } | null;
    history: Array<{
      id: string;
      agentId: string;
      sessionId: string;
      action: string;
      summary: string;
      status: 'completed' | 'failed';
      createdAt: string;
    }>;
  };
  downloads: Array<{
    id: string;
    tabId: string;
    filename: string;
    url: string;
    savePath: string;
    createdAt: string;
    state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
    receivedBytes: number;
    totalBytes: number;
    speed: number;
  }>;
  permissions: {
    pending: Array<{ id: string; tabId: string; permission: string; origin: string; createdAt: string }>;
    rules: Array<{ permission: string; origin: string; decision: 'allow' | 'deny' }>;
  };
  dialogs: Array<{
    id: string;
    tabId: string;
    type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
    message: string;
    defaultPrompt?: string;
    url: string;
    createdAt: string;
  }>;
}

export interface NoriDesktopAPI {
  getServerToken?: () => Promise<string | undefined>;
  selectProjectDirectory?: () => Promise<string | undefined>;
  saveMarkdown?: (input: { suggestedName: string; content: string }) => Promise<string | undefined>;
  onToggleMode?: (callback: (mode: string) => void) => () => void;
  // Browser IPC methods are optional because the web-only build has no native view.
  browserGetState?: () => Promise<NoriBrowserState>;
  browserNavigate?: (url: string) => Promise<NoriBrowserState>;
  browserNewTab?: (url?: string) => Promise<NoriBrowserState>;
  browserCloseTab?: (tabId: string) => Promise<NoriBrowserState>;
  browserActivateTab?: (tabId: string) => Promise<NoriBrowserState>;
  browserGoBack?: () => void;
  browserGoForward?: () => void;
  browserReload?: () => void;
  browserStop?: () => void;
  browserOpenDevTools?: () => void;
  browserOpenExternal?: () => Promise<void>;
  browserSetAnnotationMode?: (enabled: boolean) => Promise<NoriBrowserState>;
  browserClearAnnotations?: () => Promise<NoriBrowserState>;
  browserUpdateAnnotation?: (id: string, note: string) => Promise<NoriBrowserState>;
  browserSetAutomationPaused?: (paused: boolean) => Promise<NoriBrowserState>;
  browserChooseUploadFiles?: () => Promise<NoriBrowserState>;
  browserResolvePermission?: (id: string, decision: 'allow_once' | 'allow_always' | 'deny' | 'deny_always') => Promise<NoriBrowserState>;
  browserResolveDialog?: (id: string, accept: boolean, promptText?: string) => Promise<NoriBrowserState>;
  browserOpenDownload?: (id: string) => Promise<void>;
  browserClearNetwork?: (tabId?: string) => Promise<NoriBrowserState>;
  browserExecuteActionForSmoke?: (request: Record<string, unknown>) => Promise<{
    ok: boolean;
    output: string;
    screenshotDataUrl?: string;
    staleRef?: boolean;
  }>;
  browserSetVisible?: (visible: boolean) => Promise<NoriBrowserState>;
  browserResize?: (bounds: { x: number; y: number; width: number; height: number }) => void;
  onBrowserState?: (callback: (state: NoriBrowserState) => void) => () => void;
  // File system methods
  fsReadDir?: (dirPath: string) => Promise<FsEntry[]>;
  fsReadFile?: (filePath: string) => Promise<string>;
  fsReveal?: (input: { path: string; isDirectory: boolean }) => Promise<void>;
  openInspectorWindow?: (input: { tab: string; sessionId?: string; path?: string }) => Promise<void>;
}

declare global {
  interface Window {
    noriDesktop?: NoriDesktopAPI;
  }
}
