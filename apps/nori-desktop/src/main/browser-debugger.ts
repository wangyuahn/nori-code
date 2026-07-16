import type { WebContents } from 'electron';

export interface BrowserNetworkEvent {
  readonly phase: 'request' | 'response' | 'finished' | 'failed';
  readonly requestId: string;
  readonly timestamp: number;
  readonly method?: string;
  readonly url?: string;
  readonly resourceType?: string;
  readonly status?: number;
  readonly mimeType?: string;
  readonly error?: string;
}

export interface BrowserJavaScriptDialog {
  readonly type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  readonly message: string;
  readonly defaultPrompt?: string;
  readonly url: string;
}

export class BrowserDebuggerController {
  private attachedByNori = false;
  private started = false;
  private disposed = false;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly webContents: WebContents,
    private readonly onNetwork: (event: BrowserNetworkEvent) => void,
    private readonly onDialog: (dialog: BrowserJavaScriptDialog) => void,
    private readonly onFailure: (error: unknown) => void,
  ) {}

  async start(): Promise<void> {
    if (this.started || this.disposed || this.webContents.isDestroyed()) return;
    this.started = true;
    try {
      if (!this.webContents.debugger.isAttached()) {
        this.webContents.debugger.attach('1.3');
        this.attachedByNori = true;
      }
      this.webContents.debugger.on('message', this.handleMessage);
      this.webContents.debugger.on('detach', this.handleDetach);
      await Promise.all([
        this.webContents.debugger.sendCommand('Page.enable'),
        this.webContents.debugger.sendCommand('Network.enable', { maxTotalBufferSize: 10_000_000 }),
      ]);
    } catch (error) {
      this.started = false;
      this.webContents.debugger.off('message', this.handleMessage);
      this.webContents.debugger.off('detach', this.handleDetach);
      if (this.attachedByNori && this.webContents.debugger.isAttached()) this.webContents.debugger.detach();
      this.attachedByNori = false;
      throw error;
    }
  }

  async setFileInputFiles(ref: string, paths: readonly string[]): Promise<boolean> {
    await this.start();
    const expression = `(() => {
      const element = document.querySelector('[data-nori-ref="' + CSS.escape(${JSON.stringify(ref)}) + '"]');
      return element instanceof HTMLInputElement && element.type === 'file' ? element : null;
    })()`;
    const evaluation = await this.webContents.debugger.sendCommand('Runtime.evaluate', {
      expression,
      returnByValue: false,
    }) as { result?: { objectId?: string; subtype?: string } };
    const objectId = evaluation.result?.objectId;
    if (objectId === undefined || evaluation.result?.subtype === 'null') return false;
    try {
      const described = await this.webContents.debugger.sendCommand('DOM.describeNode', { objectId }) as {
        node?: { backendNodeId?: number };
      };
      const backendNodeId = described.node?.backendNodeId;
      if (backendNodeId === undefined) return false;
      await this.webContents.debugger.sendCommand('DOM.setFileInputFiles', { files: [...paths], backendNodeId });
      return true;
    } finally {
      await this.webContents.debugger.sendCommand('Runtime.releaseObject', { objectId }).catch(() => undefined);
    }
  }

  async respondToDialog(accept: boolean, promptText?: string): Promise<void> {
    await this.start();
    await this.webContents.debugger.sendCommand('Page.handleJavaScriptDialog', {
      accept,
      ...(promptText === undefined ? {} : { promptText }),
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.restartTimer !== undefined) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.webContents.debugger.off('message', this.handleMessage);
    this.webContents.debugger.off('detach', this.handleDetach);
    if (this.attachedByNori && !this.webContents.isDestroyed() && this.webContents.debugger.isAttached()) {
      this.webContents.debugger.detach();
    }
    this.attachedByNori = false;
    this.started = false;
  }

  private readonly handleDetach = () => {
    this.webContents.debugger.off('message', this.handleMessage);
    this.webContents.debugger.off('detach', this.handleDetach);
    this.attachedByNori = false;
    this.started = false;
    if (this.disposed || this.webContents.isDestroyed() || this.restartTimer !== undefined) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.start().catch(this.onFailure);
    }, 250);
    this.restartTimer.unref?.();
  };

  private readonly handleMessage = (
    _event: Electron.Event,
    method: string,
    params: Record<string, unknown>,
  ) => {
    const timestamp = Date.now();
    if (method === 'Network.requestWillBeSent') {
      const request = params['request'] as { method?: string; url?: string } | undefined;
      this.onNetwork({
        phase: 'request',
        requestId: String(params['requestId'] ?? ''),
        timestamp,
        method: request?.method,
        url: request?.url,
        resourceType: typeof params['type'] === 'string' ? params['type'] : undefined,
      });
      return;
    }
    if (method === 'Network.responseReceived') {
      const response = params['response'] as { status?: number; mimeType?: string; url?: string } | undefined;
      this.onNetwork({
        phase: 'response',
        requestId: String(params['requestId'] ?? ''),
        timestamp,
        url: response?.url,
        status: response?.status,
        mimeType: response?.mimeType,
        resourceType: typeof params['type'] === 'string' ? params['type'] : undefined,
      });
      return;
    }
    if (method === 'Network.loadingFinished') {
      this.onNetwork({ phase: 'finished', requestId: String(params['requestId'] ?? ''), timestamp });
      return;
    }
    if (method === 'Network.loadingFailed') {
      this.onNetwork({
        phase: 'failed',
        requestId: String(params['requestId'] ?? ''),
        timestamp,
        error: typeof params['errorText'] === 'string' ? params['errorText'] : 'Network request failed.',
      });
      return;
    }
    if (method === 'Page.javascriptDialogOpening') {
      this.onDialog({
        type: normalizeDialogType(params['type']),
        message: typeof params['message'] === 'string' ? params['message'] : '',
        defaultPrompt: typeof params['defaultPrompt'] === 'string' ? params['defaultPrompt'] : undefined,
        url: typeof params['url'] === 'string' ? params['url'] : this.webContents.getURL(),
      });
    }
  };
}

function normalizeDialogType(value: unknown): BrowserJavaScriptDialog['type'] {
  return value === 'confirm' || value === 'prompt' || value === 'beforeunload' ? value : 'alert';
}
