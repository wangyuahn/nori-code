export interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
}

export interface NoriDesktopAPI {
  getConfig: () => Promise<unknown>;
  reloadConfig: () => Promise<unknown>;
  getPhase: () => Promise<unknown>;
  onPhaseChange: (callback: (phase: string) => void) => () => void;
  onSwarmUpdate: (callback: (data: unknown) => void) => () => void;
  onError: (callback: (error: string) => void) => () => void;
  getServerToken?: () => Promise<string | undefined>;
  selectProjectDirectory?: () => Promise<string | undefined>;
  onToggleMode?: (callback: (mode: string) => void) => () => void;
  // Browser IPC methods (optional — may not exist in all environments)
  browserNavigate?: (url: string) => void;
  browserGoBack?: () => void;
  browserGoForward?: () => void;
  browserReload?: () => void;
  browserOpenDevTools?: () => void;
  browserSetVisible?: (visible: boolean) => void;
  onBrowserState?: (callback: (state: { url: string; title: string; canGoBack: boolean; canGoForward: boolean; loading: boolean }) => void) => () => void;
  // File system methods
  fsReadDir?: (dirPath: string) => Promise<FsEntry[]>;
  fsReadFile?: (filePath: string) => Promise<string>;
  // Terminal IPC methods
  terminalCreate?: (opts: { id: string; cols: number; rows: number; cwd?: string }) => Promise<{ ok: boolean }>;
  terminalWrite?: (opts: { id: string; data: string }) => Promise<{ ok: boolean }>;
  terminalResize?: (opts: { id: string; cols: number; rows: number }) => Promise<{ ok: boolean }>;
  terminalDestroy?: (opts: { id: string }) => Promise<{ ok: boolean }>;
  onTerminalOutput?: (callback: (data: { id: string; data: string }) => void) => () => void;
}

declare global {
  interface Window {
    noriDesktop?: NoriDesktopAPI;
  }
}

export {};
