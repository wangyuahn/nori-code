/**
 * Streaming callbacks — provider deltas are translated into LoopEvents
 * and completed text / thinking parts are persisted via appendContentPart in order.
 *
 * The fixture (`FakeLLM`) cooperates by invoking the streaming callbacks
 * during `chat()`, mirroring how a real provider adapter would. Tests
 * here drive `runTurn` and assert against the observed events / WAL
 * writes only.
 */

import { describe, expect, it } from 'vitest';

import type { LLM, LLMChatParams, LLMChatResponse } from '../../src/loop/index';
import { createLoopEventDispatcher, runTurn } from '../../src/loop/index';
import { CollectingSink } from './fixtures/collecting-sink';
import { makeEndTurnResponse, zeroUsage } from './fixtures/fake-llm';
import { RecordingContext } from './fixtures/recording-context';

/**
 * A custom LLM that exposes onTextDelta / onThinkDelta / onToolCallDelta /
 * onTextPart / onThinkPart so each test can decide what the provider emits.
 */
class StreamingLLM implements LLM {
  readonly systemPrompt = 'streaming system prompt';
  readonly modelName = 'streaming';

  readonly responseProvider: (params: LLMChatParams) => Promise<LLMChatResponse>;

  constructor(provider: (params: LLMChatParams) => Promise<LLMChatResponse>) {
    this.responseProvider = provider;
  }

  async chat(params: LLMChatParams): Promise<LLMChatResponse> {
    return this.responseProvider(params);
  }
}

async function runWithLLM(llm: LLM): Promise<{
  sink: CollectingSink;
  context: RecordingContext;
}> {
  const sink = new CollectingSink();
  const context = new RecordingContext();
  await runTurn({
    turnId: 'turn-1',
    signal: new AbortController().signal,
    llm,
    buildMessages: context.buildMessages,
    dispatchEvent: createLoopEventDispatcher({
      appendTranscriptRecord: context.appendTranscriptRecord,
      emitLiveEvent: sink.emit,
    }),
  });
  return { sink, context };
}

