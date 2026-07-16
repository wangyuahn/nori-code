/**
 * Current builtin tool smoke coverage.
 *
 * This complements focused tool tests by ensuring every current builtin
 * has at least one schema assertion and one execution/error-path assertion.
 */

import { Readable, type Writable } from 'node:stream';

import type { Kaos, KaosProcess } from '@nori-code/kaos';
import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../src/agent';
import { SwarmBackgroundTask } from '../../src/agent/background';
import type { SwarmMode } from '../../src/agent/swarm';
import { FLAG_DEFINITIONS, FlagResolver } from '../../src/flags';
import {
  type QueuedSubagentRunResult,
  type QueuedSubagentTask,
  SessionSubagentHost,
} from '../../src/session/subagent-host';
import type { Session } from '../../src/session';
import { SessionSkillRegistry } from '../../src/skill';
import { TaskListInputSchema } from '../../src/tools/background/task-list';
import { TaskOutputInputSchema } from '../../src/tools/background/task-output';
import { TaskStopInputSchema } from '../../src/tools/background/task-stop';
import { AgentTool, AgentToolInputSchema } from '../../src/tools/builtin/collaboration/agent';
import {
  AskUserQuestionInputSchema,
  AskUserQuestionTool,
} from '../../src/tools/builtin/collaboration/ask-user';
import { SkillTool, SkillToolInputSchema } from '../../src/tools/builtin/collaboration/skill-tool';
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
  AgentSwarmTool,
  AgentSwarmToolInputSchema,
} from '../../src/tools/builtin/collaboration/agent-swarm';
import { AgentSwarmControlTool } from '../../src/tools/builtin/collaboration/agent-swarm-control';
import {
  NoriAskParentInputSchema,
  NoriAskParentTool,
} from '../../src/tools/builtin/nori/nori-ask-parent';
import {
  NoriMemorySearchInputSchema,
  NoriMemorySearchTool,
} from '../../src/tools/builtin/nori/nori-memory-search';
import { NoriPlanWriteTool } from '../../src/tools/builtin/nori/nori-plan-write';
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
    getSwarmItem: vi.fn(),
    ...host,
  } as unknown as T & SessionSubagentHost;
}

function agentTool(host: SessionSubagentHost): AgentTool {
  return new AgentTool(host, createBackgroundManager().manager);
}

function mockSwarmMode(): SwarmMode {
  return { enter: vi.fn() } as unknown as SwarmMode;
}

