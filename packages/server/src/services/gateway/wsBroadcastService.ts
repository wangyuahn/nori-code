

import { join } from 'node:path';

import { Disposable, IEnvironmentService, IEventService, ILogService } from '@nori-code/agent-core';
import { isVolatileEventType, type Event, type SessionCursor } from '@nori-code/protocol';
import { IConnectionRegistry } from './connectionRegistry';
import { InFlightTurnTracker } from './inFlightTurnTracker';
import { ISessionClientsService } from './sessionClients';
import { SessionEventJournal } from './sessionEventJournal';
import {
  DEFAULT_MAX_BUFFER_SIZE,
  IWSBroadcastService,
  type BufferedSinceResult,
  type SessionSnapshotState,
} from './wsBroadcast';

import { buildEventEnvelope, type EventEnvelope } from '#/ws/protocol';
import {
  findSwarmByAgent,
  findSwarmByToolCall,
  getSwarmStatus,
  nextSwarmRound,
  setSwarmStatus,
  type SwarmStatusEntry,
  type SwarmTaskStatusEntry,
  type SwarmTokenUsage,
  updateSwarmStatus,
} from '../../routes/swarmStatus';

interface BufferEntry {
  seq: number;
  envelope: EventEnvelope;
}

interface SessionState {
  /** Resolves when the journal file has been opened/recovered. */
  ready: Promise<SessionEventJournal>;
  /** Set once `ready` resolves — for sync best-effort reads. */
  journal: SessionEventJournal | undefined;
  /** In-memory tail cache of the most recent durable envelopes. */
  tail: BufferEntry[];
  /** Per-session dispatch chain: keeps journal append + fan-out ordered. */
  queue: Promise<void>;
}

const MAIN_AGENT_ID = 'main';
const MAX_SWARM_OUTPUT_CHARS = 128_000;

interface PendingSwarmToolCall {
  ownerAgentId: string;
  toolCallId: string;
  description: string;
}

function isSubagentTranscriptEvent(event: Event): boolean {
  if (event.agentId === MAIN_AGENT_ID) return false;
  const type = (event as { type: string }).type;
  return type.startsWith('turn.')
    || type.startsWith('assistant.')
    || type.startsWith('thinking.')
    || type.startsWith('tool.call.')
    || type.startsWith('shell.')
    || type === 'tool.progress'
    || type === 'tool.result'
    || type === 'prompt.completed'
    || type === 'error';
}

function toSwarmUsage(usage: {
  inputOther: number;
  output: number;
  inputCacheRead: number;
  inputCacheCreation: number;
}): SwarmTokenUsage {
  const input = usage.inputOther + usage.inputCacheRead + usage.inputCacheCreation;
  return {
    input,
    output: usage.output,
    cache_read: usage.inputCacheRead,
    cache_write: usage.inputCacheCreation,
    total: input + usage.output,
  };
}

function addSwarmUsage(
  current: SwarmTokenUsage | undefined,
  incoming: SwarmTokenUsage,
): SwarmTokenUsage {
  if (current === undefined) return incoming;
  return {
    input: current.input + incoming.input,
    output: current.output + incoming.output,
    cache_read: current.cache_read + incoming.cache_read,
    cache_write: current.cache_write + incoming.cache_write,
    total: current.total + incoming.total,
  };
}

function aggregateSwarmUsage(
  tasks: readonly SwarmTaskStatusEntry[] | undefined,
): SwarmTokenUsage | undefined {
  const usages = tasks?.flatMap(task => task.usage === undefined ? [] : [task.usage]) ?? [];
  if (usages.length === 0) return undefined;
  return usages.reduce<SwarmTokenUsage>((total, usage) => addSwarmUsage(total, usage), {
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
    total: 0,
  });
}

function upsertSwarmTask(
  current: readonly SwarmTaskStatusEntry[] | undefined,
  task: SwarmTaskStatusEntry,
): SwarmTaskStatusEntry[] {
  const tasks = [...(current ?? [])];
  const index = tasks.findIndex(item => item.id === task.id);
  if (index < 0) tasks.push(task);
  else tasks[index] = { ...tasks[index], ...task };
  return tasks;
}

