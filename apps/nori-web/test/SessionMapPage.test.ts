import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type Session } from '../src/api/client';
import {
  buildMapComponents,
  cachedAgentsFromMapMembers,
  centerViewOnNode,
  findNearestValidWireTarget,
  fitTreeView,
  hitSessionMapNode,
  HOME_PULL_STRENGTH,
  isComponentRootPin,
  isValidWireTarget,
  mapMembersFromAgentCache,
  resolveMapNodeSpawnPosition,
  resolveNodeDragGroupIds,
  buildForceMapNodes,
  SESSION_MAP_AMBIENT_HOME_GRAVITY,
  layoutSessionMountForest,
  memberProjectCwd,
  nearestSessionMapNodeDistance,
  parentSessionIdOf,
  projectFolderName,
  SessionMapPage,
  snapMapView,
  snapComponentChildrenToLiveRoot,
  tidyComponentAroundRoot,
  wireSourceParentSessionId,
  zoomTreeView,
  NODE_H,
  NODE_W,
} from '../src/components/SessionMapPage';
import {
  describeMapCurrentAction,
  describeMapErrorSummary,
  mapNodeCapabilities,
  mapStatusDotClass,
  formatMapStatusLabel,
  mapMemberStatus,
  mergeGraphWithMapEdges,
  mapParentByChildFromEdges,
  matchesMapStatusFilter,
  pendingTopologyOpsReady,
  reconcileParentEdgesWithServer,
  upsertParentMapEdge,
  upsertTypedMapEdge,
} from '../src/utils/session-graph';
import { I18nProvider } from '../src/i18n';
import {
  loadCachedMapAgents,
  loadSessionMapDoc,
  parseCachedMapAgents,
  saveCachedMapAgents,
  saveCachedMapGraph,
  SESSION_MAP_AGENTS_CACHE_KEY,
  SESSION_MAP_GRAPH_CACHE_KEY,
  type SessionMapEdge,
  parseSessionMapDoc,
} from '../src/components/sessionMapDoc';
import { sessionsForSidebar, wouldCreateMountCycle } from '../src/utils/session-mount';
import { dedupeMapMembers, mapOpenTarget } from '../src/utils/session-map-open';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.removeItem('nori-session-map-doc');
  localStorage.removeItem(SESSION_MAP_AGENTS_CACHE_KEY);
  localStorage.removeItem(SESSION_MAP_GRAPH_CACHE_KEY);
});

function mockViewport(width = 1000, height = 600) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON: () => ({}),
  });
  if (typeof globalThis.ResizeObserver === 'undefined') {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  }
}

function session(partial: Partial<Session> & Pick<Session, 'id'>): Session {
  return {
    title: partial.title ?? partial.id,
    status: 'idle',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: partial.updated_at ?? '2026-01-02T00:00:00.000Z',
    metadata: partial.metadata,
    ...partial,
  };
}

describe('session map layout', () => {
  it('extracts the last path segment as the project folder name', () => {
    expect(projectFolderName('/home/user/nori-code')).toBe('nori-code');
    expect(projectFolderName('C:\\Users\\me\\proj\\')).toBe('proj');
  });

  it('resolves project cwd from session metadata, falling back to the parent host', () => {
    const root = session({ id: 'root', title: 'Root', metadata: { cwd: '/home/user/nori-code' } });
    const child = session({
      id: 'child',
      title: 'Child',
      metadata: { parent_session_id: 'root', cwd: '/home/user/other-app' },
    });
    const hosted = session({
      id: 'hosted',
      title: 'Reviewer',
      metadata: { parent_session_id: 'root', mount_role: 'reviewer' },
    });
    const byId = new Map([['root', root], ['child', child], ['hosted', hosted]]);
    expect(memberProjectCwd({ kind: 'session', session: root }, byId)).toBe('/home/user/nori-code');
    expect(memberProjectCwd({ kind: 'session', session: child }, byId)).toBe('/home/user/other-app');
    expect(memberProjectCwd({
      kind: 'session',
      session: hosted,
      hostSessionId: 'root',
      agent: { agent_id: 'a1', kind: 'team', name: 'Reviewer', role: 'reviewer', status: 'idle' },
    }, byId)).toBe('/home/user/nori-code');
  });

  it('places mount children under parents and keeps top-level roots', () => {
    const nodes = [
      session({ id: 'root', title: 'Root', updated_at: '2026-01-03T00:00:00.000Z' }),
      session({
        id: 'child',
        title: 'Child',
        metadata: { parent_session_id: 'root' },
        updated_at: '2026-01-02T00:00:00.000Z',
      }),
      session({ id: 'solo', title: 'Solo', updated_at: '2026-01-01T00:00:00.000Z' }),
    ];
    const { placed, edges } = layoutSessionMountForest({
      nodes,
      edges: [{ child_session_id: 'child', parent_session_id: 'root' }],
    });
    expect(placed.map((node) => node.member.session.id)).toEqual(expect.arrayContaining(['root', 'child', 'solo']));
    expect(edges).toHaveLength(1);
    expect(parentSessionIdOf(nodes[1]!)).toBe('root');
  });

  it('derives edges from metadata when the graph omits them', () => {
    const nodes = [
      session({ id: 'root', title: 'Root' }),
      session({ id: 'child', title: 'Child', metadata: { parent_session_id: 'root', mount_role: 'reviewer' } }),
    ];
    const { edges, placed } = layoutSessionMountForest({ nodes, edges: [] });
    expect(edges).toHaveLength(1);
    const child = placed.find((node) => node.member.session.id === 'child');
    const root = placed.find((node) => node.member.session.id === 'root');
    expect(child!.y).toBeGreaterThan(root!.y);
  });

  it('does not place synthetic agent cards; mounted members overlay the session', () => {
    const nodes = [
      session({ id: 'root', title: 'Root' }),
      session({
        id: 'child',
        title: 'Reviewer',
        metadata: { parent_session_id: 'root', mount_role: 'reviewer' },
      }),
    ];
    const { placed, edges } = layoutSessionMountForest(
      { nodes, edges: [{ child_session_id: 'child', parent_session_id: 'root' }] },
      [{
        kind: 'agent',
        hostSessionId: 'root',
        session: session({
          id: 'agent:root:a1',
          title: 'Reviewer',
          metadata: { parent_session_id: 'root', mount_role: 'reviewer' },
        }),
        agent: {
          agent_id: 'a1',
          kind: 'team',
          name: 'Reviewer',
          role: 'reviewer',
          status: 'idle',
          mounted_session_id: 'child',
        },
      }],
    );
    expect(placed).toHaveLength(2);
    expect(edges).toHaveLength(1);
    expect(placed.some((node) => node.member.session.id.startsWith('agent:'))).toBe(false);
    expect(placed.find((node) => node.member.session.id === 'child')?.member.agent?.agent_id).toBe('a1');
  });

  it('does not place a stale agent ghost when another host claims a mounted session', () => {
    const nodes = [
      session({ id: 'root', title: 'Root' }),
      session({ id: 'other', title: 'Other' }),
      session({ id: 'child', title: 'Child', metadata: { parent_session_id: 'root' } }),
    ];
    const staleAgent = {
      agent_id: 'stale_member',
      kind: 'team' as const,
      name: 'Stale member',
      status: 'idle',
      mounted_session_id: 'child',
    };
    const { placed } = layoutSessionMountForest(
      { nodes, edges: [{ child_session_id: 'child', parent_session_id: 'root' }] },
      [{
        kind: 'agent',
        hostSessionId: 'other',
        session: session({ id: 'agent:other:stale_member', title: 'Stale member' }),
        agent: staleAgent,
      }],
    );

    expect(placed.find((node) => node.member.session.id === 'child')?.member.agent).toBeUndefined();
    // Mounted session is already a node — never spawn an agent: duplicate for any host.
    expect(placed.some((node) => node.member.session.id.startsWith('agent:'))).toBe(false);
    expect(placed.some((node) => node.member.agent?.agent_id === 'stale_member')).toBe(false);
  });

  it('keeps fit/zoom helpers stable', () => {
    // Small content in a large viewport may enlarge up to FIT_MAX_SCALE (1.35).
    expect(fitTreeView({ width: 400, height: 200 }, { width: 1000, height: 600 }).scale).toBeGreaterThan(1);
    expect(fitTreeView({ width: 400, height: 200 }, { width: 1000, height: 600 }).scale).toBeLessThanOrEqual(1.35);
    expect(zoomTreeView({ x: 0, y: 0, scale: 1 }, 2, 100, 50)).toEqual({ x: -100, y: -50, scale: 2 });
  });

  it('centers the viewport on a session node', () => {
    const centered = centerViewOnNode(
      { x: 0, y: 0, scale: 1 },
      { x: 100, y: 50 },
      { width: 1000, height: 600 },
      { width: 220, height: 88 },
    );
    expect(centered.scale).toBe(1);
    expect(centered.x).toBe(1000 / 2 - (100 + 220 / 2));
    expect(centered.y).toBe(600 / 2 - (50 + 88 / 2));
  });

  it('centers within a usable inset (floating list / chrome)', () => {
    const centered = centerViewOnNode(
      { x: 0, y: 0, scale: 1 },
      { x: 100, y: 50 },
      { width: 1000, height: 600 },
      { width: 220, height: 88 },
      { left: 16, top: 72, bottom: 36 },
    );
    expect(centered.x).toBe(16 + (1000 - 16) / 2 - (100 + 220 / 2));
    expect(centered.y).toBe(72 + (600 - 72 - 36) / 2 - (50 + 88 / 2));
  });

  it('formats a readable map status with running duration', () => {
    expect(formatMapStatusLabel('idle')).toBe('idle');
    expect(formatMapStatusLabel('awaiting_approval')).toBe('waiting-approval');
    expect(formatMapStatusLabel('aborted')).toBe('stopped');
    expect(formatMapStatusLabel('timeout')).toBe('timeout');
    expect(formatMapStatusLabel(
      'running',
      '2026-01-01T00:00:00.000Z',
      Date.parse('2026-01-01T00:02:00.000Z'),
    )).toBe('running · 2m');
  });

  it('describes thinking, tool, and waiting-approval current actions', () => {
    const member = {
      kind: 'session' as const,
      session: session({ id: 'a', title: 'Alpha', status: 'running' }),
    };
    expect(describeMapCurrentAction(member)?.kind).toBe('thinking');
    expect(describeMapCurrentAction(member, {
      approvals: [{ session_id: 'a', tool_name: 'Bash' }],
      activity: [],
      turns: {},
      errors: [],
    })).toEqual({ kind: 'waiting-approval', detail: 'Bash' });
    expect(describeMapCurrentAction(member, {
      approvals: [],
      activity: [],
      turns: { a: { toolName: 'Read' } },
      errors: [],
    })).toEqual({ kind: 'tool', detail: 'Read' });
    expect(matchesMapStatusFilter('running', 'running')).toBe(true);
    expect(matchesMapStatusFilter('idle', 'running')).toBe(false);
    expect(matchesMapStatusFilter('error', 'error')).toBe(true);
    expect(describeMapErrorSummary({
      kind: 'session',
      session: session({
        id: 'err',
        title: 'Broken',
        status: 'error',
        metadata: { last_error: 'tool timed out' },
      }),
    })).toBe('tool timed out');
    expect(describeMapErrorSummary({
      kind: 'session',
      session: session({ id: 'slow', title: 'Slow', status: 'aborted' }),
      agent: {
        agent_id: 'reviewer',
        kind: 'team',
        name: 'Reviewer',
        status: 'aborted',
        summary: 'Member discussion turn timed out after 90s.',
      },
    })).toBe('Member discussion turn timed out after 90s.');
    expect(mapMemberStatus({
      kind: 'session',
      session: session({ id: 'slow', title: 'Slow', status: 'aborted' }),
      agent: {
        agent_id: 'reviewer',
        kind: 'team',
        name: 'Reviewer',
        status: 'aborted',
        summary: 'Member discussion turn timed out after 90s.',
      },
    })).toBe('timeout');
    expect(matchesMapStatusFilter('timeout', 'error')).toBe(true);
  });
});

describe('sidebar mount filter', () => {
  it('hides mounted children unless they are the active session', () => {
    const items = [
      session({ id: 'root', title: 'Root' }),
      session({ id: 'child', title: 'Child', metadata: { parent_session_id: 'root' } }),
    ];
    expect(sessionsForSidebar(items, null).map((item) => item.id)).toEqual(['root']);
    expect(sessionsForSidebar(items, 'child').map((item) => item.id)).toEqual(['root', 'child']);
  });
});