/** Preserve result-oriented assertions while exercising the detached runtime contract. */
function settledSwarmTool(host: SessionSubagentHost, swarmMode: SwarmMode): AgentSwarmTool {
  const background = createBackgroundManager().manager;
  const tool = new AgentSwarmTool(host, swarmMode, background);
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
          const taskId = launched.output.match(/task_id: (swarm-[0-9a-z]{8})/)?.[1];
          if (taskId === undefined) return launched;
          await background.wait(taskId);
          const output = await background.readOutput(taskId);
          const finalResultStart = output.lastIndexOf('<agent_swarm_result>');
          return { output: finalResultStart < 0 ? output : output.slice(finalResultStart) };
        },
      };
    },
  } as AgentSwarmTool;
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

  it('Edit exposes parameters and errors when old_string is missing', async () => {
    const tool = new EditTool(
      createFakeKaos({ readText: vi.fn().mockResolvedValue('alpha\nbeta\n') }),
      workspace,
    );

    expect(
      EditInputSchema.safeParse({
        path: '/workspace/a.txt',
        old_string: 'gamma',
        new_string: 'delta',
      }).success,
    ).toBe(true);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { old_string: { type: 'string' } },
    });

    const result = await executeTool(tool,
      context({ path: '/workspace/a.txt', old_string: 'gamma', new_string: 'delta' }),
    );
    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('old_string not found');
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
  it('AgentSwarmControl delegates session-wide tasks and preserves standalone fallback', async () => {
    const running = {
      taskId: 'swarm-nested',
      description: 'Nested review',
      status: 'running' as const,
      startedAt: 1,
      endedAt: null,
      kind: 'agent' as const,
      subagentType: 'swarm:2',
    };
    const paused = { ...running, paused: true };
    const listAgentSwarms = vi.fn(async () => [
      { ownerAgentId: 'agent-nested', task: running },
    ]);
    const controlAgentSwarm = vi.fn(async () => paused);
    const host = mockSubagentHost({ listAgentSwarms, controlAgentSwarm });
    const sessionFixture = createBackgroundManager();
    (sessionFixture.agent as typeof sessionFixture.agent & {
      subagentHost: SessionSubagentHost;
    }).subagentHost = host;
    const sessionTool = new AgentSwarmControlTool(sessionFixture.manager);

    const listed = await executeTool(sessionTool, context({ action: 'list' as const }));
    const pausedResult = await executeTool(
      sessionTool,
      context({ action: 'pause' as const, task_id: 'swarm-nested', prompt: 'hold' }),
    );

    expect(listed.output).toContain('task_id=swarm-nested status=running');
    expect(pausedResult.output).toContain('task_id=swarm-nested status=paused');
    expect(controlAgentSwarm).toHaveBeenCalledWith('swarm-nested', 'pause', 'hold');

    const standalone = createBackgroundManager().manager;
    vi.spyOn(standalone, 'getTask').mockReturnValue(running);
    const stop = vi.spyOn(standalone, 'stop').mockResolvedValue({
      ...running,
      status: 'killed',
      endedAt: 2,
    });
    const standaloneTool = new AgentSwarmControlTool(standalone);
    const stopped = await executeTool(
      standaloneTool,
      context({ action: 'stop' as const, task_id: 'swarm-nested' }),
    );

    expect(stopped.output).toContain('task_id=swarm-nested status=killed');
    expect(stop).toHaveBeenCalledWith('swarm-nested', 'Stopped by the main agent.');
  });

  it('AgentSwarmControl pauses, guides, and resumes a real session swarm', async () => {
    const main = createBackgroundManager();
    const owner = createBackgroundManager();
    let paused = false;
    const control = {
      get paused() { return paused; },
      pause: vi.fn(() => { paused = true; }),
      addGuidance: vi.fn(),
      resume: vi.fn(() => { paused = false; }),
    };
    const taskId = owner.manager.registerTask(new SwarmBackgroundTask(
      'Nested implementation',
      taskSignal => new Promise<string>((_resolve, reject) => {
        taskSignal.addEventListener('abort', () => reject(taskSignal.reason), { once: true });
      }),
      2,
      control,
    ));
    const session = {
      metadata: {
        agents: {
          main: { homedir: '/main', type: 'main', parentAgentId: null },
          'agent-owner': { homedir: '/owner', type: 'sub', parentAgentId: 'main' },
        },
      },
      ensureAgentResumed: vi.fn(async (agentId: string) => ({
        background: agentId === 'agent-owner' ? owner.manager : main.manager,
      })),
    } as unknown as Session;
    const host = new SessionSubagentHost(session, 'main');
    (main.agent as typeof main.agent & { subagentHost: SessionSubagentHost }).subagentHost = host;
    const tool = new AgentSwarmControlTool(main.manager);

    const pausedResult = await executeTool(tool, context({
      action: 'pause' as const,
      task_id: taskId,
      prompt: 'Hold before changing files',
    }));
    const guidedResult = await executeTool(tool, context({
      action: 'guide' as const,
      task_id: taskId,
      prompt: 'Also verify the parser',
    }));
    const resumedResult = await executeTool(tool, context({
      action: 'resume' as const,
      task_id: taskId,
      prompt: 'Continue with the new constraint',
    }));

    expect(pausedResult.output).toContain('status=paused');
    expect(guidedResult.output).toContain('status=paused');
    expect(resumedResult.output).toContain('status=running');
    expect(control.pause).toHaveBeenCalledWith('Hold before changing files');
    expect(control.addGuidance).toHaveBeenCalledWith('Also verify the parser');
    expect(control.resume).toHaveBeenCalledWith('Continue with the new constraint');
    expect(owner.agent.emittedEvents.filter(event => event.type === 'background.task.updated')).toHaveLength(3);

    await owner.manager.stop(taskId, 'test cleanup');
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

  it('Agent exposes parameters and launches a detached subagent', async () => {
    const host = mockSubagentHost({
      spawn: vi.fn().mockResolvedValue({
        agentId: 'agent-child',
        profileName: 'orchestrator',
        resumed: false,
        completion: Promise.resolve({ result: 'child result' }),
      }),
    });
    const tool = agentTool(host);

    const input = { prompt: 'Investigate', description: 'Find cause' };
    expect(AgentToolInputSchema.safeParse(input).success).toBe(true);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { prompt: { type: 'string' } },
    });

    const result = await executeTool(tool, context(input, 'call_agent'));
    expect(host.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: 'orchestrator',
        parentToolCallId: 'call_agent',
        prompt: 'Investigate',
        description: 'Find cause',
        runInBackground: true,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result.output).toContain('status: running');
    expect(result.output).not.toContain('child result');
  });

  it('AgentSwarm returns before child completion and arms no timeout', async () => {
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
    const tool = new AgentSwarmTool(host, mockSwarmMode(), background);
    const input = {
      description: 'Review files',
      prompt_template: 'Review {{item}}',
      items: ['src/a.ts', 'src/b.ts'],
    };

    const launched = await executeTool(tool, context(input, 'call_swarm'));

    expect(launched.output).toContain('status: running');
    const taskId = String(launched.output).match(/task_id: (swarm-[0-9a-z]{8})/)?.[1];
    expect(taskId).toBeDefined();
    expect(background.getTask(taskId!)).toMatchObject({
      detached: true,
      status: 'running',
      timeoutMs: undefined,
      subagentType: 'swarm:2',
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

  it('AgentSwarm applies one subagent_type across templated subagents', async () => {
    const host = mockSubagentHost({
      runQueued: vi.fn().mockResolvedValue([
        {
          task: {
            kind: 'spawn',
            data: { kind: 'spawn', index: 1, item: 'src/a.ts', prompt: 'Review src/a.ts' },
            profileName: 'explore',
            parentToolCallId: 'call_swarm',
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
            parentToolCallId: 'call_swarm',
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
    const swarmMode = mockSwarmMode();
    const tool = settledSwarmTool(host, swarmMode);
    const input = {
      description: 'Review files',
      prompt_template: 'Review {{item}}',
      items: ['src/a.ts', 'src/b.ts'],
      subagent_type: 'explore',
    };

    expect(AgentSwarmToolInputSchema.safeParse(input).success).toBe(true);
    expect(
      AgentSwarmToolInputSchema.safeParse({
        ...input,
        items: Array.from({ length: 128 }, (_, index) => `src/${String(index + 1)}.ts`),
      }).success,
    ).toBe(true);
    expect(
      AgentSwarmToolInputSchema.safeParse({
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
    expect(Object.keys(tool.parameters['properties'] as Record<string, unknown>).at(-1)).toBe(
      'resume_agent_ids',
    );

    const result = await executeTool(tool, context(input, 'call_swarm'));

    expect(swarmMode.enter).toHaveBeenCalledWith('tool');
    expect(host.runQueued).toHaveBeenCalledTimes(1);
    expect(host.runQueued).toHaveBeenCalledWith(
      [
        {
          kind: 'spawn',
          data: { kind: 'spawn', index: 1, item: 'src/a.ts', prompt: 'Review src/a.ts' },
          profileName: 'explore',
          parentToolCallId: 'call_swarm',
          prompt: 'Review src/a.ts',
          description: 'Review files #1 (explore)',
          swarmIndex: 1,
          swarmItem: 'src/a.ts',
        runInBackground: true,
          signal: expect.any(AbortSignal),
        },
        {
          kind: 'spawn',
          data: { kind: 'spawn', index: 2, item: 'src/b.ts', prompt: 'Review src/b.ts' },
          profileName: 'explore',
          parentToolCallId: 'call_swarm',
          prompt: 'Review src/b.ts',
          description: 'Review files #2 (explore)',
          swarmIndex: 2,
          swarmItem: 'src/b.ts',
        runInBackground: true,
          signal: expect.any(AbortSignal),
        },
      ],
    );
    expect(result.output).toBe([
      '<agent_swarm_result>',
      '<summary>completed: 2</summary>',
      '<subagent agent_id="agent-explore-1" item="src/a.ts" outcome="completed">explore result a</subagent>',
      '<subagent agent_id="agent-explore-2" item="src/b.ts" outcome="completed">explore result b</subagent>',
      '</agent_swarm_result>',
    ].join('\n'));
    expect(result.isError).toBeUndefined();
  });

  it('AgentSwarm does not expose permission rule argument matching', () => {
    const tool = new AgentSwarmTool(mockSubagentHost({}), mockSwarmMode());
    const execution = tool.resolveExecution({
      description: 'Review files',
      prompt_template: 'Review {{item}}',
      items: ['src/a.ts', 'src/b.ts'],
    });
    if (execution.isError === true) throw new Error('AgentSwarm resolveExecution returned an error');

    expect(execution.approvalRule).toBe('AgentSwarm');
    expect(execution.matchesRule).toBeUndefined();
  });

  it('AgentSwarm description states the enforced input requirements', () => {
    const description = new AgentSwarmTool(mockSubagentHost({}), mockSwarmMode()).description;
    // Mirrors the throws in createAgentSwarmSpecs (agent-swarm.ts): min-1-unless-resume,
    // prompt_template required + must contain {{item}}, distinct resulting prompts.
    expect(description).toContain('at least 1');
    expect(description).toContain('depends_on');
    expect(description).toContain('{{item}}');
    expect(description.toLowerCase()).toContain('distinct');
  });

  it('AgentSwarm runs heterogeneous task DAGs by dependency layer', async () => {
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
    const swarmMode = mockSwarmMode();
    const tool = settledSwarmTool(host, swarmMode);
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

    expect(AgentSwarmToolInputSchema.safeParse(input).success).toBe(true);

    const result = await executeTool(tool, context(input, 'call_swarm'));

    expect(runQueued).toHaveBeenCalledTimes(3);
    expect(runQueued.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        kind: 'spawn',
        profileName: 'explore',
        prompt: 'Inspect the code and produce an implementation plan.',
        description: 'Ship feature #1 (explore): Plan the change',
        swarmItem: 'plan',
      }),
    ]);
    expect((runQueued.mock.calls[1]?.[0] as readonly QueuedSubagentTask[])[0]?.prompt).toContain(
      '<dependency task_id="plan" outcome="completed">done plan</dependency>',
    );
    expect((runQueued.mock.calls[2]?.[0] as readonly QueuedSubagentTask[])[0]?.prompt).toContain(
      '<dependency task_id="implement" outcome="completed">done implement</dependency>',
    );
    expect(result.output).toBe([
      '<agent_swarm_result>',
      '<summary>completed: 3</summary>',
      '<subagent agent_id="agent-plan" task_id="plan" outcome="completed">done plan</subagent>',
      '<subagent agent_id="agent-implement" task_id="implement" outcome="completed">done implement</subagent>',
      '<subagent agent_id="agent-review" task_id="review" outcome="completed">done review</subagent>',
      '</agent_swarm_result>',
    ].join('\n'));
    expect(result.isError).toBeUndefined();
  });

  it('AgentSwarm reports downstream DAG tasks as not started when a dependency fails', async () => {
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
    const swarmMode = mockSwarmMode();
    const tool = settledSwarmTool(host, swarmMode);

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
        'call_swarm',
      ),
    );

    expect(runQueued).toHaveBeenCalledTimes(1);
    expect(result.output).toBe([
      '<agent_swarm_result>',
      '<summary>failed: 2</summary>',
      '<resume_hint>Call AgentSwarm with resume_agent_ids using the agent_id values in this result to continue unfinished work.</resume_hint>',
      '<subagent agent_id="agent-plan" task_id="plan" outcome="failed">plan failed</subagent>',
      '<subagent task_id="implement" state="not_started" outcome="failed">Dependency "plan" did not complete successfully.</subagent>',
      '</agent_swarm_result>',
    ].join('\n'));
    expect(result.isError).toBeUndefined();
  });

  it('AgentSwarm rejects more than 128 subagents at execution time', async () => {
    const host = mockSubagentHost({ runQueued: vi.fn() });
    const swarmMode = mockSwarmMode();
    const tool = settledSwarmTool(host, swarmMode);

    const result = await executeTool(
      tool,
      context({
        description: 'Review files',
        prompt_template: 'Review {{item}}',
        items: Array.from({ length: 129 }, (_, index) => `src/${String(index + 1)}.ts`),
      }),
    );

    expect(result.output).toBe('AgentSwarm supports at most 128 subagents.');
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
  ])('AgentSwarm rejects $name at execution time', async ({ input, output }) => {
    const host = mockSubagentHost({ runQueued: vi.fn() });
    const swarmMode = mockSwarmMode();
    const tool = settledSwarmTool(host, swarmMode);

    const result = await executeTool(tool, context(input));

    expect(result.output).toBe(output);
    expect(result.isError).toBe(true);
    expect(host.runQueued).not.toHaveBeenCalled();
  });

  it('AgentSwarm resumes mapped agents before spawning item subagents', async () => {
    const runQueued = vi.fn(
      async <T>(
        tasks: readonly QueuedSubagentTask<T>[],
      ): Promise<Array<QueuedSubagentRunResult<T>>> => {
        return tasks.map((task, index) => ({
          task,
          agentId: task.kind === 'resume' ? task.resumeAgentId : `agent-new-${String(index + 1)}`,
          status: 'completed' as const,
          result: `result ${String(index + 1)}`,
        }));
      },
    );
    const persistedItems: Record<string, string> = {
      'agent-old-1': 'src/old-a.ts',
      'agent-old-2': 'src/old-b.ts',
    };
    const host = mockSubagentHost({
      getSwarmItem: vi.fn((agentId: string) => persistedItems[agentId]),
      runQueued: runQueued as unknown as SessionSubagentHost['runQueued'],
    });
    const swarmMode = mockSwarmMode();
    const tool = settledSwarmTool(host, swarmMode);
    const input = {
      description: 'Finish review',
      subagent_type: 'explore',
      prompt_template: 'Review {{item}}',
      items: ['src/new.ts'],
      resume_agent_ids: {
        'agent-old-1': 'Continue previous review A',
        'agent-old-2': 'Continue previous review B',
      },
    };

    expect(AgentSwarmToolInputSchema.safeParse(input).success).toBe(true);
    expect(
      AgentSwarmToolInputSchema.safeParse({
        description: 'Resume two agents',
        resume_agent_ids: {
          'agent-old-1': 'Continue previous review A',
          'agent-old-2': 'Continue previous review B',
        },
      }).success,
    ).toBe(true);
    expect(
      AgentSwarmToolInputSchema.safeParse({
        description: 'Resume one agent',
        resume_agent_ids: {
          'agent-old-1': 'Continue previous review A',
        },
      }).success,
    ).toBe(true);

    const result = await executeTool(tool, context(input, 'call_swarm'));

    expect(host.runQueued).toHaveBeenCalledTimes(1);
    expect(host.runQueued).toHaveBeenCalledWith(
      [
        {
          kind: 'resume',
          data: {
            kind: 'resume',
            index: 1,
            agentId: 'agent-old-1',
            item: 'src/old-a.ts',
            prompt: 'Continue previous review A',
          },
          profileName: 'subagent',
          parentToolCallId: 'call_swarm',
          prompt: 'Continue previous review A',
          description: 'Finish review #1 (resume)',
          swarmIndex: 1,
          swarmItem: 'src/old-a.ts',
        runInBackground: true,
          resumeAgentId: 'agent-old-1',
          signal: expect.any(AbortSignal),
        },
        {
          kind: 'resume',
          data: {
            kind: 'resume',
            index: 2,
            agentId: 'agent-old-2',
            item: 'src/old-b.ts',
            prompt: 'Continue previous review B',
          },
          profileName: 'subagent',
          parentToolCallId: 'call_swarm',
          prompt: 'Continue previous review B',
          description: 'Finish review #2 (resume)',
          swarmIndex: 2,
          swarmItem: 'src/old-b.ts',
        runInBackground: true,
          resumeAgentId: 'agent-old-2',
          signal: expect.any(AbortSignal),
        },
        {
          kind: 'spawn',
          data: {
            kind: 'spawn',
            index: 3,
            item: 'src/new.ts',
            prompt: 'Review src/new.ts',
          },
          profileName: 'explore',
          parentToolCallId: 'call_swarm',
          prompt: 'Review src/new.ts',
          description: 'Finish review #3 (explore)',
          swarmIndex: 3,
          swarmItem: 'src/new.ts',
        runInBackground: true,
          signal: expect.any(AbortSignal),
        },
      ],
    );
    expect(result.output).toBe([
      '<agent_swarm_result>',
      '<summary>completed: 3</summary>',
      '<subagent mode="resume" agent_id="agent-old-1" item="src/old-a.ts" outcome="completed">result 1</subagent>',
      '<subagent mode="resume" agent_id="agent-old-2" item="src/old-b.ts" outcome="completed">result 2</subagent>',
      '<subagent agent_id="agent-new-3" item="src/new.ts" outcome="completed">result 3</subagent>',
      '</agent_swarm_result>',
    ].join('\n'));
    expect(result.isError).toBeUndefined();
  });

  it('AgentSwarm allows a single resumed subagent without item subagents', async () => {
    const runQueued = vi.fn(
      async <T>(
        tasks: readonly QueuedSubagentTask<T>[],
      ): Promise<Array<QueuedSubagentRunResult<T>>> => {
        return tasks.map((task) => ({
          task,
          agentId: task.kind === 'resume' ? task.resumeAgentId : 'agent-new',
          status: 'completed' as const,
          result: 'resumed result',
        }));
      },
    );
    const host = mockSubagentHost({
      getSwarmItem: vi.fn((agentId: string) =>
        agentId === 'agent-old-1' ? 'src/old-a.ts' : undefined,
      ),
      runQueued: runQueued as unknown as SessionSubagentHost['runQueued'],
    });
    const swarmMode = mockSwarmMode();
    const tool = settledSwarmTool(host, swarmMode);
    const input = {
      description: 'Resume review',
      resume_agent_ids: {
        'agent-old-1': 'Continue previous review A',
      },
    };

    expect(AgentSwarmToolInputSchema.safeParse(input).success).toBe(true);

    const result = await executeTool(tool, context(input, 'call_swarm'));

    expect(host.runQueued).toHaveBeenCalledTimes(1);
    expect(host.runQueued).toHaveBeenCalledWith([
      {
        kind: 'resume',
        data: {
          kind: 'resume',
          index: 1,
          agentId: 'agent-old-1',
          item: 'src/old-a.ts',
          prompt: 'Continue previous review A',
        },
        profileName: 'subagent',
        parentToolCallId: 'call_swarm',
        prompt: 'Continue previous review A',
        description: 'Resume review #1 (resume)',
        swarmIndex: 1,
        swarmItem: 'src/old-a.ts',
        runInBackground: true,
        resumeAgentId: 'agent-old-1',
        signal: expect.any(AbortSignal),
      },
    ]);
    expect(result.output).toBe([
      '<agent_swarm_result>',
      '<summary>completed: 1</summary>',
      '<subagent mode="resume" agent_id="agent-old-1" item="src/old-a.ts" outcome="completed">resumed result</subagent>',
      '</agent_swarm_result>',
    ].join('\n'));
    expect(result.isError).toBeUndefined();
  });

  it('AgentSwarm reports failed subagents inside the XML result without failing the tool', async () => {
    const host = mockSubagentHost({
      runQueued: vi.fn().mockResolvedValue([
        {
          task: {
            kind: 'spawn',
            data: { kind: 'spawn', index: 1, item: 'src/a.ts', prompt: 'Review src/a.ts' },
            profileName: 'coder',
            parentToolCallId: 'call_swarm',
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
            parentToolCallId: 'call_swarm',
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
    const swarmMode = mockSwarmMode();
    const tool = settledSwarmTool(host, swarmMode);

    const result = await executeTool(
      tool,
      context(
        {
          description: 'Review files',
          prompt_template: 'Review {{item}}',
          items: ['src/a.ts', 'src/b.ts'],
        },
        'call_swarm',
      ),
    );

    expect(result.output).toBe([
      '<agent_swarm_result>',
      '<summary>completed: 1, failed: 1</summary>',
      '<resume_hint>Call AgentSwarm with resume_agent_ids using the agent_id values in this result to continue unfinished work.</resume_hint>',
      '<subagent agent_id="agent-coder-1" item="src/a.ts" outcome="completed">imports are stable</subagent>',
      '<subagent agent_id="agent-coder-2" item="src/b.ts" outcome="failed">Agent timed out after 30s.</subagent>',
      '</agent_swarm_result>',
    ].join('\n'));
    expect(swarmMode.enter).toHaveBeenCalledWith('tool');
    expect(result.isError).toBeUndefined();
  });

  it('AgentSwarm omits resume hint when incomplete subagents have no agent ids', async () => {
    const host = mockSubagentHost({
      runQueued: vi.fn().mockResolvedValue([
        {
          task: {
            kind: 'spawn',
            data: { kind: 'spawn', index: 1, item: 'src/a.ts', prompt: 'Review src/a.ts' },
            profileName: 'coder',
            parentToolCallId: 'call_swarm',
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
            parentToolCallId: 'call_swarm',
            prompt: 'Review src/b.ts',
            description: 'Review files #2 (coder)',
        runInBackground: true,
          },
          status: 'failed',
          error: 'Agent also did not start.',
        },
      ]),
    });
    const swarmMode = mockSwarmMode();
    const tool = settledSwarmTool(host, swarmMode);

    const result = await executeTool(
      tool,
      context(
        {
          description: 'Review files',
          prompt_template: 'Review {{item}}',
          items: ['src/a.ts', 'src/b.ts'],
        },
        'call_swarm',
      ),
    );

    expect(result.output).toBe([
      '<agent_swarm_result>',
      '<summary>failed: 2</summary>',
      '<subagent item="src/a.ts" outcome="failed">Agent did not start.</subagent>',
      '<subagent item="src/b.ts" outcome="failed">Agent also did not start.</subagent>',
      '</agent_swarm_result>',
    ].join('\n'));
    expect(result.isError).toBeUndefined();
  });

  it('AgentSwarm reports partial aborted subagents inside the XML result', async () => {
    const host = mockSubagentHost({
      runQueued: vi.fn().mockResolvedValue([
        {
          task: {
            kind: 'spawn',
            data: { kind: 'spawn', index: 1, item: 'src/a.ts', prompt: 'Review src/a.ts' },
            profileName: 'coder',
            parentToolCallId: 'call_swarm',
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
            parentToolCallId: 'call_swarm',
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
            parentToolCallId: 'call_swarm',
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
    const swarmMode = mockSwarmMode();
    const tool = settledSwarmTool(host, swarmMode);

    const result = await executeTool(
      tool,
      context(
        {
          description: 'Review files',
          prompt_template: 'Review {{item}}',
          items: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
        },
        'call_swarm',
      ),
    );

    expect(result.output).toBe([
      '<agent_swarm_result>',
      '<summary>completed: 1, aborted: 2</summary>',
      '<resume_hint>Call AgentSwarm with resume_agent_ids using the agent_id values in this result to continue unfinished work.</resume_hint>',
      '<subagent agent_id="agent-coder-1" item="src/a.ts" outcome="completed">imports are stable</subagent>',
      '<subagent agent_id="agent-coder-2" item="src/b.ts" state="started" outcome="aborted">The user manually interrupted this subagent batch before this subagent finished.</subagent>',
      '<subagent item="src/c.ts" state="not_started" outcome="aborted">The user manually interrupted this subagent batch before this subagent was started.</subagent>',
      '</agent_swarm_result>',
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
        if (keywords.includes('AgentSwarm')) {
          return [
            {
              title: 'AgentSwarm ADR',
              path: 'decisions/agent-swarm.md',
              score: 3,
              excerpt: 'AgentSwarm delegates work. See [[Permission Rules]].',
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
        keywords: ['AgentSwarm'],
        include_linked: true,
        link_depth: 1,
        chain_depth: 1,
      }).success,
    ).toBe(true);

    const result = await executeTool(
      tool,
      context({
        keywords: ['AgentSwarm'],
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

  it('nori_plan_write writes to the active session plan file during plan mode', async () => {
    const mkdir = vi.fn<Kaos['mkdir']>().mockResolvedValue(undefined);
    const writeText = vi.fn<Kaos['writeText']>().mockResolvedValue(21);
    const planFilePath = '/session/agents/main/plans/current-plan.md';
    const tool = new NoriPlanWriteTool({
      config: { cwd: '/workspace' },
      kaos: createFakeKaos({ mkdir, writeText }),
      planMode: {
        isActive: true,
        planFilePath,
      },
    } as unknown as Agent);

    const result = await executeTool(
      tool,
      context({
        file_path: 'plans/huntress-hulkling-orphan.md',
        content: '# Plan\n\nFix the bug.',
      }),
    );

    expect(result.isError).toBeUndefined();
    expect(mkdir).toHaveBeenCalledWith('/session/agents/main/plans', {
      parents: true,
      existOk: true,
    });
    expect(writeText).toHaveBeenCalledWith(planFilePath, '# Plan\n\nFix the bug.');
    expect(result.output).toContain(`Plan written to ${planFilePath}`);
    expect(result.output).toContain('active plan file');
  });

  it('nori_plan_write fails in plan mode when the host has no active plan file path', async () => {
    const mkdir = vi.fn<Kaos['mkdir']>().mockResolvedValue(undefined);
    const writeText = vi.fn<Kaos['writeText']>().mockResolvedValue(21);
    const tool = new NoriPlanWriteTool({
      config: { cwd: '/workspace' },
      kaos: createFakeKaos({ mkdir, writeText }),
      planMode: {
        isActive: true,
        planFilePath: null,
      },
    } as unknown as Agent);

    const result = await executeTool(
      tool,
      context({
        file_path: 'plans/fallback.md',
        content: '# Plan',
      }),
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('no current plan file path is available');
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('nori_plan_write treats file_path as a label while plan mode is active', async () => {
    const mkdir = vi.fn<Kaos['mkdir']>().mockResolvedValue(undefined);
    const writeText = vi.fn<Kaos['writeText']>().mockResolvedValue(21);
    const planFilePath = '/session/agents/main/plans/current-plan.md';
    const tool = new NoriPlanWriteTool({
      config: { cwd: '/workspace' },
      kaos: createFakeKaos({ mkdir, writeText }),
      planMode: {
        isActive: true,
        planFilePath,
      },
    } as unknown as Agent);

    const result = await executeTool(
      tool,
      context({
        file_path: 'current-plan',
        content: '# Plan',
      }),
    );

    expect(result.isError).toBeUndefined();
    expect(writeText).toHaveBeenCalledWith(planFilePath, '# Plan');
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
