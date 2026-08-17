import { describe, expect, it } from 'vitest';

import {
  buildToolCallChangeDiff,
  buildToolCallDetailSections,
  isToolCallFailed,
} from '../src/utils/tool-call-detail';

describe('tool-call-detail', () => {
  it('detects bash failures from exit code output', () => {
    expect(isToolCallFailed('Bash', 'stdout\nCommand failed with exit code: 2.')).toBe(true);
    expect(isToolCallFailed('Bash', 'stdout\nCommand failed with exit code: 0.')).toBe(false);
  });

  it('builds edit preview lines from line_ops when no recorded diff exists', () => {
    const diff = buildToolCallChangeDiff({
      name: 'Edit',
      args: {
        path: 'src/a.ts',
        line_ops: [{ op: 'swap', start: 1, end: 1, content: 'new line' }],
      },
    });
    expect(diff).toContain('@@ replace lines 1-1 @@');
    expect(diff).toContain('+new line');
    expect(diff).not.toContain('[original line');
  });

  it('prefers recorded diff from code.change events for Edit tools', () => {
    const diff = buildToolCallChangeDiff({
      id: 'edit-1',
      name: 'Edit',
      args: {
        path: 'src/a.ts',
        line_ops: [{ op: 'swap', start: 1, end: 1, content: 'new line' }],
      },
    }, {
      recordedDiff: '-old line\n+new line',
    });
    expect(diff).toBe('-old line\n+new line');
  });

  it('strips original-line placeholders from recorded Edit diffs', () => {
    const diff = buildToolCallChangeDiff({
      id: 'edit-1',
      name: 'Edit',
      args: {
        path: 'src/a.ts',
        line_ops: [{ op: 'swap', start: 1, end: 1, content: 'background:#050510;' }],
      },
    }, {
      recordedDiff: '- [original line 1 replaced]\n+background:#050510;',
    });
    expect(diff).toBe('+background:#050510;');
    expect(diff).not.toContain('[original line');
  });

  it('falls back to line_ops when recorded Edit diffs are only placeholders', () => {
    const diff = buildToolCallChangeDiff({
      name: 'Edit',
      args: {
        path: 'src/a.ts',
        line_ops: [{ op: 'swap', start: 1, end: 1, content: 'updated' }],
      },
    }, {
      recordedDiff: '- [original line 1 replaced]\n- [original line 2 deleted]',
    });
    expect(diff).toContain('@@ replace lines 1-1 @@');
    expect(diff).toContain('+updated');
    expect(diff).not.toContain('[original line');
  });

  it('shows memory edit content without truncating it in Input', () => {
    const body = 'A'.repeat(300);
    const sections = buildToolCallDetailSections({
      name: 'nori_memory_edit',
      args: { title: 'Architecture choice', content: body },
      result: 'Note edited: analysis/architecture.md',
    });
    expect(sections.some(section => section.label === 'Input' && section.text?.includes('Architecture choice'))).toBe(true);
    expect(sections.some(section => section.label === 'Content' && section.text === body)).toBe(true);
    expect(sections.some(section => section.label === 'Input' && section.text?.includes(body))).toBe(false);
  });

  it('shows full input and output for Read, Grep, Agent, and unknown tools', () => {
    const prompt = `Please inspect ${'auth'.repeat(80)} and summarize the login flow.`;
    const readSections = buildToolCallDetailSections({
      name: 'Read',
      args: { path: 'src/app.ts', line_offset: 10 },
      result: 'export function main() {\n  return 1;\n}\n',
    });
    expect(readSections.some(section => section.label === 'Path' && section.text?.includes('src/app.ts'))).toBe(true);
    expect(readSections.some(section => section.label === 'Input' && section.text?.includes('line_offset'))).toBe(true);
    expect(readSections.some(section => section.label === 'File' && section.text?.includes('export function main()'))).toBe(true);

    const grepSections = buildToolCallDetailSections({
      name: 'Grep',
      args: { pattern: 'countActiveAgents', path: 'apps/nori-web', glob: '*.ts' },
      result: 'apps/nori-web/src/App.tsx:593:export function countActiveAgents(',
    });
    expect(grepSections.some(section => section.label === 'Pattern' && section.text === 'countActiveAgents')).toBe(true);
    expect(grepSections.some(section => section.label === 'Matches' && section.text?.includes('App.tsx'))).toBe(true);

    const agentSections = buildToolCallDetailSections({
      name: 'Agent',
      args: { subagent_type: 'explore', prompt },
      result: 'The login flow lives in src/auth.ts.',
    });
    expect(agentSections.some(section => section.label === 'Prompt' && section.text === prompt)).toBe(true);
    expect(agentSections.some(section => section.label === 'Input' && section.text?.includes(prompt))).toBe(false);
    expect(agentSections.some(section => section.label === 'Result' && section.text?.includes('src/auth.ts'))).toBe(true);

    const mcpSections = buildToolCallDetailSections({
      name: 'mcp__github__create_issue',
      args: {
        title: 'Fix badge',
        body: 'The collaboration badge counted the wrong session.\nCount paused agents too.',
      },
      result: 'Created issue #12',
    });
    expect(mcpSections.some(section => section.label === 'Input' && section.text?.includes('Fix badge'))).toBe(true);
    expect(mcpSections.some(section => section.label === 'Body' && section.text?.includes('wrong session'))).toBe(true);
    expect(mcpSections.some(section => section.label === 'Result' && section.text?.includes('#12'))).toBe(true);
  });

  it('shows full payloads for Write, Glob, FetchURL, Browser, WebSearch, and TodoList', () => {
    const writeBody = '# Auth\n\nLogin issues a token for the given user.\n';
    const writeSections = buildToolCallDetailSections({
      name: 'Write',
      args: { path: 'notes/auth.md', content: writeBody },
      result: 'Wrote notes/auth.md',
    });
    expect(writeSections.some(section => section.label === 'Input' && section.text?.includes('notes/auth.md'))).toBe(true);
    expect(writeSections.some(section => section.kind === 'diff' && section.lines?.some(line => line.includes('Login issues a token')))).toBe(true);
    expect(writeSections.some(section => section.label === 'Result' && section.text?.includes('Wrote notes/auth.md'))).toBe(true);

    const globSections = buildToolCallDetailSections({
      name: 'Glob',
      args: { pattern: '**/*.test.ts', path: 'apps/nori-web' },
      result: 'apps/nori-web/test/ChatView.test.ts\napps/nori-web/test/tool-call-detail.test.ts',
    });
    expect(globSections.some(section => section.label === 'Pattern' && section.text === '**/*.test.ts')).toBe(true);
    expect(globSections.some(section => section.label === 'Input' && section.text?.includes('apps/nori-web'))).toBe(true);
    expect(globSections.some(section => section.label === 'Files' && section.text?.includes('ChatView.test.ts'))).toBe(true);

    const fetchSections = buildToolCallDetailSections({
      name: 'FetchURL',
      args: { url: 'https://example.com/docs/api' },
      result: '# API Reference\n\nGET /v1/sessions returns the session list.',
    });
    expect(fetchSections.some(section => section.label === 'URL' && section.text === 'https://example.com/docs/api')).toBe(true);
    expect(fetchSections.some(section => section.label === 'Page' && section.text?.includes('GET /v1/sessions'))).toBe(true);

    const browserSections = buildToolCallDetailSections({
      name: 'Browser',
      args: { action: 'type', url: 'https://example.com/login', text: 'user@example.com', ref: 'e12' },
      result: 'Typed into email field\nSnapshot: 8 interactive elements.',
    });
    expect(browserSections.some(section => section.label === 'Input' && section.text?.includes('type'))).toBe(true);
    expect(browserSections.some(section => section.label === 'Text' && section.text === 'user@example.com')).toBe(true);
    expect(browserSections.some(section => section.label === 'Snapshot' && section.text?.includes('8 interactive elements'))).toBe(true);

    const query = `RFC 9110 HTTP semantics ${'cache '.repeat(40)}invalidation`;
    const searchSections = buildToolCallDetailSections({
      name: 'WebSearch',
      args: { query },
      result: '1. RFC 9110 — HTTP Semantics\n2. Cache invalidation is the origin\'s job.',
    });
    expect(searchSections.some(section => section.label === 'Query' && section.text === query)).toBe(true);
    expect(searchSections.some(section => section.label === 'Results' && section.text?.includes('RFC 9110'))).toBe(true);

    const todoSections = buildToolCallDetailSections({
      name: 'TodoList',
      args: {
        todos: [
          { title: 'Fix collaboration badge', status: 'done' },
          { title: 'Show tool details', status: 'in_progress' },
        ],
      },
      result: 'Current todo list:\n  [done] Fix collaboration badge\n  [in_progress] Show tool details',
    });
    expect(todoSections.some(section => section.label === 'Todos' && section.text?.includes('Fix collaboration badge'))).toBe(true);
    expect(todoSections.some(section => section.label === 'Result' && section.text?.includes('[in_progress] Show tool details'))).toBe(true);
  });

  it('does not truncate long input or output at 240 characters', () => {
    const title = `Issue ${'title '.repeat(80)}end`;
    const output = `Match ${'line '.repeat(80)}end`;
    const sections = buildToolCallDetailSections({
      name: 'mcp__linear__create_issue',
      args: { title, team: 'ENG' },
      result: output,
    });
    expect(sections.some(section => section.label === 'Title' && section.text === title)).toBe(true);
    expect(sections.some(section => section.label === 'Result' && section.text === output)).toBe(true);
    expect(JSON.stringify(sections)).not.toContain('…');
  });

  it('builds write diff from content', () => {
    const diff = buildToolCallChangeDiff({
      name: 'Write',
      args: { path: 'README.md', content: 'hello\nworld' },
    });
    expect(diff).toBe('+hello\n+world');
  });

  it('includes command, diff, and failure sections for failed bash calls', () => {
    const sections = buildToolCallDetailSections({
      name: 'Bash',
      args: { command: 'npm test' },
      result: 'stderr\nCommand failed with exit code: 1.',
    });
    expect(sections.some(section => section.label === 'Command' && section.text?.includes('npm test'))).toBe(true);
    expect(sections.some(section => section.kind === 'error')).toBe(true);
  });

  it('omits duplicate result body when it matches the change diff', () => {
    const sections = buildToolCallDetailSections({
      name: 'Write',
      args: { path: 'a.txt', content: 'line' },
      result: '+line',
    });
    expect(sections.filter(section => section.label === 'Result')).toHaveLength(0);
    expect(sections.some(section => section.kind === 'diff')).toBe(true);
  });
});
