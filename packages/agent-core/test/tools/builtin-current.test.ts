/**
 * Current builtin tool smoke coverage.
 *
 * This complements focused tool tests by ensuring every current builtin
 * has at least one schema assertion and one execution/error-path assertion.
 */

import { Readable, type Writable } from 'node:stream';

import { computeContentTag, type Kaos, type KaosProcess } from '@nori-code/kaos';
import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../src/agent';
import { FLAG_DEFINITIONS, FlagResolver } from '../../src/flags';
import type { SessionSubagentHost } from '../../src/session/subagent-host';
import { SessionSkillRegistry } from '../../src/skill';
import { TaskListInputSchema } from '../../src/tools/background/task-list';
import { TaskOutputInputSchema } from '../../src/tools/background/task-output';
import { TaskStopInputSchema } from '../../src/tools/background/task-stop';
import {
  AskUserQuestionInputSchema,
  AskUserQuestionTool,
} from '../../src/tools/builtin/collaboration/ask-user';
import { SkillTool, SkillToolInputSchema } from '../../src/tools/builtin/collaboration/skill-tool';
import {
  TeamAssignInputSchema,
  TeamAssignTool,
  TeamCreateInputSchema,
  TeamCreateTool,
  TeamDecideInputSchema,
  TeamDecideTool,
  TeamDMInputSchema,
  TeamSpeakInputSchema,
  TeamSpeakTool,
  TeamUpdateInputSchema,
  TeamUpdateTool,
} from '../../src/tools/builtin/collaboration/team';
import { TeamStatusInputSchema, TeamStatusTool } from '../../src/tools/builtin/collaboration/team-status';
import {
  SessionGraphInputSchema,
  SessionGraphTool,
  SessionMountInputSchema,
  SessionMountTool,
  SessionSearchInputSchema,
  SessionSearchTool,
  SessionUnmountInputSchema,
  SessionUnmountTool,
} from '../../src/tools/builtin/collaboration/session-topology';
import { compileToolArgsValidator, validateToolArgs } from '../../src/tools/args-validator';
import { EditInputSchema, EditTool } from '../../src/tools/builtin/file/edit';
import { GlobInputSchema, GlobTool } from '../../src/tools/builtin/file/glob';
import { GrepInputSchema, GrepTool } from '../../src/tools/builtin/file/grep';
import { ReadInputSchema, ReadTool } from '../../src/tools/builtin/file/read';
import { WriteInputSchema, WriteTool } from '../../src/tools/builtin/file/write';
import { BashInputSchema, BashTool } from '../../src/tools/builtin/shell/bash';
import type { WorkspaceConfig } from '../../src/tools/support/workspace';
import { createFakeKaos } from './fixtures/fake-kaos';
import { executeTool } from './fixtures/execute-tool';
import { createBackgroundManager } from '../agent/background/helpers';
import {
  NoriMemorySearchInputSchema,
  NoriMemorySearchTool,
} from '../../src/tools/builtin/nori/nori-memory-search';
import type { NoriMemoryProvider } from '../../src/tools/builtin/nori/types';

