import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forceSimulation, forceX, forceY } from 'd3-force';
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
  REARRANGE_SETTLE_MS,
  resolveMapNodeSpawnPosition,
  resolveNodeDragGroupIds,
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
} from '../src/components/SessionMapPage';
import {
  mapNodeCapabilities,
  mapStatusDotClass,
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
  SESSION_MAP_AGENTS_CACHE_KEY,
} from '../src/components/sessionMapDoc';
import { sessionsForSidebar, wouldCreateMountCycle } from '../src/utils/session-mount';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.removeItem('nori-session-map-doc');
  localStorage.removeItem(SESSION_MAP_AGENTS_CACHE_KEY);
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

  it('resolves project cwd from session metadata, falling back to host for agent ghosts', () => {
    const root = session({ id: 'root', title: 'Root', metadata: { cwd: '/home/user/nori-code' } });
    const child = session({
      id: 'child',
      title: 'Child',
      metadata: { parent_session_id: 'root', cwd: '/home/user/other-app' },
    });
    const ghost = session({
      id: 'agent:root:a1',
      title: 'Reviewer',
      metadata: { parent_session_id: 'root', mount_role: 'reviewer' },
    });
    const byId = new Map([['root', root], ['child', child]]);
    expect(memberProjectCwd({ kind: 'session', session: root }, byId)).toBe('/home/user/nori-code');
    expect(memberProjectCwd({ kind: 'session', session: child }, byId)).toBe('/home/user/other-app');
    expect(memberProjectCwd({
      kind: 'agent',
      session: ghost,
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

  it('hangs agent-only members under their host session', () => {
    const nodes = [session({ id: 'root', title: 'Root' })];
    const { placed, edges } = layoutSessionMountForest(
      { nodes, edges: [] },
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
        },
      }],
    );
    expect(placed).toHaveLength(2);
    expect(edges).toHaveLength(1);
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
  it('renders float chrome + empty stage with zero sessions (no throw)', async () => {
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
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('renders list + canvas and opens a session on click', async () => {
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
      expect(onOpen).toHaveBeenCalled();
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('shows project folder from metadata.cwd on map nodes', async () => {
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

  it('shows host project on agent ghosts when the ghost has no cwd', async () => {
    const nodes = [session({ id: 'a', title: 'Alpha', metadata: { cwd: '/work/demo-app' } })];
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
      expect(memberNode!.querySelector('.session-map-port-in')).toBeNull();
      expect(memberNode!.querySelector('.session-map-port-out')).toBeNull();
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

  it('opens agent-only members through onOpenAgent without creating sessions', async () => {
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

      expect(container.textContent).toContain('Reviewer');
      const memberNode = [...container.querySelectorAll<HTMLElement>('.session-map-node')]
        .find((el) => el.textContent?.includes('Reviewer'));
      expect(memberNode).toBeTruthy();
      await act(async () => { memberNode!.click(); });
      expect(onOpenAgent).toHaveBeenCalledWith('a', expect.objectContaining({ agent_id: 'member_1' }));
      expect(api.sessions.createChild).not.toHaveBeenCalled();
      expect(onOpenSession).not.toHaveBeenCalled();
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('opens mounted members through the owning host agent', async () => {
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
      await act(async () => { memberNode!.click(); });
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

  it('opens mounted child via onOpenSession when getAgents returns no agent', async () => {
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
      await act(async () => { childNode!.click(); });
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

  it('shows blueprint ports and parent name on mounted children', async () => {
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

  it('wires createChild under the OUT-port source session, not activeSessionId', async () => {
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

  it('right-click offers unmount and delete for mounted and top-level nodes', async () => {
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

  it('enables ambient child tidy home-pull (not link clustering)', () => {
    expect(SESSION_MAP_AMBIENT_HOME_GRAVITY).toBe(true);
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
    })).toEqual({ x: 100, y: 200 + 96 + 64 });
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
    expect(members[0]!.session.id).toBe('agent:host:a1');
    saveCachedMapAgents(cachedAgentsFromMapMembers(members));
    expect(loadCachedMapAgents()).toEqual(expect.arrayContaining([
      expect.objectContaining({ hostId: 'host', agentId: 'a1', title: 'Reviewer' }),
    ]));
    expect(parseCachedMapAgents('{')).toEqual([]);
    localStorage.removeItem(SESSION_MAP_AGENTS_CACHE_KEY);
  });

  it('LMB marquee selects; right-click selection Annotate persists a note', async () => {
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
    props: { onOpenSession?: (id: string) => void; onOpenAgent?: never; activeSessionId?: string } = {},
    options: { keepMapDoc?: boolean } = {},
  ): Promise<RenderedMap> {
    vi.spyOn(api.sessions, 'getGraph').mockResolvedValue({ nodes, edges });
    vi.spyOn(api.sessions, 'getAgents').mockResolvedValue({ items: [] });
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
      const maxRight = Math.max(...cards.map((el) => Number.parseFloat(el.style.left) + 220));
      const maxBottom = Math.max(...cards.map((el) => Number.parseFloat(el.style.top) + 96));
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

  it('(a) OUT wire dropped on empty canvas: trailing click does NOT open the source node, draft appears before createChild', async () => {
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

  it('(d) clicking a port without dragging never opens the node; the next real click still works', async () => {
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
      expect(onOpenSession).toHaveBeenCalledWith('a');
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it('(e) background graph polling never fires while an identity draft is open', async () => {
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

  it('(f) wheel zooms (never pans); Ctrl+wheel also zooms', async () => {
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
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 2,
          clientX: 200, clientY: 200, pointerId: 5, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true, button: 2,
          clientX: 260, clientY: 240, pointerId: 5, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, button: 2,
          clientX: 260, clientY: 240, pointerId: 5, pointerType: 'mouse',
        }));
      });
      const after = map.canvasTransform();
      expect(after.scale).toBe(before.scale);
      expect(Math.abs(after.x - (before.x + 60))).toBeLessThanOrEqual(2);
      expect(Math.abs(after.y - (before.y + 40))).toBeLessThanOrEqual(2);
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it('(g) the error banner can be dismissed', async () => {
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

  it('(h) Alt+click on a mounted child IN port asks before unmounting; top-level gives feedback', async () => {
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

  it('(i) deleting a session with mounted children warns that children promote to top level', async () => {
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

  it('(m) client-side cycle precheck blocks mount before API', async () => {
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

  it('(o) sticky mount errors survive a successful graph poll until dismissed', async () => {
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

  it('(p) near-miss drop shows error instead of create-new draft', async () => {
    const nodes = [session({ id: 'a', title: 'Alpha' })];
    vi.spyOn(api.sessions, 'getGraph').mockResolvedValue({ nodes, edges: [] });
    vi.spyOn(api.sessions, 'getAgents').mockResolvedValue({
      items: [{
        agent_id: 'ghost',
        kind: 'team',
        name: 'Ghost member',
        status: 'idle',
      }],
    });
    const createChild = vi.spyOn(api.sessions, 'createChild');
    const mount = vi.spyOn(api.sessions, 'mount');
    mockViewport();
    stubPointerEvents();
    localStorage.removeItem('nori-session-map-doc');
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
    try {
      const cards = [...container.querySelectorAll<HTMLElement>('.session-map-node')];
      expect(cards.length).toBeGreaterThanOrEqual(2);
      const aCard = cards.find((el) => el.dataset.sessionId === 'a')!;
      const ghostCard = cards.find((el) => el.textContent?.includes('Ghost'))!;
      const canvas = container.querySelector<HTMLElement>('.session-map-canvas')!;
      const match = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px,\s*0\)\s*scale\(([-\d.]+)\)/.exec(canvas.style.transform)!;
      const viewX = Number(match[1]);
      const viewY = Number(match[2]);
      const scale = Number(match[3]);
      const ghostCx = Number.parseFloat(ghostCard.style.left) + 110;
      const ghostCy = Number.parseFloat(ghostCard.style.top) + 48;
      const nearMiss = {
        x: (ghostCx + 44) * scale + viewX,
        y: ghostCy * scale + viewY,
      };
      const outPort = aCard.querySelector<HTMLElement>('.session-map-port-out')!;
      await dragWire(outPort, nearMiss, 35);
      expect(createChild).not.toHaveBeenCalled();
      expect(mount).not.toHaveBeenCalled();
      expect(container.querySelector('.session-map-draft-node')).toBeNull();
      expect(container.querySelector('.session-map-error')).not.toBeNull();
      expect(container.textContent).toMatch(/missed the node|未命中|real session|真实会话/);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
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

  it('(j2) batch delete confirms count and calls API for each selected session', async () => {
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

  it('(j3) rearrange tidies intra-component layout without moving the group anchor', async () => {
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
      // Child kept at group translation but pulled sideways — internal layout is messy.
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
      const beforeRoot = Number.parseFloat(map.card('root').style.left);
      const messyChildLeft = Math.round(messyChildCenterX - 110);
      const rearrangeBtn = [...map.container.querySelectorAll('button')].find((el) => (
        /Rearrange|规整/.test(el.textContent ?? '')
      ));
      expect(rearrangeBtn).toBeTruthy();
      await act(async () => { rearrangeBtn!.click(); });
      // finishRearrange hard-snaps on the settle timer — no RAF dependency.
      await act(async () => {
        await new Promise((resolve) => { window.setTimeout(resolve, REARRANGE_SETTLE_MS + 50); });
        await Promise.resolve();
        await Promise.resolve();
      });
      const afterRoot = Number.parseFloat(map.card('root').style.left);
      const afterChild = Number.parseFloat(map.card('child').style.left);
      expect(Math.abs(afterRoot - beforeRoot)).toBeLessThanOrEqual(8);
      // Child leaves the intentional messy offset toward tidy under the live root.
      expect(Math.abs(afterChild - messyChildLeft)).toBeGreaterThan(40);
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

  it('(j5) unpinned children soft-settle under a pinned root (intra gravity)', () => {
    // Deterministic: drive the same home forces the map uses, via sync ticks
    // (live RAF settle is poisoned by prior fake-timer tests / jsdom scheduling).
    expect(SESSION_MAP_AMBIENT_HOME_GRAVITY).toBe(true);
    expect(HOME_PULL_STRENGTH).toBeGreaterThan(0.1);

    const seeds = new Map([
      ['session:root', { x: 100, y: 100 }],
      ['session:child', { x: 100, y: 260 }],
    ]);
    const index = buildMapComponents(
      [
        { id: 'session:root', member: { kind: 'session', session: session({ id: 'root' }) } },
        { id: 'session:child', member: { kind: 'session', session: session({ id: 'child', metadata: { parent_session_id: 'root' } }) } },
      ],
      [{ source: 'session:root', target: 'session:child' }],
    );
    expect(isComponentRootPin('session:root', index)).toBe(true);
    expect(isComponentRootPin('session:child', index)).toBe(false);

    const rootPos = { x: 100, y: 100 };
    const childStartX = 100 + 280;
    const homeOf = (id: string) => tidyComponentAroundRoot({
      rootNodeId: 'session:root',
      nodeIds: ['session:root', 'session:child'],
      rootPosition: rootPos,
      seeds,
    }).get(id)!;

    const nodes = [
      { id: 'session:root', x: rootPos.x, y: rootPos.y, fx: rootPos.x, fy: rootPos.y },
      { id: 'session:child', x: childStartX, y: 260, fx: null as number | null, fy: null as number | null },
    ];
    const sim = forceSimulation(nodes)
      .force('homeX', forceX<typeof nodes[number]>((node) => homeOf(node.id).x).strength((node) => (
        isComponentRootPin(node.id, index) ? 0 : HOME_PULL_STRENGTH
      )))
      .force('homeY', forceY<typeof nodes[number]>((node) => homeOf(node.id).y).strength((node) => (
        isComponentRootPin(node.id, index) ? 0 : HOME_PULL_STRENGTH
      )))
      .stop();
    sim.tick(80);

    expect(Math.abs((nodes[0]!.x ?? 0) - rootPos.x)).toBeLessThanOrEqual(4);
    expect(nodes[1]!.x ?? 0).toBeLessThan(childStartX - 30);
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

  it('right-click empty canvas creates a top-level session', async () => {
    const nodes = [session({ id: 'a', title: 'Alpha', metadata: { cwd: '/tmp/proj' } })];
    const create = vi.spyOn(api.sessions, 'create').mockResolvedValue(
      session({ id: 'created', title: 'Created', metadata: { cwd: '/tmp/proj' } }),
    );
    const map = await renderMap(nodes, [], { onOpenSession: vi.fn() });
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
      expect(create).toHaveBeenCalled();
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it('right-button click (pointerdown/up, no contextmenu) still creates a top-level session', async () => {
    const nodes = [session({ id: 'a', title: 'Alpha', metadata: { cwd: '/tmp/proj' } })];
    const create = vi.spyOn(api.sessions, 'create').mockResolvedValue(
      session({ id: 'created', title: 'Created', metadata: { cwd: '/tmp/proj' } }),
    );
    const map = await renderMap(nodes, [], { onOpenSession: vi.fn() });
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
      expect(create).toHaveBeenCalledWith({ cwd: '/tmp/proj', smart_title: true });
    } finally {
      await act(async () => { map.root.unmount(); });
      map.container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it('node context menu creates a child session through the identity draft', async () => {
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

  it('label chips filter canvas nodes as well as the list', async () => {
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

  it('label chips keep unlabeled ancestors of matching mounted children', async () => {
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

  it('Shift+drag between session cards draws a local peer edge', async () => {
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

  it('queues unmount while the child session is running', async () => {
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
    // IN port at (200, 200 - 48) = (200, 152) for NODE_H=96
    const hit = hitSessionMapNode(nodes, 200, 152, { preferPort: 'in' });
    expect(hit?.id).toBe('n1');
    const nearMiss = hitSessionMapNode(nodes, 200, 152 - 30, { preferPort: 'in', portRadius: 36 });
    expect(nearMiss?.id).toBe('n1');
    const far = hitSessionMapNode(nodes, 200, 152 - 80, { preferPort: 'in', portRadius: 36 });
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

  it('peer wires ignore mount cycles so a child can link back to its parent', () => {
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
  it('grants self-bootstrap and wire-out only to top-level real sessions', () => {
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
    expect(topCaps.canSelfBootstrapRole).toBe(true);
    expect(topCaps.canWireOut).toBe(true);
    expect(topCaps.canMountOthers).toBe(true);
    expect(topCaps.displayTier).toBe('top');
    expect(childCaps.canSelfBootstrapRole).toBe(false);
    expect(childCaps.canDisconnect).toBe(true);
    expect(childCaps.canWireIn).toBe(true);
    expect(childCaps.displayTier).toBe('mounted');
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

  it('replaces stale parent edges on remount upsert', () => {
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
    expect(next.edges).toHaveLength(1);
    expect(next.edges![0]!.source).toBe('new-parent');
    expect(next.edges![0]!.target).toBe('child');
  });

  it('peer upsert treats A→B and B→A as the same undirected edge', () => {
    const empty = { version: 2 as const, annotations: [], labels: [], sessionLabels: {} };
    const ab = upsertTypedMapEdge(empty, { type: 'peer', source: 'a', target: 'b' });
    const ba = upsertTypedMapEdge(ab, { type: 'peer', source: 'b', target: 'a' });
    const peers = (ba.edges ?? []).filter((edge) => edge.type === 'peer');
    expect(peers).toHaveLength(1);
    expect(peers[0]).toMatchObject({ source: 'b', target: 'a' });
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

  it('reconciles local parent edges to the server forest and keeps peer links', () => {
    const doc = {
      version: 2 as const,
      annotations: [],
      labels: [],
      sessionLabels: {},
      edges: [
        { id: 'stale', type: 'parent' as const, source: 'old', target: 'child' },
        { id: 'peer1', type: 'peer' as const, source: 'a', target: 'b' },
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
    expect(next.edges?.some((edge) => edge.id === 'peer1' && edge.type === 'peer')).toBe(true);
  });

  it('keeps a pending remount parent while the server still shows the old parent', () => {
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
