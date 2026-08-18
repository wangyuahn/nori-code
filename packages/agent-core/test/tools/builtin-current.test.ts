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
import {
  type QueuedSubagentRunResult,
  type QueuedSubagentTask,
  SessionSubagentHost,
} from '../../src/session/subagent-host';
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
  TeamSpeakInputSchema,
  TeamSpeakTool,
} from '../../src/tools/builtin/collaboration/team';
import { TeamStatusInputSchema, TeamStatusTool } from '../../src/tools/builtin/collaboration/team-status';
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
  SubAgentTool,
  SubAgentToolInputSchema,
} from '../../src/tools/builtin/collaboration/subagent';
import {
  NoriAskParentInputSchema,
  NoriAskParentTool,
} from '../../src/tools/builtin/nori/nori-ask-parent';
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

function mockSubagentHost<T extends Partial<SessionSubagentHost>>(
  host: T,
): T & SessionSubagentHost {
  return {
    spawn: vi.fn(),
    resume: vi.fn(),
    runQueued: vi.fn(),
    getSubagentItem: vi.fn(),
    ...host,
  } as unknown as T & SessionSubagentHost;
}

/** Preserve result-oriented assertions while exercising the detached runtime contract. */
function settledSubAgentTool(host: SessionSubagentHost): SubAgentTool {
  const background = createBackgroundManager().manager;
  const tool = new SubAgentTool(host, background);
  const resolveExecution = tool.resolveExecution.bind(tool);
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    resolveExecution(args) {
      const execution = resolveExecution(args);
      if (execution.isError === true) return execution;
      return {
        ...execution,
        execute: async (ctx) => {
          const launched = await execution.execute(ctx);
          if (launched.isError === true || typeof launched.output !== 'string') return launched;
          const taskId = launched.output.match(/task_id: (subagent-[0-9a-z]{8})/)?.[1];
          if (taskId === undefined) return launched;
          await background.wait(taskId);
          const output = await background.readOutput(taskId);
          const finalResultStart = output.lastIndexOf('<subagent_result>');
          return { output: finalResultStart < 0 ? output : output.slice(finalResultStart) };
        },
      };
    },
  } as SubAgentTool;
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
      identity: {
        name: 'Reviewer',
        title: 'Risk reviewer',
        intro: 'Checks regressions.',
        mandate: 'Review behavior.',
        role: 'reviewer',
      },
    }]);
    const assignTeam = vi.fn(async () => [{ agentId: 'agent-review', task: 'Review tests.', turnId: 7 }]);
    const speakInDiscussion = vi.fn(async () => ({ discussionAgentId: 'agent-discussion', entryId: 4 }));
    const host = mockSubagentHost({ createTeam, assignTeam, speakInDiscussion });

    const create = new TeamCreateTool(host);
    const assign = new TeamAssignTool(host);
    const speak = new TeamSpeakTool(host);
    const getTeamStatus = vi.fn(async () => ({
      agent_id: 'main',
      member_count: 1,
      message: 'Direct persistent Team Agent status.',
      members: [{
        agent_id: 'agent-review',
        name: 'Reviewer',
        title: 'Risk reviewer',
        intro: 'Checks regressions.',
        role: 'reviewer',
        mandate: 'Review behavior.',
        status: 'idle' as const,
        assigned_task: 'Review tests.',
      }],
    }));
    const status = new TeamStatusTool(mockSubagentHost({ getTeamStatus }));
    const members = [{
      name: 'Reviewer',
      title: 'Risk reviewer',
      intro: 'Checks regressions.',
      mandate: 'Review behavior.',
      role: 'reviewer',
    }];
    expect(TeamCreateInputSchema.safeParse({ members }).success).toBe(true);
    expect(TeamCreateInputSchema.safeParse({ members: [{ ...members[0], intro: '' }] }).success).toBe(false);
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

    const created = await executeTool(create, context({ members }));
    const assigned = await executeTool(assign, context({
      assignments: [{ agent_id: 'agent-review', task: 'Review tests.' }],
    }));
    const spoken = await executeTool(speak, context({ message: 'The cache key is stable.' }));
    const currentStatus = await executeTool(status, context({}));

    expect(created.output).toContain('agent-review');
    expect(assigned.output).toContain('turnId');
    expect(assignTeam).toHaveBeenCalledWith(
      [{ agentId: 'agent-review', task: 'Review tests.' }],
      signal,
    );
    expect(spoken.output).toBe('Statement published.');
    expect(speakInDiscussion).toHaveBeenCalledWith('The cache key is stable.');
    const statusOutput = typeof currentStatus.output === 'string' ? currentStatus.output : '';
    expect(JSON.parse(statusOutput)).toMatchObject({
      member_count: 1,
      members: [{ agent_id: 'agent-review', status: 'idle', assigned_task: 'Review tests.' }],
    });
    expect(getTeamStatus).toHaveBeenCalledWith();
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

  it('SubAgent returns before temporary workers complete and arms no timeout', async () => {
    let queued: readonly QueuedSubagentTask<unknown>[] = [];
    let resolveBatch: (results: QueuedSubagentRunResult<unknown>[]) => void = () => {};
    const runQueued = (<T>(tasks: readonly QueuedSubagentTask<T>[]) => {
      queued = tasks;
      return new Promise<QueuedSubagentRunResult<T>[]>((resolve) => {
        resolveBatch = resolve as (results: QueuedSubagentRunResult<unknown>[]) => void;
      });
    }) satisfies SessionSubagentHost['runQueued'];
    const host = mockSubagentHost({ runQueued });
    const background = createBackgroundManager().manager;
    const tool = new SubAgentTool(host, background);
    const input = {
      description: 'Review files',
      prompt_template: 'Review {{item}}',
      items: ['src/a.ts', 'src/b.ts'],
    };

    const launched = await executeTool(tool, context(input, 'call_subagent'));

    expect(launched.output).toContain('status: running');
    const taskId = String(launched.output).match(/task_id: (subagent-[0-9a-z]{8})/)?.[1];
    expect(taskId).toBeDefined();
    expect(background.getTask(taskId!)).toMatchObject({
      detached: true,
      status: 'running',
      timeoutMs: undefined,
      subagentType: 'subagent:2',
    });
    expect(queued).toHaveLength(2);
    expect(queued.every((task) => task.runInBackground && task.timeout === undefined)).toBe(true);

    resolveBatch(queued.map((task, index) => ({
      task,
      agentId: `agent-${String(index + 1)}`,
      status: 'completed' as const,
      result: `result ${String(index + 1)}`,
    })));
    await expect(background.wait(taskId!)).resolves.toMatchObject({ status: 'completed' });
    await expect(background.readOutput(taskId!)).resolves.toContain('result 2');
  });

  it('SubAgent applies one subagent_type across templated temporary workers', async () => {
    const host = mockSubagentHost({
      runQueued: vi.fn().mockResolvedValue([
        {
          task: {
            kind: 'spawn',
            data: { kind: 'spawn', index: 1, item: 'src/a.ts', prompt: 'Review src/a.ts' },
            profileName: 'explore',
            parentToolCallId: 'call_subagent',
            prompt: 'Review src/a.ts',
            description: 'Review files #1 (explore)',
        runInBackground: true,
          },
          agentId: 'agent-explore-1',
          status: 'completed',
          result: 'explore result a',
        },
        {
          task: {
            kind: 'spawn',
            data: { kind: 'spawn', index: 2, item: 'src/b.ts', prompt: 'Review src/b.ts' },
            profileName: 'explore',
            parentToolCallId: 'call_subagent',
            prompt: 'Review src/b.ts',
            description: 'Review files #2 (explore)',
        runInBackground: true,
          },
          agentId: 'agent-explore-2',
          status: 'completed',
          result: 'explore result b',
        },
      ]),
    });
    const tool = settledSubAgentTool(host);
    const input = {
      description: 'Review files',
      prompt_template: 'Review {{item}}',
      items: ['src/a.ts', 'src/b.ts'],
      subagent_type: 'explore',
    };

    expect(SubAgentToolInputSchema.safeParse(input).success).toBe(true);
    expect(
      SubAgentToolInputSchema.safeParse({
        ...input,
        items: Array.from({ length: 128 }, (_, index) => `src/${String(index + 1)}.ts`),
      }).success,
    ).toBe(true);
    expect(
      SubAgentToolInputSchema.safeParse({
        ...input,
        items: Array.from({ length: 129 }, (_, index) => `src/${String(index + 1)}.ts`),
      }).success,
    ).toBe(false);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        subagent_type: { type: 'string' },
      },
    });
    expect(tool.parameters).not.toMatchObject({
      properties: { resume_agent_ids: expect.anything() },
    });

    const result = await executeTool(tool, context(input, 'call_subagent'));
    expect(host.runQueued).toHaveBeenCalledTimes(1);
    expect(host.runQueued).toHaveBeenCalledWith(
      [
        {
          kind: 'spawn',
          data: { kind: 'spawn', index: 1, item: 'src/a.ts', prompt: 'Review src/a.ts' },
          profileName: 'explore',
          parentToolCallId: 'call_subagent',
          prompt: 'Review src/a.ts',
          description: 'Review files #1 (explore)',
          subagentIndex: 1,
          subagentItem: 'src/a.ts',
        runInBackground: true,
          signal: expect.any(AbortSignal),
        },
        {
          kind: 'spawn',
          data: { kind: 'spawn', index: 2, item: 'src/b.ts', prompt: 'Review src/b.ts' },
          profileName: 'explore',
          parentToolCallId: 'call_subagent',
          prompt: 'Review src/b.ts',
          description: 'Review files #2 (explore)',
          subagentIndex: 2,
          subagentItem: 'src/b.ts',
        runInBackground: true,
          signal: expect.any(AbortSignal),
        },
      ],
    );
    expect(result.output).toBe([
      '<subagent_result>',
      '<summary>completed: 2</summary>',
      '<subagent item="src/a.ts" outcome="completed">explore result a</subagent>',
      '<subagent item="src/b.ts" outcome="completed">explore result b</subagent>',
      '</subagent_result>',
    ].join('\n'));
    expect(result.isError).toBeUndefined();
  });

  it('SubAgent does not expose permission rule argument matching', () => {
    const tool = new SubAgentTool(mockSubagentHost({}));
    const execution = tool.resolveExecution({
      description: 'Review files',
      prompt_template: 'Review {{item}}',
      items: ['src/a.ts', 'src/b.ts'],
    });
    if (execution.isError === true) throw new Error('SubAgent resolveExecution returned an error');

    expect(execution.approvalRule).toBe('SubAgent');
    expect(execution.matchesRule).toBeUndefined();
  });

  it('SubAgent description states the enforced input requirements', () => {
    const description = new SubAgentTool(mockSubagentHost({})).description;
    // Mirrors the current SubAgent input guidance.
    expect(description).toContain('at least one');
    expect(description).toContain('dependencies');
    expect(description).toContain('prompt_template');
    expect(description).toContain('items');
  });

  it('SubAgent runs heterogeneous task DAGs by dependency layer', async () => {
    const runQueued = vi.fn(
      async <T>(
        tasks: readonly QueuedSubagentTask<T>[],
      ): Promise<Array<QueuedSubagentRunResult<T>>> => {
        return tasks.map((task) => {
          const spec = task.data as { id?: string; index: number };
          const id = spec.id ?? String(spec.index);
          return {
            task,
            agentId: `agent-${id}`,
            status: 'completed' as const,
            result: `done ${id}`,
          };
        });
      },
    );
    const host = mockSubagentHost({
      runQueued: runQueued as unknown as SessionSubagentHost['runQueued'],
    });
    const tool = settledSubAgentTool(host);
    const input = {
      description: 'Ship feature',
      tasks: [
        {
          id: 'plan',
          description: 'Plan the change',
          subagent_type: 'explore',
          prompt: 'Inspect the code and produce an implementation plan.',
        },
        {
          id: 'implement',
          description: 'Implement the change',
          subagent_type: 'coder',
          depends_on: ['plan'],
          prompt: 'Implement the accepted plan.',
        },
        {
          id: 'review',
          description: 'Review the change',
          subagent_type: 'explore',
          depends_on: ['implement'],
          prompt: 'Review the implementation and report regressions.',
        },
      ],
    };

    expect(SubAgentToolInputSchema.safeParse(input).success).toBe(true);

    const result = await executeTool(tool, context(input, 'call_subagent'));

    expect(runQueued).toHaveBeenCalledTimes(3);
    expect(runQueued.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        kind: 'spawn',
        profileName: 'explore',
        prompt: 'Inspect the code and produce an implementation plan.',
        description: 'Ship feature #1 (explore): Plan the change',
        subagentItem: 'plan',
      }),
    ]);
    expect((runQueued.mock.calls[1]?.[0] as readonly QueuedSubagentTask[])[0]?.prompt).toContain(
      '<dependency task_id="plan" outcome="completed">done plan</dependency>',
    );
    expect((runQueued.mock.calls[2]?.[0] as readonly QueuedSubagentTask[])[0]?.prompt).toContain(
      '<dependency task_id="implement" outcome="completed">done implement</dependency>',
    );
    expect(result.output).toBe([
      '<subagent_result>',
      '<summary>completed: 3</summary>',
      '<subagent task_id="plan" outcome="completed">done plan</subagent>',
      '<subagent task_id="implement" outcome="completed">done implement</subagent>',
      '<subagent task_id="review" outcome="completed">done review</subagent>',
      '</subagent_result>',
    ].join('\n'));
    expect(result.isError).toBeUndefined();
  });

  it('SubAgent reports downstream DAG tasks as not started when a dependency fails', async () => {
    const runQueued = vi.fn(
      async <T>(
        tasks: readonly QueuedSubagentTask<T>[],
      ): Promise<Array<QueuedSubagentRunResult<T>>> => {
        return tasks.map((task) => ({
          task,
          agentId: 'agent-plan',
          status: 'failed' as const,
          error: 'plan failed',
        }));
      },
    );
    const host = mockSubagentHost({
      runQueued: runQueued as unknown as SessionSubagentHost['runQueued'],
    });
    const tool = settledSubAgentTool(host);

    const result = await executeTool(
      tool,
      context(
        {
          description: 'Ship feature',
          tasks: [
            { id: 'plan', prompt: 'Plan the change.' },
            { id: 'implement', depends_on: ['plan'], prompt: 'Implement the plan.' },
          ],
        },
        'call_subagent',
      ),
    );

    expect(runQueued).toHaveBeenCalledTimes(1);
    expect(result.output).toBe([
      '<subagent_result>',
      '<summary>failed: 2</summary>',
      '<subagent task_id="plan" outcome="failed">plan failed</subagent>',
      '<subagent task_id="implement" state="not_started" outcome="failed">Dependency "plan" did not complete successfully.</subagent>',
      '</subagent_result>',
    ].join('\n'));
    expect(result.isError).toBeUndefined();
  });

  it('SubAgent rejects more than 128 temporary workers at execution time', async () => {
    const host = mockSubagentHost({ runQueued: vi.fn() });
    const tool = settledSubAgentTool(host);

    const result = await executeTool(
      tool,
      context({
        description: 'Review files',
        prompt_template: 'Review {{item}}',
        items: Array.from({ length: 129 }, (_, index) => `src/${String(index + 1)}.ts`),
      }),
    );

    expect(result.output).toBe('SubAgent supports at most 128 subagents.');
    expect(result.isError).toBe(true);
    expect(host.runQueued).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'items without a prompt template',
      input: {
        description: 'Review files',
        items: ['src/a.ts', 'src/b.ts'],
      },
      output: 'prompt_template is required when items are provided.',
    },
    {
      name: 'a prompt template without the item placeholder',
      input: {
        description: 'Review files',
        prompt_template: 'Review files',
        items: ['src/a.ts', 'src/b.ts'],
      },
      output: 'prompt_template must include the {{item}} placeholder.',
    },
  ])('SubAgent rejects $name at execution time', async ({ input, output }) => {
    const host = mockSubagentHost({ runQueued: vi.fn() });
    const tool = settledSubAgentTool(host);

    const result = await executeTool(tool, context(input));

    expect(result.output).toBe(output);
    expect(result.isError).toBe(true);
    expect(host.runQueued).not.toHaveBeenCalled();
  });

  it('SubAgent rejects legacy resume_agent_ids instead of reviving a temporary worker', () => {
    expect(
      SubAgentToolInputSchema.safeParse({
        description: 'Resume old work',
        resume_agent_ids: { 'agent-old-1': 'Continue previous review A' },
      }).success,
    ).toBe(false);
  });

  it('SubAgent reports failed temporary workers inside the XML result without failing the tool', async () => {
    const host = mockSubagentHost({
      runQueued: vi.fn().mockResolvedValue([
        {
          task: {
            kind: 'spawn',
            data: { kind: 'spawn', index: 1, item: 'src/a.ts', prompt: 'Review src/a.ts' },
            profileName: 'coder',
            parentToolCallId: 'call_subagent',
            prompt: 'Review src/a.ts',
            description: 'Review files #1 (coder)',
        runInBackground: true,
          },
          agentId: 'agent-coder-1',
          status: 'completed',
          result: 'imports are stable',
        },
        {
          task: {
            kind: 'spawn',
            data: { kind: 'spawn', index: 2, item: 'src/b.ts', prompt: 'Review src/b.ts' },
            profileName: 'coder',
            parentToolCallId: 'call_subagent',
            prompt: 'Review src/b.ts',
            description: 'Review files #2 (coder)',
        runInBackground: true,
          },
          agentId: 'agent-coder-2',
          status: 'failed',
          error: 'Agent timed out after 30s.',
        },
      ]),
    });
    const tool = settledSubAgentTool(host);

    const result = await executeTool(
      tool,
      context(
        {
          description: 'Review files',
          prompt_template: 'Review {{item}}',
          items: ['src/a.ts', 'src/b.ts'],
        },
        'call_subagent',
      ),
    );

    expect(result.output).toBe([
      '<subagent_result>',
      '<summary>completed: 1, failed: 1</summary>',
      '<subagent item="src/a.ts" outcome="completed">imports are stable</subagent>',
      '<subagent item="src/b.ts" outcome="failed">Agent timed out after 30s.</subagent>',
      '</subagent_result>',
    ].join('\n'));
    expect(result.isError).toBeUndefined();
  });

  it('SubAgent never exposes a resumable temporary worker identifier', async () => {
    const host = mockSubagentHost({
      runQueued: vi.fn().mockResolvedValue([
        {
          task: {
            kind: 'spawn',
            data: { kind: 'spawn', index: 1, item: 'src/a.ts', prompt: 'Review src/a.ts' },
            profileName: 'coder',
            parentToolCallId: 'call_subagent',
            prompt: 'Review src/a.ts',
            description: 'Review files #1 (coder)',
        runInBackground: true,
          },
          status: 'failed',
          error: 'Agent did not start.',
        },
        {
          task: {
            kind: 'spawn',
            data: { kind: 'spawn', index: 2, item: 'src/b.ts', prompt: 'Review src/b.ts' },
            profileName: 'coder',
            parentToolCallId: 'call_subagent',
            prompt: 'Review src/b.ts',
            description: 'Review files #2 (coder)',
        runInBackground: true,
          },
          status: 'failed',
          error: 'Agent also did not start.',
        },
      ]),
    });
    const tool = settledSubAgentTool(host);

    const result = await executeTool(
      tool,
      context(
        {
          description: 'Review files',
          prompt_template: 'Review {{item}}',
          items: ['src/a.ts', 'src/b.ts'],
        },
        'call_subagent',
      ),
    );

    expect(result.output).toBe([
      '<subagent_result>',
      '<summary>failed: 2</summary>',
      '<subagent item="src/a.ts" outcome="failed">Agent did not start.</subagent>',
      '<subagent item="src/b.ts" outcome="failed">Agent also did not start.</subagent>',
      '</subagent_result>',
    ].join('\n'));
    expect(result.isError).toBeUndefined();
  });

  it('SubAgent reports partial aborted temporary workers inside the XML result', async () => {
    const host = mockSubagentHost({
      runQueued: vi.fn().mockResolvedValue([
        {
          task: {
            kind: 'spawn',
            data: { kind: 'spawn', index: 1, item: 'src/a.ts', prompt: 'Review src/a.ts' },
            profileName: 'coder',
            parentToolCallId: 'call_subagent',
            prompt: 'Review src/a.ts',
            description: 'Review files #1 (coder)',
        runInBackground: true,
          },
          agentId: 'agent-coder-1',
          status: 'completed',
          result: 'imports are stable',
        },
        {
          task: {
            kind: 'spawn',
            data: { kind: 'spawn', index: 2, item: 'src/b.ts', prompt: 'Review src/b.ts' },
            profileName: 'coder',
            parentToolCallId: 'call_subagent',
            prompt: 'Review src/b.ts',
            description: 'Review files #2 (coder)',
        runInBackground: true,
          },
          agentId: 'agent-coder-2',
          status: 'aborted',
          state: 'started',
          error: 'The user manually interrupted this subagent batch before this subagent finished.',
        },
        {
          task: {
            kind: 'spawn',
            data: { kind: 'spawn', index: 3, item: 'src/c.ts', prompt: 'Review src/c.ts' },
            profileName: 'coder',
            parentToolCallId: 'call_subagent',
            prompt: 'Review src/c.ts',
            description: 'Review files #3 (coder)',
        runInBackground: true,
          },
          status: 'aborted',
          state: 'not_started',
          error: 'The user manually interrupted this subagent batch before this subagent was started.',
        },
      ]),
    });
    const tool = settledSubAgentTool(host);

    const result = await executeTool(
      tool,
      context(
        {
          description: 'Review files',
          prompt_template: 'Review {{item}}',
          items: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
        },
        'call_subagent',
      ),
    );

    expect(result.output).toBe([
      '<subagent_result>',
      '<summary>completed: 1, aborted: 2</summary>',
      '<subagent item="src/a.ts" outcome="completed">imports are stable</subagent>',
      '<subagent item="src/b.ts" state="started" outcome="aborted">The user manually interrupted this subagent batch before this subagent finished.</subagent>',
      '<subagent item="src/c.ts" state="not_started" outcome="aborted">The user manually interrupted this subagent batch before this subagent was started.</subagent>',
      '</subagent_result>',
    ].join('\n'));
    expect(result.isError).toBeUndefined();
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
        if (keywords.includes('SubAgent')) {
          return [
            {
              title: 'SubAgent ADR',
              path: 'decisions/subagent.md',
              score: 3,
              excerpt: 'SubAgent delegates work. See [[Permission Rules]].',
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
        keywords: ['SubAgent'],
        include_linked: true,
        link_depth: 1,
        chain_depth: 1,
      }).success,
    ).toBe(true);

    const result = await executeTool(
      tool,
      context({
        keywords: ['SubAgent'],
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

  it('nori_ask_parent routes subagent questions through the parent channel', async () => {
    const askOwnerParent = vi.fn(async () => 'parent answer');
    const tool = new NoriAskParentTool({
      type: 'sub',
      subagentHost: { askOwnerParent },
    } as unknown as Agent);

    expect(
      NoriAskParentInputSchema.safeParse({
        question: 'Which implementation path should I take?',
        context: 'Two APIs are possible.',
      }).success,
    ).toBe(true);

    const result = await executeTool(
      tool,
      context({
        question: 'Which implementation path should I take?',
        context: 'Two APIs are possible.',
      }),
    );

    expect(askOwnerParent).toHaveBeenCalledWith(
      '[Context]\nTwo APIs are possible.\n\n[Question]\nWhich implementation path should I take?',
    );
    expect(result.output).toBe('parent answer');
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
