import { describe, expect, it } from 'vitest';

import {
  computeEditStats,
  computeWriteStats,
  pickChip,
} from '#/tui/components/messages/tool-renderers/chip';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';

function strip(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, '');
}

function call(name: string, args: Record<string, unknown> = {}): ToolCallBlockData {
  return { id: 'tc', name, args };
}

function result(output: string, isError = false): ToolResultBlockData {
  return { tool_call_id: 'tc', output, is_error: isError };
}

function chipFor(name: string, args: Record<string, unknown>, out: ToolResultBlockData): string {
  const provider = pickChip(name);
  return strip(provider?.(call(name, args), out) ?? '');
}

describe('chip registry', () => {
  it('Bash has no chip (exit code is not surfaced)', () => {
    expect(pickChip('Bash')).toBeUndefined();
  });

  it('Edit chip shows +N -M from line operations', () => {
    const c = chipFor(
      'Edit',
      {
        path: 'foo.ts',
        expected_tag: 'A1B2',
        line_ops: [{ op: 'swap', start: 2, end: 2, content: 'B\nd' }],
      },
      result('[foo.ts#C3D4]\nApplied 1 line operation to foo.ts.'),
    );
    expect(c).toMatch(/\+\d+/);
    expect(c).toMatch(/-\d+/);
  });

  it('Write chip shows N lines from content arg', () => {
    expect(chipFor('Write', { path: 'a.txt', content: 'a\nb\nc\n' }, result('Wrote a.txt'))).toBe(
      '3 lines',
    );
  });

  it('Read chip shows line count', () => {
    expect(chipFor('Read', { path: 'a.ts' }, result('1\tfoo\n2\tbar\n3\tbaz'))).toBe('3 lines');
  });

  it('Read chip handles single line as singular', () => {
    expect(chipFor('Read', { path: 'a.ts' }, result('1\tfoo'))).toBe('1 line');
  });

  it('Grep chip shows match count', () => {
    expect(chipFor('Grep', { pattern: 'foo' }, result('a.ts\nb.ts\nc.ts'))).toBe('3 matches');
  });

  it('Grep chip says "no matches" on empty result', () => {
    expect(chipFor('Grep', { pattern: 'foo' }, result(''))).toBe('no matches');
  });

  it('Glob chip shows file count', () => {
    expect(chipFor('Glob', { pattern: '**/*.ts' }, result('a.ts\nb.ts'))).toBe('2 files');
  });

  it('FetchURL chip shows size and is non-empty', () => {
    const out = chipFor('FetchURL', { url: 'https://example.com' }, result('hello world'));
    expect(out).toMatch(/\d+\s*B/);
  });

  it('WebSearch chip shows result count', () => {
    expect(chipFor('WebSearch', { query: 'kimi' }, result('1. Alpha\n2. Beta\n3. Gamma'))).toBe(
      '3 results',
    );
  });

  it('Think tool has no chip', () => {
    expect(pickChip('Think')).toBeUndefined();
  });

  it('GetGoal chip shows the current status', () => {
    expect(chipFor('GetGoal', {}, result('{"goal":{"status":"active"}}'))).toBe('active');
  });

  it('GetGoal chip shows when there is no current goal', () => {
    expect(chipFor('GetGoal', {}, result('{"goal":null}'))).toBe('no goal');
  });

  it('CreateGoal chip shows the created status', () => {
    expect(chipFor('CreateGoal', { objective: 'Ship feature X' }, result('{"goal":{"status":"active"}}'))).toBe('active');
  });

  it('SetGoalBudget has no chip because the budget is in the header argument', () => {
    expect(pickChip('SetGoalBudget')).toBeUndefined();
  });

  it('UpdateGoal has no chip because the status is in the header label', () => {
    expect(pickChip('UpdateGoal')).toBeUndefined();
  });

  it('Unknown tools have no chip', () => {
    expect(pickChip('SomethingElse')).toBeUndefined();
  });
});

describe('computeWriteStats', () => {
  it('returns zero lines for empty content', () => {
    expect(computeWriteStats({})).toEqual({ lines: 0 });
    expect(computeWriteStats({ content: '' })).toEqual({ lines: 0 });
  });

  it('counts a single line with no trailing newline', () => {
    expect(computeWriteStats({ content: 'hello' })).toEqual({ lines: 1 });
  });

  it('ignores trailing newline so "a\\nb\\n" is 2 lines', () => {
    expect(computeWriteStats({ content: 'a\nb\n' })).toEqual({ lines: 2 });
    expect(computeWriteStats({ content: 'a\nb' })).toEqual({ lines: 2 });
  });
});

describe('computeEditStats', () => {
  it('returns zero when line operations are absent', () => {
    expect(computeEditStats({})).toEqual({ added: 0, removed: 0 });
    expect(computeEditStats({ line_ops: [] })).toEqual({
      added: 0,
      removed: 0,
    });
  });

  it('counts added and removed lines for swap and delete operations', () => {
    const stats = computeEditStats({
      line_ops: [
        { op: 'swap', start: 2, end: 3, content: 'B\nC\nD' },
        { op: 'del', start: 5, end: 5 },
      ],
    });
    expect(stats).toEqual({ added: 3, removed: 3 });
  });

  it('counts only additions for insertion operations', () => {
    const stats = computeEditStats({
      line_ops: [{ op: 'insert_post', line: 4, content: 'x\ny\nz' }],
    });
    expect(stats.added).toBe(3);
    expect(stats.removed).toBe(0);
  });

  it('counts an empty operation content as an inserted blank line', () => {
    expect(computeEditStats({
      line_ops: [{ op: 'insert_pre', line: 1, content: '' }],
    })).toEqual({ added: 1, removed: 0 });
  });
});
