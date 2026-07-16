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
  NodeLanguageServerBackend,
  type ISessionService,
  type LanguageServerBackend,
  type LanguageServerDocument,
  type LanguageServerLaunch,
  type LanguageServerTransport,
} from '../../src/services';
import { serverDefinition } from '../../src/services/lsp/lspService';

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
  it.each([
    ['app.tsx', 'typescript-language-server', 'typescriptreact'],
    ['config.json', 'vscode-json-language-server', 'json'],
    ['index.html', 'vscode-html-language-server', 'html'],
    ['style.scss', 'vscode-css-language-server', 'scss'],
    ['main.py', 'pyright', 'python'],
    ['lib.rs', 'rust-analyzer', 'rust'],
    ['main.go', 'gopls', 'go'],
    ['main.cpp', 'clangd', 'cpp'],
    ['Main.java', 'jdtls', 'java'],
    ['Program.cs', 'omnisharp', 'csharp'],
    ['index.php', 'intelephense', 'php'],
    ['main.rb', 'solargraph', 'ruby'],
    ['init.lua', 'lua-language-server', 'lua'],
    ['script.sh', 'bash-language-server', 'shellscript'],
    ['config.yml', 'yaml-language-server', 'yaml'],
    ['README.md', 'vscode-markdown-language-server', 'markdown'],
    ['App.vue', 'vue-language-server', 'vue'],
    ['App.svelte', 'svelteserver', 'svelte'],
    ['Dockerfile', 'docker-langserver', 'dockerfile'],
  ])('configures %s with %s', (fileName, serverId, languageId) => {
    expect(serverDefinition(fileName)).toMatchObject({ id: serverId, languageId });
  });

  it('leaves unknown file types unsupported', () => {
    expect(serverDefinition('archive.unknown-extension')).toBeUndefined();
  });

  it('reports a configured external server as unavailable and retries on refresh', async () => {
    writeFileSync(join(root, 'Main.java'), 'class Main {}\n');
    const starts: LanguageServerLaunch[] = [];
    const backend: LanguageServerBackend = {
      async start(launch) {
        starts.push(launch);
        throw new Error(`spawn ${launch.command} ENOENT`);
      },
    };
    const service = new LspService({ backend }, sessionService(new Emitter()));

    const first = await service.status('session-1', 'Main.java');
    const second = await service.status('session-1', 'Main.java');

    expect(first).toMatchObject({
      available: false,
      running: false,
      server_id: 'jdtls',
      language_id: 'java',
    });
    expect(first.reason).toContain('jdtls is configured but could not be started');
    expect(first.reason).not.toContain('No language server is configured');
    expect(second.reason).toContain('jdtls is configured but could not be started');
    expect(starts).toHaveLength(2);
    service.dispose();
  });

  it('rejects a missing executable without opening a JSON-RPC connection', async () => {
    const backend = new NodeLanguageServerBackend();
    await expect(backend.start({
      id: 'missing-language-server',
      languageId: 'text',
      rootPath: root,
      command: `nori-missing-language-server-${Date.now()}`,
      args: [],
    })).rejects.toThrow(/ENOENT|not found/i);
  });

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

  it('starts the bundled HTML server', async () => {
    writeFileSync(join(root, 'src', 'index.html'), '<main><h1>Nori</h1></main>\n');
    const service = new LspService({}, sessionService(new Emitter()));
    try {
      const status = await service.status('session-1', 'src/index.html');
      const symbols = await service.request('session-1', { operation: 'document_symbols', path: 'src/index.html' });

      expect(status).toMatchObject({
        available: true,
        running: true,
        server_id: 'vscode-html-language-server',
        language_id: 'html',
      });
      expect(symbols.result).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'h1' }),
      ]));
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
