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

interface BufferEntry {
  seq: number;
  envelope: EventEnvelope;
}

interface SessionState {
  ready: Promise<SessionEventJournal>;
  journal: SessionEventJournal | undefined;
  tail: BufferEntry[];
  queue: Promise<void>;
}

export class WSBroadcastService extends Disposable implements IWSBroadcastService {
  readonly _serviceBrand: undefined;

  private readonly _sessions = new Map<string, SessionState>();
  private readonly _maxBufferSize: number;
  private readonly _journalDir: string;
  private readonly _turnTracker = new InFlightTurnTracker();

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
    this._register(eventService.onDidPublish((event) => this._onEvent(event)));
  }

  private _onEvent(event: Event): void {
    if (this._store.isDisposed) return;
    const sid = extractSessionId(event);
    const evType = event.type;
    if (sid === undefined) {
      this.logger.warn(
        { eventType: evType, eventKeys: Object.keys(event as object) },
        'wsBroadcast: event has no session_id; dropping',
      );
      return;
    }
    const state = this._getOrCreateSession(sid);
    state.queue = state.queue
      .then(() => this._dispatch(sid, state, event))
      .catch((error: unknown) => {
        this.logger.warn({ sid, eventType: evType, err: String(error) }, 'wsBroadcast dispatch failed');
      });
  }

  private async _dispatch(sid: string, state: SessionState, event: Event): Promise<void> {
    if (this._store.isDisposed) return;
    const journal = await state.ready;
    const annotation = this._turnTracker.apply(sid, event);
    const envelope = isVolatileEventType(event.type)
      ? buildEventEnvelope(journal.seq, sid, event, {
          epoch: journal.epoch,
          volatile: true,
          ...(annotation.offset !== undefined ? { offset: annotation.offset } : {}),
        })
      : buildEventEnvelope(journal.nextSeq(), sid, event, { epoch: journal.epoch });

    if (!isVolatileEventType(event.type)) {
      journal.append(envelope.seq, envelope);
      state.tail.push({ seq: envelope.seq, envelope });
      while (state.tail.length > this._maxBufferSize) state.tail.shift();
    }
    if (this._store.isDisposed) return;
    const globalEvent = isGlobalSessionEvent(event.type);
    const targets = globalEvent
      ? new Set([
        ...this.connectionRegistry.values(),
        ...this.sessionClients.getConnections(sid),
      ])
      : this.sessionClients.getConnections(sid);
    const ignoreAgentFilter = globalEvent || isSessionWideEvent(event.type);
    for (const connection of targets) {
      if (!ignoreAgentFilter && !connection.acceptsAgentEvent(sid, event.agentId)) continue;
      connection.send(envelope);
    }
  }

  async getBufferedSince(
    sid: string,
    cursor: SessionCursor,
    agentIds?: readonly string[],
  ): Promise<BufferedSinceResult> {
    const state = this._getOrCreateSession(sid);
    const journal = await state.ready;
    await state.queue;
    const currentSeq = journal.seq;
    const epoch = journal.epoch;
    if (cursor.epoch !== undefined && cursor.epoch !== epoch) {
      return { events: [], resyncRequired: 'epoch_changed', currentSeq, epoch };
    }
    if (cursor.seq > currentSeq || currentSeq - cursor.seq > this._maxBufferSize) {
      return {
        events: [],
        resyncRequired: cursor.seq > currentSeq ? 'epoch_changed' : 'buffer_overflow',
        currentSeq,
        epoch,
      };
    }
    if (cursor.seq === currentSeq) return { events: [], resyncRequired: false, currentSeq, epoch };
    const events = state.tail.length > 0 && state.tail[0]!.seq <= cursor.seq + 1
      ? state.tail
      : await journal.readSince(cursor.seq, this._maxBufferSize);
    return {
      events: filterReplayEvents(events, cursor.seq, agentIds),
      resyncRequired: false,
      currentSeq,
      epoch,
    };
  }

  async getCursor(sid: string): Promise<{ seq: number; epoch: string }> {
    const state = this._getOrCreateSession(sid);
    const journal = await state.ready;
    await state.queue;
    return { seq: journal.seq, epoch: journal.epoch };
  }

  async getSnapshotState(sid: string, agentId: string): Promise<SessionSnapshotState> {
    const state = this._getOrCreateSession(sid);
    const journal = await state.ready;
    await state.queue;
    return {
      seq: journal.seq,
      epoch: journal.epoch,
      inFlightTurn: this._turnTracker.get(sid, agentId),
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

  async _drainForTest(sid: string): Promise<void> {
    const state = this._sessions.get(sid);
    if (state === undefined) return;
    await state.ready;
    await state.queue;
  }

  private _getOrCreateSession(sid: string): SessionState {
    let state = this._sessions.get(sid);
    if (state !== undefined) return state;
    const created: SessionState = {
      ready: SessionEventJournal.open(join(this._journalDir, `${sanitizeFileName(sid)}.jsonl`), this.logger),
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
    return state;
  }

  override dispose(): void {
    if (this._store.isDisposed) return;
    for (const state of this._sessions.values()) {
      if (state.journal !== undefined) void state.journal.close().catch(() => {});
    }
    this._sessions.clear();
    super.dispose();
  }
}

function extractSessionId(event: Event): string | undefined {
  const sessionId = (event as { sessionId?: unknown }).sessionId;
  if (typeof sessionId === 'string' && sessionId.length > 0) return sessionId;
  const session_id = (event as { session_id?: unknown }).session_id;
  return typeof session_id === 'string' && session_id.length > 0 ? session_id : undefined;
}

function filterReplayEvents(
  entries: readonly BufferEntry[],
  cursorSeq: number,
  agentIds: readonly string[] | undefined,
): BufferEntry[] {
  const afterCursor = entries.filter((entry) => entry.seq > cursorSeq);
  if (agentIds === undefined) return [...afterCursor];
  const selected = new Set(agentIds);
  return afterCursor.filter(
    (entry) => selected.has(entry.envelope.payload.agentId) || isSessionWideEvent(entry.envelope.type),
  );
}

/**
 * Collaboration events describe the session's shared state (a department chat
 * log, a discussion transcript), not one agent's transcript. They are emitted
 * by whichever agent happens to own the store, so the per-agent subscription
 * filter would hide them from every other viewer; deliver them to all
 * subscribers of the session instead. Unlike `isGlobalSessionEvent` these are
 * not fanned out to connections that never subscribed to the session.
 */
function isSessionWideEvent(type: string): boolean {
  return type === 'discussion.updated' || type === 'team.chat.updated';
}

function isGlobalSessionEvent(type: string): boolean {
  return (
    type === 'event.session.created' ||
    type === 'event.session.status_changed' ||
    type === 'session.meta.updated' ||
    type === 'event.config.changed' ||
    type === 'event.model_catalog.changed' ||
    type === 'event.workspace.created' ||
    type === 'event.workspace.updated' ||
    type === 'event.workspace.deleted' ||
    type === 'event.approval.requested' ||
    type === 'event.approval.resolved'
  );
}

function sanitizeFileName(sid: string): string {
  return sid.replace(/[^A-Za-z0-9._-]/g, '_');
}
