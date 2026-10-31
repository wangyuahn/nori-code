/**
 * 团队页：只看当前会话的团队。
 *
 * 数据来自会话森林里当前会话的那一段——它自己的子成员，加上同父兄弟，
 * 所以每个对话看到的是各自独立的团队，而不是整棵全局地图。
 * 布局是 tidy-tree：叶子按序占列，父节点居中于子节点之上；
 * 连接线横平竖直，卡片简约扁平。
 */

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import '../styles/session-team.css';
import type { Session, SessionAgent } from '../api/client';
import { useI18n } from '../i18n';
import { parentSessionIdOf } from '../utils/session-mount';
import { discussionSpeakingAgentIds } from '../utils/team-discussion';
import { Icon } from './Icon';

const NODE_W = 212;
const NODE_H = 94;
const GAP_X = 26;
const GAP_Y = 58;
const CANVAS_PAD = 40;
const MIN_SCALE = 0.3;
const MAX_SCALE = 2.5;

/** 画布视图：内容坐标经 translate + scale 映射到视口。 */
export interface TreeView {
  x: number;
  y: number;
  scale: number;
}

/**
 * 把整棵树摆到视口正中：小树按 1:1 居中，大树缩到刚好放得下（只缩不放）。
 * 树是从上往下长的，所以竖直方向装不下时顶到上边留一点余量，而不是切掉根。
 */
export function fitTreeView(content: { width: number; height: number }, viewport: { width: number; height: number }): TreeView {
  if (viewport.width <= 0 || viewport.height <= 0 || content.width <= 0 || content.height <= 0) {
    return { x: 0, y: 0, scale: 1 };
  }
  const margin = 24;
  const scale = Math.max(MIN_SCALE, Math.min(1, (viewport.width - margin * 2) / content.width, (viewport.height - margin * 2) / content.height));
  const scaledWidth = content.width * scale;
  const scaledHeight = content.height * scale;
  return {
    x: (viewport.width - scaledWidth) / 2,
    y: scaledHeight + margin * 2 > viewport.height ? margin : (viewport.height - scaledHeight) / 2,
    scale,
  };
}

/** 以视口里某个点为不动点缩放，和记忆图谱的手感一致。 */
export function zoomTreeView(view: TreeView, nextScale: number, centerX: number, centerY: number): TreeView {
  const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, nextScale));
  return {
    scale,
    x: centerX - (centerX - view.x) * (scale / view.scale),
    y: centerY - (centerY - view.y) * (scale / view.scale),
  };
}

interface PlacedNode {
  agent: SessionAgent;
  /** Left edge, px. */
  x: number;
  /** Top edge, px. */
  y: number;
  /** Horizontal center, px. */
  cx: number;
}

export type StatusTone = 'running' | 'attention' | 'idle' | 'muted';

export function statusTone(agent: SessionAgent): StatusTone {
  if (agent.archived === true) return 'muted';
  switch (agent.status) {
    case 'running':
      return 'running';
    case 'awaiting_approval':
    case 'awaiting_question':
      return 'attention';
    default:
      return 'idle';
  }
}

function statusText(agent: SessionAgent): string {
  switch (agent.status) {
    case 'running':
      return 'working';
    default:
      return agent.status || 'idle';
  }
}

/**
 * Tidy-tree placement: leaves take columns left-to-right in DFS order and a
 * parent centers over its children. `rootAgentId` is the current session's own
 * node, so a tree whose root is missing renders nothing instead of guessing.
 *
 * Members carry their leader's *session* id in `parent_agent_id`, which is not
 * the root node's own id, and a session that is itself a member has siblings
 * parented to its parent. `rootAliases` names those ids so both hang under the
 * root instead of being dropped as orphans.
 */
