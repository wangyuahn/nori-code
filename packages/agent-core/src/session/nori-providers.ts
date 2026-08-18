import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, renameSync } from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { relative } from 'pathe';
import { load as loadYaml } from 'js-yaml';
import type { KimiConfig, MemoryConfig } from '../config';
import {
  compareMemoryNotesByWrittenAtDesc,
  nowUtcIso,
  resolveMemoryNoteTimestamps,
  utcDateOnly,
} from '../tools/builtin/nori/memory-note-meta';
import type { NoriMemoryProvider } from '../tools/builtin/nori/types';

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

interface MemoryRetrieveOptions {
  top_k?: number;
  type_filter?: string[];
  weights?: { embedding: number; fulltext: number; graph: number };
  link_depth?: number;
}

interface MemoryNoteInfo {
  filePath: string;
  path: string;
  title: string;
  body: string;
  fulltextScore: number;
  graphScore: number;
  links: string[];
  mtimeMs: number;
  size: number;
  createdAt?: string;
  updatedAt?: string;
  date?: string;
}

/* ------------------------------------------------------------------ */
/*  Simple Memory Provider (filesystem-based, Obsidian-style vault)    */
/* ------------------------------------------------------------------ */

class SimpleMemoryProvider implements NoriMemoryProvider {
  constructor(protected readonly vaultPath: string) {
    mkdirSync(vaultPath, { recursive: true });
    for (const dir of MEMORY_NOTE_DIRS) {
      mkdirSync(path.join(vaultPath, dir), { recursive: true });
    }
  }

  async multiRetrieve(keywords: string[], options?: MemoryRetrieveOptions): Promise<Array<{ title: string; path: string; score?: number; excerpt?: string; content?: string }>> {
    const topK = options?.top_k ?? 10;
    const notes = this.scoreNotes(keywords, options);
    return notes
      .map((note) => ({
        title: note.title,
        path: note.path,
        score: note.fulltextScore > 0 ? note.fulltextScore : note.graphScore,
        excerpt: excerpt(note.body),
        content: note.body,
        created_at: note.createdAt,
        updated_at: note.updatedAt,
        date: note.date,
      }))
      .filter((note) => note.score > 0)
      .toSorted((a, b) => b.score - a.score || compareMemoryNotesByWrittenAtDesc(a, b))
      .slice(0, topK);
  }

  protected scoreNotes(keywords: string[], options?: MemoryRetrieveOptions): MemoryNoteInfo[] {
    const allNotes = this.collectNotes(keywords, options?.type_filter);
    const linkDepth = options?.link_depth ?? 0;
    const noteToIndex = new Map<string, number>();
    for (let i = 0; i < allNotes.length; i++) {
      const note = allNotes[i];
      if (note === undefined) continue;
      for (const key of memoryNoteKeys(note)) {
        if (!noteToIndex.has(key)) noteToIndex.set(key, i);
      }
    }

    const adjacency = new Map<number, number[]>();
    for (let i = 0; i < allNotes.length; i++) {
      const note = allNotes[i];
      if (note === undefined) continue;
      adjacency.set(
        i,
        note.links.flatMap((linkTitle) => {
          const target = noteToIndex.get(normalizeMemoryLink(linkTitle));
          return target === undefined ? [] : [target];
        }),
      );
    }

    const seedScores = new Map<number, number>();
    for (let i = 0; i < allNotes.length; i++) {
      const note = allNotes[i];
      if (note !== undefined && note.fulltextScore > 0) seedScores.set(i, note.fulltextScore);
    }

    if (linkDepth < 1 || seedScores.size === 0) return allNotes;

    const inLinks = new Map<number, number[]>();
    for (let i = 0; i < allNotes.length; i++) inLinks.set(i, []);
    for (const [source, targets] of adjacency) {
      for (const target of targets) inLinks.get(target)?.push(source);
    }

    for (const [seedIndex, seedScore] of seedScores) {
      const visited = new Set<number>([seedIndex]);
      const queue: Array<{ index: number; depth: number }> = [{ index: seedIndex, depth: 0 }];
      for (let cursor = 0; cursor < queue.length; cursor++) {
        const current = queue[cursor];
        if (current === undefined || current.depth >= linkDepth) continue;
        const neighbors = new Set([
          ...(adjacency.get(current.index) ?? []),
          ...(inLinks.get(current.index) ?? []),
        ]);
        for (const neighborIndex of neighbors) {
          if (visited.has(neighborIndex)) continue;
          visited.add(neighborIndex);
          const depth = current.depth + 1;
          queue.push({ index: neighborIndex, depth });
          const note = allNotes[neighborIndex];
          if (note !== undefined && !seedScores.has(neighborIndex)) {
            note.graphScore = Math.max(note.graphScore, seedScore * Math.pow(0.5, depth));
          }
        }
      }
    }

    return allNotes;
  }

