import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNoriProvidersFromConfig } from '../../src/session/nori-providers';

const SIMPLE_CONFIG = { providers: {} };

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('Nori filesystem memory provider', () => {
  it('does not make embedding requests in simple mode', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const root = await tempRoot();
    const providers = createNoriProvidersFromConfig(
      { obsidian: { vault_path: './nori-vault' } },
      SIMPLE_CONFIG,
      root,
    );
    if (providers === null) throw new Error('expected providers');

    await providers.memory.multiRetrieve(['anything']);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('recursively searches notes under the vault without a note type filter', async () => {
    const root = await tempRoot();
    const vault = join(root, 'nori-vault');
    await mkdir(join(vault, 'analysis'), { recursive: true });
    await writeFile(
      join(vault, 'analysis', 'coder-write.md'),
      [
        '---',
        'title: "Bug: coder_write_enabled in nori.yaml is dead config"',
        'type: analysis',
        '---',
        '',
        'The coder_write_enabled field must be read from nori.yaml.',
      ].join('\n'),
      'utf-8',
    );

    const providers = createNoriProvidersFromConfig(
      { obsidian: { vault_path: './nori-vault' } },
      SIMPLE_CONFIG,
      root,
    );
    if (providers === null) throw new Error('expected providers');

    const results = await providers.memory.multiRetrieve(['coder_write_enabled']);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: 'Bug: coder_write_enabled in nori.yaml is dead config',
      path: 'analysis/coder-write.md',
    });
  });

  it('maps plural note type filters to singular note directories', async () => {
    const root = await tempRoot();
    const vault = join(root, 'nori-vault');
    await mkdir(join(vault, 'review'), { recursive: true });
    await writeFile(
      join(vault, 'review', 'rendering.md'),
      [
        '---',
        'title: "Rendering pipeline review"',
        'type: review',
        '---',
        '',
        'The rendering pipeline can black screen when shell output is not sanitized.',
      ].join('\n'),
      'utf-8',
    );

    const providers = createNoriProvidersFromConfig(
      { obsidian: { vault_path: './nori-vault' } },
      SIMPLE_CONFIG,
      root,
    );
    if (providers === null) throw new Error('expected providers');

    const results = await providers.memory.multiRetrieve(['black screen'], {
      type_filter: ['reviews'],
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.path).toBe('review/rendering.md');
  });

  it('matches title, frontmatter, and file path, not only body text', async () => {
    const root = await tempRoot();
    const vault = join(root, 'nori-vault');
    await mkdir(join(vault, 'decision'), { recursive: true });
    await writeFile(
      join(vault, 'decision', 'generic-crawler.md'),
      [
        '---',
        'title: "Generic Crawler architecture decision"',
        'type: decision',
        'tags: [crawler]',
        '---',
        '',
        'Implementation notes are intentionally generic.',
      ].join('\n'),
      'utf-8',
    );

    const providers = createNoriProvidersFromConfig(
      { obsidian: { vault_path: './nori-vault' } },
      SIMPLE_CONFIG,
      root,
    );
    if (providers === null) throw new Error('expected providers');

    const results = await providers.memory.multiRetrieve(['Generic Crawler'], {
      type_filter: ['decisions'],
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe('Generic Crawler architecture decision');
  });

  it('removes an exact-title note from retrieval and keeps it in trash', async () => {
    const root = await tempRoot();
    const vault = join(root, 'nori-vault');
    await mkdir(join(vault, 'analysis'), { recursive: true });
    await writeNote(join(vault, 'analysis', 'obsolete.md'), 'Obsolete memory', 'remove-marker');
    const providers = createNoriProvidersFromConfig(
      { obsidian: { vault_path: './nori-vault' } },
      SIMPLE_CONFIG,
      root,
    );
    if (providers === null) throw new Error('expected providers');

    await expect(providers.memory.removeNote(' Obsolete memory ')).resolves.toBe(true);
    await expect(providers.memory.multiRetrieve(['remove-marker'])).resolves.toEqual([]);
    await expect(readdir(join(vault, '.trash'))).resolves.toEqual(['obsolete.md']);
    await expect(providers.memory.removeNote('Obsolete memory')).resolves.toBe(false);
  });

  it('removes same-named notes without colliding in trash', async () => {
    const root = await tempRoot();
    const vault = join(root, 'nori-vault');
    await mkdir(join(vault, 'analysis'), { recursive: true });
    await mkdir(join(vault, 'review'), { recursive: true });
    await writeNote(join(vault, 'analysis', 'shared.md'), 'First memory', 'first');
    await writeNote(join(vault, 'review', 'shared.md'), 'Second memory', 'second');
    const providers = createNoriProvidersFromConfig(
      { obsidian: { vault_path: './nori-vault' } },
      SIMPLE_CONFIG,
      root,
    );
    if (providers === null) throw new Error('expected providers');

    await expect(providers.memory.removeNote('First memory')).resolves.toBe(true);
    await expect(providers.memory.removeNote('Second memory')).resolves.toBe(true);
    expect((await readdir(join(vault, '.trash'))).toSorted()).toEqual(['shared-2.md', 'shared.md']);
  });
});

describe('Nori vector memory provider', () => {
  it('recalls a semantic match and sends an OpenAI-compatible authenticated request', async () => {
    const root = await tempRoot();
    const vault = join(root, 'nori-vault');
    await mkdir(join(vault, 'analysis'), { recursive: true });
    await writeNote(join(vault, 'analysis', 'feline.md'), 'Feline health', 'Whiskers needs regular veterinary care.');
    await writeNote(join(vault, 'analysis', 'database.md'), 'Storage notes', 'Indexes improve relational query plans.');
    const fetchMock = embeddingFetch((text) => text.includes('Feline') ? [1, 0] : text.includes('Storage') ? [0, 1] : [1, 0]);
    vi.stubGlobal('fetch', fetchMock);
    const providers = vectorProviders(root, {
      customHeaders: { 'X-Tenant': 'team-a' },
    });

    const results = await providers.memory.multiRetrieve(['animal wellness'], { top_k: 1 });

    expect(results[0]?.title).toBe('Feline health');
    expect(results[0]?.score).toBeGreaterThan(0);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://embeddings.example.test/v1/embeddings');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ model: 'text-embedding-test', input: ['animal wellness'] });
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer secret-memory-key');
    expect(headers.get('x-tenant')).toBe('team-a');

    const fallbackWeightResults = await providers.memory.multiRetrieve(['animal wellness'], {
      top_k: 1,
      weights: { embedding: Number.NaN, fulltext: -1, graph: 0 },
    });
    expect(fallbackWeightResults[0]?.title).toBe('Feline health');
  });

  it('caches note embeddings and re-embeds a note when its file metadata changes', async () => {
    const root = await tempRoot();
    const vault = join(root, 'nori-vault');
    const notePath = join(vault, 'analysis', 'cache.md');
    await mkdir(join(vault, 'analysis'), { recursive: true });
    await writeNote(notePath, 'Cached note', 'first version');
    const fetchMock = embeddingFetch(() => [1, 0]);
    vi.stubGlobal('fetch', fetchMock);
    const providers = vectorProviders(root);

    await providers.memory.multiRetrieve(['semantic query']);
    await providers.memory.multiRetrieve(['semantic query']);
    await writeNote(notePath, 'Cached note', 'second version with a different size');
    await providers.memory.multiRetrieve(['semantic query']);

    const embeddedNoteRequests = fetchMock.mock.calls.filter(([, init]) => {
      const body = JSON.parse((init as RequestInit).body as string) as { input: string[] };
      return body.input.some((input) => input.includes('Cached note'));
    });
    expect(embeddedNoteRequests).toHaveLength(2);
  });

  it('embeds notes in batches of at most 64 inputs', async () => {
    const root = await tempRoot();
    const notesDir = join(root, 'nori-vault', 'analysis');
    await mkdir(notesDir, { recursive: true });
    await Promise.all(
      Array.from({ length: 65 }, (_, index) =>
        writeNote(join(notesDir, `note-${String(index)}.md`), `Note ${String(index)}`, 'content'),
      ),
    );
    const fetchMock = embeddingFetch(() => [1, 0]);
    vi.stubGlobal('fetch', fetchMock);
    const providers = vectorProviders(root);

    await providers.memory.multiRetrieve(['query']);

    const batchSizes = fetchMock.mock.calls.slice(1).map(([, init]) => {
      const body = JSON.parse((init as RequestInit).body as string) as { input: string[] };
      return body.input.length;
    });
    expect(batchSizes).toEqual([64, 1]);
  });

  it.each([
    [{ providerType: 'openai', baseUrl: 'https://example.test/v1', apiKey: undefined, model: 'embed' }, 'api_key'],
    [{ providerType: 'openai', baseUrl: undefined, apiKey: 'key', model: 'embed' }, 'base_url'],
    [{ providerType: 'openai', baseUrl: 'https://example.test/v1', apiKey: 'key', model: undefined }, 'model'],
    [{ providerType: 'anthropic', baseUrl: 'https://example.test/v1', apiKey: 'key', model: 'embed' }, 'Unsupported'],
  ])('fails explicitly for invalid vector configuration', async (memory, expected) => {
    const root = await tempRoot();
    const providers = vectorProviders(root, memory as never);

    await expect(providers.memory.multiRetrieve(['query'])).rejects.toThrow(expected);
  });

  it('rejects malformed embedding responses without exposing the API key', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'nori-vault', 'analysis'), { recursive: true });
    await writeNote(join(root, 'nori-vault', 'analysis', 'bad.md'), 'Bad response', 'content');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [1, Number.NaN] }],
    }), { status: 200 })));
    const providers = vectorProviders(root);

    const error = await providers.memory.multiRetrieve(['query']).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('invalid vector');
    expect((error as Error).message).not.toContain('secret-memory-key');
  });
});

async function writeNote(filePath: string, title: string, body: string): Promise<void> {
  await writeFile(filePath, ['---', `title: "${title}"`, 'type: analysis', '---', '', body].join('\n'), 'utf-8');
}

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nori-memory-'));
  tempDirs.push(dir);
  return dir;
}

function vectorProviders(
  root: string,
  memory: Record<string, unknown> = {},
): NonNullable<ReturnType<typeof createNoriProvidersFromConfig>> {
  const providers = createNoriProvidersFromConfig(
    { obsidian: { vault_path: './nori-vault' } },
    {
      providers: {},
      memory: {
        vectorEnabled: true,
        providerType: 'openai_responses',
        baseUrl: 'https://embeddings.example.test/v1/',
        apiKey: 'secret-memory-key',
        model: 'text-embedding-test',
        ...memory,
      },
    } as never,
    root,
  );
  if (providers === null) throw new Error('expected providers');
  return providers;
}

function embeddingFetch(vectorFor: (text: string) => number[]): ReturnType<typeof vi.fn> {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { input: string[] };
    return new Response(JSON.stringify({
      data: body.input.map((input, index) => ({ index, embedding: vectorFor(input) })),
    }), { status: 200 });
  });
}
