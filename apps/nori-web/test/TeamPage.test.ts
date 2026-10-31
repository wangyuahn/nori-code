import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Session, SessionAgent } from '../src/api/client';
import { departmentAgentsFromSessions } from '../src/App';
import { fitTreeView, layoutTeamTree, statusTone, TeamPage, teamRootAgent, zoomTreeView } from '../src/components/TeamPage';
import { I18nProvider } from '../src/i18n';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const lead: Session = {
  id: 'sess_lead',
  title: 'Lead',
  status: 'idle',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
  metadata: { cwd: '/work/demo' },
};

const reviewer: Session = {
  id: 'sess_reviewer',
  title: 'Reviewer',
  status: 'running',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-03T00:00:00.000Z',
  metadata: {
    parent_session_id: 'sess_lead',
    mount_name: 'Reviewer',
    mount_role: 'reviewer',
    mount_mandate: 'Review diffs',
  },
};

const writer: Session = {
  id: 'sess_writer',
  title: 'Writer',
  status: 'idle',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-04T00:00:00.000Z',
  metadata: { parent_session_id: 'sess_lead', mount_name: 'Writer', mount_role: 'writer' },
};

/** 视口坐标 → transform 里的 translate/scale。 */
function readTransform(container: HTMLElement): { x: number; y: number; scale: number } {
  const transform = container.querySelector<HTMLElement>('.team-tree-canvas')?.style.transform ?? '';
  const [, x, y] = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(transform) ?? [];
  const [, scale] = /scale\(([\d.]+)\)/.exec(transform) ?? [];
  return { x: Number(x), y: Number(y), scale: Number(scale) };
}

function stubViewport(): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600, toJSON: () => ({}),
  });
}

async function renderTeamPage(options: {
  session: Session | null;
  sessions: readonly Session[];
  onSelectAgent?: (sessionId: string, agent: SessionAgent) => void;
}): Promise<{ container: HTMLElement; root: ReturnType<typeof createRoot>; rerender: (session: Session | null) => Promise<void> }> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onSelectAgent = options.onSelectAgent ?? (() => undefined);
  const render = async (session: Session | null) => {
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(TeamPage, {
        session,
        members: departmentAgentsFromSessions(options.sessions, session),
        onSelectAgent,
      })));
      await Promise.resolve();
    });
  };
  await render(options.session);
  return { container, root, rerender: render };
}

describe('TeamPage', () => {
  it('lists only the current session members, not the whole session forest', async () => {
    const other: Session = {
      id: 'sess_other',
      title: 'Unrelated',
      status: 'idle',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      metadata: { cwd: '/work/other' },
    };
    const otherChild: Session = {
      ...other,
      id: 'sess_other_child',
      title: 'Other child',
      metadata: { parent_session_id: 'sess_other', mount_name: 'Other child' },
    };
    stubViewport();
    const { container, root } = await renderTeamPage({
      session: lead,
      sessions: [lead, reviewer, writer, other, otherChild],
    });

    const names = [...container.querySelectorAll('.team-node-name')].map(node => node.textContent);
    expect(names.some(name => name?.includes('Reviewer'))).toBe(true);
    expect(names.some(name => name?.includes('Writer'))).toBe(true);
    expect(names.some(name => name?.includes('Other child'))).toBe(false);
    expect(container.querySelector('.team-tree-empty')).toBeNull();

    await act(async () => { root.unmount(); });
  });

  it('swaps the tree when the active session changes', async () => {
    stubViewport();
    const { container, root, rerender } = await renderTeamPage({
      session: lead,
      sessions: [lead, reviewer, writer],
    });
    expect([...container.querySelectorAll('.team-node-name')].map(node => node.textContent))
      .toEqual(expect.arrayContaining(['Lead', 'Reviewer', 'Writer']));

    await rerender(reviewer);

    const names = [...container.querySelectorAll('.team-node-name')].map(node => node.textContent);
    // 切换后看到的是 Reviewer 所在的部门：自己和同父兄弟，而不是 Lead 的整棵树。
    expect(names).toEqual(expect.arrayContaining(['Reviewer', 'Writer']));
    const roots = [...container.querySelectorAll<HTMLElement>('.team-node')]
      .filter(node => node.querySelector('.team-node-name')?.textContent === 'Reviewer');
    expect(roots.length).toBeGreaterThan(0);

    await act(async () => { root.unmount(); });
  });

  it('shows an empty state instead of a lone root when the session has no members', async () => {
    stubViewport();
    const { container, root } = await renderTeamPage({ session: lead, sessions: [lead] });

    const empty = container.querySelector('.team-tree-empty');
    expect(empty).not.toBeNull();
    expect(container.querySelector('.team-tree-viewport')).toBeNull();
    expect(container.querySelectorAll('.team-node')).toHaveLength(0);

    await act(async () => { root.unmount(); });
  });

  it('asks for a session when none is active', async () => {
    const { container, root } = await renderTeamPage({ session: null, sessions: [lead, reviewer] });

    expect(container.querySelector('.team-tree-empty')?.textContent).toContain('Choose a session');
    expect(container.querySelectorAll('.team-node')).toHaveLength(0);

    await act(async () => { root.unmount(); });
  });

  it('reports the member and its hosting session when a node is clicked', async () => {
    stubViewport();
    const onSelectAgent = vi.fn();
    const { container, root } = await renderTeamPage({
      session: lead,
      sessions: [lead, reviewer, writer],
      onSelectAgent,
    });

    const node = [...container.querySelectorAll<HTMLElement>('.team-node')]
      .find(element => element.querySelector('.team-node-name')?.textContent === 'Reviewer');
    expect(node).toBeTruthy();
    await act(async () => { node!.click(); });

    expect(onSelectAgent).toHaveBeenCalledWith('sess_reviewer', expect.objectContaining({
      agent_id: 'sess_reviewer',
      mounted_session_id: 'sess_reviewer',
    }));

    await act(async () => { root.unmount(); });
  });

  it('opens the lead conversation from the root node, not a phantom main agent', async () => {
    stubViewport();
    const onSelectAgent = vi.fn();
    const { container, root } = await renderTeamPage({
      session: lead,
      sessions: [lead, reviewer, writer],
      onSelectAgent,
    });

    const rootNode = container.querySelector<HTMLElement>('.team-node.root');
    expect(rootNode).toBeTruthy();
    await act(async () => { rootNode!.click(); });

    // 根节点用会话 id 作为 agent id（成员的 parent_agent_id 指向它），但它仍是
    // main 类型，所以点击应当回到这个会话的主对话，而不是去选一个子智能体。
    expect(onSelectAgent).toHaveBeenCalledWith('sess_lead', expect.objectContaining({
      agent_id: 'sess_lead',
      kind: 'main',
    }));

    await act(async () => { root.unmount(); });
  });
});

