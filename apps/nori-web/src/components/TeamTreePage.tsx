/**
 * 团队树全屏页：根节点（main）在最上面，部门向下、向左右平铺展开。
 *
 * 布局是经典的 tidy-tree：叶子按序占列，父节点居中于子节点之上；
 * 连接线全部横平竖直（竖-横-竖的直角折线），卡片简约扁平。
 * 正在 Discuss 发言的成员高亮描边；running/idle 等状态用圆点区分。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { api, type Session, type SessionAgent } from '../api/client';
import { useI18n } from '../i18n';
import { Icon } from './Icon';

const NODE_W = 188;
const NODE_H = 62;
const GAP_X = 26;
const GAP_Y = 74;

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
              <div className="team-tree-scroll">
                <div className="team-tree-canvas" style={{ width: width + 80, height: height + 60 }}>
                  <svg className="team-tree-edges" width={width + 80} height={height + 60}>
                    {edges.map(({ from, to }) => {
                      const midY = from.y + NODE_H + GAP_Y / 2;
                      const d = `M ${from.cx + 40} ${from.y + NODE_H} V ${midY} H ${to.cx + 40} V ${to.y}`;
                      return <path key={`${from.agent.agent_id}-${to.agent.agent_id}`} d={d} />;
                    })}
                  </svg>
                  {placed.map(node => {
                    const tone = statusTone(node.agent);
                    const discussing = node.agent.discussion_turn_agent_id === node.agent.agent_id;
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
                        style={{ left: node.x + 40, top: node.y }}
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
                          {node.agent.mandate && <q>{node.agent.mandate}</q>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
      <div className="team-tree-footer">
        <Icon name="graph" size={13} />
        <span>{session ? session.title : tr('No session selected', '未选择会话')}</span>
      </div>
    </div>
  );
}
