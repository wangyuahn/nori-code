/**
 * Covers: FetchURLTool.
 *
 * Uses a fake UrlFetcher to test tool behaviour in isolation.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  FetchURLInputSchema,
  FetchURLTool,
  HttpFetchError,
  type UrlFetcher,
} from '../../src/tools/builtin/web/fetch-url';
import { toolContentString } from './fixtures/fake-kaos';
import { executeTool } from './fixtures/execute-tool';
import { BrowserInputSchema, BrowserTool } from '../../src/tools/builtin/web/browser';
import type { BrowserExecutor } from '../../src/tools/support/services';

const signal = new AbortController().signal;

function fakeFetcher(
  content = '',
  kind: 'passthrough' | 'extracted' = 'extracted',
): UrlFetcher {
  return { fetch: vi.fn().mockResolvedValue({ content, kind }) };
}

describe('FetchURLTool', () => {
  it('has name "FetchURL" and a non-empty description', () => {
    const tool = new FetchURLTool(fakeFetcher());
    expect(tool.name).toBe('FetchURL');
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it('documents both fetch modes (extracted main text vs verbatim passthrough)', () => {
    const tool = new FetchURLTool(fakeFetcher());
    const description = tool.description.toLowerCase();
    expect(description).toContain('extracted');
    expect(description).toContain('verbatim');
    // SSRF/size are provider-internal (the local provider enforces both);
    // the description must state the universal http/https contract, not impl details.
    expect(description).toContain('http');
    expect(description).not.toContain('local fetcher');
    expect(description).not.toContain('10 mib');
  });

  it('parameters are generated from the current input schema', () => {
    const tool = new FetchURLTool(fakeFetcher());
    expect(FetchURLInputSchema.safeParse({ url: 'https://example.com' }).success).toBe(true);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        url: { type: 'string' },
      },
    });
  });

  it('does not expose a "format" parameter in its JSON Schema', () => {
    const tool = new FetchURLTool(fakeFetcher());
    const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties;
    expect(properties).toBeDefined();
    expect(properties).not.toHaveProperty('format');
  });

  it('returns fetched content from provider', async () => {
    const tool = new FetchURLTool(fakeFetcher('Hello, world!'));
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c1',
      args: { url: 'https://example.com' },
      signal,
    });
    expect(result.isError).toBe(false);
    // The body is present; the mode note now rides in the model-visible output too.
    expect(toolContentString(result)).toContain('Hello, world!');
  });

  it('surfaces the extraction mode in the model-visible output', async () => {
    const tool = new FetchURLTool(fakeFetcher('Article body', 'extracted'));
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c-extracted',
      args: { url: 'https://example.com/article' },
      signal,
    });
    expect(result.isError).toBe(false);
    // The mode note must live in `output`: `message` is dropped from the transcript,
    // so `output` is the only place the model can actually read which mode it got.
    const out = toolContentString(result);
    expect(out).toContain('The returned content is the main text extracted from the page.');
    expect(out).toContain('Article body');
  });

  it('surfaces the passthrough mode in the model-visible output', async () => {
    const tool = new FetchURLTool(fakeFetcher('# Raw markdown', 'passthrough'));
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c-passthrough',
      args: { url: 'https://example.com/readme.md' },
      signal,
    });
    expect(result.isError).toBe(false);
    const out = toolContentString(result);
    expect(out).toContain('The returned content is the full response body, returned verbatim.');
    expect(out).toContain('# Raw markdown');
  });

  it('returns empty message when fetcher returns empty string', async () => {
    const tool = new FetchURLTool(fakeFetcher(''));
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c2',
      args: { url: 'https://example.com/empty' },
      signal,
    });
    expect(result.isError).toBe(false);
    expect(toolContentString(result)).toContain('empty');
  });

  it('truncates oversized fetched content through the shared builder', async () => {
    const tool = new FetchURLTool(fakeFetcher('x'.repeat(60_000)));
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c-large',
      args: { url: 'https://example.com/large' },
      signal,
    });

    const content = toolContentString(result);
    expect(result.isError).toBe(false);
    expect(content).toContain('[...truncated]');
    expect(content).toContain('Output is truncated');
    expect(content.length).toBeLessThan(60_000);
    expect((result as { message?: string }).message).toContain('Output is truncated');
  });

  it('keeps the citation reminder at the front so truncation cannot drop it', async () => {
    const tool = new FetchURLTool(fakeFetcher('x'.repeat(60_000)));
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c-cite',
      args: { url: 'https://example.com/large' },
      signal,
    });
    const out = toolContentString(result);
    // Body was truncated, yet the reminder — which rides in the front note —
    // must survive.
    expect(out).toContain('[...truncated]');
    expect(out).toContain('cite');
    expect(out).toContain('[title](url)');
  });

  it('returns error when fetcher throws', async () => {
    const fetcher: UrlFetcher = {
      fetch: vi.fn().mockRejectedValue(new Error('timeout')),
    };
    const tool = new FetchURLTool(fetcher);
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c3',
      args: { url: 'https://example.com/fail' },
      signal,
    });
    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toContain('timeout');
  });

  it('passes the tool call id to the fetcher', async () => {
    const fetcher = fakeFetcher('content');
    const tool = new FetchURLTool(fetcher);
    await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c4',
      args: { url: 'https://example.com' },
      signal,
    });
    expect(fetcher.fetch).toHaveBeenCalledWith('https://example.com', {
      toolCallId: 'c4',
    });
  });

  it('resolveExecution description truncates long URLs', () => {
    const tool = new FetchURLTool(fakeFetcher());
    const execution = tool.resolveExecution({ url: 'https://example.com/' + 'a'.repeat(60) });
    expect(execution.isError).toBeFalsy();
    if (execution.isError === true) throw new Error('expected runnable execution');
    const desc = execution.description;
    const text = desc ?? '';
    expect(text.length).toBeLessThanOrEqual(65);
    expect(text).toContain('…');
  });

  it('description names URL fetching as the tool surface', () => {
    const tool = new FetchURLTool(fakeFetcher());
    expect(tool.description).toContain('URL');
    expect(tool.description.toLowerCase()).toContain('fetch');
  });

  it('extracts visible article text and metadata from an HTML page, stripping tags', async () => {
    // The host provider is responsible for HTML→text extraction. Lock down
    // that when the fetcher returns trafilatura-style cleaned text, the tool
    // forwards it verbatim and keeps the meaningful tokens (no raw tags).
    const extracted = [
      'title: Sample Bug Report',
      'description: The default value should be lowercase.',
      '',
      'Sample Bug Report',
      'The default parameter value for optimizer should probably be adamw instead of adamW.',
    ].join('\n');
    const tool = new FetchURLTool(fakeFetcher(extracted));

    const result = await executeTool(tool,{
      turnId: 't1',
      toolCallId: 'c_html',
      args: { url: 'https://example.com/bug' },
      signal,
    });

    expect(result.isError).toBe(false);
    const content = toolContentString(result);
    expect(content).toContain('optimizer');
    expect(content).toContain('adamw');
    expect(content).toContain('adamW');
    expect(content).not.toContain('<article>');
    expect(content).not.toContain('<code>');
    expect(content.toLowerCase()).toContain('title:');
    expect(content.toLowerCase()).toContain('description:');
  });

  it('surfaces HTTP status in the error message for 404 responses', async () => {
    // py contract: "Failed to fetch URL. Status: 404. ..." Fetcher signals
    // the HTTP status via a typed HttpFetchError; tool renders Status: N.
    const fetcher: UrlFetcher = {
      fetch: vi.fn().mockRejectedValue(new HttpFetchError(404, 'Not Found')),
    };
    const tool = new FetchURLTool(fetcher);

    const result = await executeTool(tool,{
      turnId: 't1',
      toolCallId: 'c_404',
      args: { url: 'https://example.com/missing' },
      signal,
    });

    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toContain('Status: 404');
  });

  it('reports the empty URL verbatim in the error message', async () => {
    // py renders: "Failed to fetch URL due to network error: . ..." with the
    // empty URL surfaced where the URL would normally go.
    const fetcher: UrlFetcher = {
      fetch: vi.fn().mockRejectedValue(new Error('network error: ')),
    };
    const tool = new FetchURLTool(fetcher);

    const result = await executeTool(tool,{
      turnId: 't1',
      toolCallId: 'c_empty',
      args: { url: '' },
      signal,
    });

    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toMatch(/due to network error/i);
  });

  it('passes through markdown content verbatim instead of running text extraction', async () => {
    // py: when the server returns text/markdown, extraction is skipped and
    // the body is returned as-is with a different status message. The
    // fetcher signals the bypass via UrlFetchResult.kind = 'passthrough'.
    const markdown = '# Title\n\nThis is a markdown document.\n';
    const fetcher: UrlFetcher = {
      fetch: vi.fn().mockResolvedValue({ content: markdown, kind: 'passthrough' }),
    };
    const tool = new FetchURLTool(fetcher);

    const result = await executeTool(tool,{
      turnId: 't1',
      toolCallId: 'c_md',
      args: { url: 'https://example.com/page.md' },
      signal,
    });

    expect(result.isError).toBe(false);
    const out = toolContentString(result);
    // The body is passed through verbatim (not extracted/mangled)...
    expect(out).toContain(markdown);
    // ...and the passthrough mode is signalled in the model-visible output
    // (py wording was "full content"; main #238 uses "full response body").
    expect(out).toContain('full response body');
  });
});

describe('BrowserTool', () => {
  it('validates action-specific inputs before dispatch', async () => {
    const browser: BrowserExecutor = { execute: vi.fn() };
    const tool = new BrowserTool(browser);
    expect(BrowserInputSchema.safeParse({ action: 'snapshot' }).success).toBe(true);
    const result = await executeTool(tool, {
      turnId: 'turn-browser',
      toolCallId: 'call-browser',
      args: { action: 'click' },
      signal,
    });
    expect(result.isError).toBe(true);
    expect(browser.execute).not.toHaveBeenCalled();
  });

  it('forwards stable-reference actions and tool call context', async () => {
    const browser: BrowserExecutor = {
      execute: vi.fn().mockResolvedValue({ ok: true, output: 'clicked' }),
    };
    const tool = new BrowserTool(browser);
    const result = await executeTool(tool, {
      turnId: 'turn-browser',
      toolCallId: 'call-browser',
      args: { action: 'click', ref: 'n42' },
      signal,
    });
    expect(result.isError).not.toBe(true);
    expect(browser.execute).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'click', ref: 'n42' }),
      { toolCallId: 'call-browser', signal },
    );
  });

  it('returns screenshots as multimodal tool output', async () => {
    const browser: BrowserExecutor = {
      execute: vi.fn().mockResolvedValue({
        ok: true,
        output: 'screenshot',
        screenshotDataUrl: 'data:image/png;base64,AAAA',
      }),
    };
    const result = await executeTool(new BrowserTool(browser), {
      turnId: 'turn-browser',
      toolCallId: 'call-browser',
      args: { action: 'screenshot' },
      signal,
    });
    expect(result.isError).not.toBe(true);
    expect(result.output).toEqual([
      { type: 'text', text: 'screenshot' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
    ]);
  });

  it('declares file reads and forwards upload paths', async () => {
    const browser: BrowserExecutor = {
      execute: vi.fn().mockResolvedValue({ ok: true, output: 'uploaded' }),
    };
    const tool = new BrowserTool(browser);
    const execution = tool.resolveExecution({
      action: 'upload',
      ref: 'npage-4',
      paths: ['/workspace/a.png', '/workspace/b.txt'],
    });
    expect(execution).toMatchObject({
      accesses: [
        { kind: 'file', operation: 'read', path: '/workspace/a.png' },
        { kind: 'file', operation: 'read', path: '/workspace/b.txt' },
      ],
    });

    const result = await executeTool(tool, {
      turnId: 'turn-browser',
      toolCallId: 'call-upload',
      args: { action: 'upload', ref: 'npage-4', paths: ['/workspace/a.png'] },
      signal,
    });
    expect(result.isError).not.toBe(true);
    expect(browser.execute).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'upload', ref: 'npage-4', paths: ['/workspace/a.png'] }),
      { toolCallId: 'call-upload', signal },
    );
  });

  it('declares a file read when navigating to local HTML', () => {
    const tool = new BrowserTool({ execute: vi.fn() });
    expect(tool.resolveExecution({
      action: 'navigate',
      url: 'file:///C:/workspace/demo/index.html',
    })).toMatchObject({
      accesses: [{ kind: 'file', operation: 'read', path: 'C:\\workspace\\demo\\index.html' }],
    });
  });

  it('forwards network filters and JavaScript dialog responses', async () => {
    const browser: BrowserExecutor = {
      execute: vi.fn().mockResolvedValue({ ok: true, output: 'ok' }),
    };
    const tool = new BrowserTool(browser);
    await executeTool(tool, {
      turnId: 'turn-browser',
      toolCallId: 'call-network',
      args: { action: 'get_network', filter: '/api/items' },
      signal,
    });
    await executeTool(tool, {
      turnId: 'turn-browser',
      toolCallId: 'call-dialog',
      args: { action: 'dialog_respond', dialog_id: 'dialog-1', accept: true, prompt_text: 'Nori' },
      signal,
    });
    expect(browser.execute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ action: 'get_network', filter: '/api/items' }),
      { toolCallId: 'call-network', signal },
    );
    expect(browser.execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action: 'dialog_respond',
        dialogId: 'dialog-1',
        accept: true,
        promptText: 'Nori',
      }),
      { toolCallId: 'call-dialog', signal },
    );
  });

  it('rejects incomplete upload and dialog actions before dispatch', async () => {
    const browser: BrowserExecutor = { execute: vi.fn() };
    const tool = new BrowserTool(browser);
    const upload = await executeTool(tool, {
      turnId: 'turn-browser',
      toolCallId: 'call-upload',
      args: { action: 'upload', ref: 'npage-1' },
      signal,
    });
    const dialog = await executeTool(tool, {
      turnId: 'turn-browser',
      toolCallId: 'call-dialog',
      args: { action: 'dialog_respond', dialog_id: 'dialog-1' },
      signal,
    });
    expect(upload).toMatchObject({ isError: true });
    expect(dialog).toMatchObject({ isError: true });
    expect(browser.execute).not.toHaveBeenCalled();
  });
});