describe('SessionMapPage smoke', () => {
  it.skip('renders float chrome + empty stage with zero sessions (no throw)', async () => {
    vi.spyOn(api.sessions, 'getGraph').mockResolvedValue({ nodes: [], edges: [] });
    vi.spyOn(api.sessions, 'getAgents').mockResolvedValue({ items: [] });
    mockViewport();

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SessionMapPage, {
          sessions: [],
          onOpenSession: vi.fn(),
        })));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(container.querySelector('.session-map-page')).not.toBeNull();
      expect(container.querySelector('.session-map-float-top')).not.toBeNull();
      expect(container.querySelector('.session-map-stage')).not.toBeNull();
      expect(container.querySelector('.session-map-search')).not.toBeNull();
      expect(container.textContent).toMatch(/Conversation Map|对话地图/);
      expect(container.textContent).toMatch(/No sessions yet|还没有会话/);
      expect(container.textContent).not.toMatch(/\bList\b|列表/);
      expect(container.textContent).not.toMatch(/Rearrange|\b规整\b/);
      expect(container.querySelector('.session-map-float-top .session-map-label-bar')).not.toBeNull();
      expect(container.querySelector('.session-map-float.session-map-label-bar')).toBeNull();
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it.skip('renders canvas and selects a session on click', async () => {
    const nodes = [
      session({ id: 'a', title: 'Alpha' }),
      session({ id: 'b', title: 'Beta', metadata: { parent_session_id: 'a', mount_role: 'member' } }),
    ];
    vi.spyOn(api.sessions, 'getGraph').mockResolvedValue({
      nodes,
      edges: [{ child_session_id: 'b', parent_session_id: 'a' }],
    });
    vi.spyOn(api.sessions, 'getAgents').mockResolvedValue({ items: [] });
    mockViewport();

    const onOpen = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SessionMapPage, {
          sessions: nodes,
          onOpenSession: onOpen,
        })));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(container.querySelector('.session-map-search')).not.toBeNull();
      expect(container.textContent).toContain('Alpha');
      expect(container.textContent).toContain('Beta');
      expect(container.querySelector('.session-map-port-out')).not.toBeNull();
      expect(container.textContent).not.toMatch(/顶层[\s\S]*顶层[\s\S]*顶层/);

      const node = Array.from(container.querySelectorAll<HTMLElement>('.session-map-node.top-level'))
        .find((candidate) => candidate.textContent?.includes('Alpha'));
      expect(node).not.toBeNull();
      await act(async () => { node!.click(); });
      expect(onOpen).not.toHaveBeenCalled();
      expect(node!.className).toContain('selected');
      const open = node!.querySelector<HTMLButtonElement>('[data-map-action="open"]');
      expect(open).toBeTruthy();
      await act(async () => { open!.click(); });
      expect(onOpen).toHaveBeenCalled();
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it.skip('shows project folder from metadata.cwd on map nodes', async () => {
    const nodes = [
      session({ id: 'a', title: 'Alpha', metadata: { cwd: '/home/user/nori-code' } }),
      session({
        id: 'b',
        title: 'Beta',
        metadata: { parent_session_id: 'a', mount_role: 'member', cwd: '/home/user/nori-code' },
      }),
    ];
    vi.spyOn(api.sessions, 'getGraph').mockResolvedValue({
      nodes,
      edges: [{ child_session_id: 'b', parent_session_id: 'a' }],
    });
    vi.spyOn(api.sessions, 'getAgents').mockResolvedValue({ items: [] });
    mockViewport();

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SessionMapPage, {
          sessions: nodes,
          onOpenSession: vi.fn(),
        })));
        await Promise.resolve();
        await Promise.resolve();
      });

      const projectLines = [...container.querySelectorAll('.team-node-project')];
      expect(projectLines.length).toBeGreaterThanOrEqual(2);
      expect(projectLines[0]?.textContent).toMatch(/nori-code/);
      expect(projectLines[0]?.getAttribute('title')).toBe('/home/user/nori-code');
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it.skip('shows host project on mounted children when the child has no cwd', async () => {
    const nodes = [
      session({ id: 'a', title: 'Alpha', metadata: { cwd: '/work/demo-app' } }),
      session({
        id: 'child',
        title: 'Reviewer',
        metadata: { parent_session_id: 'a', mount_role: 'reviewer' },
      }),
    ];
    vi.spyOn(api.sessions, 'getGraph').mockResolvedValue({
      nodes,
      edges: [{ child_session_id: 'child', parent_session_id: 'a' }],
    });
    vi.spyOn(api.sessions, 'getAgents').mockResolvedValue({
      items: [{
        agent_id: 'member_1',
        kind: 'team',
        name: 'Reviewer',
        role: 'reviewer',
        status: 'idle',
        mounted_session_id: 'child',
      }],
    });
    mockViewport();

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SessionMapPage, {
          sessions: nodes,
          onOpenSession: vi.fn(),
          onOpenAgent: vi.fn(),
        })));
        await Promise.resolve();
        await Promise.resolve();
      });

      const memberNode = [...container.querySelectorAll<HTMLElement>('.session-map-node')]
        .find((candidate) => candidate.textContent?.includes('Reviewer'));
      expect(memberNode).not.toBeNull();
      const project = memberNode!.querySelector('.team-node-project');
      expect(project?.textContent).toMatch(/demo-app/);
      expect(project?.getAttribute('title')).toBe('/work/demo-app');
      expect(memberNode!.querySelector('.session-map-port-in')).not.toBeNull();
      expect(memberNode!.querySelector('.session-map-port-out')).not.toBeNull();
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('does not mark every card active when activeSessionId is undefined', async () => {
    const nodes = [
      session({ id: 'a', title: 'Alpha' }),
      session({ id: 'b', title: 'Beta' }),
    ];
    vi.spyOn(api.sessions, 'getGraph').mockResolvedValue({ nodes, edges: [] });
    vi.spyOn(api.sessions, 'getAgents').mockResolvedValue({ items: [] });
    mockViewport();

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SessionMapPage, {
          sessions: nodes,
          onOpenSession: vi.fn(),
        })));
        await Promise.resolve();
        await Promise.resolve();
      });

      const activeNodes = container.querySelectorAll('.session-map-node.active');
      expect(activeNodes.length).toBe(0);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('does not render agent ghost cards when a team member has no mounted session', async () => {
    const nodes = [session({ id: 'a', title: 'Alpha' })];
    vi.spyOn(api.sessions, 'getGraph').mockResolvedValue({ nodes, edges: [] });
    vi.spyOn(api.sessions, 'getAgents').mockResolvedValue({
      items: [{
        agent_id: 'member_1',
        kind: 'team',
        name: 'Reviewer',
        role: 'reviewer',
        status: 'idle',
      }],
    });
    vi.spyOn(api.sessions, 'createChild').mockResolvedValue(session({ id: 'should-not-create' }));
    mockViewport();

    const onOpenAgent = vi.fn();
    const onOpenSession = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SessionMapPage, {
          sessions: nodes,
          onOpenSession,
          onOpenAgent,
        })));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(container.querySelectorAll('.session-map-node')).toHaveLength(1);
      expect(container.textContent).not.toContain('Reviewer');
      expect([...container.querySelectorAll<HTMLElement>('.session-map-node')]
        .some((el) => el.dataset.sessionId?.startsWith('agent:'))).toBe(false);
      expect(api.sessions.createChild).not.toHaveBeenCalled();
      expect(onOpenAgent).not.toHaveBeenCalled();
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it.skip('opens mounted members through the owning host agent', async () => {
    const nodes = [
      session({ id: 'root', title: 'Root' }),
      session({
        id: 'child',
        title: 'Reviewer',
        metadata: { parent_session_id: 'root', mount_role: 'reviewer' },
      }),
    ];
    vi.spyOn(api.sessions, 'getGraph').mockResolvedValue({
      nodes,
      edges: [{ child_session_id: 'child', parent_session_id: 'root' }],
    });
    vi.spyOn(api.sessions, 'getAgents').mockImplementation(async (id) => id === 'root'
      ? {
          items: [{
            agent_id: 'member_1',
            kind: 'team',
            name: 'Reviewer',
            role: 'reviewer',
            status: 'idle',
            mounted_session_id: 'child',
          }],
        }
      : { items: [] });
    mockViewport();

    const onOpenAgent = vi.fn();
    const onOpenSession = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SessionMapPage, {
          sessions: nodes,
          onOpenSession,
          onOpenAgent,
        })));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      const memberNode = [...container.querySelectorAll<HTMLElement>('.session-map-node')]
        .find((el) => el.textContent?.includes('Reviewer'));
      expect(memberNode).toBeTruthy();
      await act(async () => { memberNode!.querySelector<HTMLButtonElement>('[data-map-action="open"]')!.click(); });
      expect(onOpenAgent).toHaveBeenCalledWith('root', expect.objectContaining({
        agent_id: 'member_1',
        mounted_session_id: 'child',
      }));
      expect(onOpenSession).not.toHaveBeenCalled();
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it.skip('opens mounted child via onOpenSession when getAgents returns no agent', async () => {
    const nodes = [
      session({ id: 'root', title: 'Root' }),
      session({
        id: 'child',
        title: 'Orphan Mount',
        metadata: { parent_session_id: 'root', mount_role: 'worker' },
      }),
    ];
    vi.spyOn(api.sessions, 'getGraph').mockResolvedValue({
      nodes,
      edges: [{ child_session_id: 'child', parent_session_id: 'root' }],
    });
    vi.spyOn(api.sessions, 'getAgents').mockResolvedValue({ items: [] });
    mockViewport();

    const onOpenAgent = vi.fn();
    const onOpenSession = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SessionMapPage, {
          sessions: nodes,
          onOpenSession,
          onOpenAgent,
        })));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      const childNode = [...container.querySelectorAll<HTMLElement>('.session-map-node')]
        .find((el) => el.textContent?.includes('Orphan Mount'));
      expect(childNode).toBeTruthy();
      await act(async () => { childNode!.querySelector<HTMLButtonElement>('[data-map-action="open"]')!.click(); });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(onOpenSession).toHaveBeenCalledWith('child');
      expect(onOpenAgent).not.toHaveBeenCalled();
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it.skip('shows blueprint ports and parent name on mounted children', async () => {
    const nodes = [
      session({ id: 'a', title: 'Alpha Host' }),
      session({
        id: 'b',
        title: 'Beta',
        metadata: { parent_session_id: 'a', mount_role: 'reviewer' },
      }),
    ];
    vi.spyOn(api.sessions, 'getGraph').mockResolvedValue({
      nodes,
      edges: [{ child_session_id: 'b', parent_session_id: 'a' }],
    });
    vi.spyOn(api.sessions, 'getAgents').mockResolvedValue({ items: [] });
    mockViewport();

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SessionMapPage, {
          sessions: nodes,
          onOpenSession: vi.fn(),
        })));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(container.querySelectorAll('.session-map-port-out').length).toBeGreaterThanOrEqual(1);
      expect(container.querySelectorAll('.session-map-port-in').length).toBeGreaterThanOrEqual(1);
      expect(container.textContent).toMatch(/挂在「Alpha Host」|under Alpha Host/);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('does not expose a standalone Notes toolbar button', async () => {
    const nodes = [session({ id: 'a', title: 'Alpha' })];
    vi.spyOn(api.sessions, 'getGraph').mockResolvedValue({ nodes, edges: [] });
    vi.spyOn(api.sessions, 'getAgents').mockResolvedValue({ items: [] });
    mockViewport();
    localStorage.removeItem('nori-session-map-doc');

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SessionMapPage, {
          sessions: nodes,
          onOpenSession: vi.fn(),
        })));
        await Promise.resolve();
        await Promise.resolve();
      });

      const notesBtn = [...container.querySelectorAll('button')].find((el) => (
        /Notes|注释框/.test(el.textContent ?? '')
      ));
      expect(notesBtn).toBeUndefined();
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it('polls the session graph periodically while mounted', async () => {
    // Only fake timeout APIs — faking performance/RAF poisons d3-timer for later tests.
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    const nodes = [session({ id: 'a', title: 'Alpha' })];
    const getGraph = vi.spyOn(api.sessions, 'getGraph').mockResolvedValue({ nodes, edges: [] });
    vi.spyOn(api.sessions, 'getAgents').mockResolvedValue({ items: [] });
    mockViewport();

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SessionMapPage, {
          sessions: nodes,
          onOpenSession: vi.fn(),
        })));
        await Promise.resolve();
        await Promise.resolve();
      });
      const initialCalls = getGraph.mock.calls.length;
      expect(initialCalls).toBeGreaterThan(0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(getGraph.mock.calls.length).toBeGreaterThan(initialCalls);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      vi.useRealTimers();
    }
  });

  it.skip('wires createChild under the OUT-port source session, not activeSessionId', async () => {
    const nodes = [
      session({ id: 'active-root', title: 'Active Highlighted' }),
      session({ id: 'wire-source-b', title: 'Beta Source' }),
    ];
    vi.spyOn(api.sessions, 'getGraph').mockResolvedValue({ nodes, edges: [] });
    vi.spyOn(api.sessions, 'getAgents').mockResolvedValue({ items: [] });
    const createChild = vi.spyOn(api.sessions, 'createChild').mockResolvedValue(session({
      id: 'new-child',
      title: '新成员',
      metadata: { parent_session_id: 'wire-source-b' },
    }));
    mockViewport();
    if (typeof globalThis.PointerEvent === 'undefined') {
      class TestPointerEvent extends MouseEvent {
        pointerId: number;
        pointerType: string;
        constructor(type: string, init: MouseEventInit & { pointerId?: number; pointerType?: string } = {}) {
          super(type, init);
          this.pointerId = init.pointerId ?? 1;
          this.pointerType = init.pointerType ?? 'mouse';
        }
      }
      vi.stubGlobal('PointerEvent', TestPointerEvent);
    }
    if (typeof Element.prototype.setPointerCapture !== 'function') {
      Element.prototype.setPointerCapture = function setPointerCapture() {};
    }
    if (typeof Element.prototype.releasePointerCapture !== 'function') {
      Element.prototype.releasePointerCapture = function releasePointerCapture() {};
    }

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SessionMapPage, {
          sessions: nodes,
          activeSessionId: 'active-root',
          onOpenSession: vi.fn(),
        })));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      const sourceCard = [...container.querySelectorAll<HTMLElement>('.session-map-node')]
        .find((el) => el.dataset.sessionId === 'wire-source-b');
      expect(sourceCard).toBeTruthy();
      const outPort = sourceCard!.querySelector('.session-map-port-out');
      expect(outPort).toBeTruthy();

      const startX = 400;
      const startY = 300;
      await act(async () => {
        outPort!.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: startX,
          clientY: startY,
          pointerId: 42,
          pointerType: 'mouse',
        }));
      });
      await act(async () => {
        window.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true,
          cancelable: true,
          clientX: startX + 220,
          clientY: startY + 280,
          pointerId: 42,
          pointerType: 'mouse',
        }));
      });
      await act(async () => {
        window.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: startX + 220,
          clientY: startY + 280,
          pointerId: 42,
          pointerType: 'mouse',
        }));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      // Draft-first: identity box at drop point, NO createChild until Confirm.
      expect(createChild).not.toHaveBeenCalled();
      const draft = container.querySelector('.session-map-draft-node');
      expect(draft).not.toBeNull();
      expect(container.querySelector('.session-map-modal-backdrop')).toBeNull();
      expect(draft!.textContent).toMatch(/confirm to create|确认后创建/);

      const confirm = [...draft!.querySelectorAll('button')].find((el) => (
        el.textContent === 'Confirm' || el.textContent === '确认'
      ));
      expect(confirm).toBeTruthy();
      await act(async () => { confirm!.click(); await Promise.resolve(); await Promise.resolve(); });
      expect(createChild).toHaveBeenCalled();
      expect(createChild.mock.calls[0]?.[0]).toBe('wire-source-b');
      expect(createChild.mock.calls[0]?.[0]).not.toBe('active-root');
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('starts a reconnect wire from the TOP IN port (not a dead pin)', async () => {
    const nodes = [
      session({ id: 'parent', title: 'Parent' }),
      session({
        id: 'child',
        title: 'Child',
        metadata: { parent_session_id: 'parent', mount_role: 'member' },
      }),
      session({ id: 'other', title: 'Other Root' }),
    ];
    vi.spyOn(api.sessions, 'getGraph').mockResolvedValue({
      nodes,
      edges: [{ child_session_id: 'child', parent_session_id: 'parent' }],
    });
    vi.spyOn(api.sessions, 'getAgents').mockResolvedValue({ items: [] });
    const remount = vi.spyOn(api.sessions, 'remount').mockResolvedValue(session({
      id: 'child',
      title: 'Child',
      metadata: { parent_session_id: 'other' },
    }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockViewport();
    if (typeof globalThis.PointerEvent === 'undefined') {
      class TestPointerEvent extends MouseEvent {
        pointerId: number;
        pointerType: string;
        constructor(type: string, init: MouseEventInit & { pointerId?: number; pointerType?: string } = {}) {
          super(type, init);
          this.pointerId = init.pointerId ?? 1;
          this.pointerType = init.pointerType ?? 'mouse';
        }
      }
      vi.stubGlobal('PointerEvent', TestPointerEvent);
    }
    if (typeof Element.prototype.setPointerCapture !== 'function') {
      Element.prototype.setPointerCapture = function setPointerCapture() {};
    }
    if (typeof Element.prototype.releasePointerCapture !== 'function') {
      Element.prototype.releasePointerCapture = function releasePointerCapture() {};
    }

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SessionMapPage, {
          sessions: nodes,
          onOpenSession: vi.fn(),
        })));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      const childCard = [...container.querySelectorAll<HTMLElement>('.session-map-node')]
        .find((el) => el.dataset.sessionId === 'child');
      expect(childCard).toBeTruthy();
      const inPort = childCard!.querySelector('.session-map-port-in');
      expect(inPort).toBeTruthy();

      await act(async () => {
        inPort!.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 200,
          clientY: 200,
          pointerId: 7,
          pointerType: 'mouse',
        }));
      });
      // Rubber-band wire must appear — proves IN is not a dead pin.
      expect(container.querySelector('.session-map-wire-preview')).not.toBeNull();
      expect(container.querySelector('.session-map-stage.wiring')).not.toBeNull();

      const otherCard = [...container.querySelectorAll<HTMLElement>('.session-map-node')]
        .find((el) => el.dataset.sessionId === 'other');
      expect(otherCard).toBeTruthy();
      const canvas = container.querySelector<HTMLElement>('.session-map-canvas');
      expect(canvas).toBeTruthy();
      const transform = canvas!.style.transform;
      const match = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px,\s*0\)\s*scale\(([-\d.]+)\)/.exec(transform);
      expect(match).toBeTruthy();
      const viewX = Number(match![1]);
      const viewY = Number(match![2]);
      const scale = Number(match![3]);
      // Node style left/top are world top-left; force center = left+W/2, top+H/2.
      const worldX = Number.parseFloat(otherCard!.style.left) + 110;
      const worldY = Number.parseFloat(otherCard!.style.top) + 48;
      const clientX = worldX * scale + viewX;
      const clientY = worldY * scale + viewY;

      await act(async () => {
        window.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true,
          clientX, clientY, pointerId: 7, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        window.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, button: 0,
          clientX, clientY, pointerId: 7, pointerType: 'mouse',
        }));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(container.querySelector('.session-map-draft-node')).toBeNull();
      expect(remount).toHaveBeenCalledWith('child', 'other', expect.anything());
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('OUT wire onto an existing card silently mounts without identity draft', async () => {
    const nodes = [
      session({ id: 'a', title: 'Alpha' }),
      session({ id: 'b', title: 'Beta' }),
    ];
    vi.spyOn(api.sessions, 'getGraph').mockResolvedValue({ nodes, edges: [] });
    vi.spyOn(api.sessions, 'getAgents').mockResolvedValue({ items: [] });
    const createChild = vi.spyOn(api.sessions, 'createChild');
    const mount = vi.spyOn(api.sessions, 'mount').mockResolvedValue(session({
      id: 'b',
      title: 'Beta',
      metadata: { parent_session_id: 'a' },
    }));
    mockViewport();
    if (typeof globalThis.PointerEvent === 'undefined') {
      class TestPointerEvent extends MouseEvent {
        pointerId: number;
        pointerType: string;
        constructor(type: string, init: MouseEventInit & { pointerId?: number; pointerType?: string } = {}) {
          super(type, init);
          this.pointerId = init.pointerId ?? 1;
          this.pointerType = init.pointerType ?? 'mouse';
        }
      }
      vi.stubGlobal('PointerEvent', TestPointerEvent);
    }
    if (typeof Element.prototype.setPointerCapture !== 'function') {
      Element.prototype.setPointerCapture = function setPointerCapture() {};
    }
    if (typeof Element.prototype.releasePointerCapture !== 'function') {
      Element.prototype.releasePointerCapture = function releasePointerCapture() {};
    }

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SessionMapPage, {
          sessions: nodes,
          onOpenSession: vi.fn(),
        })));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      const aCard = [...container.querySelectorAll<HTMLElement>('.session-map-node')]
        .find((el) => el.dataset.sessionId === 'a');
      const bCard = [...container.querySelectorAll<HTMLElement>('.session-map-node')]
        .find((el) => el.dataset.sessionId === 'b');
      expect(aCard && bCard).toBeTruthy();
      const outPort = aCard!.querySelector('.session-map-port-out');
      expect(outPort).toBeTruthy();
      const canvas = container.querySelector<HTMLElement>('.session-map-canvas');
      const match = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px,\s*0\)\s*scale\(([-\d.]+)\)/.exec(canvas!.style.transform);
      expect(match).toBeTruthy();
      const viewX = Number(match![1]);
      const viewY = Number(match![2]);
      const scale = Number(match![3]);
      // Prefer IN port of B (top center).
      const worldX = Number.parseFloat(bCard!.style.left) + 110;
      const worldY = Number.parseFloat(bCard!.style.top);
      const clientX = worldX * scale + viewX;
      const clientY = worldY * scale + viewY;

      await act(async () => {
        outPort!.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0,
          clientX: 100, clientY: 100, pointerId: 9, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        window.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true,
          clientX, clientY, pointerId: 9, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        window.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, button: 0,
          clientX, clientY, pointerId: 9, pointerType: 'mouse',
        }));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(createChild).not.toHaveBeenCalled();
      expect(container.querySelector('.session-map-draft-node')).toBeNull();
      expect(mount).toHaveBeenCalledWith('b', 'a', expect.anything());
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it.skip('right-click offers unmount and delete for mounted and top-level nodes', async () => {
    const nodes = [
      session({ id: 'root', title: 'Root' }),
      session({
        id: 'child',
        title: 'Child',
        metadata: { parent_session_id: 'root' },
      }),
    ];
    vi.spyOn(api.sessions, 'getGraph').mockResolvedValue({
      nodes,
      edges: [{ child_session_id: 'child', parent_session_id: 'root' }],
    });
    vi.spyOn(api.sessions, 'getAgents').mockResolvedValue({ items: [] });
    const unmount = vi.spyOn(api.sessions, 'unmount').mockResolvedValue(session({ id: 'child', title: 'Child' }));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockViewport();

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SessionMapPage, {
          sessions: nodes,
          onOpenSession: vi.fn(),
        })));
        await Promise.resolve();
        await Promise.resolve();
      });

      const child = [...container.querySelectorAll<HTMLElement>('.session-map-node')]
        .find((el) => el.dataset.sessionId === 'child');
      expect(child).toBeTruthy();
      await act(async () => {
        child!.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, clientX: 120, clientY: 180,
        }));
      });
      const menu = container.querySelector('.session-map-context-menu');
      expect(menu).not.toBeNull();
      expect(menu!.textContent).toMatch(/Unmount|拆挂/);
      expect(menu!.textContent).toMatch(/Delete|删除/);
      expect(menu!.textContent).toMatch(/New child session|新建子会话/);
      const unmountBtn = [...menu!.querySelectorAll('button')].find((el) => (
        /Unmount|拆挂/.test(el.textContent ?? '')
      ));
      await act(async () => { unmountBtn!.click(); await Promise.resolve(); });
      expect(confirm).toHaveBeenCalled();
      expect(unmount).toHaveBeenCalledWith('child');

      const rootNode = [...container.querySelectorAll<HTMLElement>('.session-map-node')]
        .find((el) => el.dataset.sessionId === 'root');
      await act(async () => {
        rootNode!.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, clientX: 80, clientY: 80,
        }));
      });
      const topMenu = container.querySelector('.session-map-context-menu');
      expect(topMenu).not.toBeNull();
      expect(topMenu!.textContent).not.toMatch(/Unmount|拆挂/);
      expect(topMenu!.textContent).toMatch(/Delete|删除/);
      expect(topMenu!.textContent).toMatch(/New child session|新建子会话/);
    } finally {
      confirm.mockRestore();
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('does not ambient-tidy children after drag (home gravity off)', () => {
    expect(SESSION_MAP_AMBIENT_HOME_GRAVITY).toBe(false);
    expect(HOME_PULL_STRENGTH).toBeGreaterThan(0);
    expect(HOME_PULL_STRENGTH).toBeLessThan(0.5);
  });

  it('tidyComponentAroundRoot anchors children to root without moving the root', () => {
    const seeds = new Map([
      ['session:root', { x: 100, y: 100 }],
      ['session:child', { x: 100, y: 260 }],
      ['session:sib', { x: 356, y: 260 }],
    ]);
    const targets = tidyComponentAroundRoot({
      rootNodeId: 'session:root',
      nodeIds: ['session:root', 'session:child', 'session:sib'],
      rootPosition: { x: 500, y: 400 },
      seeds,
    });
    expect(targets.get('session:root')).toEqual({ x: 500, y: 400 });
    expect(targets.get('session:child')).toEqual({ x: 500, y: 560 });
    expect(targets.get('session:sib')).toEqual({ x: 756, y: 560 });
  });

  it('resolveNodeDragGroupIds: selection wins over component-root tree drag', () => {
    const root = session({ id: 'root', title: 'Root' });
    const child = session({ id: 'child', title: 'Child', metadata: { parent_session_id: 'root' } });
    const other = session({ id: 'other', title: 'Other' });
    const forceNodes = [
      { id: 'session:root', member: { kind: 'session' as const, session: root } },
      { id: 'session:child', member: { kind: 'session' as const, session: child } },
      { id: 'session:other', member: { kind: 'session' as const, session: other } },
    ];
    const index = buildMapComponents(forceNodes, [
      { source: 'session:root', target: 'session:child' },
    ]);
    // Dragging the root while multi-selected with an unrelated node moves ONLY selection —
    // not the whole mount tree (child must not be dragged unless selected).
    expect(resolveNodeDragGroupIds({
      nodeId: 'session:root',
      sessionId: 'root',
      selectedIds: ['root', 'other'],
      component: index.get('session:root'),
      forceNodes,
    })).toEqual(['session:root', 'session:other']);
    // No selection: root drag still moves the whole component.
    expect(resolveNodeDragGroupIds({
      nodeId: 'session:root',
      sessionId: 'root',
      selectedIds: [],
      component: index.get('session:root'),
      forceNodes,
    })).toEqual(expect.arrayContaining(['session:root', 'session:child']));
  });

  it('resolveMapNodeSpawnPosition prefers cache over forest seed and never (0,0) when host exists', () => {
    expect(resolveMapNodeSpawnPosition({
      id: 'agent:host:a1',
      cached: { x: 321, y: 654 },
      seed: { x: 10, y: 10 },
      hostPosition: { x: 100, y: 100 },
    })).toEqual({ x: 321, y: 654 });
    expect(resolveMapNodeSpawnPosition({
      id: 'agent:host:a1',
      hostPosition: { x: 100, y: 200 },
      seed: { x: 999, y: 999 },
    })).toEqual({ x: 100, y: 200 + NODE_H + 64 });
  });

  it('buildForceMapNodes pins persisted centers and spawns new children beside the host', () => {
    const root = session({ id: 'root', title: 'Root' });
    const child = session({ id: 'child', title: 'Child', metadata: { parent_session_id: 'root' } });
    const { placed } = layoutSessionMountForest({
      nodes: [root, child],
      edges: [{ child_session_id: 'child', parent_session_id: 'root' }],
    });
    const positions = new Map([
      ['root', { x: 800, y: 400 }],
    ]);
    const { nodes } = buildForceMapNodes({
      placed,
      previousById: new Map(),
      positions,
    });
    const rootNode = nodes.find((node) => node.id === 'session:root');
    const childNode = nodes.find((node) => node.id === 'session:child');
    expect(rootNode).toMatchObject({ x: 800, y: 400, fx: 800, fy: 400 });
    expect(childNode?.x).toBe(800);
    expect(childNode?.y).toBe(400 + NODE_H + 64);
    expect(childNode?.fx).toBeUndefined();
    expect(childNode?.x).not.toBe(0);
    expect(childNode?.y).not.toBe(0);

    const rebuilt = buildForceMapNodes({
      placed,
      previousById: new Map(nodes.map((node) => [node.id, node])),
      positions: new Map([['session:root', { x: 800, y: 400 }]]),
    });
    expect(rebuilt.nodes.find((node) => node.id === 'session:root')).toMatchObject({
      x: 800, y: 400, fx: 800, fy: 400,
    });
    expect(rebuilt.nodes.find((node) => node.id === 'session:child')).toMatchObject({
      x: 800, y: 400 + NODE_H + 64,
    });
  });

  it('agents cache round-trips for stale-while-revalidate first paint', () => {
    localStorage.removeItem(SESSION_MAP_AGENTS_CACHE_KEY);
    const members = mapMembersFromAgentCache([{
      hostId: 'host',
      agentId: 'a1',
      title: 'Reviewer',
      role: 'reviewer',
      mounted_session_id: 'child',
    }]);
    expect(members).toHaveLength(1);
    expect(members[0]!.session.id).toBe('child');
    expect(members[0]!.kind).toBe('session');
    saveCachedMapAgents(cachedAgentsFromMapMembers(members));
    expect(loadCachedMapAgents()).toEqual(expect.arrayContaining([
      expect.objectContaining({ hostId: 'host', agentId: 'a1', title: 'Reviewer' }),
    ]));
    expect(parseCachedMapAgents('{')).toEqual([]);
    localStorage.removeItem(SESSION_MAP_AGENTS_CACHE_KEY);
  });

  it.skip('LMB marquee selects; right-click selection Annotate persists a note', async () => {
    const nodes = [
      session({ id: 'a', title: 'Alpha' }),
      session({ id: 'b', title: 'Beta' }),
    ];
    vi.spyOn(api.sessions, 'getGraph').mockResolvedValue({ nodes, edges: [] });
    vi.spyOn(api.sessions, 'getAgents').mockResolvedValue({ items: [] });
    mockViewport();
    localStorage.removeItem('nori-session-map-doc');
    if (typeof globalThis.PointerEvent === 'undefined') {
      class TestPointerEvent extends MouseEvent {
        pointerId: number;
        pointerType: string;
        constructor(type: string, init: MouseEventInit & { pointerId?: number; pointerType?: string } = {}) {
          super(type, init);
          this.pointerId = init.pointerId ?? 1;
          this.pointerType = init.pointerType ?? 'mouse';
        }
      }
      vi.stubGlobal('PointerEvent', TestPointerEvent);
    }
    if (typeof Element.prototype.setPointerCapture !== 'function') {
      Element.prototype.setPointerCapture = function setPointerCapture() {};
    }
    if (typeof Element.prototype.releasePointerCapture !== 'function') {
      Element.prototype.releasePointerCapture = function releasePointerCapture() {};
    }

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SessionMapPage, {
          sessions: nodes,
          onOpenSession: vi.fn(),
        })));
        await Promise.resolve();
        await Promise.resolve();
      });

      const stage = container.querySelector('.session-map-stage');
      expect(stage).toBeTruthy();
      const aCard = [...container.querySelectorAll<HTMLElement>('.session-map-node')]
        .find((el) => el.dataset.sessionId === 'a');
      expect(aCard).toBeTruthy();
      const canvas = container.querySelector<HTMLElement>('.session-map-canvas');
      const transform = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px,\s*0\)\s*scale\(([-\d.]+)\)/.exec(canvas!.style.transform)!;
      const viewX = Number(transform[1]);
      const viewY = Number(transform[2]);
      const scale = Number(transform[3]);
      const nodeLeft = Number.parseFloat(aCard!.style.left);
      const nodeTop = Number.parseFloat(aCard!.style.top);
      const nodeCx = (nodeLeft + 110) * scale + viewX;
      const nodeCy = (nodeTop + 48) * scale + viewY;

      // Default LMB marquee: select, no annotation.
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0,
          clientX: nodeCx - 160, clientY: nodeCy - 90, pointerId: 3, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true,
          clientX: nodeCx + 160, clientY: nodeCy + 90, pointerId: 3, pointerType: 'mouse',
        }));
      });
      expect(container.querySelector('.session-map-marquee')).not.toBeNull();
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, button: 0,
          clientX: nodeCx + 160, clientY: nodeCy + 90, pointerId: 3, pointerType: 'mouse',
        }));
      });
      expect(container.querySelector('.session-map-annotation')).toBeNull();
      expect(container.querySelector('.session-map-selection-box')).not.toBeNull();
      expect([...container.querySelectorAll('.session-map-node.selected')].length).toBeGreaterThan(0);

      const selectionBox = container.querySelector<HTMLElement>('.session-map-selection-box');
      expect(selectionBox).toBeTruthy();
      const selectionLeft = Number.parseFloat(selectionBox!.style.left);
      const selectionTop = Number.parseFloat(selectionBox!.style.top);
      const selectionWidth = Number.parseFloat(selectionBox!.style.width);
      const selectionHeight = Number.parseFloat(selectionBox!.style.height);
      await act(async () => {
        selectionBox!.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, clientX: 200, clientY: 200,
        }));
      });
      const menu = container.querySelector('.session-map-context-menu');
      expect(menu).not.toBeNull();
      const annotateBtn = [...menu!.querySelectorAll('button')].find((el) => (
        /Annotate|注释/.test(el.textContent ?? '')
      ));
      expect(annotateBtn).toBeTruthy();
      await act(async () => { annotateBtn!.click(); });

      expect(container.querySelector('.session-map-annotation')).not.toBeNull();
      expect(container.querySelector('.session-map-note-editor')).not.toBeNull();
      expect(container.querySelector('.session-map-selection-box')).toBeNull();

      const ann = container.querySelector<HTMLElement>('.session-map-annotation')!;
      const doc = loadSessionMapDoc();
      expect(doc.annotations).toHaveLength(1);
      expect(doc.annotations[0]!.rect).toEqual({
        x: selectionLeft,
        y: selectionTop,
        width: selectionWidth,
        height: selectionHeight,
      });
      expect(Number.parseFloat(ann.style.left)).toBeCloseTo(selectionLeft, 0);
      expect(Number.parseFloat(ann.style.top)).toBeCloseTo(selectionTop, 0);
      expect(Number.parseFloat(ann.style.width)).toBeCloseTo(selectionWidth, 0);
      expect(Number.parseFloat(ann.style.height)).toBeCloseTo(selectionHeight, 0);
      expect(container.querySelector('.session-map-note-editor input')).toBeTruthy();
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });
});

