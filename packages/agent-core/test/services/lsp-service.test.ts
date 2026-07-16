import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Session } from '@nori-code/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Emitter } from '../../src';
import {
  FsPathEscapesError,
  LspPositionRequiredError,
  LspService,
  type ISessionService,
  type LanguageServerBackend,
  type LanguageServerDocument,
  type LanguageServerLaunch,
  type LanguageServerTransport,
} from '../../src/services';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nori-lsp-service-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true }, include: ['src'] }));
  writeFileSync(join(root, 'src', 'app.ts'), 'export const answer: string = 42;\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

class FakeTransport implements LanguageServerTransport {
  readonly capabilities = {
    hoverProvider: true,
    definitionProvider: true,
    documentSymbolProvider: true,
    documentFormattingProvider: true,
  };
  readonly documents: LanguageServerDocument[] = [];
  readonly requests: Array<{ method: string; params: unknown }> = [];
  disposed = false;

  async prepareDocument(document: LanguageServerDocument): Promise<void> {
    this.documents.push(document);
  }

  async diagnostics(document: LanguageServerDocument): Promise<unknown> {
    this.documents.push(document);
    return [{ message: 'Type mismatch' }];
  }

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    return { contents: 'number' };
  }

  dispose(): void {
    this.disposed = true;
  }
}

class FakeBackend implements LanguageServerBackend {
  readonly launches: LanguageServerLaunch[] = [];
  readonly transport = new FakeTransport();

  async start(launch: LanguageServerLaunch): Promise<LanguageServerTransport> {
    this.launches.push(launch);
    return this.transport;
  }
}

describe('LspService', () => {
  it('starts the bundled TypeScript server and receives diagnostics', async () => {
    const service = new LspService({ diagnosticsTimeoutMs: 6000 }, sessionService(new Emitter()));
    try {
      const status = await service.status('session-1', 'src/app.ts');
      const symbols = await service.request('session-1', { operation: 'document_symbols', path: 'src/app.ts' });
      const response = await service.request('session-1', { operation: 'diagnostics', path: 'src/app.ts' });
      const diagnostics = response.result as Array<{ message?: string }>;

      expect(status).toMatchObject({
        available: true,
        running: true,
        server_id: 'typescript-language-server',
      });
      expect(symbols.result).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'answer' }),
      ]));
      expect(diagnostics.some(item => item.message?.includes('not assignable'))).toBe(true);
    } finally {
      service.dispose();
    }
  }, 20_000);

  it('reuses one server per session and maps semantic requests to JSON-RPC', async () => {
    const backend = new FakeBackend();
    const close = new Emitter<{ sessionId: string }>();
    const service = new LspService({ backend }, sessionService(close));

    const status = await service.status('session-1', 'src/app.ts');
    const hover = await service.request('session-1', {
      operation: 'hover',
      path: 'src/app.ts',
      position: { line: 0, character: 13 },
    });
    const diagnostics = await service.request('session-1', { operation: 'diagnostics', path: 'src/app.ts' });

    expect(status).toMatchObject({ available: true, running: true, language_id: 'typescript' });
    expect(status.capabilities).toContain('hover');
    expect(backend.launches).toHaveLength(1);
    expect(backend.launches[0]).toMatchObject({ id: 'typescript-language-server', rootPath: root });
    expect(backend.transport.requests[0]).toMatchObject({
      method: 'textDocument/hover',
      params: { position: { line: 0, character: 13 } },
    });
    expect(hover.result).toEqual({ contents: 'number' });
    expect(diagnostics.result).toEqual([{ message: 'Type mismatch' }]);

    close.fire({ sessionId: 'session-1' });
    expect(backend.transport.disposed).toBe(true);
    service.dispose();
  });

  it('requires positions and rejects paths outside the session workspace', async () => {
    const service = new LspService({ backend: new FakeBackend() }, sessionService(new Emitter()));

    await expect(service.request('session-1', { operation: 'hover', path: 'src/app.ts' }))
      .rejects.toBeInstanceOf(LspPositionRequiredError);
    await expect(service.status('session-1', '../outside.ts'))
      .rejects.toBeInstanceOf(FsPathEscapesError);
    service.dispose();
  });
});

function sessionService(close: Emitter<{ sessionId: string }>): ISessionService {
  const created = new Emitter<{ session: Session }>();
  return {
    _serviceBrand: undefined,
    create: vi.fn(),
    list: vi.fn(),
    get: vi.fn(async () => ({ metadata: { cwd: root } }) as Session),
    update: vi.fn(),
    fork: vi.fn(),
    listChildren: vi.fn(),
    createChild: vi.fn(),
    getStatus: vi.fn(),
    getSessionWarnings: vi.fn(),
    compact: vi.fn(),
    undo: vi.fn(),
    archive: vi.fn(),
    onDidCreate: created.event,
    onDidClose: close.event,
  } as unknown as ISessionService;
}