  private collectNotes(keywords: string[], typeFilter?: string[]): MemoryNoteInfo[] {
    const dirs = typeFilter?.length
      ? unique(typeFilter.flatMap(noteTypeDirs)).map((dir) => path.join(this.vaultPath, dir))
      : [this.vaultPath];
    const allNotes: MemoryNoteInfo[] = [];
    const seenFiles = new Set<string>();

    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      try {
        for (const fp of this.markdownFiles(dir)) {
          if (seenFiles.has(fp)) continue;
          seenFiles.add(fp);
          const raw = readFileSync(fp, 'utf-8');
          const { title, body, fields } = this.parseFrontmatter(raw);
          const notePath = relative(this.vaultPath, fp).replaceAll('\\', '/');
          const wikiLinks: string[] = [];
          const linkRegex = /\[\[([^\]]+)\]\]/g;
          let match: RegExpExecArray | null;
          while ((match = linkRegex.exec(body)) !== null) {
            const linkTarget = (match[1] ?? '').split('|')[0]?.trim();
            if (linkTarget) wikiLinks.push(linkTarget);
          }

          const searchable = `${title}\n${notePath}\n${path.basename(fp)}\n${body}`;
          const lower = searchable.toLowerCase();
          let score = 0;
          for (const kw of keywords) {
            const needle = kw.trim().toLowerCase();
            if (needle.length === 0) continue;
            let idx = 0;
            while ((idx = lower.indexOf(needle, idx)) !== -1) { score++; idx++; }
          }

          const stat = lstatSync(fp);
          const timestamps = resolveMemoryNoteTimestamps(fields, {
            fileMtimeIso: new Date(stat.mtimeMs).toISOString(),
          });
          allNotes.push({
            filePath: fp,
            path: notePath,
            title,
            body,
            fulltextScore: score,
            graphScore: 0,
            links: wikiLinks,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            createdAt: timestamps.created_at,
            updatedAt: timestamps.updated_at,
            date: timestamps.date,
          });
        }
      } catch { /* skip inaccessible dirs */ }
    }
    return allNotes;
  }

  async writeNote(params: {
    note_type: string; title: string; content: string; links?: string[]; tags?: string[];
  }): Promise<{ path: string }> {
    const dir = path.join(this.vaultPath, params.note_type);
    mkdirSync(dir, { recursive: true });
    const writtenAt = nowUtcIso();
    const fileDate = utcDateOnly(writtenAt);
    const safeName = params.title
      .replaceAll(/[<>:"/\\|?*]/g, '-').replaceAll(/\s+/g, '-').toLowerCase().slice(0, 80);
    const fileName = fileDate + '-' + safeName + '.md';
    const fp = path.join(dir, fileName);
    let createdAt = writtenAt;
    if (existsSync(fp)) {
      try {
        const existing = this.parseFrontmatter(readFileSync(fp, 'utf-8'));
        createdAt = resolveMemoryNoteTimestamps(existing.fields).created_at ?? createdAt;
      } catch { /* keep new created_at when the existing file is unreadable */ }
    }
    const dateStr = utcDateOnly(createdAt);

    const related = this.resolveRelatedLinks(params.links);
    const fm = [
      '---', `title: ${JSON.stringify(params.title)}`, `type: ${params.note_type}`,
      'date: ' + dateStr,
      `created_at: ${JSON.stringify(createdAt)}`,
      `updated_at: ${JSON.stringify(writtenAt)}`,
      ...(params.tags?.length ? ['tags:', ...params.tags.map(tag => `  - ${JSON.stringify(tag)}`)] : []),
      ...(related.length > 0 ? ['related:', ...related.map(link => `  - ${JSON.stringify(link)}`)] : []),
      '---',
    ].filter(l => l.length > 0).join('\n');

    const relatedSection = related.length > 0
      ? `\n\n## Related\n${related.map(link => `- ${link}`).join('\n')}`
      : '';
    writeFileSync(fp, `${fm}\n\n${params.content.trimEnd()}${relatedSection}\n`, 'utf-8');
    return { path: relative(this.vaultPath, fp).replaceAll('\\', '/') };
  }

  private resolveRelatedLinks(links: string[] | undefined): string[] {
    if (!links?.length) return [];
    const targets = new Map<string, { target: string; title: string }>();
    for (const fp of this.markdownFiles(this.vaultPath).toSorted()) {
      try {
        const raw = readFileSync(fp, 'utf-8');
        const { title } = this.parseFrontmatter(raw);
        const notePath = relative(this.vaultPath, fp).replaceAll('\\', '/').replace(/\.md$/i, '');
        const candidate = { target: notePath, title };
        for (const key of [title, notePath, path.basename(notePath)]) {
          const normalized = normalizeMemoryLink(key);
          if (!targets.has(normalized)) targets.set(normalized, candidate);
        }
      } catch { /* skip unreadable notes */ }
    }

    const result = new Set<string>();
    for (const rawLink of links) {
      const parsed = parseObsidianLink(rawLink);
      const resolved = targets.get(normalizeMemoryLink(parsed.target));
      if (resolved !== undefined) {
        result.add(`[[${resolved.target}|${sanitizeObsidianAlias(parsed.alias || resolved.title)}]]`);
      } else if (parsed.target.includes('/')) {
        result.add(`[[${parsed.target.replace(/\.md$/i, '')}${parsed.alias ? `|${sanitizeObsidianAlias(parsed.alias)}` : ''}]]`);
      } else if (parsed.target) {
        const unresolved = parsed.target.replaceAll(/[<>:"\\|?*]/g, '-');
        result.add(`[[unresolved/${unresolved}|${sanitizeObsidianAlias(parsed.alias || parsed.target)}]]`);
      }
    }
    return [...result];
  }

  async removeNote(title: string): Promise<boolean> {
    const normalizedTitle = title.trim();
    if (normalizedTitle.length === 0) return false;
    const trashDir = path.join(this.vaultPath, '.trash');
    for (const fp of this.markdownFiles(this.vaultPath)) {
      try {
        const raw = readFileSync(fp, 'utf-8');
        const { title: noteTitle } = this.parseFrontmatter(raw);
        if (noteTitle === normalizedTitle) {
          try {
            mkdirSync(trashDir, { recursive: true });
            const dest = this.availableTrashPath(trashDir, path.basename(fp));
            renameSync(fp, dest);
          } catch {
            return false;
          }
          return true;
        }
      } catch { /* skip unreadable files */ }
    }
    return false;
  }

  private availableTrashPath(trashDir: string, fileName: string): string {
    const direct = path.join(trashDir, fileName);
    if (!existsSync(direct)) return direct;
    const extension = path.extname(fileName);
    const stem = path.basename(fileName, extension);
    let suffix = 2;
    while (existsSync(path.join(trashDir, `${stem}-${suffix}${extension}`))) suffix++;
    return path.join(trashDir, `${stem}-${suffix}${extension}`);
  }

  protected markdownFiles(dir: string): string[] {
    const files: string[] = [];
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) continue;
      try {
        for (const entry of readdirSync(current)) {
          const fp = path.join(current, entry);
          const stat = lstatSync(fp);
          if (stat.isDirectory()) {
            if (entry === '.trash') continue;
            stack.push(fp);
          } else if (stat.isFile() && entry.endsWith('.md')) {
            files.push(fp);
          }
        }
      } catch {
        // Skip inaccessible directories without failing the whole retrieval.
      }
    }
    return files;
  }

  protected parseFrontmatter(content: string): {
    title: string;
    frontmatter: string;
    body: string;
    fields: Record<string, unknown>;
  } {
    const normalized = content.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');
    const m = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!m) return { title: 'Untitled', frontmatter: '', body: normalized, fields: {} };
    const frontmatter = m[1] ?? '';
    const body = m[2] ?? '';
    const fields = parseYamlMapping(frontmatter);
    const tm = frontmatter.match(/^title:\s*['"]?(.+?)['"]?\s*$/m);
    const yamlTitle = typeof fields['title'] === 'string' ? fields['title'].trim() : '';
    return {
      title: yamlTitle || tm?.[1] || 'Untitled',
      frontmatter,
      body,
      fields,
    };
  }
}

interface CachedEmbedding {
  mtimeMs: number;
  size: number;
  vector: number[];
}

class VectorMemoryProvider extends SimpleMemoryProvider {
  private readonly cache = new Map<string, CachedEmbedding>();

  constructor(vaultPath: string, private readonly config: MemoryConfig) {
    super(vaultPath);
  }

  override async multiRetrieve(
    keywords: string[],
    options?: MemoryRetrieveOptions,
  ): Promise<Array<{ title: string; path: string; score?: number; excerpt?: string; content?: string }>> {
    const endpoint = this.embeddingEndpoint();
    const apiKey = requiredConfig(this.config.apiKey, 'api_key');
    const model = requiredConfig(this.config.model, 'model');
    const query = keywords.map((keyword) => keyword.trim()).filter(Boolean).join(' ');
    if (query.length === 0) return [];

    const notes = this.scoreNotes(keywords, options);
    if (notes.length === 0) return [];
    const queryVector = (await this.embed(endpoint, apiKey, model, [query]))[0];
    if (queryVector === undefined) throw new Error('Memory embedding response is missing query data');

    const noteVectors = new Map<string, number[]>();
    const missing: MemoryNoteInfo[] = [];
    for (const note of notes) {
      const cached = this.cache.get(note.filePath);
      if (cached?.mtimeMs === note.mtimeMs && cached.size === note.size) {
        noteVectors.set(note.filePath, cached.vector);
      } else {
        missing.push(note);
      }
    }

    for (let offset = 0; offset < missing.length; offset += 64) {
      const batch = missing.slice(offset, offset + 64);
      const vectors = await this.embed(
        endpoint,
        apiKey,
        model,
        batch.map((note) => `${note.title}\n${note.path}\n${note.body}`),
      );
      for (let index = 0; index < batch.length; index++) {
        const note = batch[index];
        const vector = vectors[index];
        if (note === undefined || vector === undefined) continue;
        if (vector.length !== queryVector.length) {
          throw new Error('Memory embedding response contains inconsistent dimensions');
        }
        this.cache.set(note.filePath, {
          mtimeMs: note.mtimeMs,
          size: note.size,
          vector,
        });
        noteVectors.set(note.filePath, vector);
      }
    }

    const weights = normalizeWeights(options?.weights);
    const maxFulltext = Math.max(0, ...notes.map((note) => note.fulltextScore));
    const maxGraph = Math.max(0, ...notes.map((note) => note.graphScore));
    return notes
      .map((note) => {
        const vector = noteVectors.get(note.filePath);
        const semantic = vector === undefined ? 0 : Math.max(0, cosineSimilarity(queryVector, vector));
        const fulltext = maxFulltext === 0 ? 0 : note.fulltextScore / maxFulltext;
        const graph = maxGraph === 0 ? 0 : note.graphScore / maxGraph;
        const score =
          weights.embedding * semantic +
          weights.fulltext * fulltext +
          weights.graph * graph;
        return {
          title: note.title,
          path: note.path,
          score,
          excerpt: excerpt(note.body),
          content: note.body,
          created_at: note.createdAt,
          updated_at: note.updatedAt,
          date: note.date,
        };
      })
      .filter((note) => note.score > 0)
      .toSorted((a, b) => b.score - a.score || compareMemoryNotesByWrittenAtDesc(a, b))
      .slice(0, options?.top_k ?? 10);
  }

  private embeddingEndpoint(): string {
    const providerType = requiredConfig(this.config.providerType as string | undefined, 'provider_type');
    if (providerType !== 'openai' && providerType !== 'openai_responses') {
      throw new Error(`Unsupported memory embedding provider type: ${providerType}`);
    }
    const baseUrl = requiredConfig(this.config.baseUrl, 'base_url');
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new Error('Memory embedding base_url must be a valid URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Memory embedding base_url must use HTTP or HTTPS');
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/embeddings`;
    url.search = '';
    url.hash = '';
    return url.toString();
  }

  private async embed(
    endpoint: string,
    apiKey: string,
    model: string,
    input: string[],
  ): Promise<number[][]> {
    const headers = new Headers(this.config.customHeaders);
    headers.set('authorization', `Bearer ${apiKey}`);
    headers.set('content-type', 'application/json');
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, input }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error('Memory embedding request failed');
    }
    if (!response.ok) {
      throw new Error(`Memory embedding request failed with HTTP ${String(response.status)}`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error('Memory embedding response is not valid JSON');
    }
    return parseEmbeddingResponse(payload, input.length);
  }
}

function excerpt(body: string): string {
  return body.length > 500 ? `${body.slice(0, 500)}...` : body;
}

function parseYamlMapping(frontmatter: string): Record<string, unknown> {
  if (frontmatter.trim().length === 0) return {};
  try {
    const parsed = loadYaml(frontmatter);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function requiredConfig<T>(value: T | undefined, name: string): T {
  if (typeof value === 'string' && value.trim().length === 0) {
    throw new Error(`Memory vector retrieval requires memory.${name}`);
  }
  if (value === undefined) throw new Error(`Memory vector retrieval requires memory.${name}`);
  return typeof value === 'string' ? value.trim() as T : value;
}

function normalizeWeights(
  weights: MemoryRetrieveOptions['weights'],
): { embedding: number; fulltext: number; graph: number } {
  const defaults = { embedding: 0.7, fulltext: 0.2, graph: 0.1 };
  if (weights === undefined) return defaults;
  const sanitized = {
    embedding: validWeight(weights.embedding),
    fulltext: validWeight(weights.fulltext),
    graph: validWeight(weights.graph),
  };
  const total = sanitized.embedding + sanitized.fulltext + sanitized.graph;
  if (total === 0) return defaults;
  return {
    embedding: sanitized.embedding / total,
    fulltext: sanitized.fulltext / total,
    graph: sanitized.graph / total,
  };
}

function validWeight(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index++) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

function parseEmbeddingResponse(payload: unknown, expectedCount: number): number[][] {
  if (typeof payload !== 'object' || payload === null || !Array.isArray((payload as { data?: unknown }).data)) {
    throw new Error('Memory embedding response must contain a data array');
  }
  const data = (payload as { data: unknown[] }).data;
  if (data.length !== expectedCount) {
    throw new Error('Memory embedding response count does not match the request');
  }
  const vectors: Array<number[] | undefined> = Array.from({ length: expectedCount });
  let dimensions: number | undefined;
  for (const item of data) {
    if (typeof item !== 'object' || item === null) {
      throw new Error('Memory embedding response contains an invalid item');
    }
    const { index, embedding } = item as { index?: unknown; embedding?: unknown };
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= expectedCount) {
      throw new Error('Memory embedding response contains an invalid index');
    }
    if (!Array.isArray(embedding) || embedding.length === 0 || !embedding.every(Number.isFinite)) {
      throw new Error('Memory embedding response contains an invalid vector');
    }
    if (dimensions !== undefined && dimensions !== embedding.length) {
      throw new Error('Memory embedding response contains inconsistent dimensions');
    }
    dimensions = embedding.length;
    if (vectors[index as number] !== undefined) {
      throw new Error('Memory embedding response contains a duplicate index');
    }
    vectors[index as number] = embedding as number[];
  }
  if (vectors.some((vector) => vector === undefined)) {
    throw new Error('Memory embedding response is missing an index');
  }
  return vectors as number[][];
}

const MEMORY_NOTE_DIRS = ['analysis', 'decision', 'task', 'review'] as const;

function noteTypeDirs(noteType: string): string[] {
  switch (noteType) {
    case 'analysis':
    case 'analyses':
      return ['analysis', 'analyses'];
    case 'decision':
    case 'decisions':
      return ['decision', 'decisions'];
    case 'task':
    case 'tasks':
      return ['task', 'tasks'];
    case 'review':
    case 'reviews':
      return ['review', 'reviews'];
    default:
      return [noteType];
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function parseObsidianLink(value: string): { target: string; alias: string } {
  const unwrapped = value.trim().replace(/^\[\[/, '').replace(/\]\]$/, '');
  const [rawTarget = '', rawAlias = ''] = unwrapped.split('|', 2);
  return {
    target: rawTarget.split('#', 1)[0]?.trim().replaceAll('\\', '/') ?? '',
    alias: rawAlias.trim(),
  };
}

function normalizeMemoryLink(value: string): string {
  return parseObsidianLink(value).target.replace(/\.md$/i, '').replace(/^\.\//, '').trim().toLowerCase();
}

function memoryNoteKeys(note: MemoryNoteInfo): string[] {
  const notePath = note.path.replace(/\.md$/i, '');
  return unique([
    normalizeMemoryLink(note.title),
    normalizeMemoryLink(notePath),
    normalizeMemoryLink(path.basename(notePath)),
  ]);
}

function sanitizeObsidianAlias(value: string): string {
  return value.replaceAll(/[|\]]/g, '').trim();
}


/* ------------------------------------------------------------------ */
/*  Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Try to load nori.yaml from the given cwd (walks upward).
 * Returns the parsed config object or null if not found.
 */
export function loadNoriYamlConfig(cwd: string): Record<string, unknown> | null {
  let dir = cwd;
  while (dir !== path.parse(dir).root) {
    const noriYaml = path.join(dir, 'nori.yaml');
    if (existsSync(noriYaml)) {
      try {
        const content = readFileSync(noriYaml, 'utf-8');
        return loadYaml(content) as Record<string, unknown>;
      } catch { return null; }
    }
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Create nori providers from a nori.yaml configuration object.
 * Returns null if nori.yaml is not present or has no vault_path configured.
 */
export function createNoriProvidersFromConfig(
  noriConfig: Record<string, unknown> | null,
  kimiConfig: KimiConfig,
  resolveBaseDir?: string,
): {
  memory: NoriMemoryProvider;
  coderWriteEnabled: boolean;
} | null {
  const obsidian = noriConfig?.['obsidian'] as Record<string, unknown> | undefined;
  const rawVaultPath = (obsidian?.['vault_path'] as string) ?? null;
  // Default vault: ~/.nori-code/vault/
  const defaultVault = path.join(homedir(), '.nori-code', 'vault');
  const vaultPath = resolveBaseDir && rawVaultPath
    ? path.resolve(resolveBaseDir, rawVaultPath)
    : rawVaultPath ?? defaultVault;

  const coderWriteEnabled = noriConfig?.['coder_write_enabled'] === true;

  return {
    memory: kimiConfig.memory?.vectorEnabled
      ? new VectorMemoryProvider(vaultPath, kimiConfig.memory)
      : new SimpleMemoryProvider(vaultPath),
    coderWriteEnabled,
  };
}




