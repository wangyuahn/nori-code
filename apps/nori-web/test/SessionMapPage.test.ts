import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type Session } from '../src/api/client';
import {
  centerViewOnNode,
  findNearestValidWireTarget,
  fitTreeView,
  hitSessionMapNode,
  HOME_PULL_STRENGTH,
  isValidWireTarget,
  SESSION_MAP_AMBIENT_HOME_GRAVITY,
  layoutSessionMountForest,
  nearestSessionMapNodeDistance,
  parentSessionIdOf,
  SessionMapPage,
  snapMapView,
  wireSourceParentSessionId,
  zoomTreeView,
} from '../src/components/SessionMapPage';
import { I18nProvider } from '../src/i18n';
import { sessionsForSidebar, wouldCreateMountCycle } from '../src/utils/session-mount';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

  it('does not link a stale agent from another host to a mounted session', () => {
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
    expect(placed.some((node) => node.member.agent?.agent_id === 'stale_member')).toBe(true);
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

  it('adds an empty UE note box behind the canvas', async () => {
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

      const notesBtn = [...container.querySelectorAll('button')].find((el) => el.textContent?.includes('Notes'));
      expect(notesBtn).toBeTruthy();
      await act(async () => { notesBtn!.click(); });
      const addBtn = [...container.querySelectorAll('button')].find((el) => el.textContent?.includes('Add note'));
      expect(addBtn).toBeTruthy();
      await act(async () => { addBtn!.click(); });

      expect(container.querySelector('.session-map-annotation')).not.toBeNull();
      expect(container.textContent).toContain('Empty box');
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      localStorage.removeItem('nori-session-map-doc');
    }
  });

  it('polls the session graph periodically while mounted', async () => {
    vi.useFakeTimers();
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
    } finally {
      confirm.mockRestore();
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('keeps ambient home-slot gravity disabled', () => {
    expect(HOME_PULL_STRENGTH).toBe(0);
    expect(SESSION_MAP_AMBIENT_HOME_GRAVITY).toBe(false);
  });

  it('Notes-mode drag creates an annotation; Shift+drag only selects', async () => {
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

      // Shift-only: select, no annotation.
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0, shiftKey: true,
          clientX: 40, clientY: 40, pointerId: 3, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true, shiftKey: true,
          clientX: 320, clientY: 220, pointerId: 3, pointerType: 'mouse',
        }));
      });
      expect(container.querySelector('.session-map-marquee')).not.toBeNull();
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, button: 0, shiftKey: true,
          clientX: 320, clientY: 220, pointerId: 3, pointerType: 'mouse',
        }));
      });
      expect(container.querySelector('.session-map-annotation')).toBeNull();

      const notesBtn = [...container.querySelectorAll('button')].find((el) => (
        /Notes|注释框/.test(el.textContent ?? '')
      ));
      expect(notesBtn).toBeTruthy();
      await act(async () => { notesBtn!.click(); });

      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0,
          clientX: 40, clientY: 40, pointerId: 4, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true,
          clientX: 320, clientY: 220, pointerId: 4, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, button: 0,
          clientX: 320, clientY: 220, pointerId: 4, pointerType: 'mouse',
        }));
      });
      expect(container.querySelector('.session-map-annotation')).not.toBeNull();
      expect(container.querySelector('.session-map-note-editor')).not.toBeNull();
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
  ): Promise<RenderedMap> {
    vi.spyOn(api.sessions, 'getGraph').mockResolvedValue({ nodes, edges });
    vi.spyOn(api.sessions, 'getAgents').mockResolvedValue({ items: [] });
    mockViewport();
    stubPointerEvents();
    localStorage.removeItem('nori-session-map-doc');
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
    vi.useFakeTimers();
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

  it('(f) wheel pans without Ctrl and zooms with Ctrl (trackpad vs pinch)', async () => {
    const nodes = [session({ id: 'a', title: 'Alpha' })];
    const map = await renderMap(nodes, [], { onOpenSession: vi.fn() });
    try {
      const stage = map.container.querySelector<HTMLElement>('.session-map-stage');
      expect(stage).toBeTruthy();
      const before = map.canvasTransform();
      await act(async () => {
        stage!.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true, cancelable: true, deltaX: 30, deltaY: 40,
        }));
      });
      const panned = map.canvasTransform();
      expect(panned.scale).toBe(before.scale);
      expect(Math.abs(panned.x - (before.x - 30))).toBeLessThanOrEqual(1.5);
      expect(Math.abs(panned.y - (before.y - 40))).toBeLessThanOrEqual(1.5);

      await act(async () => {
        stage!.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100,
          clientX: 500, clientY: 300,
        }));
      });
      const zoomed = map.canvasTransform();
      expect(zoomed.scale).toBeGreaterThan(panned.scale);
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
    vi.useFakeTimers();
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

  it('(j) Escape clears the marquee selection', async () => {
    const nodes = [session({ id: 'a', title: 'Alpha' }), session({ id: 'b', title: 'Beta' })];
    const map = await renderMap(nodes, [], { onOpenSession: vi.fn() });
    try {
      const stage = map.container.querySelector<HTMLElement>('.session-map-stage');
      const target = map.clientPointOf('a');
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0, shiftKey: true,
          clientX: target.x - 160, clientY: target.y - 90, pointerId: 3, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true, shiftKey: true,
          clientX: target.x + 160, clientY: target.y + 90, pointerId: 3, pointerType: 'mouse',
        }));
      });
      await act(async () => {
        stage!.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, button: 0, shiftKey: true,
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
});

describe('wire parent helpers', () => {
  it('captures real session id from the wire source member, never agent ghosts', () => {
    expect(wireSourceParentSessionId({
      kind: 'session',
      session: session({ id: 'b', title: 'Beta' }),
    })).toBe('b');
    expect(wireSourceParentSessionId({
      kind: 'agent',
      hostSessionId: 'host',
      session: session({ id: 'agent:host:m1', title: 'Ghost' }),
      agent: { agent_id: 'm1', kind: 'team', name: 'Ghost', status: 'idle' },
    })).toBeNull();
    // Stale mounted_session_id UUID on an agent ghost must still be non-wireable.
    expect(wireSourceParentSessionId({
      kind: 'agent',
      hostSessionId: 'host',
      session: session({
        id: '11111111-1111-4111-8111-111111111111',
        title: 'Stale UUID ghost',
      }),
      agent: {
        agent_id: 'ghost',
        kind: 'team',
        name: 'Ghost',
        status: 'idle',
        mounted_session_id: '11111111-1111-4111-8111-111111111111',
      },
    })).toBeNull();
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
});