describe('TeamPage tree math', () => {
  it('centers a small tree and only shrinks one too large for the viewport', () => {
    const centered = fitTreeView({ width: 400, height: 200 }, { width: 1000, height: 600 });
    expect(centered.scale).toBe(1);
    expect(centered.x).toBe(300);
    expect(centered.y).toBe(200);

    const shrunk = fitTreeView({ width: 2000, height: 400 }, { width: 1000, height: 600 });
    expect(shrunk.scale).toBeCloseTo(0.476, 3);
    expect(shrunk.x).toBeCloseTo((1000 - 2000 * shrunk.scale) / 2, 3);

    // 竖直方向装不下时顶到上边留白，而不是把根节点切掉。
    const tall = fitTreeView({ width: 100, height: 4000 }, { width: 1000, height: 600 });
    expect(tall.y).toBe(24);
    expect(fitTreeView({ width: 0, height: 0 }, { width: 0, height: 0 })).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it('keeps the pointer position fixed while zooming and clamps the scale', () => {
    const zoomed = zoomTreeView({ x: 0, y: 0, scale: 1 }, 2, 100, 50);
    expect(zoomed).toEqual({ x: -100, y: -50, scale: 2 });
    expect((100 - zoomed.x) / zoomed.scale).toBeCloseTo(100, 6);
    expect(zoomTreeView({ x: 0, y: 0, scale: 1 }, 99, 0, 0).scale).toBe(2.5);
    expect(zoomTreeView({ x: 0, y: 0, scale: 1 }, 0.01, 0, 0).scale).toBe(0.3);
  });

  it('centers the root over its member columns and never invented a root', () => {
    const rootAgent = teamRootAgent(lead);
    const children = departmentAgentsFromSessions([lead, reviewer, writer], lead);
    const { placed, edges, width } = layoutTeamTree([rootAgent, ...children], lead.id);

    expect(placed.map(node => node.agent.agent_id).sort())
      .toEqual(['sess_lead', 'sess_reviewer', 'sess_writer']);
    const root = placed.find(node => node.agent.agent_id === lead.id)!;
    const kids = placed.filter(node => node.agent.parent_agent_id === lead.id);
    expect(kids).toHaveLength(2);
    expect(root.cx).toBeCloseTo((kids[0]!.cx + kids[1]!.cx) / 2, 6);
    expect(edges).toHaveLength(2);
    expect(width).toBeGreaterThan(0);

    // 根节点不在输入里就返回空布局，不替调用方猜一个根。
    expect(layoutTeamTree(children, lead.id)).toEqual({ placed: [], edges: [], width: 0, height: 0 });
  });

  it('maps agent status onto the legend tones', () => {
    const base: SessionAgent = { agent_id: 'a', kind: 'team', status: 'idle' };
    expect(statusTone(base)).toBe('idle');
    expect(statusTone({ ...base, status: 'running' })).toBe('running');
    expect(statusTone({ ...base, status: 'awaiting_approval' })).toBe('attention');
    expect(statusTone({ ...base, status: 'awaiting_question' })).toBe('attention');
    expect(statusTone({ ...base, status: 'running', archived: true })).toBe('muted');
  });
});