vi.mock('../../src/tools/support/rg-locator', () => ({
  ensureRgPath: vi.fn(async () => ({ path: '/mock/rg', source: 'system-path' })),
  rgUnavailableMessage: (cause: unknown) =>
    `rg unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
}));

const signal = new AbortController().signal;
const workspace: WorkspaceConfig = { workspaceDir: '/workspace', additionalDirs: [] };
const regularFileStat = {
  stMode: 0o100_644,
  stIno: 1,
  stDev: 1,
  stNlink: 1,
  stUid: 1000,
  stGid: 1000,
  stSize: 0,
  stAtime: 0,
  stMtime: 0,
  stCtime: 0,
} satisfies Awaited<ReturnType<Kaos['stat']>>;
const directoryStat = {
  ...regularFileStat,
  stMode: 0o040_755,
} satisfies Awaited<ReturnType<Kaos['stat']>>;

function context<Input>(args: Input, toolCallId = 'call_1') {
  return { turnId: '0', toolCallId, args, signal };
}

/** Stand in for the team host so tool tests assert wiring, not host behavior. */
function mockTeamHost<T extends Partial<SessionSubagentHost>>(
  host: T,
): T & SessionSubagentHost {
  return host as unknown as T & SessionSubagentHost;
}

function processWithOutput(stdout: string, exitCode = 0): KaosProcess {
  const stdoutStream = Readable.from([stdout]);
  const stderrStream = Readable.from([]);
  return {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: stdoutStream,
    stderr: stderrStream,
    pid: 123,
    exitCode,
    wait: vi.fn().mockResolvedValue(exitCode),
    kill: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(async () => {
      stdoutStream.destroy();
      stderrStream.destroy();
    }),
  };
}

describe('current builtin file and shell tools', () => {
  it('Read exposes parameters and reads text content', async () => {
    const content = 'alpha\nbeta\n';
    const bytes = Buffer.from(content, 'utf8');
    const tool = new ReadTool(
      createFakeKaos({
        stat: vi.fn<Kaos['stat']>().mockResolvedValue(regularFileStat),
        readBytes: vi.fn<Kaos['readBytes']>().mockImplementation(async (_path, n) => {
          return n === undefined ? bytes : bytes.subarray(0, n);
        }),
        readLines: vi.fn<Kaos['readLines']>().mockImplementation(async function* readLines() {
          yield 'alpha\n';
          yield 'beta\n';
        }),
      }),
      workspace,
    );

    expect(ReadInputSchema.safeParse({ path: '/workspace/a.txt' }).success).toBe(true);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { path: { type: 'string' } },
    });

    const result = await executeTool(tool, context({ path: '/workspace/a.txt' }));
    expect(result.output).toBe(
      [
        `[/workspace/a.txt#${computeContentTag(content)}]`,
        '1\talpha',
        '2\tbeta',
        '<system>2 lines read from file starting from line 1. Total lines in file: 2. End of file reached.</system>',
      ].join('\n'),
    );
  });

  it('Write exposes parameters and writes through kaos', async () => {
    const writeText = vi.fn().mockResolvedValue(5);
    const tool = new WriteTool(
      createFakeKaos({ writeText, stat: vi.fn<Kaos['stat']>().mockResolvedValue(directoryStat) }),
      workspace,
    );

    expect(WriteInputSchema.safeParse({ path: '/workspace/a.txt', content: 'hello' }).success).toBe(
      true,
    );
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { content: { type: 'string' } },
    });

    const result = await executeTool(tool, context({ path: '/workspace/a.txt', content: 'hello' }));
    expect(writeText).toHaveBeenCalledWith('/workspace/a.txt', 'hello');
    expect(result.output).toContain('Wrote 5 bytes');
  });

  it('Edit exposes hash-anchored line operation parameters and writes through kaos', async () => {
    const original = 'alpha\nbeta\n';
    const writeText = vi.fn().mockResolvedValue(12);
    const tool = new EditTool(
      createFakeKaos({ readText: vi.fn().mockResolvedValue(original), writeText }),
      workspace,
    );

    const args = {
      path: '/workspace/a.txt',
      expected_tag: computeContentTag(original),
      line_ops: [{ op: 'swap' as const, start: 2, end: 2, content: 'delta' }],
    };
    expect(EditInputSchema.safeParse(args).success).toBe(true);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { expected_tag: { type: 'string' }, line_ops: { type: 'array' } },
    });

    const result = await executeTool(tool, context(args));
    expect(result.isError).toBeFalsy();
    expect(writeText).toHaveBeenCalledWith('/workspace/a.txt', 'alpha\ndelta\n');
  });

  it('Glob exposes parameters and walks pure-wildcard patterns capped at MAX_MATCHES', async () => {
    // Pure wildcards used to be rejected up-front; now they walk like
    // any other pattern and the 100-match cap is the only safety.
    const exec = vi.fn().mockResolvedValue(processWithOutput('/workspace/a.ts\n'));
    const stat = vi.fn().mockResolvedValue({ ...regularFileStat, stMode: 0o040000 });
    const tool = new GlobTool(createFakeKaos({ exec, stat }), workspace);

    expect(GlobInputSchema.safeParse({ pattern: '*.ts' }).success).toBe(true);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { pattern: { type: 'string' } },
    });

    const result = await executeTool(tool, context({ pattern: '**' }));
    expect(result.isError).toBeFalsy();
    expect(exec).toHaveBeenCalled();
    expect((exec.mock.calls[0] as string[]).at(-1)).toBe('.');
    expect(result.output).toContain('a.ts');
  });

  it('Grep exposes parameters and rejects relative workspace escapes before spawning rg', async () => {
    const kaos = createFakeKaos({ exec: vi.fn() });
    const tool = new GrepTool(kaos, workspace);

    expect(GrepInputSchema.safeParse({ pattern: 'needle' }).success).toBe(true);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { pattern: { type: 'string' } },
    });

    const result = await executeTool(tool, context({ pattern: 'needle', path: '../outside' }));
    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('outside the working directory');
    expect(kaos.exec).not.toHaveBeenCalled();
  });

  it('Bash exposes parameters and returns foreground stdout', async () => {
    const tool = new BashTool(
      createFakeKaos({
        execWithEnv: vi.fn().mockResolvedValue(processWithOutput('ok\n')),
        osEnv: {
          osKind: 'Linux',
          osArch: 'arm64',
          osVersion: 'test',
          shellPath: '/bin/bash',
          shellName: 'bash',
        },
      }),
      '/workspace',
      createBackgroundManager().manager,
    );

    expect(BashInputSchema.safeParse({ command: 'printf ok' }).success).toBe(true);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { command: { type: 'string' } },
    });

    const result = await executeTool(tool, context({ command: 'printf ok', timeout: 1000 }));
    expect(result).toMatchObject({ output: 'ok\n' });
  });
});