function countCompletedSwarmTasks(tasks: readonly SwarmTaskStatusEntry[] | undefined): number {
  return tasks?.filter(task => ['completed', 'failed', 'cancelled'].includes(task.status)).length ?? 0;
}

function estimateOutputTokens(text: string): number {
  let asciiChars = 0;
  let nonAsciiChars = 0;
  for (const char of text) {
    if (char.charCodeAt(0) <= 0x7f) asciiChars++;
    else nonAsciiChars++;
  }
  return Math.ceil(asciiChars / 4) + nonAsciiChars;
}

export class WSBroadcastService extends Disposable implements IWSBroadcastService {
  readonly _serviceBrand: undefined;

  private readonly _sessions = new Map<string, SessionState>();
  private readonly _maxBufferSize: number;
  private readonly _journalDir: string;
  private readonly _turnTracker = new InFlightTurnTracker();
  private readonly _pendingSwarmTools = new Map<string, PendingSwarmToolCall[]>();

  constructor(
    @IEventService eventService: IEventService,
    @ILogService private readonly logger: ILogService,
    @ISessionClientsService private readonly sessionClients: ISessionClientsService,
    @IConnectionRegistry private readonly connectionRegistry: IConnectionRegistry,
    @IEnvironmentService env: IEnvironmentService,
  ) {
    super();
    this._maxBufferSize = DEFAULT_MAX_BUFFER_SIZE;
    this._journalDir = join(env.homeDir, 'server', 'events');

    this._register(
      eventService.onDidPublish((event) => {
        this._onEvent(event);
      }),
    );
  }

  private _onEvent(event: Event): void {
    if (this._store.isDisposed) return;
    const sid = extractSessionId(event);
    const evType = (event as { type?: string }).type ?? '<no-type>';
    if (!sid) {
      this.logger.warn(
        { eventType: evType, eventKeys: Object.keys(event as object) },
        'wsBroadcast: event has no session_id; dropping',
      );
      return;
    }
    this._updateSwarmStatus(sid, event);
    // Subagent transcript streams have their own task-output surface. Sending
    // every token and tool step through the main session socket can generate
    // thousands of frames per second during a swarm, starving the main
    // assistant stream and making snapshots wait behind an ever-growing
    // journal queue. Shared events such as code.change and subagent lifecycle
    // updates still pass through this channel.
    if (isSubagentTranscriptEvent(event)) return;
    const state = this._getOrCreateSession(sid);
    state.queue = state.queue
      .then(() => this._dispatch(sid, state, event))
      .catch((err: unknown) => {
        this.logger.warn({ sid, eventType: evType, err: String(err) }, 'wsBroadcast dispatch failed');
      });
  }

