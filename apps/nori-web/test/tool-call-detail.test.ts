import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../src/hooks/useChatMessages';
import { toolCallDetailFields } from '../src/utils/tool-call-detail';

const tr = (english: string) => english;

function fields(tool: ToolCall): Record<string, string> {
  return Object.fromEntries(toolCallDetailFields(tool, tr).map(field => [field.key, field.value]));
}

describe('tool call detail fields', () => {
  it('exposes name, arguments, result, status, duration, and error for every tool', () => {
    expect(fields({
      id: 'read-1',
      name: 'Read',
      args: { path: 'src/app.ts' },
      result: 'file contents',
      startedAt: 1_000,
      endedAt: 1_250,
    })).toMatchObject({
      name: 'Read',
      args: JSON.stringify({ path: 'src/app.ts' }, null, 2),
      result: 'file contents',
      status: 'Done',
      duration: '250ms',
      error: 'No error',
      path: 'src/app.ts',
    });
  });

  it('uses explicit empty-state copy when arguments, result, duration, or error are missing', () => {
    expect(fields({ id: 'pending-1', name: 'Bash' })).toMatchObject({
      args: 'No arguments',
      result: 'No result yet',
      status: 'Running',
      duration: 'No duration',
      error: 'No error',
      command: 'No command',
    });
    expect(fields({
      id: 'empty-1',
      name: 'Grep',
      args: {},
      result: '',
      isError: false,
      endedAt: 2,
    })).toMatchObject({
      args: 'No arguments',
      result: 'No return value',
      status: 'Done',
      error: 'No error',
      pattern: 'No pattern',
      path: 'No path',
    });
    expect(fields({
      id: 'fail-1',
      name: 'WebSearch',
      isError: true,
      endedAt: 3,
    })).toMatchObject({
      status: 'Failed',
      result: 'No return value',
      error: 'Tool failed without an error message',
      query: 'No query',
    });
  });

  it('shows hash-anchored edit path, tag, operations, diff, and apply result', () => {
    expect(fields({
      id: 'edit-1',
      name: 'Edit',
      args: {
        path: 'src/hooks/useApi.ts',
        expected_tag: 'A1B2',
        line_ops: [{ op: 'swap', start: 2, end: 2, content: 'status: running' }],
      },
      result: '[src/hooks/useApi.ts#C3D4]\nApplied 1 line operation to src/hooks/useApi.ts.',
    })).toMatchObject({
      name: 'Edit',
      path: 'src/hooks/useApi.ts',
      tag: 'A1B2',
      operations: 'replace lines 2-2',
      diff: '@@ replace lines 2-2 @@\n- [original line 2 replaced]\n+status: running',
      applied: '[src/hooks/useApi.ts#C3D4]\nApplied 1 line operation to src/hooks/useApi.ts.',
    });
  });

  it('covers write, glob, fetch, and skill specialized fields', () => {
    expect(fields({
      id: 'write-1',
      name: 'Write',
      args: { path: 'notes.md', content: '# hi' },
    })).toMatchObject({ path: 'notes.md', content: '# hi', applied: 'No apply result' });
    expect(fields({
      id: 'glob-1',
      name: 'Glob',
      args: { pattern: '**/*.ts', target_directory: 'src' },
    })).toMatchObject({ pattern: '**/*.ts', path: 'src' });
    expect(fields({
      id: 'fetch-1',
      name: 'FetchUrl',
      args: { url: 'https://example.com' },
    })).toMatchObject({ url: 'https://example.com' });
    expect(fields({
      id: 'skill-1',
      name: 'Skill',
      args: { skill: 'skill-catalog' },
    })).toMatchObject({ skill: 'skill-catalog' });
  });

  it('summarizes the Team delegation and discussion tools', () => {
    expect(fields({
      id: 'team-create-1',
      name: 'TeamCreate',
      args: { members: [{ name: 'Ren', role: 'reviewer', mandate: 'Review diffs' }, { name: 'Kai' }] },
    })).toMatchObject({ members: 'Ren — reviewer\nKai' });
    expect(fields({
      id: 'team-assign-1',
      name: 'TeamAssign',
      args: { assignments: [{ agent_id: 'agent-1', task: 'Check a.ts' }, { agent_id: 'agent-2', task: null }] },
    })).toMatchObject({ assignments: 'agent-1: Check a.ts\nagent-2: cleared' });
    expect(fields({
      id: 'team-dm-1',
      name: 'TeamDM',
      args: { agent_id: 'agent-1', message: 'Status?' },
    })).toMatchObject({ recipient: 'agent-1', message: 'Status?' });
    // TeamSpeak has no recipient — a member speaks to its whole department — so
    // the recipient row must be absent rather than rendered as "unknown".
    expect(fields({
      id: 'team-speak-1',
      name: 'TeamSpeak',
      args: { message: 'Cache first.' },
    })).toMatchObject({ message: 'Cache first.' });
    expect(fields({ id: 'team-speak-2', name: 'TeamSpeak', args: { message: 'Cache first.' } }))
      .not.toHaveProperty('recipient');
    expect(fields({
      id: 'team-decide-1',
      name: 'TeamDecide',
      args: { action: 'start', topic: 'Cache', statement: 'Lead first.' },
    })).toMatchObject({ action: 'start', topic: 'Cache', statement: 'Lead first.' });
  });
});
