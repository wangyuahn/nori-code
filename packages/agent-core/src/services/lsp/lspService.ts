import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Disposable, registerSingleton, SyncDescriptor } from '../../di';
import type { LspOperation, LspRequest, LspResult, LspStatus } from '@nori-code/protocol';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';

import { resolveSafePath } from '../fs/fsPathSafety';
import { ISessionService } from '../session/session';
import {
  ILspService,
  LspPositionRequiredError,
  LspUnavailableError,
  LspUnsupportedLanguageError,
  type LanguageServerBackend,
  type LanguageServerDocument,
  type LanguageServerLaunch,
  type LanguageServerTransport,
  type LspServiceOptions,
} from './lsp';

const require = createRequire(import.meta.url);
const POSITION_OPERATIONS = new Set<LspOperation>(['hover', 'definition', 'references', 'rename']);
const ALL_OPERATIONS: LspOperation[] = ['diagnostics', 'hover', 'definition', 'references', 'document_symbols', 'workspace_symbols', 'rename', 'format'];

interface ServerDefinition {
  id: string;
  languageId: string;
  command: string;
  args: string[];
  initializationOptions?: Record<string, unknown>;
}

interface ClientRecord {
  transport?: LanguageServerTransport;
  starting?: Promise<LanguageServerTransport>;
  error?: string;
}

export class LspService extends Disposable implements ILspService {
  readonly _serviceBrand: undefined;
  private readonly backend: LanguageServerBackend;
  private readonly requestTimeoutMs: number;
  private readonly clients = new Map<string, ClientRecord>();

  constructor(
    options: LspServiceOptions = {},
    @ISessionService private readonly sessions: ISessionService,
  ) {
    super();
    this.backend = options.backend ?? new NodeLanguageServerBackend(options.diagnosticsTimeoutMs);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this._register(this.sessions.onDidClose(({ sessionId }) => this.disposeSession(sessionId)));
  }

  async status(sessionId: string, requestPath: string): Promise<LspStatus> {
    const resolved = await this.resolve(sessionId, requestPath);
    const definition = serverDefinition(resolved.absolute);
    if (!definition) {
      return { available: false, running: false, server_id: 'none', language_id: languageIdForPath(resolved.absolute), capabilities: [], reason: 'No language server is configured for this file type.' };
    }
    const key = clientKey(sessionId, definition.id);
    const record = this.clients.get(key);
    if (record?.transport) {
      return { available: true, running: true, server_id: definition.id, language_id: definition.languageId, capabilities: supportedOperations(record.transport.capabilities) };
    }
    if (record?.error) {
      return { available: false, running: false, server_id: definition.id, language_id: definition.languageId, capabilities: [], reason: record.error };
    }
    try {
      const transport = await this.ensureClient(sessionId, resolved.root, definition);
      return { available: true, running: true, server_id: definition.id, language_id: definition.languageId, capabilities: supportedOperations(transport.capabilities) };
    } catch (error) {
      return { available: false, running: false, server_id: definition.id, language_id: definition.languageId, capabilities: [], reason: errorMessage(error) };
    }
  }

  async request(sessionId: string, input: LspRequest): Promise<LspResult> {
    const resolved = await this.resolve(sessionId, input.path);
    const definition = serverDefinition(resolved.absolute);
    if (!definition) throw new LspUnsupportedLanguageError(input.path);
    if (POSITION_OPERATIONS.has(input.operation) && input.position === undefined) {
      throw new LspPositionRequiredError(input.operation);
    }
    const transport = await this.ensureClient(sessionId, resolved.root, definition);
    const document: LanguageServerDocument = {
      uri: pathToFileURL(resolved.absolute).href,
      path: resolved.absolute,
      languageId: definition.languageId,
      text: await fs.readFile(resolved.absolute, 'utf8'),
    };
    const result = input.operation === 'diagnostics'
      ? await withTimeout(transport.diagnostics(document), this.requestTimeoutMs, `${definition.id} diagnostics`)
      : await this.semanticRequest(transport, document, input);
    return { server_id: definition.id, language_id: definition.languageId, operation: input.operation, result };
  }