  private _updateSwarmStatus(sid: string, event: Event): void {
    if (
      event.type === 'tool.call.started'
      && (event.name === 'AgentSwarm' || event.name === 'nori_swarm_launch')
    ) {
      const pending = this._pendingSwarmTools.get(sid) ?? [];
      pending.push({
        ownerAgentId: event.agentId,
        toolCallId: event.toolCallId,
        description: event.description ?? event.name,
      });
      this._pendingSwarmTools.set(sid, pending);
      return;
    }

    if (event.type === 'background.task.started' || event.type === 'background.task.terminated') {
      const { info } = event;
      if (info.kind !== 'agent' || !info.subagentType?.startsWith('swarm')) return;

      const prior = getSwarmStatus(info.taskId);
      const parsedCount = Number.parseInt(info.subagentType.split(':')[1] ?? '', 10);
      const taskCount = Number.isFinite(parsedCount) && parsedCount > 0
        ? parsedCount
        : Math.max(prior?.task_count ?? 0, prior?.tasks?.length ?? 0, 1);
      const terminal = event.type === 'background.task.terminated';
      const pending = terminal ? undefined : this._takePendingSwarmTool(sid, event.agentId);
      const parentSwarm = prior?.parent_swarm_id === undefined && event.agentId !== MAIN_AGENT_ID
        ? findSwarmByAgent(sid, event.agentId)
        : undefined;
      const status = !terminal
        ? 'running' as const
        : info.status === 'completed'
          ? 'done' as const
          : info.status === 'killed'
            ? 'stopped' as const
            : 'failed' as const;
      setSwarmStatus({
        ...prior,
        swarm_id: info.taskId,
        status,
        task_count: taskCount,
        completed_count: terminal ? taskCount : (prior?.completed_count ?? 0),
        session_id: sid,
        task_id: info.taskId,
        description: info.description,
        owner_agent_id: prior?.owner_agent_id ?? event.agentId,
        parent_swarm_id: prior?.parent_swarm_id ?? parentSwarm?.swarm_id,
        tool_call_id: prior?.tool_call_id ?? pending?.toolCallId,
        round: prior?.round ?? parentSwarm?.round ?? nextSwarmRound(sid),
        started_at: prior?.started_at ?? new Date(info.startedAt).toISOString(),
        usage: aggregateSwarmUsage(prior?.tasks),
      });
      return;
    }

    if (event.type === 'subagent.spawned') {
      const ownerAgentId = event.parentAgentId ?? event.agentId;
      const swarm = findSwarmByToolCall(sid, ownerAgentId, event.parentToolCallId);
      if (swarm === undefined) return;
      const task: SwarmTaskStatusEntry = {
        id: event.subagentId,
        agent_id: event.subagentId,
        parent_agent_id: ownerAgentId,
        profile: event.subagentName,
        label: event.description ?? `Agent ${String((event.swarmIndex ?? 0) + 1)}`,
        status: 'pending',
      };
      updateSwarmStatus(swarm.swarm_id, current => {
        const tasks = upsertSwarmTask(current.tasks, task);
        return {
          ...current,
          tasks,
          task_count: Math.max(current.task_count, tasks.length),
          completed_count: countCompletedSwarmTasks(tasks),
        };
      });
      return;
    }

    if (event.type === 'subagent.started') {
      this._updateSwarmTask(sid, event.subagentId, task => ({ ...task, status: 'running' }));
      return;
    }

    if (event.type === 'subagent.suspended') {
      this._updateSwarmTask(sid, event.subagentId, task => ({ ...task, status: 'paused' }));
      return;
    }

    if (event.type === 'assistant.delta') {
      this._updateSwarmTask(sid, event.agentId, task => {
        const output = `${task.output ?? ''}${event.delta}`.slice(-MAX_SWARM_OUTPUT_CHARS);
        const liveOutput = `${task.live_output ?? ''}${event.delta}`.slice(-MAX_SWARM_OUTPUT_CHARS);
        return {
          ...task,
          output,
          output_bytes: output.length,
          live_output: liveOutput,
          live_output_tokens: estimateOutputTokens(liveOutput),
        };
      }, false);
      return;
    }

    if (event.type === 'turn.step.completed') {
      const usage = event.usage;
      if (usage === undefined) return;
      this._updateSwarmTask(sid, event.agentId, task => ({
        ...task,
        usage: addSwarmUsage(task.usage, toSwarmUsage(usage)),
        live_output: '',
        live_output_tokens: 0,
      }), false);
      return;
    }

    if (event.type === 'subagent.completed') {
      this._updateSwarmTask(sid, event.subagentId, task => ({
        ...task,
        status: 'completed',
        output: event.resultSummary.slice(-MAX_SWARM_OUTPUT_CHARS),
        output_bytes: event.resultSummary.length,
        usage: event.usage === undefined ? task.usage : toSwarmUsage(event.usage),
        live_output: '',
        live_output_tokens: 0,
        context_tokens: event.contextTokens,
      }));
      return;
    }

    if (event.type === 'subagent.failed') {
      this._updateSwarmTask(sid, event.subagentId, task => ({
        ...task,
        status: 'failed',
        output: event.error,
        output_bytes: event.error.length,
      }));
    }
  }

