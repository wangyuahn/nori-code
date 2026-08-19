/**
 * `InFlightTurnTracker` — accumulates the current turn's volatile stream
 * state per session so a reconnecting client can rebuild mid-turn UI from
 * the session snapshot instead of replaying deltas (which are not journaled).
 *
 * Owned by `WSBroadcastService` and updated INSIDE its per-session dispatch
 * queue — this keeps the accumulated text, the journal watermark, and the
 * fan-out order mutually consistent without a second event subscription.
 *
 * `apply()` also returns the pre-append character offset for text-delta
 * frames; the broadcast layer stamps it on the wire envelope so clients can
 * align live deltas against snapshot text exactly (skip duplicates, detect
 * gaps).
 *
 * State is scoped by session + agent. Main and child chats use the same
 * accumulator; selecting an agent only changes the lookup key.
 */

import type { Event, InFlightToolCall, InFlightTurn } from '@nori-code/protocol';

interface ToolAccum {
  tool_call_id: string;
  name: string;
  args?: unknown;
  description?: string;
  display?: unknown;
  last_progress?: {
    kind: 'stdout' | 'stderr' | 'progress' | 'status' | 'custom';
    text?: string;
    percent?: number;
  };
}

interface TurnAccum {
  turnId: number;
  assistantText: string;
  thinkingText: string;
  tools: Map<string, ToolAccum>;
}

export interface VolatileAnnotation {
  /** Pre-append offset for text-delta frames. */
  offset?: number;
}

export class InFlightTurnTracker {
  private readonly bySession = new Map<string, Map<string, TurnAccum>>();

  apply(sessionId: string, event: Event): VolatileAnnotation {
    const agentId = event.agentId;
    const turns = this.bySession.get(sessionId) ?? new Map<string, TurnAccum>();

    switch (event.type) {
      case 'turn.started': {
        turns.set(agentId, {
          turnId: event.turnId,
          assistantText: '',
          thinkingText: '',
          tools: new Map(),
        });
        this.bySession.set(sessionId, turns);
        return {};
      }
      case 'turn.ended': {
        turns.delete(agentId);
        if (turns.size === 0) this.bySession.delete(sessionId);
        return {};
      }
      case 'assistant.delta': {
        const turn = turns.get(agentId);
        if (!turn || turn.turnId !== event.turnId) return {};
        const offset = turn.assistantText.length;
        turn.assistantText += event.delta;
        return { offset };
      }
      case 'thinking.delta': {
        const turn = turns.get(agentId);
        if (!turn || turn.turnId !== event.turnId) return {};
        const offset = turn.thinkingText.length;
        turn.thinkingText += event.delta;
        return { offset };
      }
      case 'tool.call.started': {
        const turn = turns.get(agentId);
        if (!turn || turn.turnId !== event.turnId) return {};
        turn.tools.set(event.toolCallId, {
          tool_call_id: event.toolCallId,
          name: event.name,
          args: event.args,
          ...(event.description !== undefined ? { description: event.description } : {}),
          ...(event.display !== undefined ? { display: event.display } : {}),
        });
        return {};
      }
      case 'tool.progress': {
        const turn = turns.get(agentId);
        const tool = turn?.tools.get(event.toolCallId);
        if (!tool) return {};
        const { kind, text, percent } = event.update;
        if (kind === 'custom') return {};
        tool.last_progress = {
          kind,
          ...(text !== undefined ? { text } : {}),
          ...(percent !== undefined ? { percent } : {}),
        };
        return {};
      }
      case 'tool.result': {
        turns.get(agentId)?.tools.delete(event.toolCallId);
        return {};
      }
      default:
        return {};
    }
  }

  get(sessionId: string, agentId: string): InFlightTurn | null {
    const turn = this.bySession.get(sessionId)?.get(agentId);
    if (!turn) return null;
    const running_tools: InFlightToolCall[] = Array.from(turn.tools.values()).map((t) => ({
      tool_call_id: t.tool_call_id,
      name: t.name,
      ...(t.args !== undefined ? { args: t.args } : {}),
      ...(t.description !== undefined ? { description: t.description } : {}),
      ...(t.display !== undefined ? { display: t.display } : {}),
      ...(t.last_progress !== undefined ? { last_progress: t.last_progress } : {}),
    }));
    return {
      turn_id: turn.turnId,
      assistant_text: turn.assistantText,
      thinking_text: turn.thinkingText,
      running_tools,
    };
  }

  clear(sessionId: string, agentId?: string): void {
    if (agentId === undefined) {
      this.bySession.delete(sessionId);
      return;
    }
    const turns = this.bySession.get(sessionId);
    turns?.delete(agentId);
    if (turns?.size === 0) this.bySession.delete(sessionId);
  }
}
