import { z } from 'zod';

import type { NoriMemoryNote, NoriMemoryProvider } from './types';

const MAX_KEYWORDS = 16;
const MAX_CHAIN_DEPTH = 3;
const KeywordSchema = z.string().trim().min(1).max(120);

export const NoriNoteTypeSchema = z.enum([
  'analysis',
  'decision',
  'decisions',
  'task',
  'tasks',
  'review',
  'reviews',
]);

export const NoriMemoryChainQuerySchema = z
  .object({
    keywords: z
      .array(KeywordSchema)
      .min(1)
      .max(MAX_KEYWORDS)
      .describe('Concrete technical search terms, such as symbols, file names, errors, or concept labels.'),
    note_types: z
      .array(NoriNoteTypeSchema)
      .max(4)
      .optional()
      .describe('Optional note type filter: analysis, decision(s), task(s), review(s).'),
    top_k: z.number().int().min(1).max(20).optional().default(10),
    include_linked: z.boolean().optional().default(false),
    link_depth: z.number().int().min(0).max(2).optional().default(0),
    chain_depth: z
      .number()
      .int()
      .min(0)
      .max(MAX_CHAIN_DEPTH)
      .optional()
      .default(0)
      .describe('Extra retrieval hops after the initial keyword search. Use 1-2 for linked memory discovery.'),
    follow_up_keywords: z
      .array(z.array(KeywordSchema).min(1).max(MAX_KEYWORDS))
      .max(MAX_CHAIN_DEPTH)
      .optional()
      .describe('Optional model-supplied keyword sets for chained retrieval hops.'),
  })
  .strict();

export type NoriMemoryChainQueryInput = z.input<typeof NoriMemoryChainQuerySchema>;
export type NoriMemoryChainQuery = z.output<typeof NoriMemoryChainQuerySchema>;

export interface NoriMemoryChainHop {
  readonly index: number;
  readonly source: 'initial' | 'model' | 'derived';
  readonly keywords: readonly string[];
  readonly results: readonly NoriMemoryNote[];
}

export interface NoriMemoryChainResult {
  readonly query: NoriMemoryChainQuery;
  readonly hops: readonly NoriMemoryChainHop[];
  readonly uniqueResults: readonly NoriMemoryNote[];
}

export async function retrieveNoriMemoryChain(
  memory: NoriMemoryProvider,
  input: NoriMemoryChainQueryInput,
): Promise<NoriMemoryChainResult> {
  const query = NoriMemoryChainQuerySchema.parse(input);
  const hops: NoriMemoryChainHop[] = [];
  const seenKeywords = new Set<string>();

  const runHop = async (
    index: number,
    source: NoriMemoryChainHop['source'],
    rawKeywords: readonly string[],
  ): Promise<NoriMemoryChainHop | undefined> => {
    const keywords = normalizeKeywords(rawKeywords);
    const unseenKeywords = keywords.filter((keyword) => !seenKeywords.has(keyword.toLowerCase()));
    if (unseenKeywords.length === 0) return undefined;
    for (const keyword of unseenKeywords) seenKeywords.add(keyword.toLowerCase());
    const results = await memory.multiRetrieve(unseenKeywords, {
      top_k: query.top_k,
      type_filter: query.note_types,
      link_depth: query.include_linked ? (query.link_depth || 1) : 0,
    });
    return { index, source, keywords: unseenKeywords, results };
  };

  const firstHop = await runHop(0, 'initial', query.keywords);
  if (firstHop !== undefined) hops.push(firstHop);

  const requestedExtraHops = Math.min(
    MAX_CHAIN_DEPTH,
    Math.max(query.chain_depth, query.follow_up_keywords?.length ?? 0),
  );
  for (let hopIndex = 1; hopIndex <= requestedExtraHops; hopIndex += 1) {
    const modelKeywords = query.follow_up_keywords?.[hopIndex - 1];
    const keywords =
      modelKeywords !== undefined
        ? normalizeKeywords(modelKeywords)
        : deriveFollowUpKeywords(hops.flatMap((hop) => hop.results), seenKeywords);
    const hop = await runHop(hopIndex, modelKeywords === undefined ? 'derived' : 'model', keywords);
    if (hop === undefined) break;
    hops.push(hop);
    if (hop.results.length === 0 && modelKeywords === undefined) break;
  }

  return {
    query,
    hops,
    uniqueResults: uniqueNotes(hops.flatMap((hop) => hop.results)),
  };
}

