/**
 * WebSearchTool - built-in web search.
 *
 * The tool is always available in Nori. The default provider uses Bing China
 * without credentials and falls back to DuckDuckGo when the first source is
 * unavailable. A host may still inject a provider for a private search API.
 */

import { DOMParser as RawDOMParser, parseHTML as rawParseHTML } from 'linkedom';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { literalRulePattern, matchesGlobRuleSubject } from '../../support/rule-match';
import { ToolResultBuilder } from '../../support/result-builder';
import DESCRIPTION from './web-search.md?raw';

// linkedom's DOM types pull in lib.dom, while agent-core intentionally does not
// compile with that library. Keep the small surface needed by the parsers here.
interface SearchNode {
  textContent: string | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): SearchNode | null;
}

interface SearchDocument extends SearchNode {
  querySelectorAll(selector: string): Iterable<SearchNode>;
}

const parseHtml = rawParseHTML as unknown as (html: string) => { document: SearchDocument };
const XmlParser = RawDOMParser as unknown as new () => {
  parseFromString(source: string, mimeType: string): SearchDocument;
};

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const BING_SEARCH_URL = 'https://cn.bing.com/search';
const DDG_SEARCH_URL = 'https://html.duckduckgo.com/html/';

// ── Provider interface ───────────────────────────────────────────────

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  date?: string;
  siteName?: string;
}

export interface WebSearchProvider {
  search(
    query: string,
    options?: { toolCallId?: string; signal?: AbortSignal },
  ): Promise<WebSearchResult[]>;
}

export interface PublicWebSearchProviderOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
}

/**
 * Credential-free public search provider used by Nori's default WebSearch.
 * Each source is attempted in order; empty results also move to the fallback.
 */
export class PublicWebSearchProvider implements WebSearchProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(options: PublicWebSearchProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  }

  async search(
    query: string,
    options?: { toolCallId?: string; signal?: AbortSignal },
  ): Promise<WebSearchResult[]> {
    const errors: string[] = [];
    const sources: Array<[string, (signal: AbortSignal) => Promise<WebSearchResult[]>]> = [
      ['Bing China', (signal) => this.searchBing(query, signal)],
      ['DuckDuckGo', (signal) => this.searchDuckDuckGo(query, signal)],
    ];

    for (const [name, searchSource] of sources) {
      if (options?.signal?.aborted) throw options.signal.reason ?? new Error('The operation was aborted');
      try {
        const results = await searchSource(options?.signal ?? new AbortController().signal);
        if (results.length > 0) return results;
        errors.push(`${name}: no results`);
      } catch (error) {
        if (isAbortError(error) || options?.signal?.aborted) throw error;
        errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (errors.length > 0) {
      throw new Error(`All public search providers failed. ${errors.join(' | ')}`);
    }
    return [];
  }

  private async searchBing(query: string, signal: AbortSignal): Promise<WebSearchResult[]> {
    const url = `${BING_SEARCH_URL}?format=rss&q=${encodeURIComponent(query)}&setlang=zh-hans`;
    const xml = await this.fetchText(url, signal);
    return parseBingRssResults(xml);
  }

  private async searchDuckDuckGo(query: string, signal: AbortSignal): Promise<WebSearchResult[]> {
    const url = `${DDG_SEARCH_URL}?q=${encodeURIComponent(query)}`;
    const html = await this.fetchText(url, signal);
    return parseDdgHtmlResults(html);
  }

  private async fetchText(url: string, externalSignal: AbortSignal): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(new Error(`Search timed out after ${String(this.timeoutMs)} ms`)),
      this.timeoutMs,
    );
    const forwardAbort = () => controller.abort(externalSignal.reason);
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener('abort', forwardAbort, { once: true });
    }

    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'User-Agent': this.userAgent,
          Accept: 'text/html, application/rss+xml, application/xml',
        },
      });
      if (!response.ok) throw new Error(`Search request failed with status ${String(response.status)}`);
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
        throw new Error(`Search response is too large: ${String(contentLength)} bytes`);
      }
      const body = await response.text();
      if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
        throw new Error(`Search response is too large: more than ${String(MAX_RESPONSE_BYTES)} bytes`);
      }
      return body;
    } finally {
      clearTimeout(timeoutId);
      externalSignal.removeEventListener('abort', forwardAbort);
    }
  }
}

const defaultWebSearchProvider = new PublicWebSearchProvider();

