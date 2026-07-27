import { AsyncLocalStorage } from 'node:async_hooks';

import type { ContentPart, Message } from '@nori-code/kosong';

import type { Agent } from '../agent';
import type {
  MCPContentBlock,
  MCPCreateMessageRequest,
  MCPCreateMessageResult,
  MCPHostRequestContext,
} from '../mcp';
import type { SDKSessionRPC } from '../rpc';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_CONCURRENCY = 2;
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
const MAX_MESSAGES = 128;
const MAX_CONTENT_BLOCKS = 256;
const MAX_SYSTEM_PROMPT_CHARS = 64 * 1024;
const MAX_INPUT_CHARS = 4 * 1024 * 1024;

export interface SessionMcpSamplingHostOptions {
  readonly getMainAgent: () => Agent | undefined;
  readonly rpc: SDKSessionRPC;
  readonly timeoutMs?: number;
  readonly maxConcurrency?: number;
  readonly maxOutputTokens?: number;
}

export class SessionMcpSamplingHost {
  private readonly approvedServers = new Set<string>();
  private readonly samplingScope = new AsyncLocalStorage<number>();
  private readonly timeoutMs: number;
  private readonly maxConcurrency: number;
  private readonly maxOutputTokens: number;
  private inFlight = 0;

  constructor(private readonly options: SessionMcpSamplingHostOptions) {
    this.timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.maxConcurrency = positiveInteger(options.maxConcurrency, DEFAULT_MAX_CONCURRENCY);
    this.maxOutputTokens = positiveInteger(options.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS);
  }

  readonly createMessage = async (
    request: MCPCreateMessageRequest,
    context: MCPHostRequestContext,
  ): Promise<MCPCreateMessageResult> => {
    const depth = this.samplingScope.getStore() ?? 0;
    if (depth > 0) {
      throw new Error(`Nested MCP sampling is not allowed for server "${context.serverName}".`);
    }
    if (this.inFlight >= this.maxConcurrency) {
      throw new Error(`MCP sampling concurrency limit reached (${String(this.maxConcurrency)}).`);
    }

    this.inFlight += 1;
    try {
      return await this.samplingScope.run(depth + 1, async () => {
        const signal = AbortSignal.any([context.signal, AbortSignal.timeout(this.timeoutMs)]);
        signal.throwIfAborted();
        return this.run(request, context, signal);
      });
    } finally {
      this.inFlight -= 1;
    }
  };

  private async run(
    request: MCPCreateMessageRequest,
    context: MCPHostRequestContext,
    signal: AbortSignal,
  ): Promise<MCPCreateMessageResult> {
    const agent = this.options.getMainAgent();
    if (agent === undefined) {
      throw new Error('MCP sampling requires the main agent to be ready.');
    }
    if (!agent.config.hasProvider || agent.config.modelAlias === undefined) {
      throw new Error('MCP sampling requires an active model.');
    }
    if ((request.tools?.length ?? 0) > 0) {
      throw new Error('MCP sampling tools are disabled; hidden tool loops are not allowed.');
    }

    const requestedMaxTokens = positiveInteger(request.maxTokens, 1);
    const maxTokens = Math.min(requestedMaxTokens, this.maxOutputTokens);
    const messages = toKosongMessages(request);
    const baseProvider = agent.config.provider;
    if (baseProvider.withMaxCompletionTokens === undefined) {
      throw new Error(`The active provider "${baseProvider.name}" cannot enforce a sampling token limit.`);
    }
    const provider = baseProvider.withMaxCompletionTokens(maxTokens);

    await this.authorize(context, request, agent, requestedMaxTokens, maxTokens, signal);
    signal.throwIfAborted();

    const generated = await agent.generate(
      provider,
      request.systemPrompt ?? '',
      [],
      messages,
      undefined,
      { signal },
    );
    signal.throwIfAborted();
    if (generated.message.toolCalls.length > 0) {
      throw new Error('The sampled model returned a tool call even though sampling tools are disabled.');
    }

    return {
      role: 'assistant',
      content: toMcpResultContent(generated.message.content),
      model: provider.modelName,
      stopReason: toMcpStopReason(generated.finishReason, generated.rawFinishReason),
    };
  }

  private async authorize(
    context: MCPHostRequestContext,
    request: MCPCreateMessageRequest,
    agent: Agent,
    requestedMaxTokens: number,
    maxTokens: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.approvedServers.has(context.serverName)) return;

    const response = await this.options.rpc.requestApproval(
      {
        agentId: 'main',
        toolCallId: `mcp-sampling:${context.serverName}:${String(context.requestId)}`,
        toolName: 'mcp_sampling',
        action: `Allow MCP server "${context.serverName}" to sample the active model`,
        display: {
          kind: 'generic',
          summary: `MCP server "${context.serverName}" requests model sampling`,
          detail: {
            serverName: context.serverName,
            model: agent.config.modelAlias,
            providerModel: agent.config.provider.modelName,
            requestedMaxTokens,
            maxTokens,
            systemPrompt: truncateText(request.systemPrompt ?? '', 2_000),
            messages: request.messages.map(samplingMessagePreview),
          },
        },
      },
      { signal },
    );

