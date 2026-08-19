/**
 * Obsidian-style shared memory vault — pure logic plus a filesystem-backed
 * engine. This module is the behaviour-tested core ported from
 * `packages/agent-core/src/session/nori-providers.ts` (SimpleMemoryProvider)
 * and `src/tools/builtin/nori/memory-chain.ts`.
 */

import type { DshFs, DshFsDirEntry, DshFsTarget } from './types.dsh.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type NoteType = 'analysis' | 'decision' | 'task' | 'review';

export interface VaultNote {
  /** Absolute path under the vault root. */
  path: string;
  /** Vault-relative path without the `.md` extension. */
  rel: string;
  title: string;
  type?: string;
  tags: string[];
  /** Normalized `[[target]]` link targets found anywhere in the note. */
  links: string[];
  /** Full raw markdown including frontmatter. */
  content: string;
}

export interface VaultResult {
  title: string;
  path: string;
  score: number;
  excerpt?: string;
  content?: string;
}

export interface ChainQueryInput {
  keywords: string[];
  note_types?: string[];
  top_k?: number;
  include_linked?: boolean;
  link_depth?: number;
  chain_depth?: number;
  follow_up_keywords?: string[][];
}

export interface ChainQuery {
  keywords: string[];
  note_types?: string[];
  top_k: number;
  include_linked: boolean;
  link_depth: number;
  chain_depth: number;
  follow_up_keywords?: string[][];
}

export interface ChainHop {
  index: number;
  source: 'initial' | 'model' | 'derived';
  keywords: string[];
  results: VaultResult[];
}

export interface ChainResult {
  query: ChainQuery;
  hops: ChainHop[];
  uniqueResults: VaultResult[];
}

export interface WriteNoteParams {
  note_type: NoteType | string;
  title: string;
  content: string;
  tags?: string[];
  links: string[];
}

export interface WriteResult {
  phase: 1 | 2;
  output: string;
  path?: string;
  isError?: boolean;
}

export interface RemoveResult {
  ok: boolean;
  path?: string;
  error?: string;
}

export const MEMORY_NOTE_DIRS = ['analysis', 'decision', 'task', 'review', '.trash'] as const;

const MAX_KEYWORDS = 16;
const MAX_CHAIN_DEPTH = 3;
const REMOVED_MARKER = '<!-- nori-removed';

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'agent', 'before', 'code', 'context', 'file', 'files',
  'from', 'function', 'implementation', 'memory', 'model', 'note', 'notes', 'result',
  'results', 'search', 'should', 'system', 'task', 'tasks', 'that', 'this', 'tool',
  'tools', 'with',
]);

/* ------------------------------------------------------------------ */
/*  Pure functions (unit-tested)                                       */
/* ------------------------------------------------------------------ */