describe('current builtin collaboration tools', () => {
  it('Team tools validate durable identities, require complete assignments, and publish explicit statements', async () => {
    const createTeam = vi.fn(async () => [{
      agentId: 'agent-review',
      sessionId: 'sess_reviewer',
      identity: {
        name: 'Reviewer',
        mandate: 'Review behavior.',
        role: 'reviewer',
      },
    }]);
    const updateTeamIdentity = vi.fn(async () => undefined);
    const assignTeam = vi.fn(async () => [{ agentId: 'agent-review', task: 'Review tests.', turnId: 7 }]);
    const speakInDiscussion = vi.fn(async () => ({ discussionAgentId: 'agent-discussion', entryId: 4 }));
    const host = mockTeamHost({ createTeam, assignTeam, speakInDiscussion, updateTeamIdentity });

    const create = new TeamCreateTool(host);
    const update = new TeamUpdateTool(host);
    const assign = new TeamAssignTool(host);
    const speak = new TeamSpeakTool(host);
    const getTeamStatus = vi.fn(async () => ({
      agent_id: 'main',
      member_count: 1,
      message: 'Direct persistent Team Agent status.',
      members: [{
        agent_id: 'agent-review',
        name: 'Reviewer',
        role: 'reviewer',
        mandate: 'Review behavior.',
        status: 'idle' as const,
        assigned_task: 'Review tests.',
      }],
    }));
    const status = new TeamStatusTool(mockTeamHost({ getTeamStatus }));
    const members = [{
      name: 'Reviewer',
      mandate: 'Review behavior.',
      role: 'reviewer',
    }];
    expect(TeamCreateInputSchema.safeParse({ members }).success).toBe(true);
    expect(TeamCreateInputSchema.safeParse({ members: [{ ...members[0], title: 'legacy' }] }).success).toBe(false);
    expect(TeamCreateInputSchema.safeParse({ members: [{ name: 'Reviewer', role: '', mandate: 'Review behavior.' }] }).success).toBe(false);
    expect(TeamCreateInputSchema.safeParse({ members: [{ name: 'Reviewer', role: 'reviewer' }] }).success).toBe(false);
    expect(TeamUpdateInputSchema.safeParse({ name: 'Lead reviewer' }).success).toBe(true);
    expect(TeamUpdateInputSchema.safeParse({ tags: ['review'] }).success).toBe(true);
    expect(TeamUpdateInputSchema.safeParse({}).success).toBe(false);
    expect(TeamDecideInputSchema.safeParse({
      action: 'start',
      topic: 'Review the cache path',
      statement: 'The cache key must stay stable.',
    }).success).toBe(true);
    expect(TeamDecideInputSchema.safeParse({ action: 'start', statement: 'Lead first.' }).success).toBe(false);
    expect(TeamDecideInputSchema.safeParse({
      action: 'start',
      topic: '',
      statement: 'Lead first.',
    }).success).toBe(false);
    expect(TeamDecideInputSchema.safeParse({
      action: 'start',
      topic: '   ',
      statement: 'Lead first.',
    }).success).toBe(false);
    expect(TeamDecideInputSchema.safeParse({ action: 'continue', statement: 'Round two.' }).success).toBe(true);
    expect(TeamDecideInputSchema.safeParse({ action: 'continue' }).success).toBe(false);
    expect(TeamDecideInputSchema.safeParse({ action: 'vote' }).success).toBe(true);
    const decide = new TeamDecideTool(host);
    const decideArgs = compileToolArgsValidator(decide.parameters);
    expect(validateToolArgs(decideArgs, {
      action: 'start',
      topic: 'Review the cache path',
      statement: 'The cache key must stay stable.',
    })).toBeNull();
    expect(validateToolArgs(decideArgs, { action: 'start', statement: 'Lead first.' })).toContain('topic');
    expect(validateToolArgs(decideArgs, {
      action: 'start',
      topic: '',
      statement: 'Lead first.',
    })).toMatch(/topic|fewer than 1|minLength|must NOT/i);
    expect(validateToolArgs(decideArgs, { action: 'vote' })).toBeNull();
    expect(TeamAssignInputSchema.safeParse({
      assignments: [{ agent_id: 'agent-review', task: 'Review tests.' }],
    }).success).toBe(true);
    expect(TeamSpeakInputSchema.safeParse({ message: 'The cache key is stable.' }).success).toBe(true);
    expect(TeamStatusInputSchema.safeParse({}).success).toBe(true);
    expect(assign.description).toContain('stay within its non-null assigned task');
    expect(assign.description).toContain('TeamDM');
    expect(decide.description).toContain('multi-round');
    expect(speak.description).toContain('Only TeamSpeak is a formal statement');
    expect(speak.description).toContain('do not finish the whole problem');
    expect(status.description).toContain('latest explicit TeamDM report status');
    expect(status.description).toContain('Ordinary TeamDM messages are not classified as reports');
    expect(TeamDMInputSchema.safeParse({
      agent_id: 'agent-review',
      message: 'ordinary coordination',
    }).success).toBe(true);
    expect(TeamDMInputSchema.safeParse({
      agent_id: 'agent-review',
      message: 'done',
      report_status: 'completed',
    }).success).toBe(false);
    expect(TeamDMInputSchema.safeParse({
      agent_id: 'agent-review',
      message: 'done',
      report_status: 'completed',
      report_summary: 'Checks passed.',
    }).success).toBe(true);

    const created = await executeTool(create, context({ members }));
    const assigned = await executeTool(assign, context({
      assignments: [{ agent_id: 'agent-review', task: 'Review tests.' }],
    }));
    const spoken = await executeTool(speak, context({ message: 'The cache key is stable.' }));
    const currentStatus = await executeTool(status, context({}));

    expect(created.output).toContain('agent-review');
    expect(created.output).toContain('sess_reviewer');
    const updated = await executeTool(update, context({ name: 'Lead reviewer', tags: ['review'] }));
    expect(updated.output).toContain('"updated":true');
    expect(updateTeamIdentity).toHaveBeenCalledWith({
      agentId: undefined,
      name: 'Lead reviewer',
      role: undefined,
      mandate: undefined,
      tags: ['review'],
    });
    expect(assigned.output).toContain('turnId');
    expect(assignTeam).toHaveBeenCalledWith(
      [{ agentId: 'agent-review', task: 'Review tests.' }],
      signal,
    );
    expect(spoken.output).toBe('Statement published.');
    expect(spoken.stopTurn).toBe(true);
    expect(speakInDiscussion).toHaveBeenCalledWith('The cache key is stable.');
    const statusOutput = typeof currentStatus.output === 'string' ? currentStatus.output : '';
    expect(JSON.parse(statusOutput)).toMatchObject({
      member_count: 1,
      members: [{ agent_id: 'agent-review', status: 'idle', assigned_task: 'Review tests.' }],
    });
    expect(JSON.parse(statusOutput).members[0]).not.toHaveProperty('title');
    expect(JSON.parse(statusOutput).members[0]).not.toHaveProperty('intro');
    expect(JSON.parse(statusOutput).members[0]).toMatchObject({
      name: 'Reviewer',
      role: 'reviewer',
      mandate: 'Review behavior.',
    });
    expect(getTeamStatus).toHaveBeenCalledWith();
  });

  it('Session topology tools search, mount, unmount, and read the forest', async () => {
    const searchSessions = vi.fn(async () => [{
      sessionId: 'sess_reviewer',
      title: 'Reviewer',
      role: 'reviewer',
    }]);
    const remountSession = vi.fn(async () => undefined);
    const unmountSession = vi.fn(async () => undefined);
    const sessionGraph = vi.fn(async () => ({
      nodes: [
        { id: 'lead', title: 'Lead' },
        { id: 'sess_reviewer', title: 'Reviewer', parentSessionId: 'lead' },
      ],
    }));
    const host = mockTeamHost({
      searchSessions,
      remountSession,
      unmountSession,
      sessionGraph,
      currentSessionId: () => 'lead',
    });
    const search = new SessionSearchTool(host);
    const mount = new SessionMountTool(host);
    const unmount = new SessionUnmountTool(host);
    const graph = new SessionGraphTool(host);

    expect(SessionSearchInputSchema.safeParse({ query: 'review' }).success).toBe(true);
    expect(SessionMountInputSchema.safeParse({ session_id: 'sess_reviewer' }).success).toBe(true);
    expect(SessionUnmountInputSchema.safeParse({ session_id: 'sess_reviewer' }).success).toBe(true);
    expect(SessionGraphInputSchema.safeParse({}).success).toBe(true);

    const searched = await executeTool(search, context({ query: 'review' }));
    expect(JSON.parse(String(searched.output))).toEqual({
      hits: [{ sessionId: 'sess_reviewer', title: 'Reviewer', role: 'reviewer' }],
    });
    const mounted = await executeTool(mount, context({
      session_id: 'sess_reviewer',
      role: 'reviewer',
    }));
    expect(JSON.parse(String(mounted.output))).toEqual({
      mounted: 'sess_reviewer',
      parent_session_id: 'lead',
    });
    expect(remountSession).toHaveBeenCalledWith('sess_reviewer', 'lead', 'reviewer', undefined);
    const unmounted = await executeTool(unmount, context({ session_id: 'sess_reviewer' }));
    expect(JSON.parse(String(unmounted.output))).toEqual({ unmounted: 'sess_reviewer' });
    const graphResult = await executeTool(graph, context({}));
    expect(JSON.parse(String(graphResult.output)).nodes).toHaveLength(2);
  });

  it('AskUserQuestion exposes parameters and asks through rpc in yolo mode', async () => {
    const tool = new AskUserQuestionTool({
      experimentalFlags: new FlagResolver({}, FLAG_DEFINITIONS),
      permission: { mode: 'yolo' },
      rpc: {
        requestQuestion: vi.fn(async () => ({ 'Which path?': 'A' })),
      },
      telemetry: { track: vi.fn() },
    } as unknown as Agent);

    const input = {
      questions: [
        {
          question: 'Which path?',
          header: 'Path',
          options: [
            { label: 'A', description: 'Use A' },
            { label: 'B', description: 'Use B' },
          ],
          multi_select: false,
        },
      ],
    };
    expect(AskUserQuestionInputSchema.safeParse(input).success).toBe(true);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { questions: { type: 'array' } },
    });

    const result = await executeTool(tool, context(input));
    expect(result.output).toBe(JSON.stringify({ answers: { 'Which path?': 'A' } }));
  });

  it('AskUserQuestion documents the answers result shape and dismissal handling', () => {
    // The result is JSON {answers}; a dismissal returns isError:false with empty
    // answers + a note (ask-user.ts), so the description must teach the model to
    // fall back rather than silently re-ask.
    const description = new AskUserQuestionTool({} as unknown as Agent).description.toLowerCase();
    expect(description).toContain('answers');
    expect(description).toContain('dismiss');
  });

  it('Skill exposes parameters and reports unknown skills as tool errors', async () => {
    const tool = new SkillTool({
      skills: {
        registry: new SessionSkillRegistry(),
        recordActivation: vi.fn(),
      },
      context: {
        appendSystemReminder: vi.fn(),
      },
    } as unknown as Agent);

    expect(SkillToolInputSchema.safeParse({ skill: 'missing' }).success).toBe(true);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { skill: { type: 'string' } },
    });

    const result = await executeTool(tool, context({ skill: 'missing' }));
    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('not found');
  });

  it('nori_memory_search exposes and executes chained retrieval', async () => {
    const memory: NoriMemoryProvider = {
      multiRetrieve: vi.fn(async (keywords: string[]) => {
        if (keywords.includes('TeamAssign')) {
          return [
            {
              title: 'TeamAssign ADR',
              path: 'decisions/team-assign.md',
              score: 3,
              excerpt: 'TeamAssign delegates work. See [[Permission Rules]].',
            },
          ];
        }
        if (keywords.includes('Permission Rules')) {
          return [
            {
              title: 'Permission Rules',
              path: 'analysis/permission-rules.md',
              score: 2,
              excerpt: 'Readonly mode allows memory APIs and blocks direct writes.',
            },
          ];
        }
        return [];
      }),
      writeNote: vi.fn(),
      removeNote: vi.fn(async () => false),
    };
    const tool = new NoriMemorySearchTool(memory);
    const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;

    expect(properties).toHaveProperty('chain_depth');
    expect(properties).toHaveProperty('follow_up_keywords');
    expect(
      NoriMemorySearchInputSchema.safeParse({
        keywords: ['TeamAssign'],
        include_linked: true,
        link_depth: 1,
        chain_depth: 1,
      }).success,
    ).toBe(true);

    const result = await executeTool(
      tool,
      context({
        keywords: ['TeamAssign'],
        include_linked: true,
        link_depth: 1,
        chain_depth: 1,
      }),
    );

    expect(memory.multiRetrieve).toHaveBeenCalledTimes(2);
    expect(result.output).toContain('Found 2 unique note(s)');
    expect(result.output).toContain('## Hop 1');
    expect(result.output).toContain('Permission Rules');
  });
});

describe('current builtin background tool schemas', () => {
  it('background task schemas and manager-backed tools are covered', () => {
    const manager = createBackgroundManager().manager;

    expect(TaskListInputSchema.safeParse({ active_only: true }).success).toBe(true);
    expect(TaskOutputInputSchema.safeParse({ task_id: 'bash-1' }).success).toBe(true);
    expect(TaskStopInputSchema.safeParse({ task_id: 'bash-1' }).success).toBe(true);
    expect(manager.list()).toEqual([]);
  });
});