    if (response.decision !== 'approved') {
      const feedback = response.feedback?.trim();
      throw new Error(
        feedback === undefined || feedback.length === 0
          ? `MCP sampling was ${response.decision}.`
          : `MCP sampling was ${response.decision}: ${feedback}`,
      );
    }
    if (response.scope === 'session') {
      this.approvedServers.add(context.serverName);
    }
  }
}

function toKosongMessages(request: MCPCreateMessageRequest): Message[] {
  if (request.messages.length > MAX_MESSAGES) {
    throw new Error(`MCP sampling accepts at most ${String(MAX_MESSAGES)} messages.`);
  }
  if ((request.systemPrompt?.length ?? 0) > MAX_SYSTEM_PROMPT_CHARS) {
    throw new Error('MCP sampling system prompt is too large.');
  }

  let blockCount = 0;
  let inputChars = request.systemPrompt?.length ?? 0;
  return request.messages.map((message) => {
    const blocks = Array.isArray(message.content) ? message.content : [message.content];
    blockCount += blocks.length;
    if (blockCount > MAX_CONTENT_BLOCKS) {
      throw new Error(`MCP sampling accepts at most ${String(MAX_CONTENT_BLOCKS)} content blocks.`);
    }
    const content = blocks.map((block) => {
      const converted = toKosongContent(block);
      inputChars += contentPartSize(converted);
      if (inputChars > MAX_INPUT_CHARS) {
        throw new Error('MCP sampling input is too large.');
      }
      return converted;
    });
    return { role: message.role, content, toolCalls: [] };
  });
}

function toKosongContent(block: MCPContentBlock): ContentPart {
  if (block.type === 'text' && typeof block.text === 'string') {
    return { type: 'text', text: block.text };
  }
  if ((block.type === 'image' || block.type === 'audio') && typeof block.data === 'string') {
    const mimeType = block.mimeType?.trim();
    if (mimeType === undefined || !mimeType.startsWith(`${block.type}/`)) {
      throw new Error(`MCP sampling ${block.type} content has an invalid MIME type.`);
    }
    const url = `data:${mimeType};base64,${block.data}`;
    return block.type === 'image'
      ? { type: 'image_url', imageUrl: { url } }
      : { type: 'audio_url', audioUrl: { url } };
  }
  if (block.type === 'tool_use' || block.type === 'tool_result') {
    throw new Error('MCP sampling tool history is disabled because sampling tools are not enabled.');
  }
  throw new Error(`Unsupported MCP sampling content type: ${block.type}`);
}

function toMcpResultContent(parts: readonly ContentPart[]): MCPContentBlock {
  const text = parts
    .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
  if (text.length > 0) return { type: 'text', text };

  for (const part of parts) {
    if (part.type !== 'image_url' && part.type !== 'audio_url') continue;
    const parsed = parseDataUrl(part.type === 'image_url' ? part.imageUrl.url : part.audioUrl.url);
    if (parsed === undefined) continue;
    return {
      type: part.type === 'image_url' ? 'image' : 'audio',
      mimeType: parsed.mimeType,
      data: parsed.data,
    };
  }
  throw new Error('The sampled model returned no visible text, image, or audio content.');
}

function toMcpStopReason(
  finishReason: string | null,
  rawFinishReason: string | null,
): MCPCreateMessageResult['stopReason'] {
  if (finishReason === 'truncated') return 'maxTokens';
  if (rawFinishReason === 'stop_sequence') return 'stopSequence';
  if (finishReason === 'tool_calls') return 'toolUse';
  return 'endTurn';
}

function samplingMessagePreview(message: MCPCreateMessageRequest['messages'][number]) {
  const blocks = Array.isArray(message.content) ? message.content : [message.content];
  return {
    role: message.role,
    content: blocks.map((block) => {
      if (block.type === 'text') return { type: 'text', text: truncateText(block.text ?? '', 2_000) };
      if (block.type === 'image' || block.type === 'audio') {
        return { type: block.type, mimeType: block.mimeType, encodedChars: block.data?.length ?? 0 };
      }
      return { type: block.type };
    }),
  };
}

function contentPartSize(part: ContentPart): number {
  if (part.type === 'text') return part.text.length;
  if (part.type === 'image_url') return part.imageUrl.url.length;
  if (part.type === 'audio_url') return part.audioUrl.url.length;
  if (part.type === 'video_url') return part.videoUrl.url.length;
  return part.think.length;
}

function parseDataUrl(url: string): { readonly mimeType: string; readonly data: string } | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (match === null || match[1] === undefined || match[2] === undefined) return undefined;
  return { mimeType: match[1], data: match[2] };
}

function truncateText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.floor(value));
}
