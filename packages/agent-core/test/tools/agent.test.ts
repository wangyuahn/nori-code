import { describe, expect, it, vi } from 'vitest';

import { ToolAccesses } from '../../src/loop';
import type { Logger, LogPayload } from '../../src/logging';
import type { ResolvedAgentProfile } from '../../src/profile';
import type { SessionSubagentHost } from '../../src/session/subagent-host';
import { AgentTool, AgentToolInputSchema } from '../../src/tools/builtin/collaboration/agent';
import { userCancellationReason } from '../../src/utils/abort';
import { agentTask, createBackgroundManager } from '../agent/background/helpers';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

function context<Input>(args: Input, toolCallId = 'call_agent') {
  return { turnId: '0', toolCallId, args, signal };
}

function mockSubagentHost<T extends Pick<SessionSubagentHost, 'spawn'> & Partial<SessionSubagentHost>>(
  host: T,
): T & SessionSubagentHost {
  return { resume: vi.fn(), ...host } as unknown as T & SessionSubagentHost;
}

function agentTool(
  host: SessionSubagentHost,
  background = createBackgroundManager().manager,
  subagents?: ResolvedAgentProfile['subagents'],
  options?: ConstructorParameters<typeof AgentTool>[3],
): AgentTool {
  return new AgentTool(host, background, subagents, options);
}

interface CapturedLogEntry {
  readonly level: 'error' | 'warn' | 'info' | 'debug';
  readonly message: string;
  readonly payload: LogPayload | undefined;
}

function captureLogs(): { logger: Logger; entries: CapturedLogEntry[] } {
  const entries: CapturedLogEntry[] = [];
  const capture =
    (level: CapturedLogEntry['level']) => (message: string, payload?: LogPayload) => {
      entries.push({ level, message, payload });
    };
  const logger: Logger = {
    error: capture('error'),
    warn: capture('warn'),
    info: capture('info'),
    debug: capture('debug'),
    createChild: () => logger,
  };
  return {
    entries,
    logger,
  };
}