  private _takePendingSwarmTool(sid: string, ownerAgentId: string): PendingSwarmToolCall | undefined {
    const pending = this._pendingSwarmTools.get(sid);
    if (pending === undefined) return undefined;
    const index = pending.findIndex(item => item.ownerAgentId === ownerAgentId);
    if (index < 0) return undefined;
    const [matched] = pending.splice(index, 1);
    if (pending.length === 0) this._pendingSwarmTools.delete(sid);
    return matched;
  }

  private _updateSwarmTask(
    sid: string,
    agentId: string,
    update: (task: SwarmTaskStatusEntry) => SwarmTaskStatusEntry,
    notify = true,
  ): void {
    const swarm = findSwarmByAgent(sid, agentId);
    if (swarm === undefined) return;
    updateSwarmStatus(swarm.swarm_id, current => {
      const tasks = current.tasks?.map(task => task.agent_id === agentId ? update(task) : task);
      const taskCount = Math.max(current.task_count, tasks?.length ?? 0);
      const completedCount = countCompletedSwarmTasks(tasks);
      const allTasksSettled = taskCount > 0
        && tasks !== undefined
        && tasks.length >= taskCount
        && completedCount >= taskCount;
      const failed = tasks?.some(task => task.status === 'failed' || task.status === 'cancelled') ?? false;
      return {
        ...current,
        tasks,
        status: allTasksSettled ? (failed ? 'failed' : 'done') : current.status,
        task_count: taskCount,
        completed_count: completedCount,
        usage: aggregateSwarmUsage(tasks),
      };
    }, notify);
  }

  private async _dispatch(sid: string, state: SessionState, event: Event): Promise<void> {
    if (this._store.isDisposed) return;
    const journal = await state.ready;
    const evType = (event as { type?: string }).type ?? 'event.unknown';

    // Track in-flight turn state inside the dispatch queue so accumulated
    // text, the journal watermark, and fan-out order stay consistent. For
    // text deltas this also yields the pre-append offset for the envelope.
    const annotation = this._turnTracker.apply(sid, event);

    let envelope: EventEnvelope;
    if (isVolatileEventType(evType)) {
      // Volatile frames ride the current durable watermark and are never
      // journaled or replayed; reconnecting clients recover their state from
      // the session snapshot instead.
      envelope = buildEventEnvelope(journal.seq, sid, event, {
        epoch: journal.epoch,
        volatile: true,
        ...(annotation.offset !== undefined ? { offset: annotation.offset } : {}),
      });
    } else {
      const seq = journal.nextSeq();
      envelope = buildEventEnvelope(seq, sid, event, { epoch: journal.epoch });
      journal.append(seq, envelope);
      state.tail.push({ seq, envelope });
      while (state.tail.length > this._maxBufferSize) {
        state.tail.shift();
      }
    }

    if (this._store.isDisposed) return;
    const targets = isGlobalSessionEvent(evType)
      ? this.connectionRegistry.values()
      : this.sessionClients.getConnections(sid);
    for (const conn of targets) {
      conn.send(envelope);
    }
  }

  async getBufferedSince(sid: string, cursor: SessionCursor): Promise<BufferedSinceResult> {
    const state = this._getOrCreateSession(sid);
    const journal = await state.ready;
    // Drain in-flight dispatches so the watermark reflects everything
    // published before this call.
    await state.queue;

    const currentSeq = journal.seq;
    const epoch = journal.epoch;

    if (cursor.epoch !== undefined && cursor.epoch !== epoch) {
      return { events: [], resyncRequired: 'epoch_changed', currentSeq, epoch };
    }
    if (cursor.seq > currentSeq) {
      // Client is ahead of the journal — a cursor from another incarnation
      // (e.g. pre-journal v1 server). Without a matching epoch we cannot
      // trust it; force a snapshot rebuild.
      return { events: [], resyncRequired: 'epoch_changed', currentSeq, epoch };
    }
    if (cursor.seq === currentSeq) {
      return { events: [], resyncRequired: false, currentSeq, epoch };
    }
    if (currentSeq - cursor.seq > this._maxBufferSize) {
      return { events: [], resyncRequired: 'buffer_overflow', currentSeq, epoch };
    }

    const tail = state.tail;
    if (tail.length > 0 && tail[0]!.seq <= cursor.seq + 1) {
      const events = tail.filter((e) => e.seq > cursor.seq);
      return { events, resyncRequired: false, currentSeq, epoch };
    }

    // Gap reaches behind the memory tail (e.g. first subscribe after a
    // server restart) — serve from the on-disk journal.
    const events = await journal.readSince(cursor.seq, this._maxBufferSize);
    return { events, resyncRequired: false, currentSeq, epoch };
  }

