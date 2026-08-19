import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DshFs, DshFsTarget } from '../src/types.dsh.js';
import {
  extractKeywords,
  NoriVault,
  parseFrontmatter,
  renderChainResult,
  renderRetrievedContext,
  scoreNotes,
  type VaultNote,
} from '../src/vault.js';

/** Minimal node:fs-backed DSH fs adapter for behaviour tests. */
class NodeFsAdapter implements DshFs {
  private target(path: string): DshFsTarget {
    return { targetKey: path, displayPath: path };
  }

  async resolve(path: string, opts?: { cwd?: string }): Promise<DshFsTarget | undefined> {
    const abs = path.includes(':') || path.startsWith('/') ? path : join(opts?.cwd ?? process.cwd(), path);
    return this.target(abs);
  }

  async readText(target: DshFsTarget): Promise<string> {
    return readFile(target.displayPath, 'utf-8');
  }

  async writeText(target: DshFsTarget, content: string): Promise<{ operation: 'create' | 'update' }> {
    const before = await readFile(target.displayPath, 'utf-8').catch(() => undefined);
    await writeFile(target.displayPath, content, 'utf-8');
    return { operation: before === undefined ? 'create' : 'update' };
  }

  async listDir(target: DshFsTarget) {
    const entries = await readdir(target.displayPath, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      type: (e.isDirectory() ? 'directory' : e.isFile() ? 'file' : 'other') as 'directory' | 'file' | 'other',
      target: this.target(join(target.displayPath, e.name)),
    }));
  }
}