export function layoutTeamTree(
  agents: readonly SessionAgent[],
  rootAgentId: string,
  rootAliases: readonly string[] = [],
): {
  placed: PlacedNode[];
  edges: Array<{ from: PlacedNode; to: PlacedNode }>;
  width: number;
  height: number;
} {
  const visible = agents.filter(agent => typeof agent.agent_id === 'string');
  const root = visible.find(agent => agent.agent_id === rootAgentId);
  if (root === undefined) {
    return { placed: [], edges: [], width: 0, height: 0 };
  }
  const rootIds = new Set([rootAgentId, ...rootAliases]);
  const childrenOf = new Map<string, SessionAgent[]>();
  for (const agent of visible) {
    if (agent.agent_id === rootAgentId) continue;
    // 没有 parent 的成员默认挂到根（当前会话）下面。
    const declaredParent = agent.parent_agent_id ?? rootAgentId;
    const parentId = rootIds.has(declaredParent) ? rootAgentId : declaredParent;
    if (parentId !== rootAgentId && !visible.some(candidate => candidate.agent_id === parentId)) continue;
    const list = childrenOf.get(parentId) ?? [];
    list.push(agent);
    childrenOf.set(parentId, list);
  }

  // 叶子按 DFS 顺序占列；父节点水平居中于其子节点。
  const nodeByAgent = new Map<string, PlacedNode>();
  const kidIdsByParent = new Map<string, string[]>();
  const placed: PlacedNode[] = [];
  let nextColumn = 0;
  let maxDepth = 0;
  const place = (agent: SessionAgent, depth: number): PlacedNode => {
    maxDepth = Math.max(maxDepth, depth);
    const kids = [...(childrenOf.get(agent.agent_id) ?? [])].sort((a, b) => a.agent_id.localeCompare(b.agent_id));
    let cx: number;
    if (kids.length === 0) {
      cx = nextColumn * (NODE_W + GAP_X) + NODE_W / 2;
      nextColumn += 1;
    } else {
      const kidNodes = kids.map(kid => place(kid, depth + 1));
      cx = (kidNodes[0]!.cx + kidNodes[kidNodes.length - 1]!.cx) / 2;
    }
    const node: PlacedNode = { agent, x: cx - NODE_W / 2, y: depth * (NODE_H + GAP_Y), cx };
    placed.push(node);
    nodeByAgent.set(agent.agent_id, node);
    kidIdsByParent.set(agent.agent_id, kids.map(kid => kid.agent_id));
    return node;
  };
  place(root, 0);

  const edges: Array<{ from: PlacedNode; to: PlacedNode }> = [];
  for (const [parentId, kidIds] of kidIdsByParent) {
    const from = nodeByAgent.get(parentId);
    if (from === undefined) continue;
    for (const kidId of kidIds) {
      const to = nodeByAgent.get(kidId);
      if (to !== undefined) edges.push({ from, to });
    }
  }

  const columns = Math.max(nextColumn, 1);
  return {
    placed: [...placed].sort((a, b) => a.y - b.y || a.x - b.x),
    edges,
    width: columns * (NODE_W + GAP_X),
    height: (maxDepth + 1) * (NODE_H + GAP_Y),
  };
}

/**
 * 当前会话在树里的代表节点。它用会话 id 作为 agent id：会话森林里每个成员
 * 本身就是独立会话，父会话的同理，这样成员的 parent_agent_id 才对得上。
 */
export function teamRootAgent(session: Session): SessionAgent {
  return {
    agent_id: session.id,
    kind: 'main',
    name: session.title || session.id,
    status: session.status,
    last_active: session.updated_at,
    mounted_session_id: session.id,
  };
}

