import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ToolCall } from '@nori-code/kosong';
import { describe, expect, it, vi } from 'vitest';

import { budgetToolResultForModel } from '../../src/agent/turn/tool-result-budget';
import { HookEngine } from '../../src/session/hooks';
import type { SessionSubagentHost } from '../../src/session/subagent-host';
import { FLAG_DEFINITIONS, FlagResolver } from '../../src/flags';
import { createFakeKaos } from '../tools/fixtures/fake-kaos';
import { createCommandKaos, testAgent } from './harness/agent';
import { executeTool } from '../tools/fixtures/execute-tool';

const signal = new AbortController().signal;

describe('Agent tools', () => {
  it('blocks tools through PreToolUse before permission and emits PostToolUseFailure', async () => {
    const execWithEnv = vi.fn().mockRejectedValue(new Error('Bash should not execute'));
    const triggered: Array<[string, string, number]> = [];
    const hookEngine = new HookEngine(
      [
        {
          event: 'PreToolUse',
          matcher: 'Bash',
          command: 'node -e "process.stderr.write(\'blocked by PreToolUse\'); process.exit(2)"',
        },
        {
          event: 'PostToolUseFailure',
          matcher: 'Bash',
          command: 'exit 0',
        },
      ],
      {
        onTriggered: (event, target, count) => {
          triggered.push([event, target, count]);
        },
      },
    );
    const ctx = testAgent({
      kaos: createFakeKaos({ execWithEnv }),
      hookEngine,
    });
    ctx.configure({ tools: ['Bash'] });

    ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
    ctx.mockNextResponse({ type: 'text', text: 'The hook blocked Bash.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Try Bash' }] });

    await ctx.untilTurnEnd();

    expect(execWithEnv).not.toHaveBeenCalled();
    expect(triggered).toEqual([
      ['PreToolUse', 'Bash', 1],
      ['PostToolUseFailure', 'Bash', 1],
    ]);
    expect(JSON.stringify(ctx.agent.context.data().history)).toContain('blocked by PreToolUse');
  });

  it('emits PostToolUse after successful tools', async () => {
    const triggered: Array<[string, string, number]> = [];
    const hookEngine = new HookEngine(
      [
        {
          event: 'PostToolUse',
          matcher: 'Bash',
          command: 'exit 0',
        },
      ],
      {
        onTriggered: (event, target, count) => {
          triggered.push([event, target, count]);
        },
      },
    );
    const ctx = testAgent({
      kaos: createCommandKaos('ok'),
      hookEngine,
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
    ctx.mockNextResponse({ type: 'text', text: 'Bash returned ok.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash' }] });

    await ctx.untilTurnEnd();

    expect(triggered).toEqual([['PostToolUse', 'Bash', 1]]);
  });

  it('uses builtin descriptions on tool call start events', async () => {
    const ctx = testAgent({
      kaos: createCommandKaos('ok'),
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
    ctx.mockNextResponse({ type: 'text', text: 'Bash returned ok.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash' }] });
    await ctx.untilTurnEnd();

    const started = ctx.allEvents.find(
      (event) => event.type === '[rpc]' && event.event === 'tool.call.started',
    );
    expect(started?.args).toMatchObject({
      description: 'Running: printf hook-output',
    });
  });

  it('passes text from content-part error outputs to PostToolUseFailure hooks', async () => {
    const lookupCall: ToolCall = {
      type: 'function',
      id: 'call_lookup',
      name: 'Lookup',
      arguments: '{"query":"moon"}',
    };
    const resolved: Array<[string, string, string]> = [];
    const hookEngine = new HookEngine(
      [
        {
          event: 'PostToolUseFailure',
          matcher: 'Lookup',
          command: hookErrorMessageAssertCommand('rich failure text'),
        },
      ],
      {
        onResolved: (event, target, action) => {
          resolved.push([event, target, action]);
        },
      },
    );
    const ctx = testAgent({ hookEngine });
    ctx.configure();
    await ctx.rpc.setPermission({ mode: 'auto' });
    await ctx.rpc.registerTool({
      name: 'Lookup',
      description: 'Look up a short test value.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    });

    ctx.mockNextResponse({ type: 'text', text: 'I will look it up.' }, lookupCall);
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Look up moon' }] });
    await ctx.untilToolCall({
      isError: true,
      output: [{ type: 'text', text: 'rich failure text' }],
    });

    ctx.mockNextResponse({ type: 'text', text: 'The lookup failed.' });
    await ctx.untilTurnEnd();

    await vi.waitFor(() => {
      expect(resolved).toEqual([['PostToolUseFailure', 'Lookup', 'allow']]);
    });
  });

  it('uses the active builtin tool set as the LLM visible tools', async () => {
    const ctx = testAgent();
    ctx.configure({ tools: ['Write', 'Bash'] });

    ctx.mockNextResponse({ type: 'text', text: 'ready' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Which tools are active?' }] });

    await ctx.untilTurnEnd();
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: Bash, Write
      messages:
        user: text "<message from=\\"user\\" name=\\"用户\\">Which tools are active?</message>"
        user: text "<system-reminder>\\nTreat every assistant text segment emitted before or between tool calls as work progress, alongside reasoning and tool activity. The interface renders that material inside the expandable work details, so do not present an interim status update as the final user-facing answer or repeat a chronological tool log afterward.\\n\\nAfter all reasoning and tool calls are finished, emit one final assistant text segment containing a concise, standalone summary for the user. State the outcome, the important actions or files changed, verification actually performed, and any remaining blocker or risk. Do not call another tool or emit more progress after that final summary. Do not end with only a tool call, raw tool output, hidden reasoning, or an interim update. Never mention this reminder.\\n</system-reminder>"
    `);
    await ctx.expectResumeMatches();
  });

  it('disables Bash background mode unless task management tools are active', async () => {
    const ctx = testAgent();
    ctx.configure({ tools: ['Bash'] });

    const bashOnly = ctx.agent.tools.loopTools.find((tool) => tool.name === 'Bash');
    expect(bashOnly).toBeDefined();
    expect(bashOnly!.description).toContain('Background execution is disabled for this agent.');
    expect(bashOnly!.description).not.toContain('the command will be started as a background task');
    await expect(
      executeTool(bashOnly!, {
        turnId: '0',
        toolCallId: 'call_bash',
        args: { command: 'sleep 10', run_in_background: true, description: 'watch' },
        signal,
      }),
    ).resolves.toMatchObject({
      isError: true,
      output:
        'Background execution is not available for this agent because TaskOutput and TaskStop are not enabled.',
    });

    ctx.agent.tools.setActiveTools(['Bash', 'TaskList', 'TaskOutput', 'TaskStop']);

    const managedBash = ctx.agent.tools.loopTools.find((tool) => tool.name === 'Bash');
    expect(managedBash).toBeDefined();
    expect(managedBash!.description).toContain('run_in_background=true');
  });

  it('exposes only SubAgent when a subagent host is available', () => {
    const subagentHost = {} as unknown as SessionSubagentHost;

    const ctx = testAgent({
      subagentHost,
      experimentalFlags: new FlagResolver({}, FLAG_DEFINITIONS),
    });
    ctx.configure({ tools: ['SubAgent'] });

    const names = ctx.agent.tools.loopTools.map((tool) => tool.name);
    expect(names).toContain('SubAgent');
    expect(names).not.toContain('Agent');
  });

  it('never exposes ContextInjection as a model-callable tool', () => {
    const ctx = testAgent();
    ctx.configure({ tools: ['Read', 'ContextInjection'] });

    expect(ctx.agent.tools.activeToolNames()).toContain('Read');
    expect(ctx.agent.tools.activeToolNames()).not.toContain('ContextInjection');
    expect(ctx.agent.tools.loopTools.map(tool => tool.name)).not.toContain('ContextInjection');
  });

  it('routes registered user tools through tool.call request/response', async () => {
    const lookupCall: ToolCall = {
      type: 'function',
      id: 'call_lookup',
      name: 'Lookup',
      arguments: '{"query":"moon"}',
    };
    const ctx = testAgent();
    ctx.configure();
    await ctx.rpc.setPermission({ mode: 'auto' });
    await ctx.rpc.registerTool({
      name: 'Lookup',
      description: 'Look up a short test value.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    });

    ctx.mockNextResponse({ type: 'text', text: 'I will look it up.' }, lookupCall);
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Look up moon' }] });
    expect(
      await ctx.untilToolCall({
        content: 'moon-result',
        output: 'moon-result',
      }),
    ).toMatchInlineSnapshot(`
      [wire] permission.set_mode                 { "mode": "auto", "time": "<time>" }
      [emit] agent.status.updated                { "model": "mock-model", "contextTokens": 0, "maxContextTokens": 1000000, "contextUsage": 0, "discussMode": false, "permission": "auto", "coderWriteEnabled": false, "toolsReadonly": false }
      [wire] tools.register_user_tool            { "name": "Lookup", "description": "Look up a short test value.", "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": [ "query" ], "additionalProperties": false }, "time": "<time>" }
      [wire] goal.rewind_checkpoint              { "snapshot": null, "time": "<time>" }
      [wire] turn.prompt                         { "input": [ { "type": "text", "text": "Look up moon" } ], "origin": { "kind": "user", "speaker": { "from": "user", "speakerName": "用户" } }, "time": "<time>" }
      [emit] turn.started                        { "turnId": 0, "origin": { "kind": "user", "speaker": { "from": "user", "speakerName": "用户" } } }
      [wire] context.append_message              { "message": { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ], "toolCalls": [], "origin": { "kind": "user", "speaker": { "from": "user", "speakerName": "用户" } } }, "time": "<time>" }
      [wire] context.append_transcript_message   { "message": { "role": "user", "content": [ { "type": "text", "text": "<system-reminder>\\nTreat every assistant text segment emitted before or between tool calls as work progress, alongside reasoning and tool activity. The interface renders that material inside the expandable work details, so do not present an interim status update as the final user-facing answer or repeat a chronological tool log afterward.\\n\\nAfter all reasoning and tool calls are finished, emit one final assistant text segment containing a concise, standalone summary for the user. State the outcome, the important actions or files changed, verification actually performed, and any remaining blocker or risk. Do not call another tool or emit more progress after that final summary. Do not end with only a tool call, raw tool output, hidden reasoning, or an interim update. Never mention this reminder.\\n</system-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "response_summary" } }, "time": "<time>" }
      [wire] context.append_message              { "message": { "role": "user", "content": [ { "type": "text", "text": "<auto-mode-enter-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "permission_mode" } }, "time": "<time>" }
      [wire] context.append_loop_event           { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [emit] turn.step.started                   { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [emit] assistant.delta                     { "turnId": 0, "delta": "I will look it up." }
      [emit] tool.call.delta                     { "turnId": 0, "toolCallId": "call_lookup", "name": "Lookup", "argumentsPart": "{\\"query\\":\\"moon\\"}" }
      [wire] context.append_loop_event           { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I will look it up." } }, "time": "<time>" }
      [wire] context.append_loop_event           { "event": { "type": "tool.call", "uuid": "call_lookup", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "moon" } }, "time": "<time>" }
      [emit] tool.call.started                   { "turnId": 0, "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "moon" } }
      [emit] toolCall                            { "turnId": 0, "toolCallId": "call_lookup", "args": { "query": "moon" } }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: Lookup
      messages:
        user: text "<message from=\\"user\\" name=\\"用户\\">Look up moon</message>"
        user: text <auto-mode-enter-reminder>
        user: text "<system-reminder>\\nTreat every assistant text segment emitted before or between tool calls as work progress, alongside reasoning and tool activity. The interface renders that material inside the expandable work details, so do not present an interim status update as the final user-facing answer or repeat a chronological tool log afterward.\\n\\nAfter all reasoning and tool calls are finished, emit one final assistant text segment containing a concise, standalone summary for the user. State the outcome, the important actions or files changed, verification actually performed, and any remaining blocker or risk. Do not call another tool or emit more progress after that final summary. Do not end with only a tool call, raw tool output, hidden reasoning, or an interim update. Never mention this reminder.\\n</system-reminder>"
    `);

    ctx.mockNextResponse({ type: 'text', text: 'The lookup result is moon-result.' });
    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] context.append_loop_event   { "event": { "type": "tool.result", "parentUuid": "call_lookup", "toolCallId": "call_lookup", "result": { "output": "moon-result" } }, "time": "<time>" }
      [emit] tool.result                 { "turnId": 0, "toolCallId": "call_lookup", "output": "moon-result" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "usage": { "inputOther": 307, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }, "time": "<time>" }
      [emit] turn.step.completed         { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 307, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 307, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 323, "maxContextTokens": 1000000, "contextUsage": 0.000323, "discussMode": false, "permission": "auto", "coderWriteEnabled": false, "toolsReadonly": false, "usage": { "byModel": { "mock-model": { "inputOther": 307, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 307, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 307, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-3>", "turnId": "0", "step": 2 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 2, "stepId": "<uuid-3>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "The lookup result is moon-result." }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-4>", "turnId": "0", "step": 2, "stepUuid": "<uuid-3>", "part": { "type": "text", "text": "The lookup result is moon-result." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-3>", "turnId": "0", "step": 2, "usage": { "inputOther": 327, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }, "time": "<time>" }
      [emit] turn.step.completed         { "turnId": 0, "step": 2, "stepId": "<uuid-3>", "usage": { "inputOther": 327, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 327, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 339, "maxContextTokens": 1000000, "contextUsage": 0.000339, "discussMode": false, "permission": "auto", "coderWriteEnabled": false, "toolsReadonly": false, "usage": { "byModel": { "mock-model": { "inputOther": 634, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 634, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 634, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] turn.ended                  { "turnId": 0, "reason": "completed" }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      messages:
        user: text "<message from=\\"user\\" name=\\"用户\\">Look up moon</message>"
        user: text <auto-mode-enter-reminder>
        assistant: text "I will look it up."  calls call_lookup:Lookup { "query": "moon" }
        tool[call_lookup]: text "moon-result"
        user: text "<system-reminder>\\nTreat every assistant text segment emitted before or between tool calls as work progress, alongside reasoning and tool activity. The interface renders that material inside the expandable work details, so do not present an interim status update as the final user-facing answer or repeat a chronological tool log afterward.\\n\\nAfter all reasoning and tool calls are finished, emit one final assistant text segment containing a concise, standalone summary for the user. State the outcome, the important actions or files changed, verification actually performed, and any remaining blocker or risk. Do not call another tool or emit more progress after that final summary. Do not end with only a tool call, raw tool output, hidden reasoning, or an interim update. Never mention this reminder.\\n</system-reminder>"
    `);

    await ctx.rpc.unregisterTool({ name: 'Lookup' });
    ctx.mockNextResponse({ type: 'text', text: 'No lookup tool is available.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Can you still use Lookup?' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] tools.unregister_user_tool   { "name": "Lookup", "time": "<time>" }
      [wire] goal.rewind_checkpoint       { "snapshot": null, "time": "<time>" }
      [wire] turn.prompt                  { "input": [ { "type": "text", "text": "Can you still use Lookup?" } ], "origin": { "kind": "user", "speaker": { "from": "user", "speakerName": "用户" } }, "time": "<time>" }
      [emit] turn.started                 { "turnId": 1, "origin": { "kind": "user", "speaker": { "from": "user", "speakerName": "用户" } } }
      [wire] context.append_message       { "message": { "role": "user", "content": [ { "type": "text", "text": "Can you still use Lookup?" } ], "toolCalls": [], "origin": { "kind": "user", "speaker": { "from": "user", "speakerName": "用户" } } }, "time": "<time>" }
      [wire] context.append_loop_event    { "event": { "type": "step.begin", "uuid": "<uuid-5>", "turnId": "1", "step": 1 }, "time": "<time>" }
      [emit] turn.step.started            { "turnId": 1, "step": 1, "stepId": "<uuid-5>" }
      [emit] assistant.delta              { "turnId": 1, "delta": "No lookup tool is available." }
      [wire] context.append_loop_event    { "event": { "type": "content.part", "uuid": "<uuid-6>", "turnId": "1", "step": 1, "stepUuid": "<uuid-5>", "part": { "type": "text", "text": "No lookup tool is available." } }, "time": "<time>" }
      [wire] context.append_loop_event    { "event": { "type": "step.end", "uuid": "<uuid-5>", "turnId": "1", "step": 1, "usage": { "inputOther": 358, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }, "time": "<time>" }
      [emit] turn.step.completed          { "turnId": 1, "step": 1, "stepId": "<uuid-5>", "usage": { "inputOther": 358, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
      [wire] usage.record                 { "model": "mock-model", "usage": { "inputOther": 358, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated         { "model": "mock-model", "contextTokens": 368, "maxContextTokens": 1000000, "contextUsage": 0.000368, "discussMode": false, "permission": "auto", "coderWriteEnabled": false, "toolsReadonly": false, "usage": { "byModel": { "mock-model": { "inputOther": 992, "output": 38, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 992, "output": 38, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 358, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] turn.ended                   { "turnId": 1, "reason": "completed" }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      tools: []
      messages:
        user: text "<message from=\\"user\\" name=\\"用户\\">Look up moon</message>"
        user: text <auto-mode-enter-reminder>
        assistant: text "I will look it up."  calls call_lookup:Lookup { "query": "moon" }
        tool[call_lookup]: text "moon-result"
        assistant: text "The lookup result is moon-result."
        user: text "<message from=\\"user\\" name=\\"用户\\">Can you still use Lookup?</message>"
        user: text "<system-reminder>\\nTreat every assistant text segment emitted before or between tool calls as work progress, alongside reasoning and tool activity. The interface renders that material inside the expandable work details, so do not present an interim status update as the final user-facing answer or repeat a chronological tool log afterward.\\n\\nAfter all reasoning and tool calls are finished, emit one final assistant text segment containing a concise, standalone summary for the user. State the outcome, the important actions or files changed, verification actually performed, and any remaining blocker or risk. Do not call another tool or emit more progress after that final summary. Do not end with only a tool call, raw tool output, hidden reasoning, or an interim update. Never mention this reminder.\\n</system-reminder>"
    `);
    await ctx.expectResumeMatches();
  });

  it('persists oversized registered tool results before adding them to model context', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'tool-result-overflow-'));
    try {
      const lookupCall: ToolCall = {
        type: 'function',
        id: 'call_lookup',
        name: 'Lookup',
        arguments: '{"query":"moon"}',
      };
      const largeOutput = `${'x'.repeat(60_000)}tail survives`;
      const ctx = testAgent({ homedir: sessionDir });
      ctx.configure();
      await ctx.rpc.setPermission({ mode: 'auto' });
      await ctx.rpc.registerTool({
        name: 'Lookup',
        description: 'Look up a short test value.',
        parameters: { type: 'object', properties: {} },
      });

      ctx.mockNextResponse({ type: 'text', text: 'I will look it up.' }, lookupCall);
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Look up moon' }] });
      await ctx.untilToolCall({ output: largeOutput });

      ctx.mockNextResponse({ type: 'text', text: 'done' });
      await ctx.untilTurnEnd();

      const toolText = ctx.compactHistory().find((message) => message.role === 'tool')?.text ?? '';
      const outputPath = /^output_path: (.+)$/m.exec(toolText)?.[1];
      expect(toolText).toContain('Tool output exceeded 50000 characters');
      expect(toolText).not.toContain('tail survives');
      expect(outputPath).toBeTruthy();
      expect(readFileSync(outputPath!, 'utf8')).toBe(largeOutput);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it('does not overwrite saved oversized tool results with repeated call IDs', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'tool-result-overflow-'));
    try {
      const firstOutput = `${'a'.repeat(60_000)}first tail`;
      const secondOutput = `${'b'.repeat(60_000)}second tail`;

      const first = await budgetToolResultForModel({
        homedir: sessionDir,
        toolName: 'Lookup',
        toolCallId: 'call_lookup',
        result: { output: firstOutput },
      });
      const second = await budgetToolResultForModel({
        homedir: sessionDir,
        toolName: 'Lookup',
        toolCallId: 'call_lookup',
        result: { output: secondOutput },
      });

      const firstPath = savedOutputPath(first.output);
      const secondPath = savedOutputPath(second.output);
      expect(firstPath).not.toBe(secondPath);
      expect(readFileSync(firstPath, 'utf8')).toBe(firstOutput);
      expect(readFileSync(secondPath, 'utf8')).toBe(secondOutput);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it('keeps oversized tool results intact when no session directory is available', async () => {
    const largeOutput = `${'x'.repeat(60_000)}tail survives`;
    const result = { output: largeOutput };

    const budgeted = await budgetToolResultForModel({
      toolName: 'Lookup',
      toolCallId: 'call_lookup',
      result,
    });

    expect(budgeted).toBe(result);
    expect(budgeted.output).toBe(largeOutput);
  });

  it('does not save already-truncated tool result previews as full output', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'tool-result-overflow-'));
    try {
      const largeOutput = `${'x'.repeat(60_000)}[...truncated]`;
      const result = {
        output: largeOutput,
        truncated: true,
      };

      const budgeted = await budgetToolResultForModel({
        homedir: sessionDir,
        toolName: 'Lookup',
        toolCallId: 'call_lookup',
        result,
      });

      expect(budgeted).toBe(result);
      expect(budgeted.output).toBe(largeOutput);
      expect(budgeted.output).not.toContain('output_path:');
      expect(existsSync(join(sessionDir, 'tool-results'))).toBe(false);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

function bashCall(): ToolCall {
  return {
    type: 'function',
    id: 'call_bash',
    name: 'Bash',
    arguments: '{"command":"printf hook-output","timeout":60}',
  };
}

function savedOutputPath(output: unknown): string {
  expect(typeof output).toBe('string');
  const outputPath = /^output_path: (.+)$/m.exec(output as string)?.[1];
  expect(outputPath).toBeTruthy();
  return outputPath!;
}

function hookErrorMessageAssertCommand(expected: string): string {
  const script = [
    "let input = '';",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    '  const payload = JSON.parse(input);',
    `  if (payload.error?.message === ${JSON.stringify(expected)}) process.exit(0);`,
    "  console.error(payload.error?.message ?? '<missing>');",
    '  process.exit(2);',
    '});',
  ].join('');
  return `node -e ${JSON.stringify(script)}`;
}
