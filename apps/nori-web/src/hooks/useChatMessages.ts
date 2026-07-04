/**
 * Hook that manages messages for a session:
 * - Loads message history via REST API
 * - Connects to WebSocket for streaming responses
 * - Provides: messages array, sendMessage function, isStreaming, abort function
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { api, type Message, type MessageContent } from '../api/client';

export interface ToolCall {
  name: string;
  args: unknown;
  result?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  toolCalls?: ToolCall[];
  thinking?: string;
  createdAt?: string;
  isStreaming?: boolean;
}

export interface UseChatMessagesResult {
  messages: ChatMessage[];
  isStreaming: boolean;
  currentStreaming: string;
  sendMessage: (text: string) => Promise<void>;
  abort: () => void;
}

interface WsMessage {
  type: string;
  payload?: {
    delta?: string;
    message_id?: string;
    id?: string;
    name?: string;
    args?: unknown;
    result?: string;
  };
}

/** Convert API Message (content array) to flat ChatMessage. */
function apiMessageToChat(m: Message): ChatMessage {
  const text = Array.isArray(m.content)
    ? m.content
        .filter((c: MessageContent) => c.type === 'text' && c.text)
        .map((c: MessageContent) => c.text!)
        .join('')
    : typeof m.content === 'string'
      ? m.content
      : '';

  const thinkingFromContent = Array.isArray(m.content)
    ? m.content
        .filter((c: MessageContent) => c.type === 'thinking')
        .map((c: MessageContent) => c.thinking ?? c.text ?? '')
        .join('\n')
    : '';
  const thinking = m.thinking || thinkingFromContent || undefined;

  const toolCalls = m.tool_calls?.map(tc => ({
    name: tc.name,
    args: tc.args,
    result: tc.result,
  }));

  if (Array.isArray(m.content)) {
    for (const c of m.content) {
      if (c.type === 'tool_use') {
        toolCalls?.push({ name: c.name ?? 'tool', args: c.input, result: undefined });
      } else if (c.type === 'tool_result') {
        if (toolCalls && toolCalls.length > 0) {
          const last = toolCalls[toolCalls.length - 1];
          if (!last.result) last.result = c.output;
        }
      }
    }
  }

  return {
    id: m.id,
    role: m.role,
    text,
    thinking,
    toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
    createdAt: m.created_at,
  };
}

export function useChatMessages(sessionId: string | null): UseChatMessagesResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [currentStreaming, setCurrentStreaming] = useState('');
  const wsRef = useRef<WebSocket | null>(null);
  const sessionRef = useRef(sessionId);
  const sendAbortRef = useRef<AbortController | null>(null);
  const streamingRef = useRef('');

  // Keep refs in sync so callbacks always see the latest values
  sessionRef.current = sessionId;
  streamingRef.current = currentStreaming;

  // Reset streaming on session change (R4)
  useEffect(() => {
    setIsStreaming(false);
    setCurrentStreaming('');
    if (!sessionId) {
      setMessages([]);
    }
  }, [sessionId]);

  // Load history when session changes
  useEffect(() => {
    if (!sessionId) return;

    let cancelled = false;

    async function loadHistory() {
      try {
        const data = await api.getMessages(sessionId!);
        if (cancelled) return;

        const msgs = (data?.items ?? []).sort(
          (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        ).map(apiMessageToChat);

        setMessages(prev => {
          const existingIds = new Set(prev.map(m => m.id));
          const newMsgs = msgs.filter(m => !existingIds.has(m.id));
          if (newMsgs.length === 0) return prev;
          return [...prev, ...newMsgs].sort(
            (a, b) => new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime()
          );
        });
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to load messages:', error);
        }
      }
    }

    void loadHistory();

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Connect WebSocket for streaming
  useEffect(() => {
    if (!sessionId) return;

    let closed = false;
    const wsUrl = api.getWsUrl();
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (closed) {
        ws.close();
        return;
      }
      ws.send(
        JSON.stringify({
          type: 'subscribe',
          session_id: sessionId,
        }),
      );
    };

    ws.onmessage = (event: MessageEvent) => {
      if (closed) return;

      let data: WsMessage;
      try {
        data = JSON.parse(event.data as string);
      } catch {
        console.error('Failed to parse WebSocket message:', event.data);
        return;
      }

      switch (data.type) {
        case 'event.assistant.delta':
          setCurrentStreaming(prev => prev + (data.payload?.delta ?? ''));
          break;

        case 'event.turn.complete': {
          setCurrentStreaming(prev => {
            streamingRef.current = prev;
            return '';
          });
          if (streamingRef.current) {
            setMessages(prev => [
              ...prev,
              {
                id: data.payload?.message_id ?? `${Date.now()}`,
                role: 'assistant',
                text: streamingRef.current,
                createdAt: new Date().toISOString(),
              },
            ]);
          }
          setIsStreaming(false);
          break;
        }

        case 'event.tool_call': {
          const tc = data.payload;
          setMessages(prev => [
            ...prev,
            {
              id: tc?.id ?? `${Date.now()}`,
              role: 'system',
              text: '',
              toolCalls: [
                { name: tc?.name ?? 'unknown', args: tc?.args, result: tc?.result },
              ],
              createdAt: new Date().toISOString(),
            },
          ]);
          break;
        }

        case 'event.error':
          console.error('Stream error:', data.payload);
          setIsStreaming(false);
          break;

        default:
          break;
      }
    };

    ws.onerror = () => {
      if (!closed) {
        console.error('WebSocket connection error');
      }
    };

    ws.onclose = () => {
      if (!closed) {
        wsRef.current = null;
      }
    };

    return () => {
      closed = true;
      ws.close();
      wsRef.current = null;
    };
  }, [sessionId]);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!sessionId || !text.trim()) return;

      // Cancel any in-flight send
      sendAbortRef.current?.abort();
      const controller = new AbortController();
      sendAbortRef.current = controller;

      const userMsg: ChatMessage = {
        id: `${Date.now()}`,
        role: 'user',
        text: text.trim(),
        createdAt: new Date().toISOString(),
      };

      setMessages(prev => [...prev, userMsg]);
      setIsStreaming(true);

      try {
        await api.sendPrompt(sessionId, text.trim());
      } catch (error) {
        if (controller.signal.aborted) return;
        setMessages(prev => [
          ...prev,
          {
            id: `${Date.now()}`,
            role: 'system',
            text: `Error: ${error instanceof Error ? error.message : 'Failed to send message'}`,
            createdAt: new Date().toISOString(),
          },
        ]);
        setIsStreaming(false);
      }
    },
    [sessionId],
  );

  const abort = useCallback(() => {
    sendAbortRef.current?.abort();
    if (sessionId) {
      api.abortSession(sessionId).catch(error => { console.error('Abort failed:', error); });
    }
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'abort', session_id: sessionId }));
    }
    setIsStreaming(false);
    setCurrentStreaming('');
  }, [sessionId]);

  return { messages, isStreaming, currentStreaming, sendMessage, abort };
}