describe('AgentTool', () => {
  it('accepts the snake_case background parameter', () => {
    const parsed = AgentToolInputSchema.parse({
      prompt: 'Investigate',
      description: 'Find cause',
      subagent_type: 'explore',
      run_in_background: true,
    });

    expect(parsed).toMatchObject({
      prompt: 'Investigate',
      description: 'Find cause',
      subagent_type: 'explore',
      run_in_background: true,
    });
  });

  it('exposes run_in_background and not runInBackground in the JSON schema', () => {
    const host = mockSubagentHost({ spawn: vi.fn() });
    const tool = agentTool(host);
    const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;

    expect(properties).toHaveProperty('run_in_background');
    expect(properties).not.toHaveProperty('runInBackground');
  });

  it('describes subagent_type and run_in_background parameters', () => {
    const host = mockSubagentHost({ spawn: vi.fn() });
    const tool = agentTool(host);
    const properties = (
      tool.parameters as {
        properties: Record<string, { description?: string }>;
      }
    ).properties;

    const subagentTypeDescription = properties['subagent_type']?.description ?? '';
    // #7: the description states the default is nori-coder
    expect(subagentTypeDescription).toContain('nori-coder');
    // #6: terminology aligned with the "Available agent types" prose heading —
    // no longer "agent registry"
    expect(subagentTypeDescription).not.toContain('registry');
    expect(subagentTypeDescription).toContain('agent type');
    expect(properties['run_in_background']?.description).toContain('always');
  });

  it('documents that resume excludes subagent_type', () => {
    const host = mockSubagentHost({ spawn: vi.fn() });
    const tool = agentTool(host);
    const properties = (
      tool.parameters as { properties: Record<string, { description?: string }> }
    ).properties;

    // Passing both resume and subagent_type is rejected at runtime (agent.ts execution()),
    // so the resume param must steer the model away from it.
    expect((properties['resume']?.description ?? '').toLowerCase()).toContain('subagent_type');
  });

  it('does not expose a timeout parameter in the JSON schema', () => {
    const host = mockSubagentHost({ spawn: vi.fn() });
    const tool = agentTool(host);
    const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;

    expect(properties).not.toHaveProperty('timeout');
  });

  it('explains always-background execution without a deadline', () => {
    const host = mockSubagentHost({ spawn: vi.fn() });
    const tool = agentTool(host);

    expect(tool.description).toContain('always run in the background');
    expect(tool.description).toContain('no execution deadline');
    expect(tool.description).toContain('<system-reminder>');
    expect(tool.description).not.toContain('fixed 30-minute timeout');
  });

  it('does not expose a model parameter in the JSON schema', () => {
    const host = mockSubagentHost({ spawn: vi.fn() });
    const tool = agentTool(host);
    const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;

    expect(properties).not.toHaveProperty('model');
  });

  it('renders the tool set for each subagent type', () => {
    const host = mockSubagentHost({ spawn: vi.fn() });
    const subagents = {
      explore: profile({
        name: 'explore',
        description: 'Read-only exploration.',
        tools: ['Read', 'Grep', 'Glob'],
      }),
      coder: profile({
        name: 'coder',
        description: 'General coding.',
        tools: ['Read', 'Write', 'Edit', 'Bash'],
      }),
    };

    const tool = agentTool(host, createBackgroundManager().manager, subagents);

    expect(tool.description).toContain('Tools: Read, Grep, Glob');
    expect(tool.description).toContain('Tools: Read, Write, Edit, Bash');
  });

  it('mentions resume preference and result visibility in the description', () => {
    const host = mockSubagentHost({ spawn: vi.fn() });
    const tool = agentTool(host);

    expect(tool.description.toLowerCase()).toContain('resume');
    expect(tool.description.toLowerCase()).toContain('only visible to you');
    expect(tool.description.toLowerCase()).toContain('when not to');
    // Moved here from system.md: the context-hygiene reason to delegate.
    expect(tool.description.toLowerCase()).toContain('out of your own context');
  });

  it('normalizes the default subagent type into tool args', () => {
    expect(
      AgentToolInputSchema.parse({
        prompt: 'Investigate',
        description: 'Find cause',
      }).subagent_type,
    ).toBe('nori-coder');
    expect(
      AgentToolInputSchema.parse({
        prompt: 'Investigate',
        description: 'Find cause',
        subagent_type: '',
      }).subagent_type,
    ).toBe('nori-coder');
    expect(
      AgentToolInputSchema.parse({
        prompt: 'Continue',
        description: 'Continue work',
        resume: 'agent-existing',
      }).subagent_type,
    ).toBeUndefined();
  });

  it('describes configured subagent types', () => {
    const host = mockSubagentHost({ spawn: vi.fn() });
    const subagents = {
      explore: profile({
        name: 'explore',
        description: 'Read-only exploration.',
        whenToUse: 'Use for searches.',
      }),
      coder: profile({ name: 'coder', description: 'General coding.' }),
    };

    const tool = agentTool(host, createBackgroundManager().manager, subagents);

    expect(tool.description).toContain('Available agent types');
    expect(tool.description).toContain('- explore: Read-only exploration. Use for searches.');
    expect(tool.description).toContain('- coder: General coding.');
  });

  it('spawns a detached subagent and returns immediately', async () => {
    const host = mockSubagentHost({
      spawn: vi.fn().mockResolvedValue({
        agentId: 'agent-child',
        profileName: 'explore',
        resumed: false,
        completion: Promise.resolve({ result: 'child result' }),
      }),
    });
    const background = createBackgroundManager().manager;
    const tool = agentTool(host, background);

    const result = await executeTool(tool,
      context({
        prompt: 'Investigate',
        description: 'Find cause',
        subagent_type: 'explore',
        run_in_background: false,
      }),
    );

    expect(host.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: 'explore',
        parentToolCallId: 'call_agent',
        prompt: 'Investigate',
        description: 'Find cause',
        runInBackground: true,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result.output).toContain('agent_id: agent-child');
    expect(result.output).toContain('actual_subagent_type: explore');
    expect(result.output).toContain('status: running');
    expect(result.output).not.toContain('child result');
    const task = background.list(false)[0]!;
    expect(task).toMatchObject({ detached: true, timeoutMs: undefined });
    await expect(background.wait(task.taskId)).resolves.toMatchObject({ status: 'completed' });
    await expect(background.readOutput(task.taskId)).resolves.toContain('child result');
  });

  it('falls back to coder for an empty subagent type', async () => {
    const host = mockSubagentHost({
      spawn: vi.fn().mockResolvedValue({
        agentId: 'agent-child',
        profileName: 'coder',
        resumed: false,
        completion: Promise.resolve({ result: 'child result' }),
      }),
    });
    const tool = agentTool(host);

    await executeTool(tool,
      context({
        prompt: 'Investigate',
        description: 'Find cause',
        subagent_type: '',
      }),
    );

    expect(host.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        parentToolCallId: 'call_agent',
        profileName: 'nori-coder',
      }),
    );
  });

  it('resumes a detached subagent when resume is provided', async () => {
    const host = mockSubagentHost({
      spawn: vi.fn(),
      resume: vi.fn().mockResolvedValue({
        agentId: 'agent-existing',
        profileName: 'explore',
        resumed: true,
        completion: Promise.resolve({ result: 'resumed result' }),
      }),
    });
    const tool = agentTool(host);

    const result = await executeTool(tool,
      context({
        prompt: 'Continue',
        description: 'Continue work',
        resume: 'agent-existing',
      }),
    );

    expect(host.spawn).not.toHaveBeenCalled();
    expect(host.resume).toHaveBeenCalledWith(
      'agent-existing',
      expect.objectContaining({
        parentToolCallId: 'call_agent',
        prompt: 'Continue',
        description: 'Continue work',
        runInBackground: true,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result.output).toContain('agent_id: agent-existing');
    expect(result.output).toContain('actual_subagent_type: explore');
    expect(result.output).toContain('status: running');
    expect(result.output).not.toContain('resumed result');
  });

  it('returns an error when resuming with a subagent type', async () => {
    const host = mockSubagentHost({
      spawn: vi.fn(),
      resume: vi.fn(),
    });
    const tool = agentTool(host);

    const result = await executeTool(tool,
      context({
        prompt: 'Continue',
        description: 'Continue work',
        resume: 'agent-existing',
        subagent_type: 'explore',
      }),
    );

    expect(result).toMatchObject({
      isError: true,
      output: 'Cannot set subagent_type when resuming an existing agent. Resume by agent id only.',
    });
    expect(host.resume).not.toHaveBeenCalled();
  });

  it('does not consume a background task slot when validation fails before launch', async () => {
    const completion = new Promise<{ result: string }>(() => {});
    const background = createBackgroundManager({ maxRunningTasks: 1 }).manager;
    const host = mockSubagentHost({
      spawn: vi.fn().mockResolvedValue({
        agentId: 'agent-child',
        profileName: 'coder',
        resumed: false,
        completion,
      }),
      resume: vi.fn(),
    });
    const tool = new AgentTool(host, background);

    const invalid = await executeTool(tool,
      context({
        prompt: 'Continue',
        description: 'Invalid background resume',
        resume: 'agent-existing',
        subagent_type: 'explore',
        run_in_background: true,
      }),
    );
    const valid = await executeTool(tool,
      context({
        prompt: 'Investigate',
        description: 'Find cause',
        run_in_background: true,
      }),
    );

    expect(invalid).toMatchObject({
      isError: true,
      output: 'Cannot set subagent_type when resuming an existing agent. Resume by agent id only.',
    });
    expect(valid.output).toContain('status: running');
    expect(host.resume).not.toHaveBeenCalled();
    expect(host.spawn).toHaveBeenCalledTimes(1);
  });

  it('resumes by id without constraining the subagent type', async () => {
    const host = mockSubagentHost({
      spawn: vi.fn(),
      resume: vi.fn().mockResolvedValue({
        agentId: 'agent-existing',
        profileName: 'explore',
        resumed: true,
        completion: Promise.resolve({ result: 'resumed result' }),
      }),
    });
    const tool = agentTool(host);

    const result = await executeTool(tool,
      context({
        prompt: 'Continue',
        description: 'Continue work',
        resume: 'agent-existing',
      }),
    );

    expect(host.spawn).not.toHaveBeenCalled();
    expect(host.resume).toHaveBeenCalledWith(
      'agent-existing',
      expect.objectContaining({
        parentToolCallId: 'call_agent',
        prompt: 'Continue',
        description: 'Continue work',
        runInBackground: true,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result.output).toContain('actual_subagent_type: explore');
  });

  it('declares no resource accesses so concurrent Agent calls can run in parallel', async () => {
    const host = mockSubagentHost({ spawn: vi.fn() });
    const tool = agentTool(host);
    const execution = await tool.resolveExecution({
      prompt: 'Investigate',
      description: 'Find cause',
      subagent_type: 'explore',
    });

    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.accesses).toEqual(ToolAccesses.none());
  });

  it('uses the resumed agent profile in the activity description', async () => {
    const host = mockSubagentHost({
      spawn: vi.fn(),
      getProfileName: vi.fn().mockReturnValue('explore'),
    });
    const tool = agentTool(host);
    const execution = await tool.resolveExecution({
      prompt: 'Continue',
      description: 'Continue work',
      resume: ' agent-existing ',
    });

    expect(execution.isError).toBeFalsy();
    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.description).toBe('Launching background explore agent: Continue work');
    expect(host.getProfileName).toHaveBeenCalledWith('agent-existing');
  });

  it('registers background subagents with the background manager', async () => {
    const completion = new Promise<{ result: string }>(() => {});
    const host = mockSubagentHost({
      spawn: vi.fn().mockResolvedValue({
        agentId: 'agent-child',
        profileName: 'coder',
        resumed: false,
        completion,
      }),
    });
    const background = createBackgroundManager().manager;
    const tool = new AgentTool(host, background);

    const result = await executeTool(tool,
      context({
        prompt: 'Investigate',
        description: 'Find cause',
        run_in_background: true,
      }),
    );

    expect(result.output).toContain('status: running');
    expect(result.output).toContain('agent_id: agent-child');
    if (typeof result.output !== 'string') throw new TypeError('expected string output');
    const taskId = result.output.match(/task_id: (agent-[0-9a-z]{8})/)?.[1];
    expect(taskId).toBeDefined();
    expect(background.getTask(taskId!)).toMatchObject({
      status: 'running',
      description: 'Find cause',
      timeoutMs: undefined,
    });
  });

  it('starts detached and remains observable through the background manager', async () => {
    let resolveCompletion: (value: { result: string }) => void = () => {};
    const completion = new Promise<{ result: string }>((resolve) => {
      resolveCompletion = resolve;
    });
    const markActiveChildDetached = vi.fn();
    const host = mockSubagentHost({
      markActiveChildDetached,
      spawn: vi.fn().mockResolvedValue({
        agentId: 'agent-child',
        profileName: 'coder',
        resumed: false,
        completion,
      }),
    });
    const background = createBackgroundManager().manager;
    const tool = new AgentTool(host, background);

    const result = await executeTool(tool,
      context({
        prompt: 'Investigate',
        description: 'Find cause',
      }),
    );
    const task = background.list(false)[0]!;

    expect(task).toMatchObject({
      kind: 'agent',
      detached: true,
      agentId: 'agent-child',
    });

    expect(markActiveChildDetached).not.toHaveBeenCalled();
    expect(result.output).toContain(`task_id: ${task.taskId}`);
    expect(result.output).toContain('agent_id: agent-child');
    expect(result.output).toContain('automatic_notification: true');

    resolveCompletion({ result: 'finished later' });
    await expect(background.wait(task.taskId)).resolves.toMatchObject({
      status: 'completed',
      detached: true,
    });
  });

  it('still runs in the background when task management tools are hidden', async () => {
    let resolveCompletion: (value: { result: string }) => void = () => {};
    const completion = new Promise<{ result: string }>((resolve) => {
      resolveCompletion = resolve;
    });
    const host = mockSubagentHost({
      spawn: vi.fn().mockResolvedValue({
        agentId: 'agent-child',
        profileName: 'coder',
        resumed: false,
        completion,
      }),
    });
    const background = createBackgroundManager().manager;
    const tool = agentTool(host, background, undefined, { allowBackground: false });

    const result = await executeTool(
      tool,
      context({
        prompt: 'Investigate',
        description: 'Find cause',
      }),
    );
    const task = background.list(false)[0]!;

    expect(result.output).toContain(`task_id: ${task.taskId}`);
    expect(result.output).toContain('next_step: The completion arrives automatically');
    expect(result.output).toContain('TaskOutput unless you explicitly need a live preview');
    expect(result.output).not.toContain('TaskStop');

    resolveCompletion({ result: 'finished later' });
    await expect(background.wait(task.taskId)).resolves.toMatchObject({
      status: 'completed',
      detached: true,
    });
  });

  it('steers the AI away from waiting and gives a resume hint on background launch', async () => {
    const host = mockSubagentHost({
      spawn: vi.fn().mockResolvedValue({
        agentId: 'agent-child',
        profileName: 'coder',
        resumed: false,
        completion: new Promise<{ result: string }>(() => {}),
      }),
    });
    const background = createBackgroundManager().manager;
    const tool = new AgentTool(host, background);

    const result = await executeTool(tool,
      context({
        prompt: 'Investigate',
        description: 'Find cause',
        run_in_background: true,
      }),
    );

    if (typeof result.output !== 'string') throw new TypeError('expected string output');
    const taskId = result.output.match(/task_id: (agent-[0-9a-z]{8})/)?.[1];
    expect(taskId).toBeDefined();
    // M9: next_step steers away from waiting on a background launch (no poll/TaskOutput).
    expect(result.output).toContain('next_step:');
    expect(result.output).toContain('do not poll or call TaskOutput unless you explicitly need a live preview');
    expect(result.output).not.toContain('block=false');
    // M9: resume_hint — continue the same subagent instance
    expect(result.output).toContain('resume_hint:');
    expect(result.output).toContain('Agent(resume="agent-child"');
    // The hint disambiguates the two look-alike identifiers in this output:
    // `agent_id` (what `subagentHost.resume` accepts) and `task_id` (the
    // BackgroundManager ledger id, which also shows up as `source_id` in
    // later <notification> entries). LLMs regularly copy the wrong one.
    expect(result.output).toMatch(/agent_id.*not.*task_id|task_id.*not.*agent_id/i);
    // Recovery scenario — `task.lost` etc. — must be called out so the
    // model knows the hint is not only for happy-path follow-up work.
    expect(result.output).toMatch(/task\.lost|task\.failed|task\.killed/);
  });

  it('ignores the legacy allowBackground gate', async () => {
    const host = mockSubagentHost({
      spawn: vi.fn().mockResolvedValue({
        agentId: 'agent-child',
        profileName: 'coder',
        resumed: false,
        completion: new Promise<{ result: string }>(() => {}),
      }),
    });
    const tool = agentTool(host, createBackgroundManager().manager, undefined, {
      allowBackground: false,
    });

    expect(tool.description).toContain('always runs detached');

    const result = await executeTool(tool,
      context({
        prompt: 'Investigate',
        description: 'Find cause',
        run_in_background: true,
      }),
    );

    expect(result.output).toContain('status: running');
    expect(host.spawn).toHaveBeenCalledTimes(1);
  });

  it('returns an error when background registration hits the task limit', async () => {
    const background = createBackgroundManager({ maxRunningTasks: 1 }).manager;
    background.registerTask(agentTask(new Promise(() => {}), 'existing agent'));
    const host = mockSubagentHost({
      spawn: vi.fn().mockResolvedValue({
        agentId: 'agent-child',
        profileName: 'coder',
        resumed: false,
        completion: new Promise<{ result: string }>(() => {}),
      }),
    });
    const tool = new AgentTool(host, background);

    const result = await executeTool(tool,
      context({
        prompt: 'Investigate',
        description: 'Find cause',
        run_in_background: true,
      }),
    );

    expect(result).toMatchObject({
      isError: true,
      output: 'Too many background tasks are already running.',
    });
    expect(host.spawn).toHaveBeenCalledTimes(1);
  });

  it('rejects one of two concurrent background subagents when the task limit is reached', async () => {
    const background = createBackgroundManager({ maxRunningTasks: 1 }).manager;
    const host = mockSubagentHost({
      spawn: vi
        .fn()
        .mockResolvedValueOnce({
          agentId: 'agent-first',
          profileName: 'coder',
          resumed: false,
          completion: new Promise<{ result: string }>(() => {}),
        })
        .mockResolvedValueOnce({
          agentId: 'agent-second',
          profileName: 'coder',
          resumed: false,
          completion: Promise.resolve({ result: 'second result' }),
        }),
    });
    const tool = new AgentTool(host, background);

    const first = executeTool(tool,
      context({
        prompt: 'Investigate first',
        description: 'Find first',
        run_in_background: true,
      }),
    );
    const second = executeTool(tool,
      context({
        prompt: 'Investigate second',
        description: 'Find second',
        run_in_background: true,
      }),
    );

    const results = await Promise.all([first, second]);

    expect(host.spawn).toHaveBeenCalledTimes(2);
    expect(results).toContainEqual(
      expect.objectContaining({ output: expect.stringContaining('status: running') }),
    );
    expect(results).toContainEqual(
      expect.objectContaining({
        isError: true,
        output: 'Too many background tasks are already running.',
      }),
    );
  });

  it('returns tool errors when spawning fails', async () => {
    const error = new Error('missing subagent');
    const { logger, entries } = captureLogs();
    const host = mockSubagentHost({
      spawn: vi.fn().mockRejectedValue(error),
    });
    const tool = agentTool(host, createBackgroundManager().manager, undefined, { log: logger });

    const result = await executeTool(tool,
      context({ prompt: 'Investigate', description: 'Find cause' }),
    );

    expect(result).toMatchObject({
      isError: true,
      output: 'subagent error: missing subagent',
    });
    expect(entries).toEqual([
      {
        level: 'warn',
        message: 'subagent launch failed',
        payload: expect.objectContaining({
          toolCallId: 'call_agent',
          runInBackground: true,
          operation: 'spawn',
          subagentType: 'nori-coder',
          error,
        }),
      },
    ]);
  });

  it('logs background registration failures', async () => {
    const error = new Error('background unavailable');
    const { logger, entries } = captureLogs();
    const host = mockSubagentHost({
      spawn: vi.fn().mockResolvedValue({
        agentId: 'agent-child',
        profileName: 'coder',
        resumed: false,
        completion: new Promise<{ result: string }>(() => {}),
      }),
    });
    const background = createBackgroundManager().manager;
    vi.spyOn(background, 'registerTask').mockImplementation(() => {
      throw error;
    });
    const tool = new AgentTool(host, background, undefined, { log: logger });

    const result = await executeTool(tool,
      context({
        prompt: 'Investigate',
        description: 'Find cause',
        run_in_background: true,
      }),
    );

    expect(result).toMatchObject({
      isError: true,
      output: 'background unavailable',
    });
    expect(entries).toEqual([
      {
        level: 'warn',
        message: 'background agent task registration failed',
        payload: expect.objectContaining({
          toolCallId: 'call_agent',
          agentId: 'agent-child',
          subagentType: 'coder',
          error,
        }),
      },
    ]);
  });

  it('does not kill a detached subagent when the parent tool signal is cancelled', async () => {
    const controller = new AbortController();
    const host = mockSubagentHost({
      spawn: vi.fn(
        (
          profileNameOrOptions: string | { readonly signal: AbortSignal },
          legacyOptions?: { readonly signal: AbortSignal },
        ) =>
        Promise.resolve({
          agentId: 'agent-child',
          profileName: 'coder',
          resumed: false,
          completion: new Promise<{ result: string }>((_resolve, reject) => {
            const signal =
              typeof profileNameOrOptions === 'string'
                ? legacyOptions!.signal
                : profileNameOrOptions.signal;
            const onAbort = (): void => {
              reject(signal.reason);
            };
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          }),
        }),
      ),
    });
    const background = createBackgroundManager().manager;
    const tool = agentTool(host, background);

    const resultPromise = executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_agent',
      args: { prompt: 'Investigate', description: 'Find cause' },
      signal: controller.signal,
    });
    const result = await resultPromise;
    controller.abort(userCancellationReason());
    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('status: running');
    expect(background.list(false)[0]).toMatchObject({ status: 'running', detached: true });
  });

  it('does not arm the old 30-minute subagent timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const host = mockSubagentHost({
        spawn: vi.fn(
          (
            profileNameOrOptions: string | { readonly signal: AbortSignal },
            legacyOptions?: { readonly signal: AbortSignal },
          ) =>
          Promise.resolve({
            agentId: 'agent-child',
            profileName: 'coder',
            resumed: false,
            completion: new Promise<{ result: string }>((_resolve, reject) => {
              const signal =
                typeof profileNameOrOptions === 'string'
                  ? legacyOptions!.signal
                  : profileNameOrOptions.signal;
              signal.addEventListener(
                'abort',
                () => {
                  reject(signal.reason);
                },
                { once: true },
              );
            }),
          }),
        ),
      });
      const background = createBackgroundManager().manager;
      const tool = agentTool(host, background);

      const resultPromise = executeTool(tool,
        context({
          prompt: 'Investigate',
          description: 'Find cause',
        }),
      );
      const result = await resultPromise;
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

      expect(result.isError).toBeUndefined();
      expect(result.output).toContain('agent_id: agent-child');
      expect(result.output).toContain('actual_subagent_type: coder');
      expect(result.output).toContain('status: running');
      expect(result.output).toContain('resume_hint:');
      expect(background.list(false)[0]).toMatchObject({
        status: 'running',
        detached: true,
        timeoutMs: undefined,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

function profile(input: {
  readonly name: string;
  readonly description?: string;
  readonly whenToUse?: string;
  readonly tools?: readonly string[];
}): ResolvedAgentProfile {
  return {
    name: input.name,
    description: input.description,
    whenToUse: input.whenToUse,
    systemPrompt: () => `${input.name} prompt`,
    tools: [...(input.tools ?? [])],
  };
}
