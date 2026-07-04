import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { Session } from '../api/client';
import type { ChatMessage } from '../hooks/useChatMessages';

interface ChatViewProps {
  session: Session | null;
  messages: ChatMessage[];
  streaming: string;
  isStreaming: boolean;
  onSendMessage: (text: string) => void;
  onAbort: () => void;
}

export function ChatView({
  session,
  messages,
  streaming,
  isStreaming,
  onSendMessage,
  onAbort,
}: ChatViewProps) {
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, streaming, scrollToBottom]);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || !session) return;
    onSendMessage(trimmed);
    setInput('');
  }, [input, session, onSendMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  // Auto-resize textarea
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [input]);

  return (
    <div className="chat-view">
      {/* Messages */}
      <div className="chat-messages">
        {messages.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">⬡</div>
            <div className="empty-state-title">
              {session ? 'Start a Conversation' : 'No Session Selected'}
            </div>
            <div className="empty-state-desc">
              {session
                ? 'Type a message below to begin chatting with Nori.'
                : 'Create or select a session from the sidebar to get started.'}
            </div>
          </div>
        ) : (
          messages.map(msg => <MessageBubble key={msg.id} message={msg} />)
        )}
        {isStreaming && (
          <div className="chat-message chat-message-assistant chat-message-streaming">
            <div className="chat-message-role">Nori</div>
            <div className="chat-message-content">
              {streaming || 'Thinking…'}
              <span className="streaming-cursor">|</span>
            </div>
            <button className="chat-abort-btn" onClick={onAbort} title="Stop generating">
              ⏹ Stop
            </button>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="chat-input-area">
        <textarea
          ref={inputRef}
          className="chat-input"
          placeholder={
            session
              ? 'Type a message... (Enter to send, Shift+Enter for new line)'
              : 'Select a session to start chatting'
          }
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={!session}
        />
        <button
          className="btn btn-primary chat-send-btn"
          onClick={handleSend}
          disabled={!input.trim() || !session}
        >
          Send
        </button>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  const text = message.text;
  const thinking = message.thinking;
  const toolCalls = message.toolCalls;

  return (
    <div className={`chat-message ${isUser ? 'chat-message-user' : 'chat-message-assistant'}`}>
      <div className="chat-message-role">
        {isUser ? 'You' : message.role === 'system' ? 'System' : 'Nori'}
      </div>
      {thinking && (
        <div className="chat-message-thinking">
          <details>
            <summary>Thinking…</summary>
            <pre>{thinking}</pre>
          </details>
        </div>
      )}
      {toolCalls && toolCalls.length > 0 && (
        <div className="chat-message-tool-calls">
          {toolCalls.map((tc, i) => (
            <div key={i} className="tool-call">
              <span className="tool-call-name">🔧 {tc.name}</span>
              {tc.result && (
                <pre className="tool-call-result">{tc.result}</pre>
              )}
            </div>
          ))}
        </div>
      )}
      {text && <div className="chat-message-content">{text}</div>}
      <div className="chat-message-time">
        {message.createdAt
          ? new Date(message.createdAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })
          : ''}
      </div>
    </div>
  );
}