describe('runTurn — streaming callbacks', () => {
  it('routes onTextDelta into text.delta events', async () => {
    const llm = new StreamingLLM(async (params) => {
      params.onTextDelta?.('hel');
      params.onTextDelta?.('lo');
      return {
        toolCalls: [],
        providerFinishReason: 'completed',
        usage: zeroUsage(),
      };
    });
    const { sink } = await runWithLLM(llm);
    const deltas = sink.byType('text.delta').map((e) => e.delta);
    expect(deltas).toEqual(['hel', 'lo']);
  });

  it('routes onThinkDelta into thinking.delta events', async () => {
    const llm = new StreamingLLM(async (params) => {
      params.onThinkDelta?.('think...');
      params.onThinkDelta?.('more');
      return makeEndTurnResponse('done');
    });
    const { sink } = await runWithLLM(llm);
    const thinks = sink.byType('thinking.delta').map((e) => e.delta);
    expect(thinks).toEqual(['think...', 'more']);
  });

  it('routes onToolCallDelta into tool.call.delta events', async () => {
    const llm = new StreamingLLM(async (params) => {
      params.onToolCallDelta?.({
        toolCallId: 'tc-1',
        name: 'echo',
        argumentsPart: '{"text":',
      });
      params.onToolCallDelta?.({
        toolCallId: 'tc-1',
        argumentsPart: '"hi"}',
      });
      return makeEndTurnResponse('done');
    });
    const { sink } = await runWithLLM(llm);
    const deltas = sink.byType('tool.call.delta');
    expect(deltas.length).toBe(2);
    expect(deltas[0]?.toolCallId).toBe('tc-1');
    expect(deltas[0]?.name).toBe('echo');
    expect(deltas[0]?.argumentsPart).toBe('{"text":');
    expect(deltas[1]?.argumentsPart).toBe('"hi"}');
  });

  it('routes onTextPart into appendContentPart{type:"text"}', async () => {
    const llm = new StreamingLLM(async (params) => {
      await params.onTextPart?.({
        type: 'text',
        text: 'first paragraph',
      });
      await params.onTextPart?.({
        type: 'text',
        text: 'second paragraph',
      });
      return makeEndTurnResponse('done');
    });
    const { context, sink } = await runWithLLM(llm);
    const cps = context.contentParts();
    expect(cps.length).toBe(2);
    expect(cps[0]?.part).toEqual({ type: 'text', text: 'first paragraph' });
    expect(cps[1]?.part).toEqual({ type: 'text', text: 'second paragraph' });
    expect(sink.byType('content.part').map((e) => e.part)).toEqual([
      { type: 'text', text: 'first paragraph' },
      { type: 'text', text: 'second paragraph' },
    ]);
    // stepUuid is consistent across the part appends and the step envelope
    const stepBeginUuid = context.stepBegins()[0]?.uuid;
    expect(stepBeginUuid).toBeDefined();
    expect(cps.every((c) => c.stepUuid === stepBeginUuid)).toBe(true);
  });

  it('routes onThinkPart into appendContentPart{type:"think"} preserving encrypted', async () => {
    const llm = new StreamingLLM(async (params) => {
      await params.onThinkPart?.({
        type: 'think',
        think: 'reasoning',
        encrypted: 'sig-abc',
      });
      await params.onThinkPart?.({
        type: 'think',
        think: 'plain reasoning',
      });
      return makeEndTurnResponse('done');
    });
    const { context } = await runWithLLM(llm);
    const cps = context.contentParts();
    expect(cps.length).toBe(2);
    expect(cps[0]?.part).toEqual({
      type: 'think',
      think: 'reasoning',
      encrypted: 'sig-abc',
    });
    expect(cps[1]?.part).toEqual({ type: 'think', think: 'plain reasoning' });
  });

  it('preserves the order of mixed content parts as they fire', async () => {
    const llm = new StreamingLLM(async (params) => {
      await params.onThinkPart?.({
        type: 'think',
        think: 'first',
      });
      await params.onTextPart?.({
        type: 'text',
        text: 'middle',
      });
      await params.onThinkPart?.({
        type: 'think',
        think: 'last',
      });
      return makeEndTurnResponse('done');
    });
    const { context } = await runWithLLM(llm);
    const kinds = context.contentParts().map((c) => c.part.type);
    expect(kinds).toEqual(['think', 'text', 'think']);
  });

  it('all completed content parts are persisted before step.end fires', async () => {
    // Use the chat() result's onTextPart to fan out two content parts,
    // then assert step.end falls AFTER both appendContentPart calls in
    // the recorded context call sequence.
    const llm = new StreamingLLM(async (params) => {
      await params.onTextPart?.({
        type: 'text',
        text: 'a',
      });
      await params.onTextPart?.({
        type: 'text',
        text: 'b',
      });
      return makeEndTurnResponse('a b');
    });
    const { context } = await runWithLLM(llm);
    const seq = context.kinds();
    const lastContent = seq.lastIndexOf('appendContentPart');
    const stepEnd = seq.indexOf('appendStepEnd');
    expect(lastContent).toBeGreaterThanOrEqual(0);
    expect(stepEnd).toBeGreaterThan(lastContent);
  });
});

/**
 * Only a completed content part is recorded, so a stream that dies mid-block
 * used to leave the assistant message empty — the reader watched text arrive and
 * then the whole round vanished on the next history read. The step records the
 * accumulated deltas as a part before letting the failure propagate.
 */
