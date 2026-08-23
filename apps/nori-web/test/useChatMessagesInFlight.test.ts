import { act, createElement, useEffect, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type Snapshot } from '../src/api/client';
import { useChatMessages, type UseChatMessagesResult } from '../src/hooks/useChatMessages';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

class SilentWebSocket {
  readonly OPEN = 1;
  readyState = 1;
  onopen: (() => void) | undefined;
  onmessage: ((event: MessageEvent) => void) | undefined;
  onclose: (() => void) | undefined;
  onerror: (() => void) | undefined;
  readonly send = vi.fn();
  readonly close = vi.fn();
}

function idleSnapshot(): Snapshot {
  return { in_flight_turn: null, pending_approvals: [], pending_questions: [] } as unknown as Snapshot;
}

function runningSnapshot(turnId: number, thinking: string, assistant: string): Snapshot {
  return {
    in_flight_turn: {
      turn_id: turnId,
      assistant_text: assistant,
      thinking_text: thinking,
      running_tools: [],
    },
    pending_approvals: [],
    pending_questions: [],
  } as unknown as Snapshot;
}

function stubTransport(snapshots: Record<string, Snapshot>) {
  const getSnapshot = vi.spyOn(api.sessions, 'getSnapshot')
    .mockImplementation(async (_id: string, agentId?: string) => snapshots[agentId ?? 'main'] ?? idleSnapshot());
  vi.spyOn(api.sessions, 'getMessages').mockResolvedValue({ items: [] });
  vi.spyOn(api.sessions, 'getDepartmentChat').mockResolvedValue({ department_leader_agent_id: null, messages: [] });
  vi.spyOn(api.sessions, 'getStatus').mockResolvedValue({
    status: 'running',
    thinking_level: 'off',
    permission: 'manual',
    discuss_mode: false,
    main_write_enabled: true,
    goal: null,
    context_tokens: 0,
    max_context_tokens: 128_000,
    context_usage: 0,
  });
  vi.spyOn(api.sessions.approvals, 'list').mockResolvedValue({ items: [] });
  vi.spyOn(api.sessions.questions, 'list').mockResolvedValue({ items: [] });
  vi.spyOn(api.sessions.prompts, 'list').mockResolvedValue({ active: null, queued: [] });
  vi.spyOn(api, 'getWsUrl').mockResolvedValue('ws://localhost/api/v1/ws');
  globalThis.WebSocket = SilentWebSocket as unknown as typeof WebSocket;
  return getSnapshot;
}

function Probe({ sessionId, agentId, onState }: {
  sessionId: string;
  agentId: string;
  onState: (state: UseChatMessagesResult) => void;
}): ReactElement {
  const state = useChatMessages(sessionId, agentId);
  useEffect(() => onState(state), [onState, state]);
  return createElement('div', { 'data-agent': agentId }, state.currentWorkBlocks
    .map(block => (block.type === 'thinking' ? block.text : ''))
    .join(''));
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

// 打开一个成员页面时，那一轮已经流过的思考与输出不会被订阅重播，历史记录也要等
// 这一步结束才成形。挂载与切换 agent 都必须主动取一次 in-flight 快照，否则切到
// 正在工作的成员就是一片空白。
describe('mount-time in-flight hydration', () => {
  it('restores the turn already streaming before a subagent page was ever opened', async () => {
    const getSnapshot = stubTransport({
      'agent-1': runningSnapshot(7, 'Weighing the two options first.', 'partial answer'),
    });

    let latest!: UseChatMessagesResult;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(createElement(Probe, {
        sessionId: 'session-team',
        agentId: 'agent-1',
        onState: state => { latest = state; },
      }));
      await Promise.resolve();
    });

    expect(getSnapshot).toHaveBeenCalledWith('session-team', 'agent-1');
    expect(latest.isStreaming).toBe(true);
    expect(latest.activeTurnId).toBe('7');
    expect(latest.currentThinking).toBe('Weighing the two options first.');
    expect(latest.currentStreaming).toBe('partial answer');
    expect(latest.currentWorkBlocks).toMatchObject([
      { type: 'thinking', text: 'Weighing the two options first.' },
    ]);
    expect(container.textContent).toBe('Weighing the two options first.');
  });

  it('rehydrates for the newly selected agent and does not keep the previous one streaming', async () => {
    const getSnapshot = stubTransport({
      'agent-1': runningSnapshot(7, 'Member one is mid-turn.', ''),
      'agent-2': idleSnapshot(),
    });

    let latest!: UseChatMessagesResult;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const render = async (agentId: string) => {
      await act(async () => {
        root.render(createElement(Probe, {
          sessionId: 'session-team',
          agentId,
          onState: state => { latest = state; },
        }));
        await Promise.resolve();
      });
    };

    await render('agent-1');
    expect(latest.isStreaming).toBe(true);

    await render('agent-2');
    expect(getSnapshot).toHaveBeenCalledWith('session-team', 'agent-2');
    expect(latest.isStreaming).toBe(false);
    expect(latest.activeTurnId).toBeNull();
    expect(latest.currentWorkBlocks).toEqual([]);

    await render('agent-1');
    expect(getSnapshot).toHaveBeenCalledTimes(3);
    expect(latest.isStreaming).toBe(true);
    expect(latest.currentWorkBlocks).toMatchObject([{ type: 'thinking', text: 'Member one is mid-turn.' }]);
  });
});
