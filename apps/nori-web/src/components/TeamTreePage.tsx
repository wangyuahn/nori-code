/**
 * 团队树全屏页：根节点（main）在最上面，部门向下、向左右平铺展开。
 *
 * 布局是经典的 tidy-tree：叶子按序占列，父节点居中于子节点之上；
 * 连接线全部横平竖直（竖-横-竖的直角折线），卡片简约扁平。
 * 正在 Discuss 发言的成员高亮描边；running/idle 等状态用圆点区分。
 */

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { api, type Session, type SessionAgent } from '../api/client';
import { useI18n } from '../i18n';
import { discussionSpeakingAgentIds } from '../utils/team-discussion';
import { Icon } from './Icon';

// 卡片是三行：名字、角色、职责。职责最多两行，所以高度按三行内容定，
// 竖直间距相应收窄，整棵树的行距和之前基本一致。
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
  y: number
  /** Horizontal center, px. */
  cx: number;
}

type StatusTone = 'running' | 'attention' | 'idle' | 'muted';

export function statusTone(agent: SessionAgent): StatusTone {
  if (agent.archived || agent.kind === 'discussion') return 'muted';
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
 * parent centers over its children. Only durable members participate —
 * discussion transcripts and archived nodes stay off the canvas.
 */
export function layoutTeamTree(agents: readonly SessionAgent[]): {
  placed: PlacedNode[];
  edges: Array<{ from: PlacedNode; to: PlacedNode }>;
  width: number;
  height: number;
} {
  const visible = agents.filter(agent =>
    agent.kind !== 'discussion'
    && !agent.archived
    && typeof agent.agent_id === 'string');
  const byId = new Map(visible.map(agent => [agent.agent_id, agent]));
  const childrenOf = new Map<string, SessionAgent[]>();
  for (const agent of visible) {
    const parentId = agent.parent_agent_id ?? (agent.kind === 'main' ? null : 'main');
    if (agent.kind === 'main' || parentId === null || !byId.has(parentId)) continue;
    const list = childrenOf.get(parentId) ?? [];
    list.push(agent);
    childrenOf.set(parentId, list);
  }
  const root = visible.find(agent => agent.kind === 'main')
    ?? visible.find(agent => agent.parent_agent_id === null);
  if (root === undefined) {
    return { placed: [], edges: [], width: 0, height: 0 };
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

export function TeamTreePage({ session, onSelectAgent }: {
  session: Session | null;
  onSelectAgent: (sessionId: string, agent: SessionAgent) => void;
}) {
  const { tr } = useI18n();
  const sessionId = session?.id ?? null;
  const [agents, setAgents] = useState<SessionAgent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  // 用户自己拖过/缩放过之后就不再自动重新居中，否则每 3 秒一次的刷新会把视图抢回去。
  const adjustedRef = useRef(false);
  const fitKeyRef = useRef('');
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<TreeView>({ x: 0, y: 0, scale: 1 });
  const [panning, setPanning] = useState(false);

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setAgents([]);
      setError(null);
      return;
    }
    const requestId = ++requestIdRef.current;
    try {
      const result = await api.sessions.getAgents(sessionId);
      if (requestId !== requestIdRef.current) return;
      setAgents(result.items ?? []);
      setError(null);
    } catch (caught) {
      if (requestId !== requestIdRef.current) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [sessionId]);

  useEffect(() => {
    setAgents([]);
    void refresh();
    if (!sessionId) return;
    const timer = window.setInterval(() => { void refresh(); }, 3_000);
    return () => window.clearInterval(timer);
  }, [refresh, sessionId]);

  const { placed, edges, width, height } = layoutTeamTree(agents);
  const contentWidth = width + CANVAS_PAD * 2;
  const contentHeight = height + CANVAS_PAD;
  // 谁正在 Discuss 里发言只写在讨论节点上，而讨论节点不上画布，
  // 所以要在 layout 过滤掉它们之前先把这一组人算出来。
  const speakingAgentIds = discussionSpeakingAgentIds(agents);
  // 只有真的画出画布时才有视口可测量、可挂监听。
  const hasCanvas = sessionId !== null && error === null && placed.length > 0;

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

  // 默认居中：树的尺寸或视口变化时重新摆正，除非用户已经自己动过视图。
  useEffect(() => {
    const key = `${contentWidth}x${contentHeight}x${Math.round(viewportSize.width)}x${Math.round(viewportSize.height)}`;
    if (fitKeyRef.current === key || adjustedRef.current) return;
    fitKeyRef.current = key;
    setView(fitTreeView({ width: contentWidth, height: contentHeight }, viewportSize));
  }, [contentWidth, contentHeight, viewportSize]);

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

      {!sessionId
        ? <div className="team-tree-empty">{tr('Choose a session to see its team.', '选择一个会话以查看它的团队。')}</div>
        : error !== null
          ? <div className="team-tree-empty">{error}</div>
          : placed.length === 0
            ? <div className="team-tree-empty">{tr('No agents yet.', '还没有智能体。')}</div>
            : (
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
                        onClick={() => onSelectAgent(sessionId, node.agent)}
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
            )}
      <div className="team-tree-footer">
        <Icon name="graph" size={13} />
        <span>{session ? session.title : tr('No session selected', '未选择会话')}</span>
      </div>
    </div>
  );
}
