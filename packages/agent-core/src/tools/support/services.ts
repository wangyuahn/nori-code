import type { UrlFetcher, WebSearchProvider } from '../builtin';

export type BrowserActionName =
  | 'snapshot'
  | 'navigate'
  | 'click'
  | 'type'
  | 'upload'
  | 'keypress'
  | 'scroll'
  | 'wait'
  | 'screenshot'
  | 'back'
  | 'forward'
  | 'reload'
  | 'retry'
  | 'get_console'
  | 'get_network'
  | 'download_list'
  | 'permission_list'
  | 'dialog_list'
  | 'dialog_respond'
  | 'annotation_list';

export interface BrowserActionRequest {
  readonly action: BrowserActionName;
  readonly tabId?: string;
  readonly url?: string;
  readonly ref?: string;
  readonly text?: string;
  readonly key?: string;
  readonly x?: number;
  readonly y?: number;
  readonly deltaX?: number;
  readonly deltaY?: number;
  readonly timeoutMs?: number;
  readonly clear?: boolean;
  readonly paths?: readonly string[];
  readonly dialogId?: string;
  readonly accept?: boolean;
  readonly promptText?: string;
  readonly filter?: string;
}

export interface BrowserActionResult {
  readonly ok: boolean;
  readonly output: string;
  readonly url?: string;
  readonly title?: string;
  readonly tabId?: string;
  readonly screenshotDataUrl?: string;
  readonly staleRef?: boolean;
}

export interface BrowserExecutionScope {
  readonly sessionId: string;
  readonly agentId: string;
}

export interface BrowserExecutor {
  execute(
    request: BrowserActionRequest,
    options: { readonly toolCallId: string; readonly signal: AbortSignal },
  ): Promise<BrowserActionResult>;
}

export interface BrowserProvider {
  bind(scope: BrowserExecutionScope): BrowserExecutor | undefined;
}

export interface ToolServices {
  readonly urlFetcher?: UrlFetcher;
  readonly webSearcher?: WebSearchProvider;
  readonly browser?: BrowserExecutor;
}