export function formatNoriMemoryChainResult(result: NoriMemoryChainResult): string {
  if (result.uniqueResults.length === 0) {
    return 'No matching notes found in Obsidian vault.';
  }

  const lines = [
    `Found ${String(result.uniqueResults.length)} unique note(s) across ${String(result.hops.length)} retrieval hop(s).`,
    'You may call nori_memory_search again with new keywords if this context is incomplete.',
  ];

  for (const hop of result.hops) {
    lines.push('', `## Hop ${String(hop.index)} (${hop.source})`, `Keywords: ${hop.keywords.join(', ')}`);
    if (hop.results.length === 0) {
      lines.push('No matches.');
      continue;
    }
    for (const note of hop.results) {
      const score = note.score === undefined ? 'N/A' : note.score.toFixed(2);
      const body = truncateText(note.excerpt ?? note.content ?? '', 700);
      lines.push(`- **${note.title}** (${note.path}) [score: ${score}]`);
      if (body.length > 0) lines.push(`  ${body}`);
    }
  }

  return lines.join('\n');
}

export function extractNoriMemoryKeywords(text: string, limit = 8): string[] {
  const candidates = collectCandidateTerms(text);
  return scoreCandidates(candidates, new Set()).slice(0, limit);
}

function deriveFollowUpKeywords(
  notes: readonly NoriMemoryNote[],
  seenKeywords: ReadonlySet<string>,
): string[] {
  const text = notes
    .map((note) => `${note.title}\n${note.path}\n${note.excerpt ?? ''}\n${note.content ?? ''}`)
    .join('\n');
  return scoreCandidates(collectCandidateTerms(text), seenKeywords).slice(0, 8);
}

function normalizeKeywords(keywords: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const keyword of keywords) {
    const trimmed = keyword.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
    if (normalized.length >= MAX_KEYWORDS) break;
  }
  return normalized;
}

function uniqueNotes(notes: readonly NoriMemoryNote[]): NoriMemoryNote[] {
  const byPath = new Map<string, NoriMemoryNote>();
  for (const note of notes) {
    const previous = byPath.get(note.path);
    if (previous === undefined || (note.score ?? 0) > (previous.score ?? 0)) {
      byPath.set(note.path, note);
    }
  }
  return [...byPath.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

function collectCandidateTerms(text: string): string[] {
  const candidates: string[] = [];
  for (const match of text.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
    const linked = match[1]?.trim();
    if (linked !== undefined && linked.length > 0) candidates.push(linked);
  }
  for (const match of text.matchAll(/[\p{L}_][\p{L}\p{N}_./:-]{2,}/gu)) {
    const token = match[0].trim();
    if (isUsefulCandidate(token)) candidates.push(token);
  }
  return candidates;
}

function scoreCandidates(candidates: readonly string[], seenKeywords: ReadonlySet<string>): string[] {
  const counts = new Map<string, { readonly value: string; count: number }>();
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (seenKeywords.has(key) || STOP_WORDS.has(key)) continue;
    const current = counts.get(key);
    if (current === undefined) {
      counts.set(key, { value: candidate, count: 1 });
    } else {
      current.count += 1;
    }
  }
  return [...counts.values()]
    .toSorted((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .map((entry) => entry.value);
}

function isUsefulCandidate(value: string): boolean {
  const lower = value.toLowerCase();
  if (STOP_WORDS.has(lower)) return false;
  if (/^\d+$/.test(value)) return false;
  if (value.length < 3) return false;
  return true;
}

function truncateText(text: string, limit: number): string {
  const normalized = text.replaceAll(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
}

const STOP_WORDS = new Set([
  'about',
  'after',
  'again',
  'agent',
  'before',
  'code',
  'context',
  'file',
  'files',
  'from',
  'function',
  'implementation',
  'memory',
  'model',
  'note',
  'notes',
  'result',
  'results',
  'search',
  'should',
  'system',
  'task',
  'tasks',
  'that',
  'this',
  'tool',
  'tools',
  'with',
]);
