import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type Session, type SessionAgent } from '../src/api/client';
import { fitTreeView, layoutTeamTree, TeamTreePage, zoomTreeView } from '../src/components/TeamTreePage';
import { I18nProvider } from '../src/i18n';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const agents: SessionAgent[] = [
  { agent_id: 'main', kind: 'main', name: 'main', status: 'idle' },
  { agent_id: 'l1', kind: 'team', parent_agent_id: 'main', name: 'L1', status: 'idle' },
  { agent_id: 'l1-b', kind: 'team', parent_agent_id: 'main', name: 'L1-B', status: 'idle' },
  { agent_id: 'l2', kind: 'team', parent_agent_id: 'l1', name: 'L2', status: 'idle' },
];

const session = { id: 'session-team', title: 'Team' } as unknown as Session;

/** 视口坐标 → transform 里的 translate/scale。 */
function readTransform(container: HTMLElement): { x: number; y: number; scale: number } {
  const transform = container.querySelector<HTMLElement>('.team-tree-canvas')?.style.transform ?? '';
  const [, x, y] = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(transform) ?? [];
  const [, scale] = /scale\(([\d.]+)\)/.exec(transform) ?? [];
  return { x: Number(x), y: Number(y), scale: Number(scale) };
}

describe('team tree view', () => {
  it('centers a small tree and only shrinks one too large for the viewport', () => {
    const centered = fitTreeView({ width: 400, height: 200 }, { width: 1000, height: 600 });
    expect(centered.scale).toBe(1);
    expect(centered.x).toBe(300);
    expect(centered.y).toBe(200);

    const shrunk = fitTreeView({ width: 2000, height: 400 }, { width: 1000, height: 600 });
    expect(shrunk.scale).toBeCloseTo(0.476, 3);
    // 缩放后仍水平居中。
    expect(shrunk.x).toBeCloseTo((1000 - 2000 * shrunk.scale) / 2, 3);

    // 竖直方向装不下时顶到上边留白，而不是把根节点切掉。
    const tall = fitTreeView({ width: 100, height: 4000 }, { width: 1000, height: 600 });
    expect(tall.y).toBe(24);
    // 没有内容或没有视口时不要产生 NaN。
    expect(fitTreeView({ width: 0, height: 0 }, { width: 0, height: 0 })).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it('keeps the pointer position fixed while zooming and clamps the scale', () => {
    const zoomed = zoomTreeView({ x: 0, y: 0, scale: 1 }, 2, 100, 50);
    expect(zoomed).toEqual({ x: -100, y: -50, scale: 2 });
    // 视口里的 (100,50) 仍指向同一个内容点。
    expect((100 - zoomed.x) / zoomed.scale).toBeCloseTo(100, 6);
    expect(zoomTreeView({ x: 0, y: 0, scale: 1 }, 99, 0, 0).scale).toBe(2.5);
    expect(zoomTreeView({ x: 0, y: 0, scale: 1 }, 0.01, 0, 0).scale).toBe(0.3);
  });

  it('lays the tree out with the root centered over its children', () => {
    const { placed, edges, width, height } = layoutTeamTree(agents);
    expect(placed.map(node => node.agent.agent_id)).toEqual(['main', 'l1', 'l1-b', 'l2']);
    const root = placed.find(node => node.agent.agent_id === 'main')!;
    const kids = placed.filter(node => node.agent.parent_agent_id === 'main');
    expect(root.cx).toBeCloseTo((kids[0]!.cx + kids[1]!.cx) / 2, 6);
    expect(edges).toHaveLength(3);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });

  it('pans on drag, zooms on wheel and recenters on double-click', async () => {
    vi.spyOn(api.sessions, 'getAgents').mockResolvedValue({ items: agents } as unknown as Awaited<ReturnType<typeof api.sessions.getAgents>>);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600, toJSON: () => ({}),
    });
    Object.assign(HTMLElement.prototype, { setPointerCapture: () => undefined, releasePointerCapture: () => undefined });

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(TeamTreePage, {
          session,
          onSelectAgent: vi.fn(),
        })));
        await Promise.resolve();
      });

      const viewport = container.querySelector<HTMLElement>('.team-tree-viewport')!;
      const centered = readTransform(container);
      // 默认居中：树比视口窄，所以 1:1 且左右留白相等。
      expect(centered.scale).toBe(1);
      expect(centered.x).toBeGreaterThan(0);

      const PointerEventCtor = (window as unknown as { PointerEvent?: typeof MouseEvent }).PointerEvent;
      const pointer = (type: string, x: number, y: number) => PointerEventCtor === undefined
        ? Object.assign(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }), { pointerId: 1 })
        : new PointerEventCtor(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
      await act(async () => { viewport.dispatchEvent(pointer('pointerdown', 500, 300)); });
      await act(async () => { viewport.dispatchEvent(pointer('pointermove', 560, 340)); });
      await act(async () => { viewport.dispatchEvent(pointer('pointerup', 560, 340)); });
      const panned = readTransform(container);
      expect(panned.x).toBeCloseTo(centered.x + 60, 3);
      expect(panned.y).toBeCloseTo(centered.y + 40, 3);

      await act(async () => { viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -200, clientX: 500, clientY: 300 })); });
      const zoomed = readTransform(container);
      expect(zoomed.scale).toBeGreaterThan(panned.scale);
      // 缩放围绕指针：视口 (500,300) 前后指向同一个内容点。
      expect((500 - zoomed.x) / zoomed.scale).toBeCloseTo((500 - panned.x) / panned.scale, 3);

      await act(async () => { viewport.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
      expect(readTransform(container)).toEqual(centered);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