  override dispose(): void {
    for (const record of this.clients.values()) record.transport?.dispose();
    this.clients.clear();
    super.dispose();
  }

  private async semanticRequest(transport: LanguageServerTransport, document: LanguageServerDocument, input: LspRequest): Promise<unknown> {
    await transport.prepareDocument(document);
    const textDocument = { uri: document.uri };
    let method: string;
    let params: Record<string, unknown>;
    switch (input.operation) {
      case 'hover':
        method = 'textDocument/hover';
        params = { textDocument, position: input.position };
        break;
      case 'definition':
        method = 'textDocument/definition';
        params = { textDocument, position: input.position };
        break;
      case 'references':
        method = 'textDocument/references';
        params = { textDocument, position: input.position, context: { includeDeclaration: true } };
        break;
      case 'document_symbols':
        method = 'textDocument/documentSymbol';
        params = { textDocument };
        break;
      case 'workspace_symbols':
        method = 'workspace/symbol';
        params = { query: input.query ?? '' };
        break;
      case 'rename':
        method = 'textDocument/rename';
        params = { textDocument, position: input.position, newName: input.new_name ?? '' };
        break;
      case 'format':
        method = 'textDocument/formatting';
        params = { textDocument, options: { tabSize: 2, insertSpaces: true } };
        break;
      default:
        return [];
    }
    return withTimeout(transport.request(method, params), this.requestTimeoutMs, `${method} request`);
  }

  private async resolve(sessionId: string, requestPath: string): Promise<{ root: string; absolute: string }> {
    const session = await this.sessions.get(sessionId);
    const root = await fs.realpath(session.metadata.cwd);
    const safe = await resolveSafePath(root, requestPath);
    return { root, absolute: safe.absolute };
  }

  private async ensureClient(sessionId: string, rootPath: string, definition: ServerDefinition): Promise<LanguageServerTransport> {
    const key = clientKey(sessionId, definition.id);
    let record = this.clients.get(key);
    if (!record) {
      record = {};
      this.clients.set(key, record);
    }
    if (record.transport) return record.transport;
    if (record.starting) return record.starting;
    const launch: LanguageServerLaunch = { ...definition, rootPath };
    record.starting = this.backend.start(launch).then(transport => {
      record!.transport = transport;
      record!.starting = undefined;
      record!.error = undefined;
      return transport;
    }).catch(error => {
      record!.starting = undefined;
      record!.error = errorMessage(error);
      throw new LspUnavailableError(definition.id, record!.error);
    });
    return record.starting;
  }

  private disposeSession(sessionId: string): void {
    const prefix = `${sessionId}\0`;
    for (const [key, record] of this.clients) {
      if (!key.startsWith(prefix)) continue;
      record.transport?.dispose();
      this.clients.delete(key);
    }
  }
}

export class NodeLanguageServerBackend implements LanguageServerBackend {
  constructor(private readonly diagnosticsTimeoutMs = 2500) {}

  async start(launch: LanguageServerLaunch): Promise<LanguageServerTransport> {
    return NodeLanguageServerTransport.start(launch, this.diagnosticsTimeoutMs);
  }
}

class NodeLanguageServerTransport implements LanguageServerTransport {
  private readonly documents = new Map<string, { text: string; version: number }>();
  private readonly diagnosticsByUri = new Map<string, unknown>();
  private readonly diagnosticWaiters = new Map<string, Set<(value: unknown) => void>>();
  private disposed = false;

  private constructor(
    private readonly process: ChildProcessWithoutNullStreams,
    private readonly connection: MessageConnection,
    readonly capabilities: Readonly<Record<string, unknown>>,
    private readonly diagnosticsTimeoutMs: number,
  ) {
    connection.onNotification('textDocument/publishDiagnostics', (params: { uri?: string; diagnostics?: unknown }) => {
      if (!params.uri) return;
      const diagnostics = params.diagnostics ?? [];
      this.diagnosticsByUri.set(params.uri, diagnostics);
      for (const resolve of this.diagnosticWaiters.get(params.uri) ?? []) resolve(diagnostics);
      this.diagnosticWaiters.delete(params.uri);
    });
  }

