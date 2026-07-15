export interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
}

export interface NoriDesktopAPI {
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
}

declare global {
  interface Window {
    noriDesktop?: NoriDesktopAPI;
  }
}

export {};