  async getCursor(sid: string): Promise<{ seq: number; epoch: string }> {
    const state = this._getOrCreateSession(sid);
    const journal = await state.ready;
    await state.queue;
    return { seq: journal.seq, epoch: journal.epoch };
  }

  async getSnapshotState(sid: string): Promise<SessionSnapshotState> {
    const state = this._getOrCreateSession(sid);
    const journal = await state.ready;
    await state.queue;
    // Sync reads after the drain — seq and in-flight state form a
    // consistent pair (no dispatch can interleave a sync section).
    return {
      seq: journal.seq,
      epoch: journal.epoch,
      inFlightTurn: this._turnTracker.get(sid),
    };
  }

  currentSeq(sid: string): number {
    return this._sessions.get(sid)?.journal?.seq ?? 0;
  }

  _currentSeqForTest(sid: string): number {
    return this.currentSeq(sid);
  }

  _bufferLengthForTest(sid: string): number {
    return this._sessions.get(sid)?.tail.length ?? 0;
  }

  /** Settles when every queued dispatch for `sid` has completed. */
  async _drainForTest(sid: string): Promise<void> {
    const state = this._sessions.get(sid);
    if (!state) return;
    await state.ready;
    await state.queue;
  }

  private _getOrCreateSession(sid: string): SessionState {
    let state = this._sessions.get(sid);
    if (!state) {
      const filePath = join(this._journalDir, `${sanitizeFileName(sid)}.jsonl`);
      const created: SessionState = {
        ready: SessionEventJournal.open(filePath, this.logger),
        journal: undefined,
        tail: [],
        queue: Promise.resolve(),
      };
      created.ready = created.ready.then((journal) => {
        created.journal = journal;
        return journal;
      });
      this._sessions.set(sid, created);
      state = created;
    }
    return state;
  }

  override dispose(): void {
    if (this._store.isDisposed) return;
    for (const state of this._sessions.values()) {
      const journal = state.journal;
      if (journal) {
        void journal.close().catch(() => {});
      }
    }
    this._sessions.clear();
    super.dispose();
  }
}

function extractSessionId(event: Event): string | undefined {
  const camel = (event as { sessionId?: unknown }).sessionId;
  if (typeof camel === 'string' && camel.length > 0) return camel;
  const snake = (event as { session_id?: unknown }).session_id;
  if (typeof snake === 'string' && snake.length > 0) return snake;
  return undefined;
}

function isGlobalSessionEvent(type: string): boolean {
  return (
    type === 'event.session.created' ||
    type === 'event.session.status_changed' ||
    // Session metadata (e.g. title) must reach every connection, including
    // clients not yet subscribed to the session, so session lists stay in sync
    // when another client creates or renames a session.
    type === 'session.meta.updated' ||
    type === 'event.config.changed' ||
    // Provider-model catalog is global (not session-scoped): every connected
    // client must learn when a manual or scheduled refresh changes it.
    type === 'event.model_catalog.changed' ||
    // Workspace registry is not session-scoped: workspace lifecycle events ride
    // the '__global__' watermark and fan out to every connection.
    type === 'event.workspace.created' ||
    type === 'event.workspace.updated' ||
    type === 'event.workspace.deleted'
  );
}

/** Session ids are ULID-ish, but never trust an id used as a path segment. */
function sanitizeFileName(sid: string): string {
  return sid.replace(/[^A-Za-z0-9._-]/g, '_');
}