let root = '';
let vault: NoriVault;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nori-vault-test-'));
  for (const dir of ['analysis', 'decision', 'task', 'review', '.trash']) {
    await mkdir(join(root, 'nori-vault', dir), { recursive: true });
  }
  vault = new NoriVault(new NodeFsAdapter(), root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seed(title: string, body: string, type = 'analysis', links: string[] = []): Promise<string> {
  const note = `---\ntitle: ${JSON.stringify(title)}\ntype: ${type}\ndate: 2026-07-01\n---\n\n${body}\n${
    links.length > 0 ? `\n## Related\n${links.map((l) => `- [[${l}]]`).join('\n')}` : ''
  }\n`;
  const file = join(root, 'nori-vault', type, `${title.toLowerCase().replaceAll(' ', '-')}.md`);
  await writeFile(file, note, 'utf-8');
  return file;
}

describe('parseFrontmatter', () => {
  it('parses scalar and list fields', () => {
    const fm = parseFrontmatter('---\ntitle: "Hello World"\ntype: analysis\ntags:\n  - a\n  - b\n---\nbody');
    expect(fm['title']).toBe('Hello World');
    expect(fm['type']).toBe('analysis');
    expect(fm['tags']).toEqual(['a', 'b']);
  });

  it('returns empty for a frontmatter-less note', () => {
    expect(parseFrontmatter('# Just a heading')).toEqual({});
  });
});

describe('extractKeywords', () => {
  it('extracts wiki links and technical tokens, drops stop words', () => {
    const kws = extractKeywords('debug the [[flux capacitor]] in electron desktop tool', 10);
    expect(kws).toContain('flux capacitor');
    expect(kws).toContain('electron');
    expect(kws.some((k) => ['tool', 'tools', 'with', 'should'].includes(k))).toBe(false);
  });
});

describe('scoreNotes', () => {
  it('scores title hits higher and propagates through links', () => {
    const notes: VaultNote[] = [
      { path: 'a.md', rel: 'a', title: 'Flux Notes', type: 'analysis', tags: [], links: ['b'], content: '# x\n\nnothing' },
      { path: 'b.md', rel: 'b', title: 'Unrelated', type: 'analysis', tags: [], links: [], content: '# x\n\nno match' },
    ];
    const direct = scoreNotes(['flux'], notes, 0);
    expect(direct).toHaveLength(1);
    expect(direct[0]!.note.title).toBe('Flux Notes');
    const linked = scoreNotes(['flux'], notes, 1);
    expect(linked).toHaveLength(2);
    const b = linked.find((e) => e.note.title === 'Unrelated');
    expect(b!.score).toBeCloseTo(direct[0]!.score * 0.5, 5);
  });
});

describe('NoriVault write/search/remove', () => {
  it('two-phase write: empty links returns candidates, then writes with resolved links', async () => {
    await seed('Existing Alpha', 'content about alpha');
    const phase1 = await vault.writeNote({ note_type: 'analysis', title: 'New Beta', content: 'beta body', tags: ['alpha'], links: [] });
    expect(phase1.phase).toBe(1);
    expect(phase1.output).toContain('Existing Alpha');

    const phase2 = await vault.writeNote({
      note_type: 'analysis',
      title: 'New Beta',
      content: 'beta body',
      links: ['Existing Alpha'],
    });
    expect(phase2.phase).toBe(2);
    expect(phase2.path).toBeDefined();
    const raw = await readFile(phase2.path!, 'utf-8');
    expect(raw).toContain('title: "New Beta"');
    expect(raw).toContain('## Related');
    expect(raw).toContain('[[analysis/existing-alpha|Existing Alpha]]');
  });

  it('"None" sentinel skips linking entirely', async () => {
    const r = await vault.writeNote({ note_type: 'task', title: 'Solo', content: 'x', links: ['None'] });
    expect(r.phase).toBe(2);
    const raw = await readFile(r.path!, 'utf-8');
    expect(raw).not.toContain('## Related');
  });

  it('chained retrieval finds linked notes across hops', async () => {
    await seed('Alpha', 'flux capacitor diagnostics');
    await seed('Beta', 'beta decision uses the capacitor', 'decision', ['Alpha']);
    const chain = await vault.retrieveChain({ keywords: ['flux'], include_linked: true, link_depth: 1, chain_depth: 1 });
    expect(chain.hops.length).toBeGreaterThanOrEqual(1);
    expect(chain.uniqueResults.map((r) => r.title)).toEqual(expect.arrayContaining(['Alpha', 'Beta']));
  });

  it('removeNote moves the note to .trash and tombstones the original', async () => {
    await seed('Doomed', 'content');
    const r = await vault.removeNote('Doomed');
    expect(r.ok).toBe(true);
    const trashFiles = await readdir(join(root, 'nori-vault', '.trash'));
    expect(trashFiles.length).toBe(1);
    const after = await vault.retrieveChain({ keywords: ['Doomed'] });
    expect(after.uniqueResults).toHaveLength(0);
  });

  it('duplicate trash names get a -2 suffix instead of overwriting', async () => {
    const path = await seed('Twice', 'content');
    expect((await vault.removeNote('Twice')).ok).toBe(true);
    // Re-seed the same title, then remove again.
    await writeFile(path, await (await import('node:fs/promises')).readFile(join(root, 'nori-vault', '.trash', 'twice.md'), 'utf-8'), 'utf-8');
    expect((await vault.removeNote('Twice')).ok).toBe(true);
    const trashFiles = await readdir(join(root, 'nori-vault', '.trash'));
    expect(trashFiles.sort()).toEqual(['twice-2.md', 'twice.md']);
  });

  it('removed notes never surface again (tombstone filter)', async () => {
    await seed('Gone', 'unique marker zzzgone');
    await vault.removeNote('Gone');
    const chain = await vault.retrieveChain({ keywords: ['zzzgone'] });
    expect(chain.uniqueResults).toHaveLength(0);
  });
});

describe('renderers', () => {
  it('renderChainResult and renderRetrievedContext escape XML', () => {
    const chain = {
      query: { keywords: ['x'], top_k: 10, include_linked: false, link_depth: 0, chain_depth: 0 },
      hops: [
        {
          index: 0,
          source: 'initial' as const,
          keywords: ['x<&'],
          results: [{ title: 'T<a>', path: 'p<1>', score: 1, excerpt: 'body <b>' }],
        },
      ],
      uniqueResults: [{ title: 'T<a>', path: 'p<1>', score: 1, excerpt: 'body <b>' }],
    };
    expect(renderChainResult(chain)).toContain('T<a>');
    const ctx = renderRetrievedContext(chain);
    // Tag names stay structural XML; values are escaped.
    expect(ctx).toContain('<note path="p&lt;1&gt;"');
    expect(ctx).toContain('<title>T&lt;a&gt;</title>');
  });
});