  static async start(launch: LanguageServerLaunch, diagnosticsTimeoutMs: number): Promise<NodeLanguageServerTransport> {
    const child = spawn(launch.command, [...launch.args], {
      cwd: launch.rootPath,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
    connection.listen();
    const processFailure = new Promise<never>((_resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => reject(new Error(`language server exited during startup (${code ?? signal ?? 'unknown'})`)));
    });
    try {
      const initialize = connection.sendRequest<{ capabilities?: Record<string, unknown> }>('initialize', {
        processId: process.pid,
        rootUri: pathToFileURL(launch.rootPath).href,
        rootPath: launch.rootPath,
        capabilities: {
          workspace: { workspaceFolders: true, symbol: { dynamicRegistration: false } },
          textDocument: {
            publishDiagnostics: { relatedInformation: true, versionSupport: true },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            definition: { linkSupport: true },
            references: {},
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            rename: { prepareSupport: false },
            formatting: {},
          },
        },
        workspaceFolders: [{ uri: pathToFileURL(launch.rootPath).href, name: path.basename(launch.rootPath) }],
        initializationOptions: launch.initializationOptions ?? {},
      });
      const result = await withTimeout(Promise.race([initialize, processFailure]), 12_000, `${launch.id} initialize`);
      connection.sendNotification('initialized', {});
      return new NodeLanguageServerTransport(child, connection, result.capabilities ?? {}, diagnosticsTimeoutMs);
    } catch (error) {
      connection.dispose();
      child.kill();
      throw error;
    }
  }

  async prepareDocument(document: LanguageServerDocument): Promise<void> {
    const current = this.documents.get(document.uri);
    if (!current) {
      this.documents.set(document.uri, { text: document.text, version: 1 });
      this.connection.sendNotification('textDocument/didOpen', { textDocument: { uri: document.uri, languageId: document.languageId, version: 1, text: document.text } });
      return;
    }
    if (current.text === document.text) return;
    const next = { text: document.text, version: current.version + 1 };
    this.documents.set(document.uri, next);
    this.connection.sendNotification('textDocument/didChange', { textDocument: { uri: document.uri, version: next.version }, contentChanges: [{ text: document.text }] });
  }

  async diagnostics(document: LanguageServerDocument): Promise<unknown> {
    let resolveNext: ((value: unknown) => void) | undefined;
    const next = new Promise<unknown>(resolve => {
      resolveNext = resolve;
      let waiters = this.diagnosticWaiters.get(document.uri);
      if (!waiters) {
        waiters = new Set();
        this.diagnosticWaiters.set(document.uri, waiters);
      }
      waiters.add(resolve);
    });
    const current = this.documents.get(document.uri);
    await this.prepareDocument(document);
    if (current?.text === document.text && this.diagnosticsByUri.has(document.uri)) {
      this.diagnosticWaiters.delete(document.uri);
      return this.diagnosticsByUri.get(document.uri) ?? [];
    }
    try {
      return await withTimeout(next, this.diagnosticsTimeoutMs, 'diagnostics');
    } catch {
      const waiters = this.diagnosticWaiters.get(document.uri);
      if (resolveNext) waiters?.delete(resolveNext);
      if (waiters?.size === 0) this.diagnosticWaiters.delete(document.uri);
      return this.typescriptDiagnostics(document).catch(() => this.diagnosticsByUri.get(document.uri) ?? []);
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    return this.connection.sendRequest(method, params);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const waiters of this.diagnosticWaiters.values()) for (const resolve of waiters) resolve([]);
    this.diagnosticWaiters.clear();
    if (process.platform === 'win32' && this.process.pid !== undefined) {
      this.connection.dispose();
      spawnSync('taskkill', ['/pid', String(this.process.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      return;
    }
    let finalized = false;
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      this.connection.dispose();
      if (this.process.exitCode === null) this.process.kill();
    };
    this.process.once('exit', finalize);
    const fallback = setTimeout(finalize, 1000);
    fallback.unref();
    void this.connection.sendRequest('shutdown').then(() => {
      this.connection.sendNotification('exit');
      const flush = setTimeout(finalize, 50);
      flush.unref();
    }).catch(finalize);
  }

  private async typescriptDiagnostics(document: LanguageServerDocument): Promise<unknown[]> {
    const executeCommands = (this.capabilities['executeCommandProvider'] as { commands?: unknown } | undefined)?.commands;
    if (!Array.isArray(executeCommands) || !executeCommands.includes('typescript.tsserverRequest')) return [];
    const commands = ['syntacticDiagnosticsSync', 'semanticDiagnosticsSync', 'suggestionDiagnosticsSync'];
    const responses = await Promise.all(commands.map(command => this.request('workspace/executeCommand', {
      command: 'typescript.tsserverRequest',
      arguments: [command, { file: document.uri }],
    })));
    return responses.flatMap(response => tsServerDiagnostics(response));
  }
}

function serverDefinition(filePath: string): ServerDefinition | undefined {
  const extension = path.extname(filePath).toLowerCase();
  if (['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'].includes(extension)) {
    const packageRoot = path.dirname(require.resolve('typescript-language-server/package.json'));
    return {
      id: 'typescript-language-server',
      languageId: ['.ts', '.mts', '.cts'].includes(extension) ? 'typescript' : extension === '.tsx' ? 'typescriptreact' : extension === '.jsx' ? 'javascriptreact' : 'javascript',
      command: process.execPath,
      args: [path.join(packageRoot, 'lib', 'cli.mjs'), '--stdio'],
      initializationOptions: { tsserver: { path: require.resolve('typescript/lib/tsserver.js') } },
    };
  }
  if (extension === '.py') return { id: 'pyright', languageId: 'python', command: 'pyright-langserver', args: ['--stdio'] };
  if (extension === '.rs') return { id: 'rust-analyzer', languageId: 'rust', command: 'rust-analyzer', args: [] };
  if (extension === '.go') return { id: 'gopls', languageId: 'go', command: 'gopls', args: ['serve'] };
  if (['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp'].includes(extension)) return { id: 'clangd', languageId: extension === '.c' ? 'c' : 'cpp', command: 'clangd', args: ['--background-index'] };
  return undefined;
}

function languageIdForPath(filePath: string): string {
  return path.extname(filePath).slice(1).toLowerCase() || 'text';
}

function supportedOperations(capabilities: Readonly<Record<string, unknown>>): LspOperation[] {
  const operations: LspOperation[] = ['diagnostics'];
  if (capabilities['hoverProvider']) operations.push('hover');
  if (capabilities['definitionProvider']) operations.push('definition');
  if (capabilities['referencesProvider']) operations.push('references');
  if (capabilities['documentSymbolProvider']) operations.push('document_symbols');
  if (capabilities['workspaceSymbolProvider']) operations.push('workspace_symbols');
  if (capabilities['renameProvider']) operations.push('rename');
  if (capabilities['documentFormattingProvider']) operations.push('format');
  return operations.filter(operation => ALL_OPERATIONS.includes(operation));
}

function clientKey(sessionId: string, serverId: string): string {
  return `${sessionId}\0${serverId}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tsServerDiagnostics(value: unknown): unknown[] {
  if (!value || typeof value !== 'object') return [];
  const response = value as Record<string, unknown>;
  const diagnostics = Array.isArray(response['body']) ? response['body'] : Array.isArray(value) ? value : [];
  return diagnostics.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const diagnostic = item as Record<string, unknown>;
    const start = tsServerPosition(diagnostic['start']);
    const end = tsServerPosition(diagnostic['end']);
    if (!start || !end || typeof diagnostic['text'] !== 'string') return [];
    const category = diagnostic['category'];
    return [{
      range: { start, end },
      message: diagnostic['text'],
      severity: category === 'error' ? 1 : category === 'warning' ? 2 : 4,
      code: typeof diagnostic['code'] === 'number' ? diagnostic['code'] : undefined,
      source: 'typescript',
    }];
  });
}

function tsServerPosition(value: unknown): { line: number; character: number } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const position = value as Record<string, unknown>;
  if (typeof position['line'] !== 'number' || typeof position['offset'] !== 'number') return undefined;
  return { line: Math.max(0, position['line'] - 1), character: Math.max(0, position['offset'] - 1) };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

registerSingleton(ILspService, new SyncDescriptor(LspService, [{}], false));