export function parseFrontmatter(raw: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  if (!raw.startsWith('---')) return out;
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return out;
  const block = raw.slice(3, end);
  let listKey: string | null = null;
  for (const line of block.split('\n')) {
    const m = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (m) {
      const key = m[1] ?? '';
      let value = (m[2] ?? '').trim();
      value = value.replace(/^['"](.*)['"]$/, '$1');
      if (value === '') {
        listKey = key;
        out[key] = [];
        continue;
      }
      listKey = null;
      out[key] = value;
      continue;
    }
    const li = line.match(/^\s*-\s+(.+)$/);
    if (li && listKey !== null) {
      const v = (li[1] ?? '').trim().replace(/^['"](.*)['"]$/, '$1');
      const arr = out[listKey];
      if (!Array.isArray(arr)) out[listKey] = [];
      (out[listKey] as string[]).push(v);
    }
  }
  return out;
}

export function extractWikiLinks(text: string): string[] {
  const links: string[] = [];
  for (const m of text.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const inner = (m[1] ?? '').split('|')[0]!.trim();
    if (inner.length > 0 && !links.includes(inner)) links.push(inner);
  }
  return links;
}

export function extractKeywords(text: string, limit = 8): string[] {
  const candidates: string[] = [];
  for (const m of String(text).matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
    const linked = (m[1] ?? '').trim();
    if (linked.length > 0) candidates.push(linked);
  }
  for (const m of String(text).matchAll(/[\p{L}_][\p{L}\p{N}_./:-]{2,}/gu)) {
    const token = (m[0] ?? '').trim();
    if (token.length >= 3 && !/^\d+$/.test(token) && !STOP_WORDS.has(token.toLowerCase())) {
      candidates.push(token);
    }
  }
  const counts = new Map<string, { value: string; count: number }>();
  for (const c of candidates) {
    const k = c.toLowerCase();
    const cur = counts.get(k);
    if (cur === undefined) counts.set(k, { value: c, count: 1 });
    else cur.count += 1;
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .map((e) => e.value)
    .slice(0, limit);
}

export function scoreNotes(keywords: string[], notes: VaultNote[], linkDepth: number): { note: VaultNote; score: number }[] {
  const idx = new Map<string, number>();
  notes.forEach((n, i) => idx.set(n.rel.toLowerCase(), i));
  const seeds = new Map<number, number>();
  notes.forEach((n, i) => {
    const title = n.title.toLowerCase();
    const body = n.content.toLowerCase();
    let s = 0;
    for (const kw of keywords) {
      const k = String(kw).toLowerCase();
      if (k.length === 0) continue;
      s += (title.split(k).length - 1) * 3 + (body.split(k).length - 1);
    }
    if (s > 0) seeds.set(i, s);
  });
  if (linkDepth < 1 || seeds.size === 0) {
    return notes
      .map((n, i) => ({ note: n, score: seeds.get(i) || 0 }))
      .filter((e) => e.score > 0);
  }
  const scores = new Map(seeds);
  for (const [seedIndex, seedScore] of seeds) {
    const visited = new Set<number>([seedIndex]);
    const queue: { index: number; depth: number }[] = [{ index: seedIndex, depth: 0 }];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const current = queue[cursor];
      if (current === undefined || current.depth >= linkDepth) continue;
      const note = notes[current.index]!;
      for (const link of note.links) {
        const target = idx.get(link.toLowerCase());
        if (target === undefined || visited.has(target)) continue;
        visited.add(target);
        queue.push({ index: target, depth: current.depth + 1 });
        scores.set(target, Math.max(scores.get(target) || 0, seedScore * Math.pow(0.5, current.depth + 1)));
      }
    }
  }
  return notes
    .map((n, i) => ({ note: n, score: scores.get(i) || 0 }))
    .filter((e) => e.score > 0);
}

export function excerptOf(content: string, limit = 700): string {
  const flat = String(content)
    .replace(/^---[\s\S]*?\n---\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit - 3)}...`;
}

export function slugify(title: string): string {
  return String(title)
    .replaceAll(/[<>:"/\\|?*]/g, '-')
    .replaceAll(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 80);
}

export function buildFrontmatter(title: string, noteType: string, dateStr: string, tags: string[] | undefined, related: string[]): string {
  const lines = ['---', `title: ${JSON.stringify(title)}`, `type: ${String(noteType)}`, `date: ${dateStr}`];
  if (Array.isArray(tags) && tags.length > 0) {
    lines.push('tags:');
    for (const tag of tags) lines.push(`  - ${JSON.stringify(tag)}`);
  }
  if (related.length > 0) {
    lines.push('related:');
    for (const link of related) lines.push(`  - ${JSON.stringify(link)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

export function escapeXml(text: unknown): string {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function truncate1200(text: string): string {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length <= 1200 ? flat : `${flat.slice(0, 1197)}...`;
}

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function renderChainResult(result: ChainResult): string {
  if (result.uniqueResults.length === 0) return 'No matching notes found in Obsidian vault.';
  const lines = [
    `Found ${result.uniqueResults.length} unique note(s) across ${result.hops.length} retrieval hop(s).`,
    'You may call nori_memory_search again with new keywords if this context is incomplete.',
  ];
  for (const hop of result.hops) {
    lines.push('', `## Hop ${hop.index} (${hop.source})`, `Keywords: ${hop.keywords.join(', ')}`);
    if (hop.results.length === 0) {
      lines.push('No matches.');
      continue;
    }
    for (const note of hop.results) {
      lines.push(`- **${note.title}** (${note.path}) [score: ${note.score}]`);
      const body = note.excerpt || '';
      if (body.length > 0) lines.push(`  ${body}`);
    }
  }
  return lines.join('\n');
}

export function renderRetrievedContext(result: ChainResult): string {
  const lines = [
    `<retrieved_context unique_count="${result.uniqueResults.length}" hops="${result.hops.length}">`,
    '<instruction>Use this shared memory as prior context. You may call nori_memory_search again with new keywords if needed.</instruction>',
  ];
  const rendered = new Set<string>();
  for (const hop of result.hops) {
    lines.push(`<memory_hop index="${hop.index}" source="${hop.source}" keywords="${escapeXml(hop.keywords.join(', '))}">`);
    for (const note of hop.results) {
      if (rendered.has(note.path)) continue;
      rendered.add(note.path);
      lines.push(`<note path="${escapeXml(note.path)}" score="${note.score}">`);
      lines.push(`<title>${escapeXml(note.title)}</title>`);
      lines.push(`<content>${escapeXml(truncate1200(note.excerpt || note.content || ''))}</content>`);
      lines.push('</note>');
    }
    lines.push('</memory_hop>');
  }
  lines.push('</retrieved_context>');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/*  Vault engine                                                       */
/* ------------------------------------------------------------------ */

export class NoriVault {
  readonly vaultPath: string;

  constructor(
    private readonly fs: DshFs,
    private readonly root: string,
    relativeVault = 'nori-vault',
    private readonly topK = 10,
    private readonly maxChainDepth = 3,
  ) {
    this.vaultPath = this.join(this.root, relativeVault);
  }

  private join(a: string, b: string): string {
    return `${String(a).replace(/[\\/]+$/, '')}/${String(b).replace(/^[\\/]+/, '')}`;
  }

  private async resolveTarget(path: string): Promise<DshFsTarget | undefined> {
    try {
      return await this.fs.resolve(path, { cwd: this.root });
    } catch {
      return undefined;
    }
  }

  private async readTextSafe(path: string): Promise<string | undefined> {
    const t = await this.resolveTarget(path);
    if (t === undefined) return undefined;
    try {
      return await this.fs.readText(t);
    } catch {
      return undefined;
    }
  }

  private async writeTextSafe(path: string, content: string): Promise<{ ok: boolean; error?: string }> {
    const t = await this.resolveTarget(path);
    if (t === undefined) return { ok: false, error: `resolve failed: ${path}` };
    try {
      await this.fs.writeText(t, content);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async scan(): Promise<VaultNote[]> {
    const notes: VaultNote[] = [];
    const walkDir = async (dirPath: string): Promise<void> => {
      const t = await this.resolveTarget(dirPath);
      if (t === undefined) return;
      let entries: DshFsDirEntry[] = [];
      try {
        entries = await this.fs.listDir(t);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === '.trash') continue;
        const childPath = this.join(dirPath, entry.name);
        if (entry.type === 'directory') {
          await walkDir(childPath);
          continue;
        }
        if (entry.type !== 'file' || !String(entry.name).toLowerCase().endsWith('.md')) continue;
        const raw = await this.readTextSafe(childPath);
        if (raw === undefined) continue;
        if (raw.startsWith(REMOVED_MARKER)) continue;
        const parsed = this.parseNote(childPath, raw);
        if (parsed !== undefined) notes.push(parsed);
      }
    };
    await walkDir(this.vaultPath);
    return notes;
  }

  private parseNote(path: string, raw: string): VaultNote | undefined {
    const fm = parseFrontmatter(raw);
    const title = fm['title'];
    if (typeof title !== 'string' || title.trim().length === 0) return undefined;
    const rel = path.slice(this.vaultPath.length + 1).replace(/\.md$/i, '');
    return {
      path,
      rel,
      title,
      type: typeof fm['type'] === 'string' ? fm['type'] : undefined,
      tags: Array.isArray(fm['tags']) ? (fm['tags'] as string[]) : [],
      links: extractWikiLinks(raw),
      content: raw,
    };
  }

  async multiRetrieve(keywords: string[], options?: { top_k?: number; type_filter?: string[]; link_depth?: number }): Promise<VaultResult[]> {
    const topK = clampInt(options?.top_k, this.topK, 1, 20);
    const linkDepth = clampInt(options?.link_depth, 0, 0, 2);
    const all = await this.scan();
    const filtered =
      options?.type_filter && options.type_filter.length > 0
        ? all.filter((n) => options.type_filter!.includes(n.type ?? '') || options.type_filter!.includes(`${n.type ?? ''}s`))
        : all;
    return scoreNotes(keywords, filtered, linkDepth)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((e) => ({
        title: e.note.title,
        path: e.note.rel,
        score: Math.round(e.score * 100) / 100,
        excerpt: excerptOf(e.note.content),
        content: e.note.content,
      }));
  }

  async retrieveChain(input: ChainQueryInput): Promise<ChainResult> {
    const query: ChainQuery = {
      keywords: Array.isArray(input.keywords) ? input.keywords.map(String).slice(0, MAX_KEYWORDS) : [],
      note_types: Array.isArray(input.note_types) ? input.note_types : undefined,
      top_k: clampInt(input.top_k, this.topK, 1, 20),
      include_linked: input.include_linked === true,
      link_depth: clampInt(input.link_depth, 0, 0, 2),
      chain_depth: clampInt(input.chain_depth, 0, 0, Math.min(MAX_CHAIN_DEPTH, this.maxChainDepth)),
      follow_up_keywords: Array.isArray(input.follow_up_keywords) ? input.follow_up_keywords : undefined,
    };
    if (query.keywords.length === 0) throw new Error('nori_memory_search requires at least 1 keyword');
    const hops: ChainHop[] = [];
    const seen = new Set<string>();
    const runHop = async (index: number, source: ChainHop['source'], rawKeywords: unknown[]): Promise<ChainHop | undefined> => {
      const kws: string[] = [];
      for (const k of rawKeywords) {
        const t = String(k).trim();
        if (t.length > 0 && !seen.has(t.toLowerCase())) {
          seen.add(t.toLowerCase());
          kws.push(t);
        }
      }
      if (kws.length === 0) return undefined;
      const results = await this.multiRetrieve(kws, {
        top_k: query.top_k,
        type_filter: query.note_types,
        link_depth: query.include_linked ? query.link_depth || 1 : 0,
      });
      return { index, source, keywords: kws, results };
    };
    const first = await runHop(0, 'initial', query.keywords);
    if (first !== undefined) hops.push(first);
    const extra = Math.min(MAX_CHAIN_DEPTH, Math.max(query.chain_depth, query.follow_up_keywords?.length ?? 0));
    for (let hopIndex = 1; hopIndex <= extra; hopIndex++) {
      const modelKws = query.follow_up_keywords?.[hopIndex - 1];
      let kws: unknown[];
      let source: ChainHop['source'] = 'model';
      if (modelKws === undefined) {
        source = 'derived';
        const text = hops.flatMap((h) => h.results).map((x) => `${x.title} ${x.excerpt || ''}`).join(' ');
        kws = extractKeywords(text, 8).filter((k) => !seen.has(k.toLowerCase()));
      } else {
        kws = modelKws;
      }
      const hop = await runHop(hopIndex, source, kws);
      if (hop === undefined) break;
      hops.push(hop);
      if (hop.results.length === 0 && source === 'derived') break;
    }
    const byPath = new Map<string, VaultResult>();
    for (const x of hops.flatMap((h) => h.results)) {
      const prev = byPath.get(x.path);
      if (prev === undefined || x.score > prev.score) byPath.set(x.path, x);
    }
    const unique = [...byPath.values()].sort((a, b) => b.score - a.score);
    return { query, hops, uniqueResults: unique };
  }

  async writeNote(params: WriteNoteParams): Promise<WriteResult> {
    const dirPath = this.join(this.vaultPath, String(params.note_type));
    const dateStr = new Date().toISOString().split('T')[0] ?? '';
    const fileName = `${dateStr}-${slugify(params.title)}.md`;
    const filePath = this.join(dirPath, fileName);
    const links = Array.isArray(params.links) ? params.links : [];
    const isExplicitNone = links.length === 1 && links[0] === 'None';
    if (!isExplicitNone && links.length === 0) {
      const keywords = Array.isArray(params.tags) && params.tags.length > 0 ? params.tags : [String(params.title)];
      const results = await this.multiRetrieve(keywords, { top_k: 5 });
      const titles = results.map((r) => r.title);
      return {
        phase: 1,
        output: [
          'No links provided. Search the vault first, then retry with the correct note titles in the links parameter.',
          '',
          `Suggested search: pass links: [${titles.slice(0, 5).map((t) => `"${t}"`).join(', ')}]`,
          '',
          'Recent matching notes:',
          ...titles.map((t) => `  - ${t}`),
        ].join('\n'),
      };
    }
    const related = isExplicitNone ? [] : await this.resolveRelatedLinks(links);
    const fm = buildFrontmatter(params.title, params.note_type, dateStr, params.tags, related);
    const relatedSection = related.length > 0 ? `\n\n## Related\n${related.map((l) => `- ${l}`).join('\n')}` : '';
    const fullContent = `${fm}\n\n${String(params.content).trimEnd()}${relatedSection}\n`;
    const res = await this.writeTextSafe(filePath, fullContent);
    if (!res.ok) return { phase: 2, output: `Memory write failed: ${res.error}`, isError: true };
    return {
      phase: 2,
      output: `Note written: ${filePath.slice(this.vaultPath.length + 1).replaceAll('\\', '/')}`,
      path: filePath,
    };
  }

  private async resolveRelatedLinks(links: string[]): Promise<string[]> {
    const all = await this.scan();
    const byTitle = new Map<string, VaultNote>();
    for (const n of all) {
      const key = n.title.toLowerCase().replaceAll(/\s+/g, ' ').trim();
      if (!byTitle.has(key)) byTitle.set(key, n);
    }
    const result: string[] = [];
    for (const raw of links) {
      const t = String(raw).trim();
      if (t.length === 0) continue;
      const found = byTitle.get(t.toLowerCase().replaceAll(/\s+/g, ' ').trim());
      if (found !== undefined) {
        result.push(`[[${found.rel}|${found.title}]]`);
      } else {
        result.push(`[[unresolved/${t.replaceAll(/[<>:"\\|?*]/g, '-').replaceAll(/\s+/g, '-')}|${t}]]`);
      }
    }
    return result;
  }

  async removeNote(title: string): Promise<RemoveResult> {
    const target = String(title).trim();
    if (target.length === 0) return { ok: false, error: 'title required' };
    const all = await this.scan();
    const found = all.find((n) => n.title === target);
    if (found === undefined) return { ok: false, error: `Note "${target}" not found` };
    const base = found.path.slice(found.path.lastIndexOf('/') + 1);
    let trashPath = this.join(this.join(this.vaultPath, '.trash'), base);
    const existing = await this.readTextSafe(trashPath);
    if (existing !== undefined) {
      trashPath = this.join(this.join(this.vaultPath, '.trash'), `${base.replace(/\.md$/i, '')}-2.md`);
    }
    const moved = await this.writeTextSafe(trashPath, found.content);
    if (!moved.ok) return { ok: false, error: `trash copy failed: ${moved.error}` };
    const tomb = await this.writeTextSafe(found.path, `${REMOVED_MARKER}: ${target} -->\n`);
    if (!tomb.ok) return { ok: false, error: `tombstone failed: ${tomb.error}` };
    return { ok: true, path: found.rel };
  }

  async preRetrieve(prompt: string): Promise<{ rendered?: string; count: number; keywords?: string[] }> {
    const keywords = extractKeywords(prompt, 8);
    if (keywords.length === 0) return { count: 0 };
    const result = await this.retrieveChain({
      keywords,
      note_types: ['analysis', 'decision', 'review', 'task'],
      include_linked: true,
      link_depth: 1,
      chain_depth: 1,
    });
    if (result.uniqueResults.length === 0) return { rendered: undefined, count: 0 };
    return { rendered: renderRetrievedContext(result), count: result.uniqueResults.length, keywords };
  }
}
