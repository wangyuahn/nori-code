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