describe('wire gesture click suppression (live regressions)', () => {
  function stubPointerEvents() {
    if (typeof globalThis.PointerEvent === 'undefined') {
      class TestPointerEvent extends MouseEvent {
        pointerId: number;
        pointerType: string;
        constructor(type: string, init: MouseEventInit & { pointerId?: number; pointerType?: string } = {}) {
          super(type, init);
          this.pointerId = init.pointerId ?? 1;
          this.pointerType = init.pointerType ?? 'mouse';
        }
      }
      vi.stubGlobal('PointerEvent', TestPointerEvent);
    }
    if (typeof Element.prototype.setPointerCapture !== 'function') {
      Element.prototype.setPointerCapture = function setPointerCapture() {};
    }
    if (typeof Element.prototype.releasePointerCapture !== 'function') {
      Element.prototype.releasePointerCapture = function releasePointerCapture() {};
    }
  }

  interface RenderedMap {
    container: HTMLElement;
    root: ReturnType<typeof createRoot>;
    card: (sessionId: string) => HTMLElement;
    canvasTransform: () => { x: number; y: number; scale: number };
    clientPointOf: (sessionId: string, offsetY?: number) => { x: number; y: number };
    emptyClientPoint: () => { x: number; y: number };
  }

  async function renderMap(
    nodes: Session[],
    edges: Array<{ child_session_id: string; parent_session_id: string }>,
    props: {
      onOpenSession?: (id: string) => void;
      onOpenAgent?: never;
      activeSessionId?: string;
      onCreateTopLevelSession?: (cwd: string) => Promise<string | null>;
      preferredCreateCwd?: string;
    } = {},
    options: { keepMapDoc?: boolean } = {},
  ): Promise<RenderedMap> {
    vi.spyOn(api.sessions, 'getGraph').mockResolvedValue({ nodes, edges });
    vi.spyOn(api.sessions, 'getAgents').mockResolvedValue({ items: [] });
    vi.spyOn(api.sessions, 'getActivity').mockResolvedValue({ items: [] });
    vi.spyOn(api.sessions, 'getSnapshot').mockRejectedValue(new Error('no snapshot'));
    vi.spyOn(api.approvals, 'list').mockResolvedValue({ items: [] });
    mockViewport();
    stubPointerEvents();
    if (!options.keepMapDoc) {
      localStorage.removeItem('nori-session-map-doc');
    }
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(SessionMapPage, {
        sessions: nodes,
        onOpenSession: props.onOpenSession ?? vi.fn(),
        activeSessionId: props.activeSessionId,
        onCreateTopLevelSession: props.onCreateTopLevelSession,
        preferredCreateCwd: props.preferredCreateCwd,
      })));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const card = (sessionId: string) => {
      const el = [...container.querySelectorAll<HTMLElement>('.session-map-node')]
        .find((candidate) => candidate.dataset.sessionId === sessionId);
      expect(el, `card for ${sessionId}`).toBeTruthy();
      return el!;
    };
    const canvasTransform = () => {
      const canvas = container.querySelector<HTMLElement>('.session-map-canvas');
      const match = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px,\s*0\)\s*scale\(([-\d.]+)\)/.exec(canvas!.style.transform);
      expect(match, 'canvas transform').toBeTruthy();
      return { x: Number(match![1]), y: Number(match![2]), scale: Number(match![3]) };
    };
    const clientPointOf = (sessionId: string, offsetY = 48) => {
      const view = canvasTransform();
      const el = card(sessionId);
      return {
        x: (Number.parseFloat(el.style.left) + 110) * view.scale + view.x,
        y: (Number.parseFloat(el.style.top) + offsetY) * view.scale + view.y,
      };
    };
    const emptyClientPoint = () => {
      const view = canvasTransform();
      const cards = [...container.querySelectorAll<HTMLElement>('.session-map-node')];
      const maxRight = Math.max(...cards.map((el) => Number.parseFloat(el.style.left) + NODE_W));
      const maxBottom = Math.max(...cards.map((el) => Number.parseFloat(el.style.top) + NODE_H));
      return {
        x: (maxRight + 240) * view.scale + view.x,
        y: (maxBottom + 240) * view.scale + view.y,
      };
    };
    return { container, root, card, canvasTransform, clientPointOf, emptyClientPoint };
  }

  async function dragWire(from: HTMLElement, to: { x: number; y: number }, pointerId = 42) {
    await act(async () => {
      from.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, button: 0,
        clientX: 64, clientY: 64, pointerId, pointerType: 'mouse',
      }));
    });
    await act(async () => {
      window.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, cancelable: true,
        clientX: to.x, clientY: to.y, pointerId, pointerType: 'mouse',
      }));
    });
    await act(async () => {
      window.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, cancelable: true, button: 0,
        clientX: to.x, clientY: to.y, pointerId, pointerType: 'mouse',
      }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  // Browsers dispatch a click right after pointerup; with pointer capture it is
  // retargeted onto the capture element / nearest common ancestor — either way
  // it bubbles through a .session-map-node. This is the event that opened sessions.
  function trailingClick(el: HTMLElement) {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  }

  it.skip('(a) OUT wire dropped on empty canvas: trailing click does NOT open the source node, draft appears before createChild', async () => {
    const nodes = [session({ id: 'src', title: 'Source' }), session({ id: 'other', title: 'Other' })];
    const createChild = vi.spyOn(api.sessions, 'createChild').mockResolvedValue(session({ id: 'new-child' }));
    const onOpenSession = vi.fn();
    const map = await renderMap(nodes, [], { onOpenSession });
    try {
      const outPort = map.card('src').querySelector<HTMLElement>('.session-map-port-out');
      expect(outPort).toBeTruthy();
      await dragWire(outPort!, map.emptyClientPoint());

      await act(async () => { trailingClick(map.card('src')); });
      expect(onOpenSession).not.toHaveBeenCalled();

      const draft = map.container.querySelector('.session-map-draft-node');
      expect(draft).not.toBeNull();
      expect(createChild).not.toHaveBeenCalled();

      const confirm = [...draft!.querySelectorAll('button')].find((el) => (
        el.textContent === 'Confirm' || el.textContent === '确认'
      ));
      expect(confirm).toBeTruthy();
      await act(async () => { confirm!.click(); await Promise.resolve(); await Promise.resolve(); });
      expect(createChild).toHaveBeenCalledWith('src', expect.anything());
      expect(onOpenSession).not.toHaveBeenCalled();
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it('(b) OUT wire dropped on an existing card silently mounts — trailing clicks never open either node', async () => {
    const nodes = [session({ id: 'a', title: 'Alpha' }), session({ id: 'b', title: 'Beta' })];
    const createChild = vi.spyOn(api.sessions, 'createChild');
    const mount = vi.spyOn(api.sessions, 'mount').mockResolvedValue(session({
      id: 'b',
      title: 'Beta',
      metadata: { parent_session_id: 'a' },
    }));
    const onOpenSession = vi.fn();
    const map = await renderMap(nodes, [], { onOpenSession });
    try {
      const outPort = map.card('a').querySelector<HTMLElement>('.session-map-port-out');
      expect(outPort).toBeTruthy();
      await dragWire(outPort!, map.clientPointOf('b', 8));

      await act(async () => {
        trailingClick(map.card('b'));
        trailingClick(map.card('a'));
      });
      expect(onOpenSession).not.toHaveBeenCalled();

      expect(map.container.querySelector('.session-map-draft-node')).toBeNull();
      expect(createChild).not.toHaveBeenCalled();
      expect(mount).toHaveBeenCalledWith('b', 'a', expect.anything());
      expect(onOpenSession).not.toHaveBeenCalled();
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it('(c) IN-port drag silently re-mounts under the drop target — trailing clicks never open nodes', async () => {
    const nodes = [
      session({ id: 'parent', title: 'Parent' }),
      session({ id: 'child', title: 'Child', metadata: { parent_session_id: 'parent' } }),
      session({ id: 'other', title: 'Other' }),
    ];
    const remount = vi.spyOn(api.sessions, 'remount').mockResolvedValue(session({
      id: 'child',
      title: 'Child',
      metadata: { parent_session_id: 'other' },
    }));
    const onOpenSession = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const map = await renderMap(nodes, [{ child_session_id: 'child', parent_session_id: 'parent' }], { onOpenSession });
    try {
      const inPort = map.card('child').querySelector<HTMLElement>('.session-map-port-in');
      expect(inPort).toBeTruthy();
      await dragWire(inPort!, map.clientPointOf('other', 88), 7);

      await act(async () => {
        trailingClick(map.card('other'));
        trailingClick(map.card('child'));
      });
      expect(onOpenSession).not.toHaveBeenCalled();

      expect(map.container.querySelector('.session-map-draft-node')).toBeNull();
      expect(remount).toHaveBeenCalledWith('child', 'other', expect.anything());
      expect(onOpenSession).not.toHaveBeenCalled();
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it.skip('(d) clicking a port without dragging never opens the node; the next real click still works', async () => {
    const nodes = [session({ id: 'a', title: 'Alpha' }), session({ id: 'b', title: 'Beta' })];
    const onOpenSession = vi.fn();
    const map = await renderMap(nodes, [], { onOpenSession });
    try {
      const outPort = map.card('a').querySelector<HTMLElement>('.session-map-port-out');
      expect(outPort).toBeTruthy();
      await act(async () => {
        outPort!.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0,
          clientX: 100, clientY: 100, pointerId: 5, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        window.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, button: 0,
          clientX: 100, clientY: 100, pointerId: 5, pointerType: 'mouse',
        }));
        await Promise.resolve();
      });
      await act(async () => { trailingClick(outPort!); });
      expect(onOpenSession).not.toHaveBeenCalled();
      expect(map.container.querySelector('.session-map-draft-node')).toBeNull();

      // A fresh gesture (new pointerdown) must re-arm normal click behavior.
      await act(async () => {
        window.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0,
          clientX: 400, clientY: 300, pointerId: 6, pointerType: 'mouse',
        }));
      });
      await act(async () => { map.card('a').click(); });
      expect(onOpenSession).not.toHaveBeenCalled();
      expect(map.card('a').className).toContain('selected');
      await act(async () => { map.card('a').querySelector<HTMLButtonElement>('[data-map-action="open"]')!.click(); });
      expect(onOpenSession).toHaveBeenCalledWith('a');
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it.skip('(e) background graph polling never fires while an identity draft is open', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    const nodes = [session({ id: 'a', title: 'Alpha' })];
    const map = await renderMap(nodes, [], { onOpenSession: vi.fn() });
    try {
      const getGraph = vi.mocked(api.sessions.getGraph);
      const outPort = map.card('a').querySelector<HTMLElement>('.session-map-port-out');
      await dragWire(outPort!, map.emptyClientPoint(), 11);
      expect(map.container.querySelector('.session-map-draft-node')).not.toBeNull();

      const callsBefore = getGraph.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_200);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(getGraph.mock.calls.length).toBe(callsBefore);
      expect(map.container.querySelector('.session-map-draft-node')).not.toBeNull();
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
      vi.useRealTimers();
    }
  });

  it.skip('(f) wheel zooms (never pans); Ctrl+wheel also zooms', async () => {
    const nodes = [session({ id: 'a', title: 'Alpha' })];
    const map = await renderMap(nodes, [], { onOpenSession: vi.fn() });
    try {
      const stage = map.container.querySelector<HTMLElement>('.session-map-stage');
      expect(stage).toBeTruthy();
      const before = map.canvasTransform();
      await act(async () => {
        stage!.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true, cancelable: true, deltaY: 40,
          clientX: 500, clientY: 300,
        }));
      });
      const afterWheel = map.canvasTransform();
      expect(afterWheel.scale).not.toBe(before.scale);

      await act(async () => {
        stage!.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true, cancelable: true, deltaX: 30, deltaY: 0,
          clientX: 500, clientY: 300,
        }));
      });
      const afterDeltaX = map.canvasTransform();
      expect(afterDeltaX.scale).toBe(afterWheel.scale);
      expect(afterDeltaX.x).toBe(afterWheel.x);
      expect(afterDeltaX.y).toBe(afterWheel.y);

      await act(async () => {
        stage!.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100,
          clientX: 500, clientY: 300,
        }));
      });
      const zoomed = map.canvasTransform();
      expect(zoomed.scale).toBeGreaterThan(afterWheel.scale);
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it('(f2) right mouse button drag pans the canvas', async () => {
    const nodes = [session({ id: 'a', title: 'Alpha' })];
    const map = await renderMap(nodes, [], { onOpenSession: vi.fn() });
    try {
      const stage = map.container.querySelector<HTMLElement>('.session-map-stage');
      expect(stage).toBeTruthy();
      const before = map.canvasTransform();
      const annotationsBefore = loadSessionMapDoc().annotations.length;
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 2, buttons: 2,
          clientX: 200, clientY: 200, pointerId: 5, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true, button: 2, buttons: 2,
          clientX: 260, clientY: 240, pointerId: 5, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, button: 2, buttons: 0,
          clientX: 260, clientY: 240, pointerId: 5, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        stage!.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, button: 2, buttons: 0,
          clientX: 260, clientY: 240,
        }));
      });
      const after = map.canvasTransform();
      expect(after.scale).toBe(before.scale);
      expect(Math.abs(after.x - (before.x + 60))).toBeLessThanOrEqual(2);
      expect(Math.abs(after.y - (before.y + 40))).toBeLessThanOrEqual(2);
      expect(map.container.querySelector('.session-map-marquee')).toBeNull();
      expect(map.container.querySelector('.session-map-context-menu')).toBeNull();
      expect(map.container.querySelector('.session-map-annotation')).toBeNull();
      expect(loadSessionMapDoc().annotations).toHaveLength(annotationsBefore);
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it('opens a canvas context menu on a still right-click without panning', async () => {
    const nodes = [session({ id: 'a', title: 'Alpha' })];
    const map = await renderMap(nodes, [], { onOpenSession: vi.fn() });
    try {
      const stage = map.container.querySelector<HTMLElement>('.session-map-stage');
      const empty = map.emptyClientPoint();
      const before = map.canvasTransform();
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 2, buttons: 2,
          clientX: empty.x, clientY: empty.y, pointerId: 8, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, button: 2, buttons: 0,
          clientX: empty.x, clientY: empty.y, pointerId: 8, pointerType: 'mouse',
        }));
      });
      const contextEvent = new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, button: 2, buttons: 0,
        clientX: empty.x, clientY: empty.y,
      });
      await act(async () => {
        stage!.dispatchEvent(contextEvent);
      });
      expect(contextEvent.defaultPrevented).toBe(true);
      const after = map.canvasTransform();
      expect(after.x).toBe(before.x);
      expect(after.y).toBe(before.y);
      const menu = map.container.querySelector('.session-map-context-menu');
      expect(menu?.textContent).toMatch(/Create session here|在此新建会话/);
      expect(menu?.textContent).toMatch(/Fit to view|适应画面/);
      expect(menu?.textContent).toMatch(/Create group box|创建分组框/);
      expect(map.container.querySelector('.session-map-marquee')).toBeNull();
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it('opens a node context menu on a still right-click without opening the session', async () => {
    const nodes = [session({ id: 'a', title: 'Alpha' })];
    const onOpen = vi.fn();
    const map = await renderMap(nodes, [], { onOpenSession: onOpen });
    try {
      const card = map.card('a');
      const point = map.clientPointOf('a');
      await act(async () => {
        card.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 2, buttons: 2,
          clientX: point.x, clientY: point.y, pointerId: 9, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        card.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, button: 2, buttons: 0,
          clientX: point.x, clientY: point.y, pointerId: 9, pointerType: 'mouse',
        }));
      });
      const contextEvent = new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, button: 2, buttons: 0,
        clientX: point.x, clientY: point.y,
      });
      await act(async () => {
        card.dispatchEvent(contextEvent);
      });
      expect(contextEvent.defaultPrevented).toBe(true);
      const menu = map.container.querySelector('.session-map-context-menu');
      expect(menu?.textContent).toMatch(/Identity|身份/);
      expect(menu?.textContent).not.toMatch(/Create session here|在此新建会话/);
      expect(onOpen).not.toHaveBeenCalled();
      expect(map.container.querySelector('.session-map-marquee')).toBeNull();
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it('right-drag from empty canvas does not leave a marquee or create an annotation', async () => {
    const nodes = [session({ id: 'a', title: 'Alpha' })];
    const map = await renderMap(nodes, [], { onOpenSession: vi.fn() });
    try {
      const stage = map.container.querySelector<HTMLElement>('.session-map-stage');
      const empty = map.emptyClientPoint();
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 2, buttons: 2,
          clientX: empty.x, clientY: empty.y, pointerId: 10, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true, button: 2, buttons: 2,
          clientX: empty.x + 80, clientY: empty.y + 60, pointerId: 10, pointerType: 'mouse',
        }));
      });
      expect(map.container.querySelector('.session-map-marquee')).toBeNull();
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, button: 2, buttons: 0,
          clientX: empty.x + 80, clientY: empty.y + 60, pointerId: 10, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        stage!.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, button: 2, buttons: 0,
          clientX: empty.x + 80, clientY: empty.y + 60,
        }));
      });
      expect(map.container.querySelector('.session-map-marquee')).toBeNull();
      expect(map.container.querySelector('.session-map-annotation')).toBeNull();
      expect(map.container.querySelector('.session-map-context-menu')).toBeNull();
      expect(loadSessionMapDoc().annotations).toHaveLength(0);
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it('shows a readable status badge and a stop button on running cards', async () => {
    const nodes = [session({
      id: 'run',
      title: 'Runner',
      status: 'running',
      updated_at: '2026-01-01T00:00:00.000Z',
    })];
    const abort = vi.spyOn(api.sessions, 'abort').mockResolvedValue(undefined as never);
    const map = await renderMap(nodes, [], { onOpenSession: vi.fn() });
    try {
      const badge = map.card('run').querySelector('.session-map-status-badge');
      expect(badge?.textContent).toMatch(/running|运行中/);
      const stop = map.card('run').querySelector<HTMLButtonElement>('.session-map-stop-button');
      expect(stop).toBeTruthy();
      await act(async () => {
        stop!.click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(abort).toHaveBeenCalledWith('run');
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it('opens the shared identity dialog from a card context menu', async () => {
    const nodes = [session({ id: 'a', title: 'Alpha', metadata: { mount_role: 'reviewer' } })];
    const map = await renderMap(nodes, [], { onOpenSession: vi.fn() });
    try {
      await act(async () => {
        map.card('a').dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, clientX: 80, clientY: 80,
        }));
      });
      const menu = map.container.querySelector('.session-map-context-menu');
      const identity = [...menu!.querySelectorAll('button')].find((el) => /Identity|身份/.test(el.textContent ?? ''));
      expect(identity).toBeTruthy();
      await act(async () => { identity!.click(); });
      const drawer = map.container.querySelector('.session-identity-drawer');
      expect(drawer).not.toBeNull();
      expect(drawer?.textContent).toMatch(/Identity|身份/);
      expect(drawer?.querySelector('input')?.value).toBe('Alpha');
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it('opens a create dialog from empty canvas without posting a session', async () => {
    const nodes = [session({ id: 'a', title: 'Alpha', metadata: { cwd: '/tmp/proj' } })];
    const onCreate = vi.fn().mockResolvedValue('created');
    const create = vi.spyOn(api.sessions, 'create');
    const map = await renderMap(nodes, [], {
      onOpenSession: vi.fn(),
      onCreateTopLevelSession: onCreate,
    });
    try {
      const empty = map.emptyClientPoint();
      const stage = map.container.querySelector<HTMLElement>('.session-map-stage');
      await act(async () => {
        stage!.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, clientX: empty.x, clientY: empty.y,
        }));
      });
      const menu = map.container.querySelector('.session-map-context-menu');
      expect(menu?.textContent).toMatch(/Fit to view|适应画面/);
      expect(menu?.textContent).not.toMatch(/Focus|聚焦/);
      const createBtn = [...menu!.querySelectorAll('button')].find((el) => /Create session here|在此新建会话/.test(el.textContent ?? ''));
      await act(async () => { createBtn!.click(); });
      expect(onCreate).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      const drawer = map.container.querySelector('.session-identity-drawer');
      expect(drawer).not.toBeNull();
      expect(drawer?.textContent).toMatch(/Create|创建/);
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it('keeps box selection after releasing over a card', async () => {
    const nodes = [session({ id: 'a', title: 'Alpha' }), session({ id: 'b', title: 'Beta' })];
    const onOpen = vi.fn();
    const map = await renderMap(nodes, [], { onOpenSession: onOpen });
    try {
      const stage = map.container.querySelector<HTMLElement>('.session-map-stage');
      const aPoint = map.clientPointOf('a');
      const bPoint = map.clientPointOf('b');
      const left = Math.min(aPoint.x, bPoint.x) - 180;
      const top = Math.min(aPoint.y, bPoint.y) - 120;
      const right = Math.max(aPoint.x, bPoint.x) + 180;
      const bottom = Math.max(aPoint.y, bPoint.y) + 120;
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0,
          clientX: left, clientY: top, pointerId: 44, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true,
          clientX: right, clientY: bottom, pointerId: 44, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, button: 0,
          clientX: right, clientY: bottom, pointerId: 44, pointerType: 'mouse',
        }));
      });
      await act(async () => { map.card('a').click(); });
      expect(onOpen).not.toHaveBeenCalled();
      expect(map.card('a').className).toContain('selected');
      expect(map.container.querySelector('.session-map-selection-toolbar')?.textContent).toMatch(/Create group box|创建分组框/);
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it.skip('(g) the error banner can be dismissed', async () => {
    const nodes = [
      session({ id: 'parent', title: 'Parent' }),
      session({ id: 'child', title: 'Child', metadata: { parent_session_id: 'parent' } }),
    ];
    const map = await renderMap(nodes, [{ child_session_id: 'child', parent_session_id: 'parent' }], { onOpenSession: vi.fn() });
    try {
      const inPort = map.card('child').querySelector<HTMLElement>('.session-map-port-in');
      // IN wire dropped on empty canvas → error feedback.
      await dragWire(inPort!, map.emptyClientPoint(), 13);
      const banner = map.container.querySelector('.session-map-error');
      expect(banner).not.toBeNull();
      const close = banner!.querySelector('button');
      expect(close).toBeTruthy();
      await act(async () => { close!.click(); });
      expect(map.container.querySelector('.session-map-error')).toBeNull();
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it.skip('(h) Alt+click on a mounted child IN port asks before unmounting; top-level gives feedback', async () => {
    const nodes = [
      session({ id: 'parent', title: 'Parent' }),
      session({ id: 'child', title: 'Child', metadata: { parent_session_id: 'parent' } }),
    ];
    const unmount = vi.spyOn(api.sessions, 'unmount').mockResolvedValue(session({ id: 'child', title: 'Child' }));
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const onOpenSession = vi.fn();
    const map = await renderMap(nodes, [{ child_session_id: 'child', parent_session_id: 'parent' }], { onOpenSession });
    try {
      const childIn = map.card('child').querySelector<HTMLElement>('.session-map-port-in');
      await act(async () => {
        childIn!.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0, altKey: true,
          clientX: 10, clientY: 10, pointerId: 8, pointerType: 'mouse',
        }));
      });
      expect(confirmSpy).toHaveBeenCalled();
      expect(unmount).not.toHaveBeenCalled();
      await act(async () => { trailingClick(map.card('child')); });
      expect(onOpenSession).not.toHaveBeenCalled();

      confirmSpy.mockReturnValue(true);
      await act(async () => {
        childIn!.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0, altKey: true,
          clientX: 10, clientY: 10, pointerId: 9, pointerType: 'mouse',
        }));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(unmount).toHaveBeenCalledWith('child');

      // Top-level node: silent no-op becomes explicit feedback.
      const parentIn = map.card('parent').querySelector<HTMLElement>('.session-map-port-in');
      await act(async () => {
        parentIn!.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0, altKey: true,
          clientX: 10, clientY: 10, pointerId: 10, pointerType: 'mouse',
        }));
      });
      expect(map.container.querySelector('.session-map-error')).not.toBeNull();
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it('Alt+left-click on a connected IN port unmounts that job', async () => {
    const parent = session({ id: 'parent', title: 'Parent' });
    const childMounted = session({ id: 'child', title: 'Child', metadata: { parent_session_id: 'parent' } });
    const childFree = session({ id: 'child', title: 'Child' });
    const unmount = vi.spyOn(api.sessions, 'unmount').mockImplementation(async () => {
      vi.mocked(api.sessions.getGraph).mockResolvedValue({
        nodes: [parent, childFree],
        edges: [],
      });
      return childFree;
    });
    const confirmSpy = vi.spyOn(window, 'confirm');
    const mount = vi.spyOn(api.sessions, 'mount');
    const remount = vi.spyOn(api.sessions, 'remount');
    const onOpenSession = vi.fn();
    const map = await renderMap(
      [parent, childMounted],
      [{ child_session_id: 'child', parent_session_id: 'parent' }],
      { onOpenSession },
    );
    try {
      const childIn = map.card('child').querySelector<HTMLElement>('.session-map-port-in');
      expect(childIn).toBeTruthy();
      await act(async () => {
        childIn!.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0, altKey: true,
          clientX: 10, clientY: 10, pointerId: 8, pointerType: 'mouse',
        }));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(confirmSpy).not.toHaveBeenCalled();
      expect(mount).not.toHaveBeenCalled();
      expect(remount).not.toHaveBeenCalled();
      expect(unmount).toHaveBeenCalledWith('child');
      expect(unmount).toHaveBeenCalledTimes(1);
      await act(async () => { trailingClick(map.card('child')); });
      expect(onOpenSession).not.toHaveBeenCalled();

      const parentIn = map.card('parent').querySelector<HTMLElement>('.session-map-port-in');
      await act(async () => {
        parentIn!.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0, altKey: true,
          clientX: 10, clientY: 10, pointerId: 9, pointerType: 'mouse',
        }));
        await Promise.resolve();
      });
      expect(unmount).toHaveBeenCalledTimes(1);
      expect(confirmSpy).not.toHaveBeenCalled();
      expect(map.container.textContent).toMatch(/no job to disconnect|没有可拆的工作/);

      const before = map.canvasTransform();
      const empty = map.emptyClientPoint();
      const stage = map.container.querySelector<HTMLElement>('.session-map-stage');
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0, altKey: true,
          clientX: empty.x, clientY: empty.y, pointerId: 10, pointerType: 'mouse',
        }));
      });
      const after = map.canvasTransform();
      expect(after.x).toBe(before.x);
      expect(after.y).toBe(before.y);
      expect(map.container.querySelector('.session-map-marquee')).toBeNull();
      expect(unmount).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it('Alt+left-click on a work edge unmounts that parent mount', async () => {
    const parent = session({ id: 'parent', title: 'Parent' });
    const childMounted = session({ id: 'child', title: 'Child', metadata: { parent_session_id: 'parent' } });
    const childFree = session({ id: 'child', title: 'Child' });
    const unmount = vi.spyOn(api.sessions, 'unmount').mockImplementation(async () => {
      vi.mocked(api.sessions.getGraph).mockResolvedValue({
        nodes: [parent, childFree],
        edges: [],
      });
      return childFree;
    });
    const confirmSpy = vi.spyOn(window, 'confirm');
    const map = await renderMap(
      [parent, childMounted],
      [{ child_session_id: 'child', parent_session_id: 'parent' }],
      { onOpenSession: vi.fn() },
    );
    try {
      const edge = map.container.querySelector<SVGPathElement>('path[data-parent-id="parent"][data-child-id="child"]');
      expect(edge).toBeTruthy();
      await act(async () => {
        edge!.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0, altKey: true,
          clientX: 20, clientY: 20, pointerId: 11, pointerType: 'mouse',
        }));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(confirmSpy).not.toHaveBeenCalled();
      expect(unmount).toHaveBeenCalledWith('child');
      expect(unmount).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it.skip('(i) deleting a session with mounted children warns that children promote to top level', async () => {
    const nodes = [
      session({ id: 'root', title: 'Root' }),
      session({ id: 'child', title: 'Child', metadata: { parent_session_id: 'root' } }),
    ];
    const del = vi.spyOn(api.sessions, 'delete').mockResolvedValue({ deleted: true });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const map = await renderMap(nodes, [{ child_session_id: 'child', parent_session_id: 'root' }], { onOpenSession: vi.fn() });
    try {
      await act(async () => {
        map.card('root').dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, clientX: 80, clientY: 80,
        }));
      });
      const menu = map.container.querySelector('.session-map-context-menu');
      expect(menu).not.toBeNull();
      const deleteBtn = [...menu!.querySelectorAll('button')].find((el) => /Delete|删除/.test(el.textContent ?? ''));
      expect(deleteBtn).toBeTruthy();
      await act(async () => { deleteBtn!.click(); await Promise.resolve(); await Promise.resolve(); });
      expect(confirmSpy).toHaveBeenCalled();
      const message = String(confirmSpy.mock.calls[0]?.[0] ?? '');
      expect(message).toMatch(/top level|顶层/);
      expect(del).toHaveBeenCalledWith('root');
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it('(k) dropping the wire back onto the SOURCE card cancels silently (no draft, no create, no error)', async () => {
    const nodes = [session({ id: 'src', title: 'Source' }), session({ id: 'other', title: 'Other' })];
    const createChild = vi.spyOn(api.sessions, 'createChild');
    const onOpenSession = vi.fn();
    const map = await renderMap(nodes, [], { onOpenSession });
    try {
      const outPort = map.card('src').querySelector<HTMLElement>('.session-map-port-out');
      // Drop right onto the source card body (off its own ports).
      await dragWire(outPort!, map.clientPointOf('src', 48), 21);
      await act(async () => { trailingClick(map.card('src')); });
      expect(onOpenSession).not.toHaveBeenCalled();
      expect(map.container.querySelector('.session-map-draft-node')).toBeNull();
      expect(map.container.querySelector('.session-map-error')).toBeNull();
      expect(createChild).not.toHaveBeenCalled();
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it('(l) rewiring under the same parent shows a hint and skips mount API', async () => {
    const nodes = [
      session({ id: 'parent', title: 'Parent' }),
      session({ id: 'child', title: 'Child', metadata: { parent_session_id: 'parent' } }),
    ];
    const remount = vi.spyOn(api.sessions, 'remount');
    const mount = vi.spyOn(api.sessions, 'mount');
    const map = await renderMap(nodes, [{ child_session_id: 'child', parent_session_id: 'parent' }], { onOpenSession: vi.fn() });
    try {
      const outPort = map.card('parent').querySelector<HTMLElement>('.session-map-port-out');
      await dragWire(outPort!, map.clientPointOf('child', 8), 31);
      expect(remount).not.toHaveBeenCalled();
      expect(mount).not.toHaveBeenCalled();
      expect(map.container.querySelector('.session-map-draft-node')).toBeNull();
      expect(map.container.textContent).toMatch(/Already mounted|已挂载/);
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it('OUT wire onto an already-mounted child keeps an unapplied extra job instead of remounting', async () => {
    const parent = session({ id: 'parent', title: 'Parent', metadata: { mount_role: '审查' } });
    const child = session({
      id: 'child',
      title: 'Child',
      metadata: { parent_session_id: 'parent', mount_role: '审查' },
    });
    const other = session({ id: 'other', title: 'Other' });
    const remount = vi.spyOn(api.sessions, 'remount');
    const mount = vi.spyOn(api.sessions, 'mount');
    const unmount = vi.spyOn(api.sessions, 'unmount');
    const confirmSpy = vi.spyOn(window, 'confirm');
    const map = await renderMap(
      [parent, child, other],
      [{ child_session_id: 'child', parent_session_id: 'parent' }],
      { onOpenSession: vi.fn() },
    );
    try {
      const outPort = map.card('other').querySelector<HTMLElement>('.session-map-port-out');
      await dragWire(outPort!, map.clientPointOf('child', 8), 81);
      expect(confirmSpy).not.toHaveBeenCalled();
      expect(remount).not.toHaveBeenCalled();
      expect(mount).not.toHaveBeenCalled();
      expect(unmount).not.toHaveBeenCalled();
      const extra = map.container.querySelector<SVGPathElement>('path[data-parent-id="other"][data-child-id="child"]');
      expect(extra).toBeTruthy();
      expect(extra!.getAttribute('data-edge-status')).toBe('pending-multi-parent');
      expect(extra!.getAttribute('class') ?? '').toMatch(/pending-multi-parent/);
      const live = map.container.querySelector<SVGPathElement>('path[data-parent-id="parent"][data-child-id="child"]');
      expect(live).toBeTruthy();
      expect(live!.getAttribute('data-edge-status')).not.toBe('pending-multi-parent');
      const panel = map.container.querySelector('[data-map-unapplied-job]');
      expect(panel).not.toBeNull();
      expect(panel!.textContent).toMatch(/Can't work for two people at once yet|现在还不能同时给两个人干活/);
      expect(map.container.querySelectorAll('[data-map-action="dismiss-unapplied"]')).toHaveLength(1);
      expect(map.container.querySelectorAll('[data-map-action="remount-unapplied"]')).toHaveLength(1);
      expect(map.card('child').textContent).toMatch(/2 jobs|2 份工作/);
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it('remounts an unapplied extra job only after choosing to move it', async () => {
    const parent = session({ id: 'parent', title: 'Parent' });
    const child = session({ id: 'child', title: 'Child', metadata: { parent_session_id: 'parent' } });
    const other = session({ id: 'other', title: 'Other' });
    const remount = vi.spyOn(api.sessions, 'remount').mockImplementation(async () => {
      const moved = session({ id: 'child', title: 'Child', metadata: { parent_session_id: 'other' } });
      vi.mocked(api.sessions.getGraph).mockResolvedValue({
        nodes: [parent, other, moved],
        edges: [{ parent_session_id: 'other', child_session_id: 'child' }],
      });
      return moved;
    });
    const unmount = vi.spyOn(api.sessions, 'unmount');
    const confirmSpy = vi.spyOn(window, 'confirm');
    const map = await renderMap(
      [parent, child, other],
      [{ child_session_id: 'child', parent_session_id: 'parent' }],
      { onOpenSession: vi.fn() },
    );
    try {
      const outPort = map.card('other').querySelector<HTMLElement>('.session-map-port-out');
      await dragWire(outPort!, map.clientPointOf('child', 8), 82);
      expect(remount).not.toHaveBeenCalled();
      await act(async () => {
        map.container.querySelector<HTMLButtonElement>('[data-map-action="remount-unapplied"]')!.click();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(confirmSpy).not.toHaveBeenCalled();
      expect(unmount).not.toHaveBeenCalled();
      expect(remount).toHaveBeenCalledWith('child', 'other', expect.anything());
      expect(remount).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it('removing an unapplied extra job does not unmount the live parent', async () => {
    const parent = session({ id: 'parent', title: 'Parent' });
    const child = session({ id: 'child', title: 'Child', metadata: { parent_session_id: 'parent' } });
    const other = session({ id: 'other', title: 'Other' });
    const remount = vi.spyOn(api.sessions, 'remount');
    const unmount = vi.spyOn(api.sessions, 'unmount');
    const map = await renderMap(
      [parent, child, other],
      [{ child_session_id: 'child', parent_session_id: 'parent' }],
      { onOpenSession: vi.fn() },
    );
    try {
      const outPort = map.card('other').querySelector<HTMLElement>('.session-map-port-out');
      await dragWire(outPort!, map.clientPointOf('child', 8), 83);
      await act(async () => {
        map.container.querySelector<HTMLButtonElement>('[data-map-action="dismiss-unapplied"]')!.click();
      });
      expect(unmount).not.toHaveBeenCalled();
      expect(remount).not.toHaveBeenCalled();
      expect(map.container.querySelector('path[data-parent-id="other"][data-child-id="child"]')).toBeNull();
      expect(map.container.querySelector('path[data-parent-id="parent"][data-child-id="child"]')).not.toBeNull();
      expect(map.container.querySelector('[data-map-unapplied-job]')).toBeNull();
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it('Alt+left-click on an unapplied extra job removes the line without unmounting', async () => {
    const parent = session({ id: 'parent', title: 'Parent' });
    const child = session({ id: 'child', title: 'Child', metadata: { parent_session_id: 'parent' } });
    const other = session({ id: 'other', title: 'Other' });
    const unmount = vi.spyOn(api.sessions, 'unmount');
    const remount = vi.spyOn(api.sessions, 'remount');
    const map = await renderMap(
      [parent, child, other],
      [{ child_session_id: 'child', parent_session_id: 'parent' }],
      { onOpenSession: vi.fn() },
    );
    try {
      const outPort = map.card('other').querySelector<HTMLElement>('.session-map-port-out');
      await dragWire(outPort!, map.clientPointOf('child', 8), 84);
      const extra = map.container.querySelector<SVGPathElement>('path[data-parent-id="other"][data-child-id="child"]');
      expect(extra).toBeTruthy();
      await act(async () => {
        extra!.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0, altKey: true,
          clientX: 20, clientY: 20, pointerId: 85, pointerType: 'mouse',
        }));
      });
      expect(unmount).not.toHaveBeenCalled();
      expect(remount).not.toHaveBeenCalled();
      expect(map.container.querySelector('path[data-parent-id="other"][data-child-id="child"]')).toBeNull();
      expect(map.container.querySelector('path[data-parent-id="parent"][data-child-id="child"]')).not.toBeNull();
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it('Delete on a selected unapplied extra job removes the line without unmounting', async () => {
    const parent = session({ id: 'parent', title: 'Parent' });
    const child = session({ id: 'child', title: 'Child', metadata: { parent_session_id: 'parent' } });
    const other = session({ id: 'other', title: 'Other' });
    const unmount = vi.spyOn(api.sessions, 'unmount');
    const remount = vi.spyOn(api.sessions, 'remount');
    const map = await renderMap(
      [parent, child, other],
      [{ child_session_id: 'child', parent_session_id: 'parent' }],
      { onOpenSession: vi.fn() },
    );
    try {
      const outPort = map.card('other').querySelector<HTMLElement>('.session-map-port-out');
      await dragWire(outPort!, map.clientPointOf('child', 8), 86);
      expect(map.container.querySelector('[data-map-unapplied-job]')).not.toBeNull();
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
      });
      expect(unmount).not.toHaveBeenCalled();
      expect(remount).not.toHaveBeenCalled();
      expect(map.container.querySelector('path[data-parent-id="other"][data-child-id="child"]')).toBeNull();
      expect(map.container.querySelector('[data-map-unapplied-job]')).toBeNull();
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it('IN-port onto another parent remounts and does not create an unapplied extra job', async () => {
    const parent = session({ id: 'parent', title: 'Parent' });
    const child = session({ id: 'child', title: 'Child', metadata: { parent_session_id: 'parent' } });
    const other = session({ id: 'other', title: 'Other' });
    const remount = vi.spyOn(api.sessions, 'remount').mockImplementation(async () => {
      const moved = session({ id: 'child', title: 'Child', metadata: { parent_session_id: 'other' } });
      vi.mocked(api.sessions.getGraph).mockResolvedValue({
        nodes: [parent, other, moved],
        edges: [{ parent_session_id: 'other', child_session_id: 'child' }],
      });
      return moved;
    });
    const confirmSpy = vi.spyOn(window, 'confirm');
    const map = await renderMap(
      [parent, child, other],
      [{ child_session_id: 'child', parent_session_id: 'parent' }],
      { onOpenSession: vi.fn() },
    );
    try {
      const inPort = map.card('child').querySelector<HTMLElement>('.session-map-port-in');
      await dragWire(inPort!, map.clientPointOf('other', 88), 84);
      expect(confirmSpy).not.toHaveBeenCalled();
      expect(remount).toHaveBeenCalledWith('child', 'other', expect.anything());
      expect(map.container.querySelector('[data-map-unapplied-job]')).toBeNull();
      expect(map.container.querySelector('path[data-edge-status="pending-multi-parent"]')).toBeNull();
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it.skip('(m) client-side cycle precheck blocks mount before API', async () => {
    const nodes = [
      session({ id: 'root', title: 'Root' }),
      session({ id: 'mid', title: 'Mid', metadata: { parent_session_id: 'root' } }),
      session({ id: 'leaf', title: 'Leaf', metadata: { parent_session_id: 'mid' } }),
    ];
    const remount = vi.spyOn(api.sessions, 'remount');
    const map = await renderMap(nodes, [
      { child_session_id: 'mid', parent_session_id: 'root' },
      { child_session_id: 'leaf', parent_session_id: 'mid' },
    ], { onOpenSession: vi.fn() });
    try {
      const inPort = map.card('root').querySelector<HTMLElement>('.session-map-port-in');
      await dragWire(inPort!, map.clientPointOf('leaf', 88), 32);
      expect(remount).not.toHaveBeenCalled();
      expect(map.container.querySelector('.session-map-error')).not.toBeNull();
      expect(map.container.textContent).toMatch(/cycle|环/);
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it('(n) Escape cancels an in-progress wire without opening draft', async () => {
    const nodes = [session({ id: 'a', title: 'Alpha' }), session({ id: 'b', title: 'Beta' })];
    const mount = vi.spyOn(api.sessions, 'mount');
    const map = await renderMap(nodes, [], { onOpenSession: vi.fn() });
    try {
      const outPort = map.card('a').querySelector<HTMLElement>('.session-map-port-out');
      await act(async () => {
        outPort!.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0,
          clientX: 64, clientY: 64, pointerId: 33, pointerType: 'mouse',
        }));
      });
      expect(map.container.querySelector('.session-map-stage.wiring')).not.toBeNull();
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(map.container.querySelector('.session-map-stage.wiring')).toBeNull();
      expect(map.container.querySelector('.session-map-draft-node')).toBeNull();
      expect(mount).not.toHaveBeenCalled();
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it('right-click during a wire cancels it without creating a draft or opening a menu', async () => {
    const nodes = [session({ id: 'a', title: 'Alpha' }), session({ id: 'b', title: 'Beta' })];
    const mount = vi.spyOn(api.sessions, 'mount');
    const map = await renderMap(nodes, [], { onOpenSession: vi.fn() });
    try {
      const outPort = map.card('a').querySelector<HTMLElement>('.session-map-port-out');
      const stage = map.container.querySelector<HTMLElement>('.session-map-stage');
      const empty = map.emptyClientPoint();
      await act(async () => {
        outPort!.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0,
          clientX: 64, clientY: 64, pointerId: 34, pointerType: 'mouse',
        }));
      });
      expect(map.container.querySelector('.session-map-stage.wiring')).not.toBeNull();
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 2, buttons: 2,
          clientX: empty.x, clientY: empty.y, pointerId: 34, pointerType: 'mouse',
        }));
      });
      expect(map.container.querySelector('.session-map-stage.wiring')).toBeNull();
      expect(map.container.querySelector('.session-map-draft-node')).toBeNull();
      expect(map.container.querySelector('.session-map-context-menu')).toBeNull();
      expect(mount).not.toHaveBeenCalled();
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it.skip('(o) sticky mount errors survive a successful graph poll until dismissed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    const nodes = [
      session({ id: 'a', title: 'Alpha' }),
      session({ id: 'b', title: 'Beta' }),
    ];
    vi.spyOn(api.sessions, 'mount').mockRejectedValue(new Error('mount denied'));
    const map = await renderMap(nodes, [], { onOpenSession: vi.fn() });
    try {
      const outPort = map.card('a').querySelector<HTMLElement>('.session-map-port-out');
      await dragWire(outPort!, map.clientPointOf('b', 8), 34);
      expect(map.container.querySelector('.session-map-error.sticky')).not.toBeNull();
      const callsBefore = vi.mocked(api.sessions.getGraph).mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_200);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(vi.mocked(api.sessions.getGraph).mock.calls.length).toBeGreaterThan(callsBefore);
      expect(map.container.querySelector('.session-map-error.sticky')).not.toBeNull();
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
      vi.useRealTimers();
    }
  });

  it.skip('(p) near-miss drop shows error instead of create-new draft', async () => {
    const nodes = [
      session({ id: 'a', title: 'Alpha' }),
      session({
        id: 'child',
        title: 'Child',
        metadata: { parent_session_id: 'a' },
      }),
    ];
    const createChild = vi.spyOn(api.sessions, 'createChild');
    const mount = vi.spyOn(api.sessions, 'mount');
    const remount = vi.spyOn(api.sessions, 'remount');
    const map = await renderMap(
      nodes,
      [{ child_session_id: 'child', parent_session_id: 'a' }],
      { onOpenSession: vi.fn() },
    );
    try {
      const aCard = map.card('a');
      const view = map.canvasTransform();
      // Just outside the parent card: mounting the child under its own parent
      // is an invalid cycle, so snap must not take it, and the drop is a miss.
      const nearMiss = {
        x: (Number.parseFloat(aCard.style.left) + 220 + 24) * view.scale + view.x,
        y: (Number.parseFloat(aCard.style.top) + 48) * view.scale + view.y,
      };
      const outPort = map.card('child').querySelector<HTMLElement>('.session-map-port-out')!;
      await dragWire(outPort, nearMiss, 35);
      expect(createChild).not.toHaveBeenCalled();
      expect(mount).not.toHaveBeenCalled();
      expect(remount).not.toHaveBeenCalled();
      expect(map.container.querySelector('.session-map-draft-node')).toBeNull();
      expect(map.container.querySelector('.session-map-error')).not.toBeNull();
      expect(map.container.textContent).toMatch(/missed the node|未命中|real session|真实会话/);
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it('(j) Escape clears the marquee selection; LMB marquee selects', async () => {
    const nodes = [session({ id: 'a', title: 'Alpha' }), session({ id: 'b', title: 'Beta' })];
    const map = await renderMap(nodes, [], { onOpenSession: vi.fn() });
    try {
      const stage = map.container.querySelector<HTMLElement>('.session-map-stage');
      const target = map.clientPointOf('a');
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0,
          clientX: target.x - 160, clientY: target.y - 90, pointerId: 3, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true,
          clientX: target.x + 160, clientY: target.y + 90, pointerId: 3, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, button: 0,
          clientX: target.x + 160, clientY: target.y + 90, pointerId: 3, pointerType: 'mouse',
        }));
      });
      expect(map.card('a').className).toContain('selected');

      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(map.card('a').className).not.toContain('selected');
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it.skip('(j2) batch delete confirms count and calls API for each selected session', async () => {
    const nodes = [
      session({ id: 'a', title: 'Alpha' }),
      session({ id: 'b', title: 'Beta' }),
    ];
    const del = vi.spyOn(api.sessions, 'delete').mockResolvedValue({ deleted: true });
    const unmount = vi.spyOn(api.sessions, 'unmount').mockResolvedValue(session({ id: 'b', title: 'Beta' }));
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const map = await renderMap(nodes, [], { onOpenSession: vi.fn() });
    try {
      const stage = map.container.querySelector<HTMLElement>('.session-map-stage');
      const aPoint = map.clientPointOf('a');
      const bPoint = map.clientPointOf('b');
      const left = Math.min(aPoint.x, bPoint.x) - 180;
      const top = Math.min(aPoint.y, bPoint.y) - 120;
      const right = Math.max(aPoint.x, bPoint.x) + 180;
      const bottom = Math.max(aPoint.y, bPoint.y) + 120;
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0,
          clientX: left, clientY: top, pointerId: 11, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true,
          clientX: right, clientY: bottom, pointerId: 11, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, button: 0,
          clientX: right, clientY: bottom, pointerId: 11, pointerType: 'mouse',
        }));
      });
      expect(map.card('a').className).toContain('selected');
      expect(map.card('b').className).toContain('selected');

      const selectionBox = map.container.querySelector<HTMLElement>('.session-map-selection-box');
      expect(selectionBox).toBeTruthy();
      await act(async () => {
        selectionBox!.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, clientX: 200, clientY: 200,
        }));
      });
      const menu = map.container.querySelector('.session-map-context-menu');
      expect(menu).not.toBeNull();
      const deleteBtn = [...menu!.querySelectorAll('button')].find((el) => /Delete|删除/.test(el.textContent ?? ''));
      expect(deleteBtn).toBeTruthy();
      await act(async () => {
        deleteBtn!.click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(confirmSpy).toHaveBeenCalled();
      expect(String(confirmSpy.mock.calls[0]?.[0] ?? '')).toMatch(/2 selected|已选 2|2 个/);
      expect(del).toHaveBeenCalledTimes(2);
      expect(del).toHaveBeenCalledWith('a');
      expect(del).toHaveBeenCalledWith('b');
      expect(unmount).not.toHaveBeenCalled();
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it.skip('shows a selection toolbar with stop and a readable running badge', async () => {
    const nodes = [
      session({
        id: 'a',
        title: 'Alpha',
        status: 'running',
        updated_at: '2026-01-01T00:00:00.000Z',
      }),
      session({ id: 'b', title: 'Beta' }),
    ];
    const abort = vi.spyOn(api.sessions, 'abort').mockResolvedValue(undefined as never);
    const map = await renderMap(nodes, [], { onOpenSession: vi.fn() });
    try {
      const badge = map.card('a').querySelector('.session-map-status-badge');
      expect(badge?.textContent).toMatch(/running/);
      const stage = map.container.querySelector<HTMLElement>('.session-map-stage');
      const aPoint = map.clientPointOf('a');
      const bPoint = map.clientPointOf('b');
      const left = Math.min(aPoint.x, bPoint.x) - 180;
      const top = Math.min(aPoint.y, bPoint.y) - 120;
      const right = Math.max(aPoint.x, bPoint.x) + 180;
      const bottom = Math.max(aPoint.y, bPoint.y) + 120;
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0,
          clientX: left, clientY: top, pointerId: 21, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true,
          clientX: right, clientY: bottom, pointerId: 21, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, button: 0,
          clientX: right, clientY: bottom, pointerId: 21, pointerType: 'mouse',
        }));
      });
      expect(map.card('a').className).toContain('selected');
      expect(map.card('b').className).toContain('selected');
      const toolbar = map.container.querySelector('.session-map-selection-toolbar');
      expect(toolbar).not.toBeNull();
      expect(toolbar?.textContent).toMatch(/2 selected|已选 2/);
      const stop = [...toolbar!.querySelectorAll('button')].find((el) => /Stop|停止/.test(el.textContent ?? ''));
      expect(stop).toBeTruthy();
      await act(async () => {
        stop!.click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(abort).toHaveBeenCalledWith('a');
      expect(abort).toHaveBeenCalledWith('b');
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it.skip('selects with click/shift, filters by status, and exposes card console actions', async () => {
    const nodes = [
      session({
        id: 'run',
        title: 'Runner',
        status: 'running',
        updated_at: '2026-01-01T00:00:00.000Z',
      }),
      session({
        id: 'err',
        title: 'Broken',
        status: 'error',
        metadata: { last_error: 'disk full on example.com' },
      }),
      session({ id: 'idle', title: 'Idle One', status: 'idle' }),
    ];
    const onOpen = vi.fn();
    const abort = vi.spyOn(api.sessions, 'abort').mockResolvedValue(undefined as never);
    const updateIdentity = vi.spyOn(api.sessions, 'updateIdentity').mockImplementation(async (id, patch) => (
      session({ id, title: id, metadata: { session_tags: patch.tags ?? [] } })
    ));
    const map = await renderMap(nodes, [], { onOpenSession: onOpen });
    try {
      expect(map.card('run').querySelector('.session-map-status-badge')?.textContent).toMatch(/running/);
      expect(map.card('run').querySelector('[data-action-kind="thinking"]')?.textContent).toMatch(/thinking|思考中/);
      expect(map.card('err').querySelector('.session-map-card-error')?.textContent).toMatch(/disk full/);

      await act(async () => { map.card('run').click(); });
      expect(onOpen).not.toHaveBeenCalled();
      expect(map.card('run').className).toContain('selected');
      await act(async () => {
        map.card('err').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
      });
      expect(map.card('err').className).toContain('selected');
      expect(map.container.querySelector('.session-map-selection-toolbar')?.textContent).toMatch(/2 selected|已选 2/);

      const selectAll = map.container.querySelector<HTMLButtonElement>('[data-map-action="select-all"]');
      await act(async () => { selectAll!.click(); });
      expect(map.card('idle').className).toContain('selected');
      expect(map.container.querySelector('.session-map-selection-count')?.textContent).toMatch(/3 selected|已选 3/);

      const runningFilter = map.container.querySelector<HTMLButtonElement>('[data-status-filter="running"]');
      await act(async () => { runningFilter!.click(); });
      expect(map.container.querySelector('[data-session-id="run"]')).toBeTruthy();
      expect(map.container.querySelector('[data-session-id="idle"]')).toBeNull();
      expect(map.container.querySelector('[data-session-id="err"]')).toBeNull();

      await act(async () => { runningFilter!.click(); });
      const errorFilter = map.container.querySelector<HTMLButtonElement>('[data-status-filter="error"]');
      await act(async () => { errorFilter!.click(); });
      expect(map.container.querySelector('[data-session-id="err"]')).toBeTruthy();
      expect(map.container.querySelector('[data-session-id="run"]')).toBeNull();
      await act(async () => { errorFilter!.click(); });

      await act(async () => { map.card('run').querySelector<HTMLButtonElement>('[data-map-action="open"]')!.click(); });
      expect(onOpen).toHaveBeenCalledWith('run');
      await act(async () => { map.card('run').querySelector<HTMLButtonElement>('[data-map-action="stop"]')!.click(); await Promise.resolve(); });
      expect(abort).toHaveBeenCalledWith('run');

      await act(async () => { map.card('run').click(); });
      await act(async () => {
        map.card('err').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
      });
      const toolbar = map.container.querySelector('.session-map-selection-toolbar');
      const tags = toolbar!.querySelector<HTMLButtonElement>('[data-map-action="tags"]');
      await act(async () => { tags!.click(); });
      const addIdentity = [...map.container.querySelectorAll('button')].find((el) => (
        /Add identity tag|添加身份标签/.test(el.textContent ?? '')
      ));
      const prompt = vi.spyOn(window, 'prompt').mockReturnValue('review');
      await act(async () => {
        addIdentity!.click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(prompt).toHaveBeenCalled();
      expect(updateIdentity).toHaveBeenCalled();
      prompt.mockRestore();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      await act(async () => { map.card('run').click(); });
      await act(async () => {
        map.card('idle').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
      });
      const laterToolbar = map.container.querySelector('.session-map-selection-toolbar');
      expect(laterToolbar?.textContent).toMatch(/2 selected|已选 2/);
      await act(async () => {
        laterToolbar!.querySelector<HTMLButtonElement>('[data-map-action="open"]')!.click();
      });
      expect(map.container.querySelector('.session-map-hint-toast')?.textContent).toMatch(/1 of 2|只打开 1/);
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it('(j3) map chrome has no rearrange control and does not auto-tidy a messy layout', async () => {
    const nodes = [
      session({ id: 'root', title: 'Root' }),
      session({ id: 'child', title: 'Child', metadata: { parent_session_id: 'root' } }),
    ];
    const layout = layoutSessionMountForest({
      nodes,
      edges: [{ child_session_id: 'child', parent_session_id: 'root' }],
    });
    const rootPlaced = layout.placed.find((node) => node.member.session.id === 'root')!;
    const childPlaced = layout.placed.find((node) => node.member.session.id === 'child')!;
    const groupDx = 400;
    const groupDy = 300;
    const messyChildCenterX = childPlaced.cx + groupDx + 220;
    const offsetPositions: Record<string, { x: number; y: number }> = {
      'session:root': { x: rootPlaced.cx + groupDx, y: rootPlaced.y + 48 + groupDy },
      'session:child': { x: messyChildCenterX, y: childPlaced.y + 48 + groupDy + 80 },
    };
    localStorage.setItem('nori-session-map-doc', JSON.stringify({
      version: 1,
      annotations: [],
      labels: [],
      sessionLabels: {},
      positions: offsetPositions,
    }));

    const map = await renderMap(nodes, [{
      child_session_id: 'child',
      parent_session_id: 'root',
    }], { onOpenSession: vi.fn() }, { keepMapDoc: true });
    try {
      expect(map.container.textContent).not.toMatch(/Rearrange|\b规整\b/);
      expect(map.container.textContent).not.toMatch(/Focus|聚焦/);
      const beforeRoot = Number.parseFloat(map.card('root').style.left);
      const beforeChild = Number.parseFloat(map.card('child').style.left);
      await act(async () => {
        await new Promise((resolve) => { window.setTimeout(resolve, 80); });
        await Promise.resolve();
      });
      expect(Math.abs(Number.parseFloat(map.card('root').style.left) - beforeRoot)).toBeLessThanOrEqual(2);
      expect(Math.abs(Number.parseFloat(map.card('child').style.left) - beforeChild)).toBeLessThanOrEqual(2);
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it('hydrates bare position keys as centers and keeps them after remount', async () => {
    const nodes = [
      session({ id: 'root', title: 'Root' }),
      session({ id: 'child', title: 'Child', metadata: { parent_session_id: 'root' } }),
    ];
    localStorage.setItem('nori-session-map-doc', JSON.stringify({
      version: 2,
      annotations: [],
      labels: [],
      sessionLabels: {},
      positions: {
        root: { x: 800, y: 400 },
        'session:child': { x: 800, y: 584 },
      },
    }));
    const first = await renderMap(nodes, [
      { child_session_id: 'child', parent_session_id: 'root' },
    ], { onOpenSession: vi.fn() }, { keepMapDoc: true });
    try {
      expect(Number.parseFloat(first.card('root').style.left)).toBe(800 - NODE_W / 2);
      expect(Number.parseFloat(first.card('root').style.top)).toBe(400 - NODE_H / 2);
      expect(Number.parseFloat(first.card('child').style.left)).toBe(800 - NODE_W / 2);
      expect(Number.parseFloat(first.card('child').style.top)).toBe(584 - NODE_H / 2);
    } finally {
      await act(async () => { first.root.unmount(); });
      first.container.remove();
    }
    const second = await renderMap(nodes, [
      { child_session_id: 'child', parent_session_id: 'root' },
    ], { onOpenSession: vi.fn() }, { keepMapDoc: true });
    try {
      expect(Number.parseFloat(second.card('root').style.left)).toBe(800 - NODE_W / 2);
      expect(Number.parseFloat(second.card('child').style.top)).toBe(584 - NODE_H / 2);
      const stored = loadSessionMapDoc().positions ?? {};
      expect(stored['session:root']).toEqual({ x: 800, y: 400 });
      expect(stored.root).toBeUndefined();
    } finally {
      await act(async () => { second.root.unmount(); });
      second.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it('persists dragged node centers under session: keys that reload reads', async () => {
    const nodes = [session({ id: 'solo', title: 'Solo' })];
    const map = await renderMap(nodes, [], { onOpenSession: vi.fn() });
    try {
      const beforeLeft = Number.parseFloat(map.card('solo').style.left);
      const start = map.clientPointOf('solo');
      await act(async () => {
        map.card('solo').dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0,
          clientX: start.x, clientY: start.y, pointerId: 77, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        window.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true,
          clientX: start.x + 160, clientY: start.y + 80, pointerId: 77, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        window.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, button: 0,
          clientX: start.x + 160, clientY: start.y + 80, pointerId: 77, pointerType: 'mouse',
        }));
      });
      const afterLeft = Number.parseFloat(map.card('solo').style.left);
      const afterTop = Number.parseFloat(map.card('solo').style.top);
      expect(afterLeft - beforeLeft).toBeGreaterThan(40);
      const stored = loadSessionMapDoc().positions ?? {};
      expect(Object.keys(stored)).toEqual(['session:solo']);
      expect(Math.round((stored['session:solo']?.x ?? 0) - NODE_W / 2)).toBe(afterLeft);
      expect(Math.round((stored['session:solo']?.y ?? 0) - NODE_H / 2)).toBe(afterTop);
      expect(stored.solo).toBeUndefined();
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it('(j4) batch drag moves all selected nodes together', async () => {
    const nodes = [
      session({ id: 'a', title: 'Alpha' }),
      session({ id: 'b', title: 'Beta' }),
    ];
    const map = await renderMap(nodes, [], { onOpenSession: vi.fn() });
    try {
      const stage = map.container.querySelector<HTMLElement>('.session-map-stage');
      const aPoint = map.clientPointOf('a');
      const bPoint = map.clientPointOf('b');
      const left = Math.min(aPoint.x, bPoint.x) - 180;
      const top = Math.min(aPoint.y, bPoint.y) - 120;
      const right = Math.max(aPoint.x, bPoint.x) + 180;
      const bottom = Math.max(aPoint.y, bPoint.y) + 120;
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0,
          clientX: left, clientY: top, pointerId: 21, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true,
          clientX: right, clientY: bottom, pointerId: 21, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, button: 0,
          clientX: right, clientY: bottom, pointerId: 21, pointerType: 'mouse',
        }));
      });
      expect(map.card('a').className).toContain('selected');
      expect(map.card('b').className).toContain('selected');

      const beforeA = Number.parseFloat(map.card('a').style.left);
      const beforeB = Number.parseFloat(map.card('b').style.left);
      const start = map.clientPointOf('a');
      await act(async () => {
        map.card('a').dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0,
          clientX: start.x, clientY: start.y, pointerId: 22, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        window.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true,
          clientX: start.x + 120, clientY: start.y + 40, pointerId: 22, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        window.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, button: 0,
          clientX: start.x + 120, clientY: start.y + 40, pointerId: 22, pointerType: 'mouse',
        }));
      });
      const afterA = Number.parseFloat(map.card('a').style.left);
      const afterB = Number.parseFloat(map.card('b').style.left);
      expect(afterA - beforeA).toBeGreaterThan(40);
      expect(afterB - beforeB).toBeGreaterThan(40);
      expect(Math.abs((afterA - beforeA) - (afterB - beforeB))).toBeLessThan(8);
      expect(map.container.querySelector('.session-map-selection-box')).toBeNull();
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it('(j4b) box-select parent+child then drag ROOT moves ALL selected by same delta', async () => {
    // Regression: multi-select must beat "drag root → whole tree / only root" branches.
    const nodes = [
      session({ id: 'root', title: 'Root' }),
      session({ id: 'child', title: 'Child', metadata: { parent_session_id: 'root' } }),
      session({ id: 'solo', title: 'Solo' }),
    ];
    const map = await renderMap(nodes, [
      { child_session_id: 'child', parent_session_id: 'root' },
    ], { onOpenSession: vi.fn() });
    try {
      const stage = map.container.querySelector<HTMLElement>('.session-map-stage');
      const rootPoint = map.clientPointOf('root');
      const childPoint = map.clientPointOf('child');
      const left = Math.min(rootPoint.x, childPoint.x) - 180;
      const top = Math.min(rootPoint.y, childPoint.y) - 120;
      const right = Math.max(rootPoint.x, childPoint.x) + 180;
      const bottom = Math.max(rootPoint.y, childPoint.y) + 120;
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0,
          clientX: left, clientY: top, pointerId: 31, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true,
          clientX: right, clientY: bottom, pointerId: 31, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, button: 0,
          clientX: right, clientY: bottom, pointerId: 31, pointerType: 'mouse',
        }));
      });
      expect(map.card('root').className).toContain('selected');
      expect(map.card('child').className).toContain('selected');

      const beforeRoot = Number.parseFloat(map.card('root').style.left);
      const beforeChild = Number.parseFloat(map.card('child').style.left);
      const beforeSolo = Number.parseFloat(map.card('solo').style.left);
      const start = map.clientPointOf('root');
      await act(async () => {
        map.card('root').dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0,
          clientX: start.x, clientY: start.y, pointerId: 32, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        window.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true,
          clientX: start.x + 140, clientY: start.y + 50, pointerId: 32, pointerType: 'mouse',
        }));
      });
      const midRoot = Number.parseFloat(map.card('root').style.left);
      const midChild = Number.parseFloat(map.card('child').style.left);
      const midSolo = Number.parseFloat(map.card('solo').style.left);
      // BOTH selected cards must move by the same delta during the drag — not only root.
      expect(midRoot - beforeRoot).toBeGreaterThan(40);
      expect(midChild - beforeChild).toBeGreaterThan(40);
      expect(Math.abs((midRoot - beforeRoot) - (midChild - beforeChild))).toBeLessThan(8);
      expect(Math.abs(midSolo - beforeSolo)).toBeLessThan(8);
      await act(async () => {
        window.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, button: 0,
          clientX: start.x + 140, clientY: start.y + 50, pointerId: 32, pointerType: 'mouse',
        }));
      });
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it('(j5) ambient home gravity stays off so dragged children keep their drop position', () => {
    expect(SESSION_MAP_AMBIENT_HOME_GRAVITY).toBe(false);
    expect(HOME_PULL_STRENGTH).toBeGreaterThan(0.1);
  });

  it('pins only component roots for ambient settle', () => {
    const root = session({ id: 'root', title: 'Root' });
    const child = session({ id: 'child', title: 'Child', metadata: { parent_session_id: 'root' } });
    const { placed, edges } = layoutSessionMountForest({
      nodes: [root, child],
      edges: [{ child_session_id: 'child', parent_session_id: 'root' }],
    });
    const nodes = placed.map((node) => ({
      id: `session:${node.member.session.id}`,
      member: node.member,
    }));
    const links = edges.map(({ from, to }) => ({
      source: `session:${from.member.session.id}`,
      target: `session:${to.member.session.id}`,
    }));
    const index = buildMapComponents(nodes, links);
    expect(isComponentRootPin('session:root', index)).toBe(true);
    expect(isComponentRootPin('session:child', index)).toBe(false);
  });

  it.skip('right-click empty canvas creates a top-level session via the shared callback', async () => {
    const nodes = [session({ id: 'a', title: 'Alpha', metadata: { cwd: '/tmp/proj' } })];
    const onCreate = vi.fn().mockResolvedValue('created');
    const create = vi.spyOn(api.sessions, 'create');
    const map = await renderMap(nodes, [], {
      onOpenSession: vi.fn(),
      onCreateTopLevelSession: onCreate,
    });
    try {
      const empty = map.emptyClientPoint();
      const stage = map.container.querySelector<HTMLElement>('.session-map-stage');
      expect(stage).toBeTruthy();
      await act(async () => {
        stage!.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, clientX: empty.x, clientY: empty.y,
        }));
      });
      const menu = map.container.querySelector('.session-map-context-menu');
      expect(menu?.textContent).toMatch(/New session|新建会话/);
      const createBtn = [...menu!.querySelectorAll('button')].find((el) => /New session|新建会话/.test(el.textContent ?? ''));
      expect(createBtn).toBeTruthy();
      await act(async () => {
        createBtn!.click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(onCreate).toHaveBeenCalledWith('/tmp/proj');
      expect(create).not.toHaveBeenCalled();
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it.skip('right-button click (pointerdown/up, no contextmenu) still creates a top-level session', async () => {
    const nodes = [session({ id: 'a', title: 'Alpha', metadata: { cwd: '/tmp/proj' } })];
    const onCreate = vi.fn().mockResolvedValue('created');
    const create = vi.spyOn(api.sessions, 'create');
    const map = await renderMap(nodes, [], {
      onOpenSession: vi.fn(),
      onCreateTopLevelSession: onCreate,
      preferredCreateCwd: '/tmp/from-sidebar',
    });
    try {
      const empty = map.emptyClientPoint();
      const stage = map.container.querySelector<HTMLElement>('.session-map-stage');
      expect(stage).toBeTruthy();
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 2,
          clientX: empty.x, clientY: empty.y, pointerId: 31, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, button: 2,
          clientX: empty.x, clientY: empty.y, pointerId: 31, pointerType: 'mouse',
        }));
      });
      const menu = map.container.querySelector('.session-map-context-menu');
      expect(menu?.textContent).toMatch(/New session|新建会话/);
      const createBtn = [...menu!.querySelectorAll('button')].find((el) => /New session|新建会话/.test(el.textContent ?? ''));
      expect(createBtn).toBeTruthy();
      await act(async () => {
        createBtn!.click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(onCreate).toHaveBeenCalledWith('/tmp/from-sidebar');
      expect(create).not.toHaveBeenCalled();
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it.skip('node context menu creates a child session through the identity draft', async () => {
    const nodes = [session({ id: 'src', title: 'Source', metadata: { cwd: '/tmp/proj' } })];
    const createChild = vi.spyOn(api.sessions, 'createChild').mockResolvedValue(
      session({ id: 'child', title: 'Child', metadata: { cwd: '/tmp/proj', parent_session_id: 'src' } }),
    );
    const map = await renderMap(nodes, [], { onOpenSession: vi.fn() });
    try {
      await act(async () => {
        map.card('src').dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, clientX: 80, clientY: 80,
        }));
      });
      const menu = map.container.querySelector('.session-map-context-menu');
      const createBtn = [...menu!.querySelectorAll('button')].find((el) => (
        /New child session|新建子会话/.test(el.textContent ?? '')
      ));
      expect(createBtn).toBeTruthy();
      await act(async () => { createBtn!.click(); });
      const draft = map.container.querySelector('.session-map-draft-node');
      expect(draft).not.toBeNull();
      expect(createChild).not.toHaveBeenCalled();
      const confirm = [...draft!.querySelectorAll('button')].find((el) => (
        el.textContent === 'Confirm' || el.textContent === '确认'
      ));
      expect(confirm).toBeTruthy();
      await act(async () => { confirm!.click(); await Promise.resolve(); await Promise.resolve(); });
      expect(createChild).toHaveBeenCalledWith('src', expect.anything());
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it.skip('label chips filter canvas nodes', async () => {
    localStorage.setItem('nori-session-map-doc', JSON.stringify({
      version: 2,
      annotations: [],
      labels: [{ id: 'lbl-hot', name: 'Hot', color: '#ef4444' }],
      sessionLabels: { a: ['lbl-hot'] },
      edges: [],
    }));
    const nodes = [
      session({ id: 'a', title: 'Alpha' }),
      session({ id: 'b', title: 'Beta' }),
    ];
    const map = await renderMap(nodes, [], { onOpenSession: vi.fn() }, { keepMapDoc: true });
    try {
      expect(map.container.querySelector('[data-session-id="a"]')).toBeTruthy();
      expect(map.container.querySelector('[data-session-id="b"]')).toBeTruthy();
      const chip = [...map.container.querySelectorAll<HTMLButtonElement>('.session-map-label-chip')]
        .find((el) => el.textContent === 'Hot');
      expect(chip).toBeTruthy();
      await act(async () => { chip!.click(); });
      expect(map.container.querySelector('[data-session-id="a"]')).toBeTruthy();
      expect(map.container.querySelector('[data-session-id="b"]')).toBeNull();
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it.skip('label chips keep unlabeled ancestors of matching mounted children', async () => {
    localStorage.setItem('nori-session-map-doc', JSON.stringify({
      version: 2,
      annotations: [],
      labels: [{ id: 'lbl-hot', name: 'Hot', color: '#ef4444' }],
      sessionLabels: { child: ['lbl-hot'] },
      edges: [{ id: 'e1', type: 'parent', source: 'parent', target: 'child' }],
    }));
    const nodes = [
      session({ id: 'parent', title: 'Parent' }),
      session({ id: 'child', title: 'Child', metadata: { parent_session_id: 'parent' } }),
      session({ id: 'other', title: 'Other' }),
    ];
    const map = await renderMap(
      nodes,
      [{ child_session_id: 'child', parent_session_id: 'parent' }],
      { onOpenSession: vi.fn() },
      { keepMapDoc: true },
    );
    try {
      const chip = [...map.container.querySelectorAll<HTMLButtonElement>('.session-map-label-chip')]
        .find((el) => el.textContent === 'Hot');
      expect(chip).toBeTruthy();
      await act(async () => { chip!.click(); });
      expect(map.container.querySelector('[data-session-id="child"]')).toBeTruthy();
      expect(map.container.querySelector('[data-session-id="parent"]')).toBeTruthy();
      expect(map.container.querySelector('[data-session-id="other"]')).toBeNull();
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it.skip('Shift+drag between session cards draws a local peer edge', async () => {
    const nodes = [
      session({ id: 'a', title: 'Alpha' }),
      session({ id: 'b', title: 'Beta' }),
    ];
    const mount = vi.spyOn(api.sessions, 'mount');
    const map = await renderMap(nodes, [], { onOpenSession: vi.fn() });
    try {
      const outPort = map.card('a').querySelector<HTMLElement>('.session-map-port-out');
      const drop = map.clientPointOf('b', 8);
      await act(async () => {
        outPort!.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0, shiftKey: true,
          clientX: 64, clientY: 64, pointerId: 77, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        window.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true, shiftKey: true,
          clientX: drop.x, clientY: drop.y, pointerId: 77, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        window.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, button: 0, shiftKey: true,
          clientX: drop.x, clientY: drop.y, pointerId: 77, pointerType: 'mouse',
        }));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(map.container.querySelector('path.session-map-edge-peer')).not.toBeNull();
      expect(mount).not.toHaveBeenCalled();
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it.skip('queues unmount while the child session is running', async () => {
    const nodes = [
      session({ id: 'parent', title: 'Parent' }),
      session({ id: 'child', title: 'Child', status: 'running', metadata: { parent_session_id: 'parent' } }),
    ];
    const unmount = vi.spyOn(api.sessions, 'unmount');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const map = await renderMap(nodes, [{ child_session_id: 'child', parent_session_id: 'parent' }], { onOpenSession: vi.fn() });
    try {
      const childIn = map.card('child').querySelector<HTMLElement>('.session-map-port-in');
      await act(async () => {
        childIn!.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0, altKey: true,
          clientX: 10, clientY: 10, pointerId: 88, pointerType: 'mouse',
        }));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(unmount).not.toHaveBeenCalled();
      expect(map.container.textContent).toMatch(/queued|排队/);
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });
});

describe('wire parent helpers', () => {
  it('buildMapComponents groups mount subtrees and picks a root per component', () => {
    const root = session({ id: 'root', title: 'Root' });
    const child = session({ id: 'child', title: 'Child', metadata: { parent_session_id: 'root' } });
    const solo = session({ id: 'solo', title: 'Solo' });
    const { placed, edges } = layoutSessionMountForest({
      nodes: [root, child, solo],
      edges: [{ child_session_id: 'child', parent_session_id: 'root' }],
    });
    const nodes = placed.map((node) => ({
      id: `session:${node.member.session.id}`,
      member: node.member,
    }));
    const links = edges.map(({ from, to }) => ({
      source: `session:${from.member.session.id}`,
      target: `session:${to.member.session.id}`,
    }));
    const index = buildMapComponents(nodes, links);
    expect(index.get('session:root')?.rootNodeId).toBe('session:root');
    expect(index.get('session:child')?.rootNodeId).toBe('session:root');
    expect(index.get('session:solo')?.rootNodeId).toBe('session:solo');
    expect(index.get('session:root')?.nodeIds).toEqual(expect.arrayContaining(['session:root', 'session:child']));
  });

  it('captures wire parent only from real session nodes', () => {
    expect(wireSourceParentSessionId({
      kind: 'session',
      session: session({ id: 'b', title: 'Beta' }),
    })).toBe('b');
    // Pure agent ghost with no dual-write session — still non-wireable.
    expect(wireSourceParentSessionId({
      kind: 'agent',
      hostSessionId: 'host',
      session: session({ id: 'agent:host:m1', title: 'Ghost' }),
      agent: { agent_id: 'm1', kind: 'team', name: 'Ghost', status: 'idle' },
    })).toBeNull();
    // A mounted agent ghost still is not a real session node and cannot wire.
    expect(wireSourceParentSessionId({
      kind: 'agent',
      hostSessionId: 'host',
      session: session({ id: 'agent:host:ghost', title: 'L2 ghost' }),
      agent: {
        agent_id: 'ghost',
        kind: 'team',
        name: 'L2',
        status: 'idle',
        mounted_session_id: '11111111-1111-4111-8111-111111111111',
      },
    })).toBeNull();
    // Dual-write session card with agent attached.
    expect(wireSourceParentSessionId({
      kind: 'session',
      hostSessionId: 'host',
      session: session({
        id: 'child-sess',
        title: 'L1-B',
        metadata: { parent_session_id: 'host', mount_role: 'member' },
      }),
      agent: {
        agent_id: 'm2',
        kind: 'team',
        name: 'L1-B',
        status: 'idle',
        mounted_session_id: 'child-sess',
      },
    })).toBe('child-sess');
  });

  it('tidy slots track the root after the root moves', () => {
    const seeds = new Map([
      ['session:root', { x: 100, y: 100 }],
      ['session:child', { x: 100, y: 260 }],
    ]);
    const before = tidyComponentAroundRoot({
      rootNodeId: 'session:root',
      nodeIds: ['session:root', 'session:child'],
      rootPosition: { x: 100, y: 100 },
      seeds,
    });
    const after = tidyComponentAroundRoot({
      rootNodeId: 'session:root',
      nodeIds: ['session:root', 'session:child'],
      rootPosition: { x: 400, y: 300 },
      seeds,
    });
    expect(before.get('session:child')).toEqual({ x: 100, y: 260 });
    expect(after.get('session:root')).toEqual({ x: 400, y: 300 });
    expect(after.get('session:child')).toEqual({ x: 400, y: 460 });
  });

  it('nested dual-write member keeps agent on the session card (no host ghost)', () => {
    const nodes = [
      session({ id: 'root', title: '打招呼' }),
      session({ id: 'l1', title: 'L1', metadata: { parent_session_id: 'root', mount_role: 'member' } }),
      session({ id: 'l2', title: 'L2', metadata: { parent_session_id: 'l1', mount_role: 'member' } }),
    ];
    const { placed } = layoutSessionMountForest(
      {
        nodes,
        edges: [
          { child_session_id: 'l1', parent_session_id: 'root' },
          { child_session_id: 'l2', parent_session_id: 'l1' },
        ],
      },
      [{
        kind: 'agent',
        hostSessionId: 'root',
        session: session({ id: 'agent:root:l2', title: 'L2 ghost' }),
        agent: {
          agent_id: 'l2',
          kind: 'team',
          name: 'L2',
          role: 'member',
          status: 'idle',
          mounted_session_id: 'l2',
        },
      }],
    );
    expect(placed.find((node) => node.member.session.id.startsWith('agent:'))).toBeUndefined();
    const l2 = placed.find((node) => node.member.session.id === 'l2');
    expect(l2?.member.agent?.agent_id).toBe('l2');
    expect(wireSourceParentSessionId(l2!.member)).toBe('l2');
  });

  it('createChild+mount: no agent ghost when mounted_session_id is already in the graph', () => {
    const nodes = [
      session({ id: 'root', title: '你好问候' }),
      session({
        id: 'child',
        title: 'New member',
        metadata: { parent_session_id: 'root', mount_role: 'member' },
      }),
    ];
    const extras = [
      {
        kind: 'session' as const,
        hostSessionId: 'root',
        session: nodes[1]!,
        agent: {
          agent_id: 'member_1',
          kind: 'team' as const,
          name: 'New member',
          role: 'member',
          status: 'idle',
          mounted_session_id: 'child',
        },
      },
      {
        kind: 'agent' as const,
        hostSessionId: 'root',
        session: session({ id: 'agent:root:member_1', title: 'New member' }),
        agent: {
          agent_id: 'member_1',
          kind: 'team' as const,
          name: 'New member',
          role: 'member',
          status: 'idle',
          mounted_session_id: 'child',
        },
      },
    ];
    const { placed } = layoutSessionMountForest(
      { nodes, edges: [{ child_session_id: 'child', parent_session_id: 'root' }] },
      extras,
    );
    const keys = placed.map((node) => (
      node.member.kind === 'agent'
        ? `agent:${node.member.hostSessionId}:${node.member.agent?.agent_id}`
        : `session:${node.member.session.id}`
    ));
    expect(keys.filter((key) => key === 'session:child')).toHaveLength(1);
    expect(keys.filter((key) => key === 'session:root')).toHaveLength(1);
    expect(placed.some((node) => node.member.session.id.startsWith('agent:'))).toBe(false);
    expect(placed).toHaveLength(2);
    expect(placed.find((node) => node.member.session.id === 'child')?.member.agent?.agent_id)
      .toBe('member_1');
  });

  it('mapDoc layout edge alone does not double-place child as a second root', () => {
    // Wire lands a parent edge before server parent_session_id is written.
    const nodes = [
      session({ id: 'root', title: '你好问候' }),
      session({ id: 'child', title: 'New member' }), // no metadata parent yet
    ];
    const { placed } = layoutSessionMountForest(
      { nodes, edges: [{ child_session_id: 'child', parent_session_id: 'root' }] },
      [{
        kind: 'agent',
        hostSessionId: 'root',
        session: session({ id: 'agent:root:m1', title: 'New member' }),
        agent: {
          agent_id: 'm1',
          kind: 'team',
          name: 'New member',
          role: 'member',
          status: 'idle',
          mounted_session_id: 'child',
        },
      }],
    );
    expect(placed.filter((node) => node.member.session.id === 'child')).toHaveLength(1);
    expect(placed.filter((node) => node.member.session.id === 'root')).toHaveLength(1);
    expect(placed.some((node) => node.member.session.id.startsWith('agent:'))).toBe(false);
    expect(placed).toHaveLength(2);
  });

  it('mounted session in nodes without parent edge still skips agent ghost', () => {
    // Dual-write race: session exists in the graph but parent edge/metadata has
    // not landed yet — must still not place agent: ghost beside the real card.
    const nodes = [
      session({ id: 'root', title: 'Root' }),
      session({ id: 'child', title: 'New member' }), // no parent_session_id, no edge
    ];
    const { placed } = layoutSessionMountForest(
      { nodes, edges: [] },
      [{
        kind: 'agent',
        hostSessionId: 'root',
        session: session({ id: 'agent:root:m1', title: 'New member' }),
        agent: {
          agent_id: 'm1',
          kind: 'team',
          name: 'New member',
          role: 'member',
          status: 'idle',
          mounted_session_id: 'child',
        },
      }, {
        kind: 'session',
        hostSessionId: 'root',
        session: nodes[1]!,
        agent: {
          agent_id: 'm1',
          kind: 'team',
          name: 'New member',
          role: 'member',
          status: 'idle',
          mounted_session_id: 'child',
        },
      }],
    );
    expect(placed.filter((node) => node.member.session.id === 'child')).toHaveLength(1);
    expect(placed.filter((node) => node.member.session.id === 'root')).toHaveLength(1);
    expect(placed.some((node) => node.member.session.id.startsWith('agent:'))).toBe(false);
    expect(placed).toHaveLength(2);
  });

  it('snapComponentChildrenToLiveRoot hard-sets children under the moved root', () => {
    const seeds = new Map([
      ['session:root', { x: 100, y: 100 }],
      ['session:child', { x: 100, y: 260 }],
      ['session:sib', { x: 356, y: 260 }],
    ]);
    const nodes = [
      { id: 'session:root', x: 500, y: 400, vx: 1, vy: 1 },
      { id: 'session:child', x: 100, y: 260, vx: 9, vy: 9 },
      { id: 'session:sib', x: 356, y: 260, vx: 9, vy: 9 },
    ];
    const snapped = snapComponentChildrenToLiveRoot({
      rootNodeId: 'session:root',
      nodeIds: ['session:root', 'session:child', 'session:sib'],
      rootPosition: { x: 500, y: 400 },
      seeds,
      nodes,
    });
    expect(snapped.get('session:child')).toEqual({ x: 500, y: 560 });
    expect(snapped.get('session:sib')).toEqual({ x: 756, y: 560 });
    expect(nodes[0]).toMatchObject({ x: 500, y: 400 }); // root untouched
    expect(nodes[1]).toMatchObject({ x: 500, y: 560, vx: 0, vy: 0 });
    expect(nodes[2]).toMatchObject({ x: 756, y: 560, vx: 0, vy: 0 });
  });

  it('cyclic mapDoc parent edges still place every session (no vanish)', () => {
    const nodes = [
      session({ id: 'a', title: 'A' }),
      session({ id: 'b', title: 'B' }),
    ];
    const { placed } = layoutSessionMountForest({
      nodes,
      edges: [
        { child_session_id: 'b', parent_session_id: 'a' },
        { child_session_id: 'a', parent_session_id: 'b' },
      ],
    });
    expect(placed.map((node) => node.member.session.id).sort()).toEqual(['a', 'b']);
  });

  it('wouldCreateMountCycle respects mapDoc parents when metadata lags', () => {
    const nodes = [
      session({ id: 'root', title: 'Root' }),
      session({ id: 'child', title: 'Child' }), // no metadata parent yet
    ];
    const mapParents = new Map([['child', 'root']]);
    expect(wouldCreateMountCycle('root', 'child', nodes, mapParents)).toBe(true);
    expect(wouldCreateMountCycle('root', 'child', nodes)).toBe(false);
  });

  it('hit-tests prefer the nearest overlapping node', () => {
    const nodes = [
      { id: 'far', x: 100, y: 100 },
      { id: 'near', x: 120, y: 100 },
    ];
    // Point closer to `near` but inside both body hit boxes.
    const hit = hitSessionMapNode(nodes, 118, 100);
    expect(hit?.id).toBe('near');
  });

  it('snaps view translation to device pixels for crisp canvas text', () => {
    const snapped = snapMapView({ x: 10.4, y: 20.6, scale: 1.15 });
    expect(Number.isInteger(snapped.x * (window.devicePixelRatio || 1))
      || Math.abs(snapped.x - Math.round(snapped.x * (window.devicePixelRatio || 1)) / (window.devicePixelRatio || 1)) < 1e-9).toBe(true);
    expect(snapped.scale).toBe(1.15);
  });

  it('hit-tests the TOP IN port with a generous radius', () => {
    const nodes = [{ id: 'n1', x: 200, y: 200 }];
    const inY = 200 - NODE_H / 2;
    const hit = hitSessionMapNode(nodes, 200, inY, { preferPort: 'in' });
    expect(hit?.id).toBe('n1');
    const nearMiss = hitSessionMapNode(nodes, 200, inY - 30, { preferPort: 'in', portRadius: 36 });
    expect(nearMiss?.id).toBe('n1');
    const far = hitSessionMapNode(nodes, 200, inY - 80, { preferPort: 'in', portRadius: 36 });
    expect(far).toBeUndefined();
  });

  it('detects mount cycles client-side', () => {
    const nodes = [
      session({ id: 'root', title: 'Root' }),
      session({ id: 'mid', title: 'Mid', metadata: { parent_session_id: 'root' } }),
      session({ id: 'leaf', title: 'Leaf', metadata: { parent_session_id: 'mid' } }),
    ];
    expect(wouldCreateMountCycle('root', 'leaf', nodes)).toBe(true);
    expect(wouldCreateMountCycle('mid', 'leaf', nodes)).toBe(true);
    expect(wouldCreateMountCycle('leaf', 'root', nodes)).toBe(false);
  });

  it('finds nearest valid wire targets for rubber-band snap', () => {
    const forceNodes = [
      {
        id: 'session:a',
        x: 100,
        y: 100,
        member: { kind: 'session' as const, session: session({ id: 'a', title: 'A' }) },
      },
      {
        id: 'session:b',
        x: 400,
        y: 400,
        member: { kind: 'session' as const, session: session({ id: 'b', title: 'B' }) },
      },
    ];
    const wire = { side: 'out' as const, parentSessionId: 'a', childSessionId: '', fromId: 'session:a' };
    expect(isValidWireTarget(wire, forceNodes[1]!, [forceNodes[0]!.member.session, forceNodes[1]!.member.session])).toBe(true);
    const snap = findNearestValidWireTarget(forceNodes, 400, 360, wire, [
      forceNodes[0]!.member.session,
      forceNodes[1]!.member.session,
    ]);
    expect(snap?.node.id).toBe('session:b');
    expect(nearestSessionMapNodeDistance(forceNodes, 500, 500)).toBeGreaterThan(0);
  });

  it.skip('peer wires ignore mount cycles so a child can link back to its parent', () => {
    const parent = {
      id: 'session:p',
      x: 0,
      y: 0,
      member: { kind: 'session' as const, session: session({ id: 'p', title: 'P' }) },
    };
    const child = {
      id: 'session:c',
      x: 0,
      y: 200,
      member: {
        kind: 'session' as const,
        session: session({ id: 'c', title: 'C', metadata: { parent_session_id: 'p' } }),
      },
    };
    const nodes = [parent.member.session, child.member.session];
    const mountWire = { side: 'out' as const, parentSessionId: 'c', childSessionId: '', fromId: 'session:c' };
    expect(isValidWireTarget(mountWire, parent, nodes)).toBe(false);
    const peerWire = { ...mountWire, edgeType: 'peer' as const };
    expect(isValidWireTarget(peerWire, parent, nodes)).toBe(true);
    expect(isValidWireTarget(peerWire, child, nodes)).toBe(false);
  });
});

describe('map node capabilities', () => {
  it('exposes only session capabilities and wire directions', () => {
    const top = session({ id: 'root', title: 'Root', status: 'idle' });
    const child = session({
      id: 'child',
      title: 'Child',
      status: 'running',
      metadata: { parent_session_id: 'root', mount_role: 'worker' },
    });
    const sessions = [top, child];
    const topCaps = mapNodeCapabilities({ kind: 'session', session: top }, { sessions });
    const childCaps = mapNodeCapabilities({ kind: 'session', session: child }, { sessions });
    expect(topCaps.canWireOut).toBe(true);
    expect(childCaps.canDisconnect).toBe(true);
    expect(childCaps.canWireIn).toBe(true);
    expect('displayTier' in topCaps).toBe(false);
    expect(mapStatusDotClass(childCaps.status)).toBe('running');
  });

  it('allows dual-write members to wire out via mounted_session_id', () => {
    const host = session({ id: 'host', title: 'Host' });
    const child = session({
      id: 'child',
      title: 'Child',
      metadata: { parent_session_id: 'host' },
    });
    const member = mapNodeCapabilities({
      kind: 'session',
      session: child,
      hostSessionId: 'host',
      agent: {
        agent_id: 'a1',
        kind: 'team',
        status: 'working',
        mounted_session_id: 'child',
      },
    }, { sessions: [host, child] });
    expect(member.canWireOut).toBe(true);
    expect(member.wireSessionId).toBe('child');
    expect(mapStatusDotClass(member.status)).toBe('active');
  });

  it('queues pending topology until sessions are idle', () => {
    const busy = session({ id: 'child', title: 'Child', status: 'running' });
    const idle = session({ id: 'parent', title: 'Parent', status: 'idle' });
    const doc = {
      version: 2 as const,
      annotations: [],
      labels: [],
      sessionLabels: {},
      pendingTopology: [{
        id: 'pt1',
        kind: 'mount' as const,
        childSessionId: 'child',
        parentSessionId: 'parent',
        queuedAt: new Date().toISOString(),
      }],
    };
    expect(pendingTopologyOpsReady(doc, [busy, idle])).toHaveLength(0);
    expect(pendingTopologyOpsReady(doc, [
      { ...busy, status: 'idle' },
      idle,
    ])).toHaveLength(1);
  });

  it('preserves an existing job when adding another parent edge', () => {
    const doc = {
      version: 2 as const,
      annotations: [],
      labels: [],
      sessionLabels: {},
      edges: [{
        id: 'e1',
        type: 'parent' as const,
        source: 'old-parent',
        target: 'child',
      }],
    };
    const next = upsertParentMapEdge(doc, 'new-parent', 'child');
    expect(next.edges).toHaveLength(2);
    expect(next.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'old-parent', target: 'child' }),
      expect.objectContaining({ source: 'new-parent', target: 'child' }),
    ]));
  });

  it('keeps an unapplied extra job visual without making it layout topology', () => {
    const parentA = session({ id: 'parent-a', title: 'A' });
    const parentB = session({ id: 'parent-b', title: 'B' });
    const child = session({ id: 'child', title: 'Child', metadata: { parent_session_id: 'parent-a' } });
    const extra = {
      id: 'extra',
      type: 'parent' as const,
      source: 'parent-b',
      target: 'child',
      status: 'pending-multi-parent',
    };
    const merged = mergeGraphWithMapEdges(
      [parentA, parentB, child],
      [{ parent_session_id: 'parent-a', child_session_id: 'child' }],
      [extra],
    );
    expect(merged.visualEdges).toEqual([extra]);
    expect(merged.layoutEdges).toEqual([
      { parent_session_id: 'parent-a', child_session_id: 'child' },
    ]);
  });

  it('does not treat an unapplied extra job as live mount topology', () => {
    const parents = mapParentByChildFromEdges([
      { type: 'parent', source: 'live', target: 'child' },
      { type: 'parent', source: 'extra', target: 'child', status: 'pending-multi-parent' },
    ]);
    expect(parents.get('child')).toBe('live');
    expect(parents.size).toBe(1);
  });

  it('keeps the cached graph visible when graph refresh fails before sidebar sessions arrive', async () => {
    const cached = session({ id: 'cached-session', title: 'Cached session' });
    saveCachedMapGraph({ nodes: [cached], edges: [] });
    vi.spyOn(api.sessions, 'getGraph').mockRejectedValue(new Error('offline'));
    vi.spyOn(api.sessions, 'getAgents').mockResolvedValue({ items: [] });
    mockViewport();

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SessionMapPage, {
          sessions: [],
          onOpenSession: vi.fn(),
        })));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(container.querySelector('[data-session-id="cached-session"]')).not.toBeNull();
      expect(JSON.parse(localStorage.getItem(SESSION_MAP_GRAPH_CACHE_KEY) ?? '{}')).toMatchObject({
        nodes: [expect.objectContaining({ id: 'cached-session' })],
      });
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('ignores removed non-parent edge types', () => {
    const empty = { version: 2 as const, annotations: [], labels: [], sessionLabels: {} };
    const next = upsertTypedMapEdge(empty, { type: 'peer' as never, source: 'a', target: 'b' });
    expect(next.edges ?? []).toHaveLength(0);
  });

  it('disconnects from mapDoc parent edges even when metadata is missing', () => {
    const child = session({ id: 'child', title: 'Child' });
    const parent = session({ id: 'root', title: 'Root' });
    const caps = mapNodeCapabilities({ kind: 'session', session: child }, {
      sessions: [parent, child],
      mapEdges: [{ id: 'e1', type: 'parent', source: 'root', target: 'child' }],
    });
    expect(caps.canDisconnect).toBe(true);
    expect(caps.isTopLevel).toBe(false);
  });

  it('reconciles local parent edges to the server forest and drops stale links', () => {
    const doc = {
      version: 2 as const,
      annotations: [],
      labels: [],
      sessionLabels: {},
      edges: [
        { id: 'stale', type: 'parent' as const, source: 'old', target: 'child' },
      ],
    };
    const next = reconcileParentEdgesWithServer(doc, [
      { parent_session_id: 'root', child_session_id: 'child' },
      { parent_session_id: 'root', child_session_id: 'other' },
    ]);
    const parents = (next.edges ?? []).filter((edge) => edge.type === 'parent');
    expect(parents).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'root', target: 'child' }),
      expect.objectContaining({ source: 'root', target: 'other' }),
    ]));
    expect(parents).toHaveLength(2);
    expect(next.edges?.some((edge) => edge.source === 'old')).toBe(false);
  });

  it('keeps a local extra job while marking the server-confirmed job live', () => {
    const doc = {
      version: 2 as const,
      annotations: [],
      labels: [],
      sessionLabels: {},
      edges: [
        { id: 'live', type: 'parent' as const, source: 'old', target: 'child' },
        { id: 'extra', type: 'parent' as const, source: 'new', target: 'child', status: 'pending-multi-parent' },
      ],
    };
    const next = reconcileParentEdgesWithServer(doc, [
      { parent_session_id: 'old', child_session_id: 'child' },
    ]);
    const live = next.edges?.find((edge) => edge.source === 'old' && edge.target === 'child');
    const extra = next.edges?.find((edge) => edge.source === 'new' && edge.target === 'child');
    expect(live?.status).toBeUndefined();
    expect(extra?.status).toBe('pending-multi-parent');
  });

  it('keeps a failed job intent so the edge can be retried after refresh', () => {
    const doc = {
      version: 2 as const,
      annotations: [],
      labels: [],
      sessionLabels: {},
      edges: [{ id: 'failed', type: 'parent' as const, source: 'new', target: 'child', status: 'error' }],
    };
    const next = reconcileParentEdgesWithServer(doc, []);
    expect(next.edges).toEqual([
      expect.objectContaining({ source: 'new', target: 'child', status: 'error' }),
    ]);
  });

  it.skip('keeps a pending remount parent while the server still shows the old parent', () => {
    const doc = {
      version: 2 as const,
      annotations: [],
      labels: [],
      sessionLabels: {},
      edges: [{ id: 'e1', type: 'parent' as const, source: 'new', target: 'child' }],
      pendingTopology: [{
        id: 'pt1',
        kind: 'remount' as const,
        childSessionId: 'child',
        parentSessionId: 'new',
        queuedAt: new Date().toISOString(),
      }],
    };
    const next = reconcileParentEdgesWithServer(doc, [
      { parent_session_id: 'old', child_session_id: 'child' },
    ]);
    expect(next.edges).toEqual([
      expect.objectContaining({ source: 'new', target: 'child' }),
    ]);
  });
});

describe('redesigned conversation map contracts', () => {
  function ensurePointerEvents() {
    if (typeof globalThis.PointerEvent === 'undefined') {
      class TestPointerEvent extends MouseEvent {
        pointerId: number;
        pointerType: string;
        constructor(type: string, init: MouseEventInit & { pointerId?: number; pointerType?: string } = {}) {
          super(type, init);
          this.pointerId = init.pointerId ?? 1;
          this.pointerType = init.pointerType ?? 'mouse';
        }
      }
      vi.stubGlobal('PointerEvent', TestPointerEvent);
    }
    Element.prototype.setPointerCapture ??= function setPointerCapture() {};
    Element.prototype.releasePointerCapture ??= function releasePointerCapture() {};
  }

  async function render(
    nodes: Session[],
    edges: Array<{ child_session_id: string; parent_session_id: string }> = [],
    options?: { mapEdges?: SessionMapEdge[] },
  ) {
    vi.spyOn(api.sessions, 'getGraph').mockResolvedValue({ nodes, edges });
    vi.spyOn(api.sessions, 'getAgents').mockResolvedValue({ items: [] });
    vi.spyOn(api.sessions, 'getActivity').mockResolvedValue({ items: [] });
    vi.spyOn(api.sessions, 'getSnapshot').mockRejectedValue(new Error('snapshot unavailable'));
    vi.spyOn(api.approvals, 'list').mockResolvedValue({ items: [] });
    mockViewport();
    ensurePointerEvents();
    if (options?.mapEdges === undefined) {
      localStorage.removeItem('nori-session-map-doc');
    } else {
      localStorage.setItem('nori-session-map-doc', JSON.stringify({
        version: 2,
        annotations: [],
        labels: [],
        sessionLabels: {},
        edges: options.mapEdges,
      }));
    }
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(SessionMapPage, {
        sessions: nodes,
        onOpenSession: vi.fn(),
      })));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    return { container, root };
  }

  it('opens every session card through its own session id', async () => {
    const rootSession = session({ id: 'root', title: 'Root' });
    const child = session({ id: 'child', title: 'Child', metadata: { parent_session_id: 'root' } });
    const onOpen = vi.fn();
    vi.spyOn(api.sessions, 'getGraph').mockResolvedValue({
      nodes: [rootSession, child],
      edges: [{ parent_session_id: 'root', child_session_id: 'child' }],
    });
    vi.spyOn(api.sessions, 'getAgents').mockResolvedValue({ items: [] });
    mockViewport();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SessionMapPage, {
          sessions: [rootSession, child],
          onOpenSession: onOpen,
          onOpenAgent: vi.fn(),
        })));
        await Promise.resolve();
        await Promise.resolve();
      });
      const card = container.querySelector<HTMLElement>('[data-session-id="child"]');
      expect(card).not.toBeNull();
      await act(async () => { card!.click(); });
      expect(onOpen).toHaveBeenCalledWith('child');
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('keeps a child edge when a second parent job is added', () => {
    const doc = { version: 2 as const, annotations: [], labels: [], sessionLabels: {}, edges: [
      { id: 'first', type: 'parent' as const, source: 'a', target: 'child' },
    ] };
    const next = upsertParentMapEdge(doc, 'b', 'child', { role: 'reviewer' });
    expect(next.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'a', target: 'child' }),
      expect.objectContaining({ source: 'b', target: 'child', role: 'reviewer' }),
    ]));
  });

  it('labels a child with multiple jobs, including an unapplied extra job', async () => {
    const parent = session({ id: 'parent', title: 'Parent' });
    const other = session({ id: 'other', title: 'Other' });
    const child = session({
      id: 'child',
      title: 'Child',
      metadata: { parent_session_id: 'parent', mount_role: '审查' },
    });
    const { container, root } = await render([parent, other, child], [{
      parent_session_id: 'parent',
      child_session_id: 'child',
    }], {
      mapEdges: [
        { id: 'live', type: 'parent', source: 'parent', target: 'child', role: '审查' },
        { id: 'extra', type: 'parent', source: 'other', target: 'child', status: 'pending-multi-parent' },
      ],
    });
    try {
      const card = container.querySelector<HTMLElement>('[data-session-id="child"]');
      expect(card?.textContent).toMatch(/2 jobs|2 份工作/);
      expect(container.querySelector('path[data-parent-id="other"][data-child-id="child"]')?.getAttribute('data-edge-status')).toBe('pending-multi-parent');
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('exposes the parent, role, and responsibility when hovering a work edge', async () => {
    const parent = session({ id: 'parent', title: '审查组' });
    const child = session({ id: 'child', title: '检查员', metadata: { parent_session_id: 'parent' } });
    const { container, root } = await render([parent, child], [{
      parent_session_id: 'parent',
      child_session_id: 'child',
    }], {
      mapEdges: [{
        id: 'job',
        type: 'parent',
        source: 'parent',
        target: 'child',
        role: '审查',
        mandate: '检查变更',
      }],
    });
    try {
      const title = container.querySelector('svg.session-map-edges title');
      expect(title?.textContent).toContain('审查组');
      expect(title?.textContent).toContain('审查 · 检查变更');
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('keeps top-bar search collapsed to a magnifier until opened', async () => {
    const { container, root } = await render([session({ id: 'root', title: 'Root' })]);
    try {
      const chrome = container.querySelector('.session-map-float-top');
      expect(chrome).not.toBeNull();
      expect(container.querySelectorAll('.session-map-float-top')).toHaveLength(1);
      expect(container.querySelector('.session-map-search-toggle')).not.toBeNull();
      expect(container.querySelector('.session-map-search')).toBeNull();
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('expands search in the same top chrome instead of dropping a second bar', async () => {
    const { container, root } = await render([session({ id: 'root', title: 'Root' })]);
    try {
      await act(async () => {
        container.querySelector<HTMLButtonElement>('.session-map-search-toggle')!.click();
      });
      const input = container.querySelector('.session-map-float-top .session-map-search');
      expect(input).not.toBeNull();
      expect(container.querySelectorAll('.session-map-float-top')).toHaveLength(1);
      expect(container.querySelectorAll('.session-map-search')).toHaveLength(1);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('closes search with the clear button, Escape, and the magnifier toggle', async () => {
    const { container, root } = await render([session({ id: 'root', title: 'Root' })]);
    try {
      const toggle = () => container.querySelector<HTMLButtonElement>('.session-map-search-toggle')!;
      await act(async () => { toggle().click(); });
      expect(container.querySelector('.session-map-search')).not.toBeNull();
      await act(async () => {
        container.querySelector<HTMLButtonElement>('.session-map-search-clear')!.click();
      });
      expect(container.querySelector('.session-map-search')).toBeNull();

      await act(async () => { toggle().click(); });
      const input = container.querySelector<HTMLInputElement>('.session-map-search');
      expect(input).not.toBeNull();
      await act(async () => {
        input!.focus();
        input!.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }));
      });
      expect(container.querySelector('.session-map-search')).toBeNull();

      await act(async () => { toggle().click(); });
      expect(container.querySelector('.session-map-search')).not.toBeNull();
      await act(async () => { toggle().click(); });
      expect(container.querySelector('.session-map-search')).toBeNull();
      expect(container.querySelector('.session-map-search-toggle')).not.toBeNull();
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('Enter in search jumps to the next matching card', async () => {
    const { container, root } = await render([
      session({ id: 'alpha', title: 'Alpha review' }),
      session({ id: 'beta', title: 'Beta review' }),
    ]);
    try {
      await act(async () => {
        container.querySelector<HTMLButtonElement>('.session-map-search-toggle')!.click();
      });
      const input = container.querySelector<HTMLInputElement>('.session-map-search');
      expect(input).not.toBeNull();
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, 'review');
        input!.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(container.querySelectorAll('.session-map-node.search-match')).toHaveLength(2);
      await act(async () => {
        input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      });
      expect(container.querySelector('.session-map-node.search-match-current')).not.toBeNull();
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('remembers the first-use hint only after the user dismisses it', async () => {
    const hintKey = 'nori-session-map-first-use-hint';
    localStorage.removeItem(hintKey);
    const { container, root } = await render([session({ id: 'root', title: 'Root' })]);
    try {
      expect(container.querySelector('.session-map-first-use-hint')).not.toBeNull();
      expect(localStorage.getItem(hintKey)).toBeNull();
      await act(async () => {
        container.querySelector<HTMLButtonElement>('.session-map-first-use-hint button')!.click();
      });
      expect(container.querySelector('.session-map-first-use-hint')).toBeNull();
      expect(localStorage.getItem(hintKey)).toBe('1');
    } finally {
      localStorage.removeItem(hintKey);
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('ignores legacy peer and service edges when loading the map document', () => {
    const doc = parseSessionMapDoc(JSON.stringify({
      version: 2,
      annotations: [],
      labels: [],
      sessionLabels: {},
      edges: [
        { id: 'peer', type: 'peer', source: 'a', target: 'b' },
        { id: 'service', type: 'service', source: 'a', target: 'b' },
      ],
    }));
    expect(doc.edges).toEqual([]);
  });

  it('uses the mounted session id as the open target even when agent metadata is present', () => {
    const target = mapOpenTarget({
      kind: 'session',
      hostSessionId: 'root',
      session: session({ id: 'child', title: 'Child' }),
      agent: {
        agent_id: 'agent-1',
        kind: 'team',
        status: 'idle',
        mounted_session_id: 'different-session',
      },
    });
    expect(target).toEqual({ kind: 'session', sessionId: 'child' });
  });

  it('keeps the durable session when an agent overlay has the same mounted id', () => {
    const child = session({ id: 'child', title: 'Child' });
    const result = dedupeMapMembers([
      { kind: 'session', session: child },
      {
        kind: 'session',
        session: child,
        hostSessionId: 'parent',
        agent: { agent_id: 'member', kind: 'team', status: 'idle', mounted_session_id: 'child' },
      },
    ], [child]);
    expect(result).toHaveLength(1);
    expect(result[0]?.session.id).toBe('child');
    expect(result[0]?.agent?.agent_id).toBe('member');
  });

  it('does not turn a cached TeamCreate member without a Session into a map card', async () => {
    const rootSession = session({ id: 'root', title: 'Root' });
    saveCachedMapAgents([{
      hostId: 'root',
      agentId: 'ghost',
      title: 'Ghost member',
      mounted_session_id: 'missing-session',
    }]);
    vi.spyOn(api.sessions, 'getGraph').mockResolvedValue({ nodes: [rootSession], edges: [] });
    vi.spyOn(api.sessions, 'getAgents').mockResolvedValue({ items: [] });
    mockViewport();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SessionMapPage, {
          sessions: [rootSession],
          onOpenSession: vi.fn(),
        })));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(container.querySelectorAll('.session-map-node')).toHaveLength(1);
      expect(container.textContent).not.toContain('Ghost member');
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('uses normal wheel input for zooming', async () => {
    const { container, root } = await render([session({ id: 'a', title: 'A' })]);
    try {
      const stage = container.querySelector<HTMLElement>('.session-map-stage')!;
      const canvas = container.querySelector<HTMLElement>('.session-map-canvas')!;
      const before = canvas.style.transform;
      const beforeScale = /scale\(([-\d.]+)\)/.exec(before)?.[1];
      await act(async () => {
        stage.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120, clientX: 200, clientY: 120 }));
        await Promise.resolve();
      });
      const afterZoom = canvas.style.transform;
      expect(afterZoom).not.toBe(before);
      expect(/scale\(([-\d.]+)\)/.exec(afterZoom)?.[1]).not.toBe(beforeScale);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });
});