export function TeamPage({ session, members, onSelectAgent }: {
  session: Session | null;
  /** Mounted children of the current session plus its sibling department members. */
  members: readonly SessionAgent[];
  onSelectAgent: (sessionId: string, agent: SessionAgent) => void;
}) {
  const { tr } = useI18n();
  const sessionId = session?.id ?? null;
  const viewportRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  // 用户自己拖过/缩放过之后就不再自动重新居中，否则每次成员变化都会把视图抢回去。
  const adjustedRef = useRef(false);
  const fitKeyRef = useRef('');
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<TreeView>({ x: 0, y: 0, scale: 1 });
  const [panning, setPanning] = useState(false);

  // 谁正在 Discuss 里发言只写在讨论节点上，所以要在丢弃这些节点之前先算出来。
  const speakingAgentIds = discussionSpeakingAgentIds(members);
  const rootAgent = session === null ? null : teamRootAgent(session);
  const treeAgents = rootAgent === null
    ? []
    : [rootAgent, ...members.filter(member => member.archived !== true && member.agent_id !== rootAgent.agent_id)];
  const rootAliases = session === null
    ? []
    : [parentSessionIdOf(session) ?? ''].filter(alias => alias.length > 0);
  const { placed, edges, width, height } = layoutTeamTree(treeAgents, rootAgent?.agent_id ?? '', rootAliases);
  const contentWidth = width + CANVAS_PAD * 2;
  const contentHeight = height + CANVAS_PAD;
  // 只有一个根节点等于「这个对话还没有团队」，此时画布没有意义，改为显示空态。
  const hasMembers = treeAgents.length > 1;
  const hasCanvas = sessionId !== null && hasMembers && placed.length > 0;

  useEffect(() => {
    const element = viewportRef.current;
    if (element === null) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setViewportSize(previous =>
        Math.abs(previous.width - rect.width) < 1 && Math.abs(previous.height - rect.height) < 1
          ? previous
          : { width: rect.width, height: rect.height });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasCanvas]);

  const resetView = useCallback(() => {
    adjustedRef.current = false;
    setView(fitTreeView({ width: contentWidth, height: contentHeight }, viewportSize));
  }, [contentWidth, contentHeight, viewportSize]);

  useEffect(() => {
    const key = `${sessionId ?? ''}|${contentWidth}x${contentHeight}x${Math.round(viewportSize.width)}x${Math.round(viewportSize.height)}`;
    if (fitKeyRef.current === key || adjustedRef.current) return;
    fitKeyRef.current = key;
    setView(fitTreeView({ width: contentWidth, height: contentHeight }, viewportSize));
  }, [contentWidth, contentHeight, sessionId, viewportSize]);

  // 滚轮缩放要能 preventDefault 拦住页面滚动，所以只能自己挂非 passive 监听。
  useEffect(() => {
    const element = viewportRef.current;
    if (element === null) return;
    const onWheel = (event: globalThis.WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      adjustedRef.current = true;
      setView(previous => zoomTreeView(
        previous,
        previous.scale * Math.exp(-event.deltaY * 0.0015),
        event.clientX - rect.left,
        event.clientY - rect.top,
      ));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [hasCanvas]);

  useEffect(() => {
    adjustedRef.current = false;
    fitKeyRef.current = '';
  }, [sessionId]);

  const zoomBy = (factor: number) => {
    adjustedRef.current = true;
    setView(previous => zoomTreeView(previous, previous.scale * factor, viewportSize.width / 2, viewportSize.height / 2));
  };
  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    // 卡片自己要能点开对话，所以只有按在空白处才开始拖动画布。
    if (event.button !== 0 || (event.target as HTMLElement).closest('.team-node') !== null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    panRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: view.x, originY: view.y };
    setPanning(true);
  };
  const movePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (pan === null || pan.pointerId !== event.pointerId) return;
    adjustedRef.current = true;
    setView(previous => ({ ...previous, x: pan.originX + event.clientX - pan.startX, y: pan.originY + event.clientY - pan.startY }));
  };
  const endPan = () => {
    panRef.current = null;
    setPanning(false);
  };

  return (
    <div className="view-page view-page-wide team-tree-page">
      <div className="team-tree-header">
        <div>
          <span className="eyebrow">{tr('Workspace', '工作区')}</span>
          <h2>{tr('Team', '团队')}</h2>
        </div>
        <div className="team-tree-legend">
          <span><i className="tone-running" />{tr('Working', '运行中')}</span>
          <span><i className="tone-discuss" />{tr('In discuss', '讨论中')}</span>
          <span><i className="tone-idle" />{tr('Idle', '空闲')}</span>
          <span><i className="tone-attention" />{tr('Needs you', '等待确认')}</span>
        </div>
      </div>

      {session === null
        ? <div className="team-tree-empty">{tr('Choose a session to see its team.', '选择一个会话以查看它的团队。')}</div>
        : !hasCanvas
          ? (
            <div className="team-tree-empty">
              <p>{tr('This conversation has no team members yet.', '这个对话还没有团队成员。')}</p>
              <p>{tr('Hire a member from the chat, and it shows up here under this conversation only.', '在对话里招募成员，它就只出现在这个对话的团队里。')}</p>
            </div>
          )
          : (() => {
            // 只有这里会画出画布，所以节点点击一定能拿到非空的会话 id。
            const openSessionId = sessionId;
            return (
            <div
              className={'team-tree-viewport' + (panning ? ' panning' : '')}
              ref={viewportRef}
              onPointerDown={startPan}
              onPointerMove={movePan}
              onPointerUp={endPan}
              onPointerCancel={endPan}
              onDoubleClick={resetView}
            >
              <div
                className="team-tree-canvas"
                style={{
                  width: contentWidth,
                  height: contentHeight,
                  transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
                }}
              >
                <svg className="team-tree-edges" width={contentWidth} height={contentHeight}>
                  {edges.map(({ from, to }) => {
                    const midY = from.y + NODE_H + GAP_Y / 2;
                    const d = `M ${from.cx + CANVAS_PAD} ${from.y + NODE_H} V ${midY} H ${to.cx + CANVAS_PAD} V ${to.y}`;
                    return <path key={`${from.agent.agent_id}-${to.agent.agent_id}`} d={d} />;
                  })}
                </svg>
                {placed.map(node => {
                  const tone = statusTone(node.agent);
                  const discussing = speakingAgentIds.has(node.agent.agent_id);
                  const nodeSessionId = node.agent.mounted_session_id ?? openSessionId;
                  return (
                    <button
                      key={node.agent.agent_id}
                      type="button"
                      className={[
                        'team-node',
                        `tone-${tone}`,
                        discussing ? 'discussing' : '',
                        node.agent.kind === 'main' ? 'root' : '',
                      ].join(' ').trim()}
                      style={{ left: node.x + CANVAS_PAD, top: node.y }}
                      onClick={() => onSelectAgent(nodeSessionId, node.agent)}
                      title={tr('Open conversation', '打开对话')}
                    >
                      <span className="team-node-name">
                        <i className={`dot tone-${tone}`} />
                        {node.agent.name || node.agent.agent_id}
                      </span>
                      <span className="team-node-sub">
                        {discussing
                          ? <em className="discuss-badge">{tr('Discussing', '讨论中')}</em>
                          : <em>{node.agent.role || statusText(node.agent)}</em>}
                      </span>
                      {node.agent.mandate && <q className="team-node-task" title={node.agent.mandate}>{node.agent.mandate}</q>}
                    </button>
                  );
                })}
              </div>
              <div className="team-tree-controls">
                <button type="button" onClick={() => zoomBy(1.2)} aria-label={tr('Zoom in', '放大')}>+</button>
                <button type="button" onClick={() => zoomBy(1 / 1.2)} aria-label={tr('Zoom out', '缩小')}>−</button>
                <button type="button" onClick={resetView} aria-label={tr('Center the tree', '居中显示')}>{Math.round(view.scale * 100)}%</button>
              </div>
              <span className="team-tree-hint">{tr('Drag to pan · scroll to zoom · double-click to recenter', '拖动平移 · 滚轮缩放 · 双击回到居中')}</span>
            </div>
            );
          })()}
      <div className="team-tree-footer">
        <Icon name="graph" size={13} />
        <span>{session ? session.title : tr('No session selected', '未选择会话')}</span>
      </div>
    </div>
  );
}
