import { createDecorator } from '../../di';
import type { LspOperation, LspRequest, LspResult, LspStatus } from '@nori-code/protocol';

export interface LanguageServerDocument {
  readonly uri: string;
  readonly path: string;
  readonly languageId: string;
  readonly text: string;
}

export interface LanguageServerLaunch {
  readonly id: string;
  readonly languageId: string;
  readonly rootPath: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly initializationOptions?: Record<string, unknown>;
}

export interface LanguageServerTransport {
  readonly capabilities: Readonly<Record<string, unknown>>;
  prepareDocument(document: LanguageServerDocument): Promise<void>;
  diagnostics(document: LanguageServerDocument): Promise<unknown>;
  request(method: string, params: unknown): Promise<unknown>;
  dispose(): void;
}

export interface LanguageServerBackend {
  start(launch: LanguageServerLaunch): Promise<LanguageServerTransport>;
}

export interface LspServiceOptions {
  readonly backend?: LanguageServerBackend;
  readonly requestTimeoutMs?: number;
  readonly diagnosticsTimeoutMs?: number;
}

export interface ILspService {
  readonly _serviceBrand: undefined;
  status(sessionId: string, path: string): Promise<LspStatus>;
  request(sessionId: string, input: LspRequest): Promise<LspResult>;
}

export const ILspService = createDecorator<ILspService>('lspService');

export class LspUnsupportedLanguageError extends Error {
  constructor(readonly path: string) {
    super(`no language server is configured for ${path}`);
    this.name = 'LspUnsupportedLanguageError';
  }
}

export class LspPositionRequiredError extends Error {
  constructor(readonly operation: LspOperation) {
    super(`${operation} requires a line and character position`);
    this.name = 'LspPositionRequiredError';
  }
}

export class LspUnavailableError extends Error {
  constructor(readonly serverId: string, message: string) {
    super(`${serverId} is unavailable: ${message}`);
    this.name = 'LspUnavailableError';
  }
}