// ── Input schema ─────────────────────────────────────────────────────

export const WebSearchInputSchema = z.object({
  query: z.string().describe('The query text to search for.'),
});

export type WebSearchInput = z.Infer<typeof WebSearchInputSchema>;

// ── Tool ─────────────────────────────────────────────────────────────

export class WebSearchTool implements BuiltinTool<WebSearchInput> {
  readonly name = 'WebSearch' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(WebSearchInputSchema);
  constructor(private readonly provider: WebSearchProvider = defaultWebSearchProvider) {}

  resolveExecution(args: WebSearchInput): ToolExecution {
    const preview = args.query.length > 40 ? `${args.query.slice(0, 40)}…` : args.query;
    return {
      accesses: ToolAccesses.none(),
      description: `Searching: ${preview}`,
      display: { kind: 'search', query: args.query },
      approvalRule: literalRulePattern(this.name, args.query),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.query),
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: WebSearchInput,
    { toolCallId, signal }: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const results = await this.provider.search(args.query, { toolCallId, signal });
      const builder = new ToolResultBuilder({ maxLineLength: null });

      if (results.length === 0) {
        builder.write('No search results found.');
        return builder.ok();
      }

      let first = true;
      for (const result of results) {
        if (!first) builder.write('---\n\n');
        first = false;
        builder.write(`Title: ${result.title}\n`);
        if (result.siteName) builder.write(`Site: ${result.siteName}\n`);
        if (result.date) builder.write(`Date: ${result.date}\n`);
        builder.write(`URL: ${result.url}\n`);
        builder.write(`Snippet: ${result.snippet}\n\n`);
      }
      builder.write(
        'When you rely on a result in your answer, cite it inline as a markdown link, e.g. [title](url).',
      );
      return builder.ok();
    } catch (error) {
      return { isError: true, output: classifySearchError(error) };
    }
  }
}

function parseBingRssResults(xml: string): WebSearchResult[] {
  const document = new XmlParser().parseFromString(xml, 'text/xml');
  const results: WebSearchResult[] = [];
  for (const item of document.querySelectorAll('item')) {
    const title = textOf(item.querySelector('title'));
    const url = textOf(item.querySelector('link'));
    if (!title || !url) continue;
    const result: WebSearchResult = {
      title,
      url,
      snippet: textOf(item.querySelector('description')),
      siteName: siteNameFromUrl(url),
    };
    const date = textOf(item.querySelector('pubDate'));
    if (date) result.date = date;
    results.push(result);
    if (results.length >= 10) break;
  }
  return results;
}

function parseDdgHtmlResults(html: string): WebSearchResult[] {
  const { document } = parseHtml(html);
  const results: WebSearchResult[] = [];
  for (const block of document.querySelectorAll('.result')) {
    const link = block.querySelector('.result__a');
    const href = link?.getAttribute('href');
    const title = textOf(link);
    if (!href || !title) continue;
    const url = normalizeDdgUrl(href);
    if (!url) continue;
    results.push({
      title,
      url,
      snippet: textOf(block.querySelector('.result__snippet')),
      siteName: siteNameFromUrl(url),
    });
    if (results.length >= 10) break;
  }
  return results;
}

function normalizeDdgUrl(href: string): string {
  try {
    const parsed = new URL(href, DDG_SEARCH_URL);
    const target = parsed.searchParams.get('uddg');
    return target ?? parsed.href;
  } catch {
    return href;
  }
}

function siteNameFromUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || undefined;
  } catch {
    return undefined;
  }
}

function textOf(node: SearchNode | null): string {
  return (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message.toLowerCase().includes('abort'));
}

function classifySearchError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (name === 'AbortError' || lower.includes('abort')) return withSearchPrefix('Search cancelled', message);
  if (name === 'TimeoutError' || lower.includes('timed out') || lower.includes('timeout')) {
    return withSearchPrefix('Search timed out', message);
  }
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('authentication')) {
    return `Search failed (authentication): ${message}`;
  }
  if (lower.includes('http ') || lower.includes('network') || lower.includes('fetch') || name === 'TypeError') {
    return `Search failed (network): ${message}`;
  }
  return `Search failed: ${message}`;
}

function withSearchPrefix(prefix: string, message: string): string {
  return message.trimStart().toLowerCase().startsWith(prefix.toLowerCase())
    ? message
    : `${prefix}: ${message}`;
}
