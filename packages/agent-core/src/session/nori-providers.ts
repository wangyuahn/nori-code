import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, renameSync } from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { relative } from 'pathe';
import { load as loadYaml } from 'js-yaml';
import type { KimiConfig, MemoryConfig } from '../config';
import type { NoriMemoryProvider, NoriSwarmProvider } from '../tools/builtin/nori/types';
import type { Agent } from '../agent';
import type { QueuedSubagentTask, SubagentResult } from './subagent-batch';

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

interface SwarmCheckDef {
  id: string;
  agent_type: string;
  depends_on: string[];
  on_failure: string;
}

interface SwarmState {
  status: 'running' | 'completed' | 'failed';
  taskCount: number;
  task_results: Record<string, { status: string; output?: { analysis_summary?: string } }>;
}

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
      }))
      .filter((note) => note.score > 0)
      .toSorted((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  protected scoreNotes(keywords: string[], options?: MemoryRetrieveOptions): MemoryNoteInfo[] {
    const allNotes = this.collectNotes(keywords, options?.type_filter);
    const linkDepth = options?.link_depth ?? 0;
    const titleToIndex = new Map<string, number>();
    for (let i = 0; i < allNotes.length; i++) {
      const note = allNotes[i];
      if (note !== undefined) titleToIndex.set(note.title, i);
    }

    const adjacency = new Map<number, number[]>();
    for (let i = 0; i < allNotes.length; i++) {
      const note = allNotes[i];
      if (note === undefined) continue;
      adjacency.set(
        i,
        note.links.flatMap((linkTitle) => {
          const target = titleToIndex.get(linkTitle);
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
          const { title, body } = this.parseFrontmatter(raw);
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
    const dateStr = new Date().toISOString().split('T')[0];
    const safeName = params.title
      .replaceAll(/[<>:"/\\|?*]/g, '-').replaceAll(/\s+/g, '-').toLowerCase().slice(0, 80);
    const fileName = dateStr + '-' + safeName + '.md';
    const fp = path.join(dir, fileName);

    const tagsYaml = params.tags?.length ? '\ntags: [' + params.tags.join(', ') + ']' : '';
    const linksYaml = params.links?.length ? '\nlinks: [' + params.links.join(', ') + ']' : '';
    const fm = [
      '---', 'title: "' + params.title + '"', 'type: ' + params.note_type,
      'date: ' + dateStr,
      ...(tagsYaml ? [tagsYaml.trim()] : []),
      ...(linksYaml ? [linksYaml.trim()] : []),
      '---',
    ].filter(l => l.length > 0).join('\n');

    writeFileSync(fp, fm + '\n\n' + params.content, 'utf-8');
    return { path: relative(this.vaultPath, fp).replaceAll('\\', '/') };
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

  protected parseFrontmatter(content: string): { title: string; frontmatter: string; body: string } {
    const normalized = content.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');
    const m = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!m) return { title: 'Untitled', frontmatter: '', body: normalized };
    const frontmatter = m[1] ?? '';
    const body = m[2] ?? '';
    const tm = frontmatter.match(/^title:\s*['"]?(.+?)['"]?\s*$/m);
    return { title: tm?.[1] ?? 'Untitled', frontmatter, body };
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
        };
      })
      .filter((note) => note.score > 0)
      .toSorted((a, b) => b.score - a.score)
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

const MEMORY_NOTE_DIRS = [
  'analysis',
  'decision',
  'decisions',
  'task',
  'tasks',
  'review',
  'reviews',
] as const;

function noteTypeDirs(noteType: string): string[] {
  switch (noteType) {
    case 'analysis':
      return ['analysis'];
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

/* ------------------------------------------------------------------ */
/*  Concurrent Swarm Provider (SubagentBatch-based)                    */
/* ------------------------------------------------------------------ */

class SimpleSwarmProvider implements NoriSwarmProvider {
  private agent?: Agent;
  private noriConfig?: Record<string, unknown>;
  private readonly activeSwarms = new Map<string, SwarmState>();

  wireToAgent(agent: Agent): void { this.agent = agent; }
  setNoriConfig(config: Record<string, unknown>): void { this.noriConfig = config; }

  private host() {
    if (!this.agent) throw new Error('SwarmProvider not wired to agent');
    return this.agent.subagentHost;
  }

  async launchDag(
    templateName: string,
    params: Record<string, unknown>,
    _depth: number,
  ): Promise<{ swarm_id: string }> {
    const h = this.host();
    if (!h) throw new Error('No subagent host available');

    const swarmId = 'swarm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

    // Build tasks from nori.yaml swarm.checks or fallback templates
    const checkDefs = this.resolveCheckDefs(templateName, params);
    const tasks: QueuedSubagentTask<string>[] = checkDefs.map((check, idx) => ({
      kind: 'spawn' as const,
      data: check.id,
      profileName: this.mapAgentType(check.agent_type),
      parentToolCallId: 'nori-swarm-launch',
      prompt: this.buildCheckPrompt(check, params),
      description: 'swarm:' + check.id,
      swarmIndex: idx,
      swarmItem: check.id,
      runInBackground: true,
    }));

    // Fire-and-forget: launch all tasks concurrently via SubagentBatch
    this.activeSwarms.set(swarmId, {
      status: 'running',
      taskCount: tasks.length,
      task_results: {},
    });

    this.executeSwarm(swarmId, tasks).catch(() => {
      const existing = this.activeSwarms.get(swarmId);
      if (existing) existing.status = 'failed';
    });

    return { swarm_id: swarmId };
  }

  private async executeSwarm(swarmId: string, tasks: QueuedSubagentTask<string>[]): Promise<void> {
    const h = this.host();
    if (!h) return;

    const results: Array<SubagentResult<string>> = await h.runQueued(tasks);
    const taskResults: Record<string, { status: string; output?: { analysis_summary?: string } }> = {};

    for (const r of results) {
      taskResults[r.task.data] = {
        status: r.status,
        output: r.result ? { analysis_summary: r.result } : undefined,
      };
    }

    const allSucceeded = results.every(r => r.status === 'completed');
    this.activeSwarms.set(swarmId, {
      status: allSucceeded ? 'completed' : 'failed',
      taskCount: results.length,
      task_results: taskResults,
    });
  }

  async getStatus(swarmId: string): Promise<{ status: string; results?: Record<string, unknown> }> {
    const s = this.activeSwarms.get(swarmId);
    if (!s) return { status: 'not_found' };
    return { status: s.status, results: s.task_results as Record<string, unknown> };
  }

  async getResult(swarmId: string): Promise<{
    status: string;
    task_results: Record<string, { status: string; output?: { analysis_summary?: string } }>;
  }> {
    const s = this.activeSwarms.get(swarmId);
    if (!s) return { status: 'not_found', task_results: {} };
    return { status: s.status, task_results: s.task_results };
  }

  /* ------------------------------------------------------------------ */
  /*  Task building                                                       */
  /* ------------------------------------------------------------------ */

  /** Resolve which checks to run based on template name. */
  private resolveCheckDefs(templateName: string, params: Record<string, unknown>): SwarmCheckDef[] {
    const checks = this.getConfiguredChecks();

    // If template_name is 'all' or empty, run all checks
    if (!templateName || templateName === 'all' || templateName === 'default') {
      if (checks.length > 0) return checks;
      // Fallback: default coding + testing checks
      return this.defaultChecks(params);
    }

    // Specific template: filter checks by id
    const matching = checks.filter(c => c.id === templateName);
    if (matching.length > 0) return matching;

    // Template not in checks: create a single coder task
    return [{
      id: templateName,
      agent_type: (params['agent_type'] as string | undefined) ?? 'orchestrator',
      depends_on: [],
      on_failure: 'report',
    }];
  }

  /** Default checks when no nori.yaml swarm.checks are defined. */
  private defaultChecks(_params: Record<string, unknown>): SwarmCheckDef[] {
    return [
      {
        id: 'code_implementation',
        agent_type: 'orchestrator',
        depends_on: [],
        on_failure: 'block',
      },
      {
        id: 'unit_tests',
        agent_type: 'coder',
        depends_on: [],
        on_failure: 'warn',
      },
    ];
  }

  private getConfiguredChecks(): SwarmCheckDef[] {
    const swarm = this.noriConfig?.['swarm'] as Record<string, unknown> | undefined;
    const checks = swarm?.['checks'] as Array<Record<string, unknown>> | undefined;
    if (!checks) return [];
    return checks.map(c => ({
      id: c['id'] as string,
      agent_type: c['agent_type'] as string,
      depends_on: (c['depends_on'] as string[]) ?? [],
      on_failure: c['on_failure'] as string ?? 'report',
    }));
  }

  private mapAgentType(agentType: string): string {
    // coder: writes code (has Write/Edit/Bash, not tools_readonly)
    // nori-coder: read-only orchestrator (plans and delegates)
    // explore: read-only codebase explorer
    // plan: read-only planner
    switch (agentType) {
      case 'coder': return 'coder';
      case 'explore': return 'explore';
      case 'orchestrator':
      case 'nori-coder': return 'coder';  // legacy nori-coder remains compatible
      case 'plan': return 'plan';
      case 'test': case 'test_check': return 'coder';
      case 'review': case 'style_check': case 'security': return 'explore';
      default: return 'coder';
    }
  }

  private buildCheckPrompt(check: SwarmCheckDef, params: Record<string, unknown>): string {
    const context = (params['context'] as string | undefined) ?? '';
    const taskDesc = (params['description'] as string | undefined) ?? check.id;
    const filesChanged = (params['changed_files'] as string[] | undefined) ?? [];
    const isCoder = check.agent_type === 'coder' || check.agent_type === 'orchestrator' || check.agent_type === 'nori-coder';
    let prompt = '';

    if (isCoder) {
      prompt += [
        '# Swarm Task: ' + check.id,
        '',
        '## Role: Coder',
        '',
        'You are a coder sub-agent in a **parallel swarm**. The orchestrator has delegated this implementation task to you. Other swarm agents are working on related tasks concurrently.',
        '',
        '## Core Instructions',
        '',
        '1. **Search memory first.** Call `nori_memory_search` with keywords relevant to this task before writing any code. Check for past decisions, patterns, and related analyses.',
        '2. **Read the codebase.** Use Read/Grep/Glob to understand the relevant files and their context.',
        '3. **Implement the changes.** Use Write/Edit/Bash to make the actual code changes. Follow existing patterns and conventions in the codebase.',
        '4. **Verify your work.** Run relevant tests with Bash. Fix any failures before reporting completion.',
        '5. **Document findings.** Use `nori_memory_write` to record decisions, trade-offs, or patterns discovered during implementation.',
        '',
        '## Important',
        '',
        '- Make **minimal changes** to achieve the goal. No speculative refactors or cleanup.',
        '- Follow the **existing coding style** in the project.',
        '- You have Write/Edit/Bash access 鈥?actually make the changes, do not just describe them.',
        '- If you encounter ambiguity, resolve it yourself based on the codebase context.',
        '- Do NOT ask the end user questions. Report any ambiguity in your summary.',
      ].join('\n');
    } else {
      prompt += [
        '# Swarm Task: ' + check.id,
        '',
        '## Role: Reviewer',
        '',
        'You are a reviewer sub-agent in a **parallel swarm**. Your job is to inspect, verify, and report. Do NOT modify code.',
        '',
        '## Core Instructions',
        '',
        '1. **Search memory.** Call `nori_memory_search` for related decisions, past reviews, and known patterns.',
        '2. **Inspect the code.** Use Read/Grep/Glob to analyze the relevant files.',
        '3. **Evaluate quality.** Check for: correctness, adherence to project conventions, edge cases, test coverage, security concerns, performance issues.',
        '4. **Report findings.** Be specific about issues found. Include file paths and line references.',
        '5. **Document.** Use `nori_memory_write` to record your review findings.',
        '',
        '## Important',
        '',
        '- You are **read-only**. Do not modify any files.',
        '- If you find issues, describe them clearly for the orchestrator to handle.',
        '- If there are no issues, state that explicitly.',
      ].join('\n');
    }

    prompt += '\n\n---\n';
    prompt += '\n## Task Details\n\n';
    prompt += '**Task**: ' + taskDesc;

    if (filesChanged.length > 0) {
      prompt += '\n\n**Relevant files**:';
      for (const f of filesChanged) prompt += '\n- ' + f;
    }

    if (context) {
      prompt += '\n\n**Context from orchestrator**:\n> ' + context.replaceAll('\n', '\n> ');
    }

    prompt += '\n\n## Expected Output\n\n';
    prompt += 'At the end of your turn, provide a clear summary including:\n';
    if (isCoder) {
      prompt += '- What files were changed and why\n';
      prompt += '- Test results (pass/fail)\n';
      prompt += '- Any decisions or trade-offs made\n';
    } else {
      prompt += '- What was inspected\n';
      prompt += '- Issues found (with file:line references)\n';
      prompt += '- Recommendations\n';
    }
    prompt += '- Whether the task is complete or needs follow-up\n';

    return prompt;
  }
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
  swarm: SimpleSwarmProvider;
  maxSwarmDepth: number;
  coderWriteEnabled: boolean;
} | null {
  const obsidian = noriConfig?.['obsidian'] as Record<string, unknown> | undefined;
  const rawVaultPath = (obsidian?.['vault_path'] as string) ?? null;
  // Default vault: ~/.nori-code/vault/
  const defaultVault = path.join(homedir(), '.nori-code', 'vault');
  const vaultPath = resolveBaseDir && rawVaultPath
    ? path.resolve(resolveBaseDir, rawVaultPath)
    : rawVaultPath ?? defaultVault;

  const swarm = noriConfig?.['swarm'] as Record<string, unknown> | undefined;
  const maxSwarmDepth = (swarm?.['max_swarm_depth'] as number) ?? 3;

  const coderWriteEnabled = (swarm?.['coder_write_enabled'] as boolean) ?? false;
  const swarmProvider = new SimpleSwarmProvider();
  if (noriConfig !== null) swarmProvider.setNoriConfig(noriConfig);

  return {
    memory: kimiConfig.memory?.vectorEnabled
      ? new VectorMemoryProvider(vaultPath, kimiConfig.memory)
      : new SimpleMemoryProvider(vaultPath),
    swarm: swarmProvider,
    maxSwarmDepth,
    coderWriteEnabled,
  };
}