describe('runTurn — partial content survives a failed step', () => {
  const failMidStream = (deltas: readonly string[], thinking?: readonly string[]) =>
    new StreamingLLM(async (params) => {
      for (const delta of thinking ?? []) params.onThinkDelta?.(delta);
      for (const delta of deltas) params.onTextDelta?.(delta);
      throw new Error('terminated');
    });

  it('records the text and reasoning that streamed before the provider failed', async () => {
    const sink = new CollectingSink();
    const context = new RecordingContext();
    await expect(runTurn({
      turnId: 'turn-fail',
      signal: new AbortController().signal,
      llm: failMidStream(['Here is half ', 'a sentence'], ['weighing it']),
      buildMessages: context.buildMessages,
      dispatchEvent: createLoopEventDispatcher({
        appendTranscriptRecord: context.appendTranscriptRecord,
        emitLiveEvent: sink.emit,
      }),
    })).rejects.toThrow('terminated');

    // Reasoning first, then text: the order the reader saw them in.
    expect(context.contentParts().map((c) => c.part)).toEqual([
      { type: 'think', think: 'weighing it' },
      { type: 'text', text: 'Here is half a sentence' },
    ]);
    // Same open step as the envelope, so it lands in that assistant message.
    const stepUuid = context.stepBegins()[0]?.uuid;
    expect(context.contentParts().every((c) => c.stepUuid === stepUuid)).toBe(true);
  });

  it('records the partial answer when the user aborts mid-stream', async () => {
    const controller = new AbortController();
    const context = new RecordingContext();
    const llm = new StreamingLLM(async (params) => {
      params.onTextDelta?.('as far as I got');
      controller.abort();
      params.signal.throwIfAborted();
      return makeEndTurnResponse('unreachable');
    });

    const result = await runTurn({
      turnId: 'turn-abort',
      signal: controller.signal,
      llm,
      buildMessages: context.buildMessages,
      dispatchEvent: createLoopEventDispatcher({
        appendTranscriptRecord: context.appendTranscriptRecord,
      }),
    });

    expect(result.stopReason).toBe('aborted');
    expect(context.contentParts().map((c) => c.part)).toEqual([
      { type: 'text', text: 'as far as I got' },
    ]);
  });

  it('keeps the completed part and drops nothing when the provider closed the block itself', async () => {
    const context = new RecordingContext();
    const llm = new StreamingLLM(async (params) => {
      params.onTextDelta?.('done');
      await params.onTextPart?.({ type: 'text', text: 'done' });
      throw new Error('terminated after the block closed');
    });

    await expect(runTurn({
      turnId: 'turn-closed-block',
      signal: new AbortController().signal,
      llm,
      buildMessages: context.buildMessages,
      dispatchEvent: createLoopEventDispatcher({
        appendTranscriptRecord: context.appendTranscriptRecord,
      }),
    })).rejects.toThrow('terminated after the block closed');

    // The part superseded its deltas, so the flush must not duplicate it.
    expect(context.contentParts().map((c) => c.part)).toEqual([{ type: 'text', text: 'done' }]);
  });

  it('drops the failed attempt\'s stream when a retry re-sends the message', async () => {
    const context = new RecordingContext();
    let attempt = 0;
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'retrying',
      isRetryableError: () => true,
      async chat(params: LLMChatParams): Promise<LLMChatResponse> {
        attempt += 1;
        if (attempt === 1) {
          params.onTextDelta?.('first attempt text');
          throw new Error('terminated');
        }
        params.onTextDelta?.('second attempt text');
        await params.onTextPart?.({ type: 'text', text: 'second attempt text' });
        return makeEndTurnResponse('second attempt text');
      },
    };

    await runTurn({
      turnId: 'turn-retry',
      signal: new AbortController().signal,
      llm,
      buildMessages: context.buildMessages,
      dispatchEvent: createLoopEventDispatcher({
        appendTranscriptRecord: context.appendTranscriptRecord,
      }),
    });

    expect(attempt).toBe(2);
    expect(context.contentParts().map((c) => c.part)).toEqual([
      { type: 'text', text: 'second attempt text' },
    ]);
  });
});
