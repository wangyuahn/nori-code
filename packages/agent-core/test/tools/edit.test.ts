import { computeContentTag } from '@nori-code/kaos';
import { describe, expect, it, vi } from 'vitest';

import { type EditInput, EditInputSchema, EditTool } from '../../src/tools/builtin/file/edit';
import { createFakeKaos, PERMISSIVE_WORKSPACE } from './fixtures/fake-kaos';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

function context(args: EditInput) {
  return { turnId: '0', toolCallId: 'call_edit', args, signal };
}

function input(
  content: string,
  lineOps: EditInput['line_ops'],
  path = '/tmp/a.txt',
): EditInput {
  return {
    path,
    expected_tag: computeContentTag(content),
    line_ops: lineOps,
  };
}

describe('EditTool', () => {
  it('exposes a strict hash-anchored line operation schema', () => {
    const tool = new EditTool(createFakeKaos(), PERMISSIVE_WORKSPACE);

    expect(tool.name).toBe('Edit');
    expect(tool.description).toContain('expected_tag');
    expect(tool.description).toContain('line_ops');
    expect(tool.description).toContain('re-read');
    expect(tool.description).toContain('Do not include `-old`');
    expect(tool.description).toContain('do not widen a `swap`');
    expect(tool.description).toContain('Do not use Write or Bash `sed`');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        path: { type: 'string' },
        expected_tag: { type: 'string' },
        line_ops: { type: 'array' },
      },
      required: expect.arrayContaining(['path', 'expected_tag', 'line_ops']),
    });

    expect(
      EditInputSchema.safeParse({
        path: '/tmp/a.txt',
        expected_tag: 'A1B2',
        line_ops: [{ op: 'del', start: 1, end: 1 }],
      }).success,
    ).toBe(true);
    expect(
      EditInputSchema.safeParse({
        path: '/tmp/a.txt',
        expected_tag: 'A1B2',
        line_ops: [{ op: 'del', start: 1, end: 1 }],
        unsupported_field: true,
      }).success,
    ).toBe(false);
    expect(
      EditInputSchema.safeParse({
        path: '/tmp/a.txt',
        expected_tag: 'A1B2',
        line_ops: [],
      }).success,
    ).toBe(false);
    expect(
      EditInputSchema.safeParse({
        path: '/tmp/a.txt',
        expected_tag: 'not-a-tag',
        line_ops: [{ op: 'del', start: 1, end: 1 }],
      }).success,
    ).toBe(false);
  });

  it('shows the expected tag and operations in approval metadata', () => {
    const tool = new EditTool(createFakeKaos(), PERMISSIVE_WORKSPACE);
    const execution = tool.resolveExecution({
      path: '/tmp/foo.ts',
      expected_tag: 'a1b2',
      line_ops: [
        { op: 'swap', start: 2, end: 3, content: 'updated' },
        { op: 'insert_post', line: 5, content: 'tail' },
      ],
    });
    if (execution.isError === true) throw new TypeError('expected runnable execution');

    expect(execution.display).toEqual({
      kind: 'file_io',
      operation: 'edit',
      path: '/tmp/foo.ts',
      detail: 'Expected tag: A1B2\nswap 2-3\ninsert after 5',
    });
  });

  it('applies swap, delete, insert-before, and insert-after in original coordinates', async () => {
    const original = ['one', 'two', 'three', 'four', 'five'].join('\n');
    const writeText = vi.fn().mockResolvedValue(0);
    const reportChange = vi.fn();
    const tool = new EditTool(
      createFakeKaos({ readText: vi.fn().mockResolvedValue(original), writeText }),
      PERMISSIVE_WORKSPACE,
      reportChange,
    );

    const result = await executeTool(
      tool,
      context(
        input(original, [
          { op: 'insert_pre', line: 1, content: 'zero' },
          { op: 'swap', start: 2, end: 2, content: 'TWO\nsecond-extra' },
          { op: 'del', start: 4, end: 4 },
          { op: 'insert_post', line: 5, content: 'six' },
        ]),
      ),
    );

    const expected = ['zero', 'one', 'TWO', 'second-extra', 'three', 'five', 'six'].join('\n');
    expect(result.isError).toBeFalsy();
    expect(result.output).toBe(
      `[/tmp/a.txt#${computeContentTag(expected)}]\nApplied 4 line operations to /tmp/a.txt.`,
    );
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('/tmp/a.txt', expected);
    expect(reportChange).toHaveBeenCalledWith({
      operationId: 'call_edit',
      operation: 'edit',
      path: '/tmp/a.txt',
      diff: expect.stringContaining('+zero'),
      occurredAt: expect.any(String),
    });
  });

  it('rejects a stale tag and returns the live tag without writing', async () => {
    const original = 'alpha\nbeta\n';
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeKaos({ readText: vi.fn().mockResolvedValue(original), writeText }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/a.txt',
        expected_tag: '0000',
        line_ops: [{ op: 'swap', start: 2, end: 2, content: 'BETA' }],
      }),
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('Content tag mismatch');
    expect(result.output).toContain(`current ${computeContentTag(original)}`);
    expect(result.output).toContain('Re-read');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('uses the same tag for LF, CRLF, lone CR, and a leading BOM', () => {
    expect(computeContentTag('\uFEFFa\r\nb\r')).toBe(computeContentTag('a\nb\n'));
  });

  it('preserves pure CRLF files and returns the tag for materialized content', async () => {
    const original = 'alpha\r\nbeta\r\ngamma\r\n';
    const expected = 'alpha\r\nBETA\r\ngamma\r\n';
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeKaos({ readText: vi.fn().mockResolvedValue(original), writeText }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context(input(original, [{ op: 'swap', start: 2, end: 2, content: 'BETA' }])),
    );

    expect(writeText).toHaveBeenCalledWith('/tmp/a.txt', expected);
    expect(result.output).toContain(`[/tmp/a.txt#${computeContentTag(expected)}]`);
  });

  it('preserves a leading BOM without requiring it in replacement content', async () => {
    const original = '\uFEFFalpha\nbeta';
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeKaos({ readText: vi.fn().mockResolvedValue(original), writeText }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context(input(original, [{ op: 'swap', start: 1, end: 1, content: 'ALPHA' }])),
    );

    expect(result.isError).toBeFalsy();
    expect(writeText).toHaveBeenCalledWith('/tmp/a.txt', '\uFEFFALPHA\nbeta');
  });

  it('preserves a trailing newline after line operations', async () => {
    const original = 'a\nb\n';
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeKaos({ readText: vi.fn().mockResolvedValue(original), writeText }),
      PERMISSIVE_WORKSPACE,
    );

    await executeTool(
      tool,
      context(input(original, [{ op: 'insert_post', line: 2, content: 'c' }])),
    );

    expect(writeText).toHaveBeenCalledWith('/tmp/a.txt', 'a\nb\nc\n');
  });

  it('deleting the only line produces an empty file rather than a newline', async () => {
    const original = 'only\n';
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeKaos({ readText: vi.fn().mockResolvedValue(original), writeText }),
      PERMISSIVE_WORKSPACE,
    );

    await executeTool(tool, context(input(original, [{ op: 'del', start: 1, end: 1 }])));

    expect(writeText).toHaveBeenCalledWith('/tmp/a.txt', '');
  });

  it('allows insertions at the outside boundaries of a replaced range', async () => {
    const original = 'a\nb\nc\nd';
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeKaos({ readText: vi.fn().mockResolvedValue(original), writeText }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context(
        input(original, [
          { op: 'insert_pre', line: 2, content: 'before' },
          { op: 'swap', start: 2, end: 3, content: 'middle' },
          { op: 'insert_post', line: 3, content: 'after' },
        ]),
      ),
    );

    expect(result.isError).toBeFalsy();
    expect(writeText).toHaveBeenCalledWith('/tmp/a.txt', 'a\nbefore\nmiddle\nafter\nd');
  });

  it('rejects overlapping replacement ranges before writing', async () => {
    const original = 'a\nb\nc\nd';
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeKaos({ readText: vi.fn().mockResolvedValue(original), writeText }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context(
        input(original, [
          { op: 'swap', start: 1, end: 2, content: 'x' },
          { op: 'del', start: 2, end: 3 },
        ]),
      ),
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('overlap');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('rejects reversed and out-of-bounds ranges before writing', async () => {
    const original = 'a\nb';
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeKaos({ readText: vi.fn().mockResolvedValue(original), writeText }),
      PERMISSIVE_WORKSPACE,
    );

    const reversed = await executeTool(
      tool,
      context(input(original, [{ op: 'del', start: 2, end: 1 }])),
    );
    const outside = await executeTool(
      tool,
      context(input(original, [{ op: 'swap', start: 3, end: 3, content: 'x' }])),
    );

    expect(reversed.output).toContain('greater than end');
    expect(outside.output).toContain('outside the original file');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('rejects insert anchors inside a multi-line replacement range', async () => {
    const original = 'a\nb\nc\nd';
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeKaos({ readText: vi.fn().mockResolvedValue(original), writeText }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context(
        input(original, [
          { op: 'swap', start: 1, end: 3, content: 'x' },
          { op: 'insert_pre', line: 2, content: 'ambiguous' },
        ]),
      ),
    );

    expect(result.output).toContain('falls inside range');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('rejects no-op operations without writing', async () => {
    const original = 'same';
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeKaos({ readText: vi.fn().mockResolvedValue(original), writeText }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context(input(original, [{ op: 'swap', start: 1, end: 1, content: 'same' }])),
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('No changes to make');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('rejects line operations against an empty file', async () => {
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeKaos({ readText: vi.fn().mockResolvedValue(''), writeText }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context(input('', [{ op: 'insert_pre', line: 1, content: 'first' }])),
    );

    expect(result.output).toContain('file is empty');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('expands leading tilde paths through the Kaos home directory', async () => {
    const original = 'alpha\nbeta';
    const readText = vi.fn().mockResolvedValue(original);
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(createFakeKaos({ readText, writeText }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(
      tool,
      context(input(original, [{ op: 'swap', start: 2, end: 2, content: 'BETA' }], '~/notes/today.txt')),
    );

    expect(result.isError).toBeFalsy();
    expect(readText).toHaveBeenCalledWith('/home/test/notes/today.txt');
    expect(writeText).toHaveBeenCalledWith('/home/test/notes/today.txt', 'alpha\nBETA');
  });

  it('rejects relative traversal before reading', async () => {
    const readText = vi.fn().mockResolvedValue('secret');
    const tool = new EditTool(createFakeKaos({ readText }), {
      workspaceDir: '/workspace/project',
      additionalDirs: [],
    });

    const result = await executeTool(
      tool,
      context(input('secret', [{ op: 'del', start: 1, end: 1 }], '../outside.txt')),
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('absolute path');
    expect(readText).not.toHaveBeenCalled();
  });

  it('supports Unicode replacement content', async () => {
    const original = 'Hello\n世界';
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeKaos({ readText: vi.fn().mockResolvedValue(original), writeText }),
      PERMISSIVE_WORKSPACE,
    );

    await executeTool(
      tool,
      context(input(original, [{ op: 'swap', start: 2, end: 2, content: '地球 🌍' }])),
    );

    expect(writeText).toHaveBeenCalledWith('/tmp/a.txt', 'Hello\n地球 🌍');
  });

  it('reports directories as not files', async () => {
    const original = 'old';
    const tool = new EditTool(
      createFakeKaos({
        readText: vi.fn().mockRejectedValue(
          Object.assign(new Error('EISDIR: illegal operation on a directory'), { code: 'EISDIR' }),
        ),
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context(input(original, [{ op: 'swap', start: 1, end: 1, content: 'new' }], '/tmp/dir')),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('is not a file');
  });
});
