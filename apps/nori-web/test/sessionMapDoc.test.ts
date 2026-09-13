import { describe, expect, it } from 'vitest';

import {
  annotationBounds,
  canonicalMapPositionKey,
  edgesForLayout,
  emptySessionMapDoc,
  isLiveLayoutParentEdge,
  loadCachedMapAgents,
  lookupMapPosition,
  normalizeMapPositions,
  parseCachedMapAgents,
  parseSessionMapDoc,
  saveCachedMapAgents,
  sessionMatchesLabelFilter,
  toggleSessionLabel,
} from '../src/components/sessionMapDoc';
import { parentSessionIdOf } from '../src/utils/session-mount';
import type { Session } from '../src/api/client';

describe('sessionMapDoc', () => {
  it('parses empty / corrupt storage as empty doc', () => {
    expect(parseSessionMapDoc(null)).toEqual(emptySessionMapDoc());
    expect(parseSessionMapDoc('{')).toEqual(emptySessionMapDoc());
  });

  it('rewrites bare session position keys to session:id and keeps world centers', () => {
    expect(canonicalMapPositionKey('abc')).toBe('session:abc');
    expect(canonicalMapPositionKey('session:abc')).toBe('session:abc');
    expect(canonicalMapPositionKey('draft:x')).toBe('draft:x');
    expect(canonicalMapPositionKey('creating:x')).toBe('creating:x');
    expect(lookupMapPosition({ abc: { x: 10, y: 20 } }, 'session:abc')).toEqual({ x: 10, y: 20 });
    expect(lookupMapPosition({ 'session:abc': { x: 3, y: 4 }, abc: { x: 1, y: 2 } }, 'abc'))
      .toEqual({ x: 3, y: 4 });
    expect(normalizeMapPositions({ abc: { x: 8, y: 9 }, 'session:abc': { x: 80, y: 90 } }))
      .toEqual({ 'session:abc': { x: 80, y: 90 } });
    const doc = parseSessionMapDoc(JSON.stringify({
      version: 2,
      annotations: [],
      labels: [],
      sessionLabels: {},
      positions: { root: { x: 400, y: 300 } },
    }));
    expect(doc.positions).toEqual({ 'session:root': { x: 400, y: 300 } });
  });

  it('parses and loads agents cache for map first-paint', () => {
    expect(parseCachedMapAgents(null)).toEqual([]);
    expect(parseCachedMapAgents('[{"hostId":"h","agentId":"a","title":"T"}]')).toEqual([
      { hostId: 'h', agentId: 'a', title: 'T' },
    ]);
    const storage = {
      store: '' as string,
      getItem() { return this.store || null; },
      setItem(_key: string, value: string) { this.store = value; },
    };
    saveCachedMapAgents([{ hostId: 'h', agentId: 'a1', role: 'dev' }], storage);
    expect(loadCachedMapAgents(storage)).toEqual([
      { hostId: 'h', agentId: 'a1', role: 'dev' },
    ]);
  });

  it('uses an explicit note rect and ignores legacy node bindings', () => {
    const withNodes = annotationBounds(
      { id: 'a', title: 'Group', color: '#3b82f6', nodeIds: ['x', 'y'] },
      [
        { session: { id: 'x' }, x: 40, y: 40 },
        { session: { id: 'y' }, x: 280, y: 40 },
      ],
      { width: 200, height: 72 },
    );
    expect(withNodes).toEqual({ x: 40, y: 40, width: 248, height: 120 });

    const empty = annotationBounds(
      {
        id: 'b',
        title: '',
        color: '#22c55e',
        nodeIds: [],
        rect: { x: 10, y: 20, width: 100, height: 80 },
      },
      [],
      { width: 200, height: 72 },
    );
    expect(empty).toEqual({ x: 10, y: 20, width: 100, height: 80 });
  });

  it('prefers explicit marquee rect over soft-bound node hull', () => {
    const rect = { x: 12, y: 34, width: 400, height: 220 };
    const bounds = annotationBounds(
      {
        id: 'ann',
        title: 'Note',
        color: '#3b82f6',
        nodeIds: ['x', 'y'],
        rect,
      },
      [
        { session: { id: 'x' }, x: 40, y: 40 },
        { session: { id: 'y' }, x: 280, y: 40 },
      ],
      { width: 200, height: 72 },
    );
    expect(bounds).toEqual(rect);
  });

  it('tolerates missing color and strips invalid rect on parse', () => {
    const doc = parseSessionMapDoc(JSON.stringify({
      version: 1,
      annotations: [
        { id: 'a1', title: 'ok', nodeIds: [], rect: { x: 1, y: 2, width: 30, height: 40 } },
        { id: 'a2', title: 'bad', color: '#ef4444', nodeIds: [], rect: { x: 1, y: 2, width: 0, height: 40 } },
        { id: 'a3', title: 'nan', color: '#22c55e', nodeIds: [], rect: { x: Number.NaN, y: 1, width: 10, height: 10 } },
      ],
      labels: [],
      sessionLabels: {},
    }));
    expect(doc.annotations).toHaveLength(3);
    expect(doc.annotations[0]!.color).toMatch(/^#/);
    expect(doc.annotations[0]!.rect).toEqual({ x: 1, y: 2, width: 30, height: 40 });
    expect(doc.annotations[1]!.rect).toBeUndefined();
    expect(doc.annotations[2]!.rect).toBeUndefined();
  });

  it('keeps legacy label helpers for stored documents', () => {
    const doc = toggleSessionLabel(
      {
        ...emptySessionMapDoc(),
        labels: [{ id: 'l1', name: 'hot', color: '#ef4444' }],
      },
      's1',
      'l1',
    );
    expect(sessionMatchesLabelFilter('s1', doc.sessionLabels, [])).toBe(true);
    expect(sessionMatchesLabelFilter('s1', doc.sessionLabels, ['l1'])).toBe(true);
    expect(sessionMatchesLabelFilter('s2', doc.sessionLabels, ['l1'])).toBe(false);
  });
});

describe('edgesForLayout', () => {
  const session = (partial: Partial<Session> & { id: string }): Session => ({
    title: partial.title ?? partial.id,
    status: 'idle',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...partial,
  });

  it('merges mapDoc parent edges with server metadata gaps', () => {
    const sessions = [
      session({ id: 'root' }),
      session({ id: 'wired', metadata: { parent_session_id: 'root' } }),
      session({ id: 'createChild', metadata: { parent_session_id: 'root' } }),
    ];
    // mapDoc only knows about `wired` — createChild must still layout under root.
    const layout = edgesForLayout([
      { id: 'e1', type: 'parent', source: 'root', target: 'wired' },
    ], sessions);
    expect(layout).toEqual(expect.arrayContaining([
      { parent_session_id: 'root', child_session_id: 'wired' },
      { parent_session_id: 'root', child_session_id: 'createChild' },
    ]));
    expect(layout).toHaveLength(2);
    expect(parentSessionIdOf(sessions[2])).toBe('root');
  });

  it('prefers mapDoc parent over conflicting metadata', () => {
    const sessions = [
      session({ id: 'a' }),
      session({ id: 'b' }),
      session({ id: 'child', metadata: { parent_session_id: 'a' } }),
    ];
    const layout = edgesForLayout([
      { id: 'e1', type: 'parent', source: 'b', target: 'child' },
    ], sessions);
    expect(layout).toEqual([
      { parent_session_id: 'b', child_session_id: 'child' },
    ]);
  });

  it('does not let an unapplied extra job replace the live parent in layout', () => {
    const sessions = [
      session({ id: 'live' }),
      session({ id: 'extra' }),
      session({ id: 'child', metadata: { parent_session_id: 'live' } }),
    ];
    const layout = edgesForLayout([
      { id: 'live', type: 'parent', source: 'live', target: 'child' },
      { id: 'extra', type: 'parent', source: 'extra', target: 'child', status: 'pending-multi-parent' },
    ], sessions);
    expect(layout).toEqual([
      { parent_session_id: 'live', child_session_id: 'child' },
    ]);
    expect(isLiveLayoutParentEdge({ type: 'parent', status: 'pending-multi-parent' })).toBe(false);
    expect(isLiveLayoutParentEdge({ type: 'parent', status: 'draft' })).toBe(false);
    expect(isLiveLayoutParentEdge({ type: 'parent' })).toBe(true);
  });
});
