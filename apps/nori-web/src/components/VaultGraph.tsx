import { useEffect, useRef, useState, type MouseEvent, type PointerEvent, type WheelEvent } from 'react';
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import type { Note } from '../api/client';
import { useI18n } from '../i18n';

interface LinkedNote extends Note { content?: string }
interface GraphNode extends SimulationNodeDatum { id: string; note: LinkedNote }
interface GraphLink extends SimulationLinkDatum<GraphNode> { source: string | GraphNode; target: string | GraphNode }

const COLORS: Record<Note['type'], string> = {
  analysis: '#56d8c2',
  decision: '#a985ff',
  review: '#4bd783',
  task: '#e8ad3d',
};

const CLICK_MOVE_THRESHOLD = 5;
const TYPE_CLUSTER_STRENGTH = 0.035;

export function forceSameType(strength = TYPE_CLUSTER_STRENGTH) {
  let nodes: GraphNode[] = [];
  const force = (alpha: number) => {
    const centroids = new Map<Note['type'], { x: number; y: number; count: number }>();
    for (const node of nodes) {
      const centroid = centroids.get(node.note.type) ?? { x: 0, y: 0, count: 0 };
      centroid.x += node.x ?? 0;
      centroid.y += node.y ?? 0;
      centroid.count += 1;
      centroids.set(node.note.type, centroid);
    }

    for (const node of nodes) {
      const centroid = centroids.get(node.note.type);
      if (!centroid || centroid.count < 2) continue;
      const factor = strength * alpha;
      node.vx = (node.vx ?? 0) + (centroid.x / centroid.count - (node.x ?? 0)) * factor;
      node.vy = (node.vy ?? 0) + (centroid.y / centroid.count - (node.y ?? 0)) * factor;
    }
  };
  force.initialize = (nextNodes: GraphNode[]) => { nodes = nextNodes; };
  return force;
}

export function VaultGraph({ notes, onOpenNote }: { notes: LinkedNote[]; onOpenNote: (note: Note) => void }) {
  const { tr } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const simulationRef = useRef<ReturnType<typeof forceSimulation<GraphNode>> | null>(null);
  const topologyKeyRef = useRef('');
  const positionsRef = useRef(new Map<string, { x: number; y: number }>());
  const dragRef = useRef<{ node: GraphNode; startX: number; startY: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef<string | null>(null);
  const panRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  const [size, setSize] = useState({ width: 900, height: 620 });
  const [viewport, setViewport] = useState({ x: 0, y: 0, scale: 1 });
  const [graph, setGraph] = useState<{ nodes: GraphNode[]; links: GraphLink[] }>({ nodes: [], links: [] });
  const [, redraw] = useState(0);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const next = { width: Math.max(420, Math.round(entry.contentRect.width)), height: Math.max(420, Math.round(entry.contentRect.height)) };
      setSize(previous => previous.width === next.width && previous.height === next.height ? previous : next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const topologyKey = sorted(notes
      .map(note => `${note.path || `${note.type}:${note.title}`}\0${note.type}\0${sorted([...(note.links ?? []), ...extractWikiLinks(note.content ?? '')]).join('\0')}`))
      .join('\u0001');
    if (topologyKeyRef.current === topologyKey) return;
    topologyKeyRef.current = topologyKey;

    const nodes: GraphNode[] = notes.map(note => {
      const id = note.path || `${note.type}:${note.title}`;
      const position = positionsRef.current.get(id);
      return { id, note, ...position };
    });
    const byTitle = new Map(nodes.map(node => [normalizeTitle(node.note.title), node]));
    const links: GraphLink[] = [];
    const seen = new Set<string>();
    for (const node of nodes) {
      for (const target of new Set([...(node.note.links ?? []), ...extractWikiLinks(node.note.content ?? '')])) {
        const resolved = byTitle.get(normalizeTitle(target));
        if (!resolved || resolved.id === node.id) continue;
        const key = sorted([node.id, resolved.id]).join('\0');
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ source: node.id, target: resolved.id });
      }
    }
    setGraph({ nodes, links });
  }, [notes]);

  useEffect(() => {
    simulationRef.current?.stop();
    if (graph.nodes.length === 0) return;
    const simulation = forceSimulation(graph.nodes)
      .force('link', forceLink<GraphNode, GraphLink>(graph.links).id(node => node.id).distance(95).strength(0.45))
      .force('charge', forceManyBody().strength(-240))
      .force('collision', forceCollide<GraphNode>().radius(25))
      .force('type-cluster', forceSameType())
      .force('center', forceCenter(size.width / 2, size.height / 2))
      .force('x', forceX<GraphNode>(size.width / 2).strength(0.045))
      .force('y', forceY<GraphNode>(size.height / 2).strength(0.06))
      .alphaMin(0.035)
      .velocityDecay(0.5)
      .on('tick', () => {
        for (const node of graph.nodes) {
          node.x = Math.max(24, Math.min(size.width - 190, node.x ?? size.width / 2));
          node.y = Math.max(42, Math.min(size.height - 28, node.y ?? size.height / 2));
          positionsRef.current.set(node.id, { x: node.x, y: node.y });
        }
        redraw(value => value + 1);
      });
    simulationRef.current = simulation;
    return () => { simulation.stop(); };
  }, [graph, size]);

  const screenPosition = (event: PointerEvent<SVGElement>) => {
    const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const graphPosition = (event: PointerEvent<SVGElement>) => {
    const point = screenPosition(event);
    return { x: (point.x - viewport.x) / viewport.scale, y: (point.y - viewport.y) / viewport.scale };
  };
  const startDrag = (event: PointerEvent<SVGGElement>, node: GraphNode) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { node, startX: event.clientX, startY: event.clientY, moved: false };
    suppressClickRef.current = null;
    node.fx = node.x;
    node.fy = node.y;
    simulationRef.current?.alphaTarget(0.2).restart();
  };
  const moveDrag = (event: PointerEvent<SVGGElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    drag.moved ||= pointerMovedBeyondClickThreshold(drag, event);
    const point = graphPosition(event);
    drag.node.fx = point.x;
    drag.node.fy = point.y;
  };

  const startPan = (event: PointerEvent<SVGRectElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    panRef.current = { startX: event.clientX, startY: event.clientY, originX: viewport.x, originY: viewport.y };
  };
  const movePan = (event: PointerEvent<SVGSVGElement>) => {
    const pan = panRef.current;
    if (!pan) return;
    setViewport(previous => ({ ...previous, x: pan.originX + event.clientX - pan.startX, y: pan.originY + event.clientY - pan.startY }));
  };
  const endPan = () => { panRef.current = null; };
  const zoom = (nextScale: number, centerX = size.width / 2, centerY = size.height / 2) => {
    const clamped = Math.max(0.25, Math.min(3.5, nextScale));
    setViewport(previous => ({
      scale: clamped,
      x: centerX - (centerX - previous.x) * (clamped / previous.scale),
      y: centerY - (centerY - previous.y) * (clamped / previous.scale),
    }));
  };
  const onZoomWheel = (event: WheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    zoom(viewport.scale * Math.exp(-event.deltaY * 0.0012), event.clientX - rect.left, event.clientY - rect.top);
  };
  const endDrag = (event: PointerEvent<SVGGElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    drag.moved ||= pointerMovedBeyondClickThreshold(drag, event);
    drag.node.fx = null;
    drag.node.fy = null;
    simulationRef.current?.alphaTarget(0);
    suppressClickRef.current = drag.moved || event.type === 'pointercancel' ? drag.node.id : null;
    dragRef.current = null;
  };
  const openNode = (event: MouseEvent<SVGGElement>, node: GraphNode) => {
    if (suppressClickRef.current === node.id) {
      suppressClickRef.current = null;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onOpenNote(node.note);
  };

  return <div className="vault-graph" ref={containerRef}>
    <div className="vault-graph-legend">
      {(['analysis', 'decision', 'review', 'task'] as const).map(type => <span key={type}><i style={{ background: COLORS[type] }} />{tr(type, type === 'analysis' ? '分析' : type === 'decision' ? '决策' : type === 'review' ? '评审' : '任务')}</span>)}
    </div>
    <div className="vault-graph-controls"><button onClick={() => zoom(viewport.scale * 1.25)} aria-label={tr('Zoom in', '放大')}><IconPlaceholder symbol="+" /></button><button onClick={() => zoom(viewport.scale / 1.25)} aria-label={tr('Zoom out', '缩小')}><IconPlaceholder symbol="-" /></button><button onClick={() => setViewport({ x: 0, y: 0, scale: 1 })} aria-label={tr('Reset view', '重置视图')}>1:1</button></div>
    {graph.nodes.length === 0 ? <div className="vault-note-state">{tr('No linked notes found.', '没有可显示的链接笔记。')}</div> : <svg width="100%" height="100%" viewBox={`0 0 ${size.width} ${size.height}`} aria-label={tr('Bidirectional note graph', '笔记双向链接图')} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan} onWheel={onZoomWheel}>
      <rect className="vault-graph-pan-surface" width={size.width} height={size.height} onPointerDown={startPan} />
      <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}>
      <g className="vault-graph-links">{graph.links.map((link, index) => {
        const source = link.source as GraphNode;
        const target = link.target as GraphNode;
        return <line key={`${source.id}-${target.id}-${index}`} x1={source.x} y1={source.y} x2={target.x} y2={target.y} />;
      })}</g>
      <g className="vault-graph-nodes">{graph.nodes.map(node => <g key={node.id} transform={`translate(${node.x ?? size.width / 2},${node.y ?? size.height / 2})`} onPointerDown={event => startDrag(event, node)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onClick={event => { openNode(event, node); }} tabIndex={0} role="button" aria-label={node.note.title} onKeyDown={event => { if (event.key === 'Enter') onOpenNote(node.note); }}>
        <circle r="8" fill={COLORS[node.note.type]} />
        <circle className="vault-graph-node-ring" r="13" stroke={COLORS[node.note.type]} />
        <text x="17" y="4">{truncate(node.note.title, 30)}</text>
      </g>)}</g></g>
    </svg>}
  </div>;
}

function pointerMovedBeyondClickThreshold(
  drag: { startX: number; startY: number },
  event: PointerEvent<SVGGElement>,
): boolean {
  const deltaX = event.clientX - drag.startX;
  const deltaY = event.clientY - drag.startY;
  return deltaX * deltaX + deltaY * deltaY > CLICK_MOVE_THRESHOLD * CLICK_MOVE_THRESHOLD;
}

function IconPlaceholder({ symbol }: { symbol: string }) {
  return <span aria-hidden="true">{symbol}</span>;
}

function extractWikiLinks(content: string): string[] {
  return [...content.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)].map(match => match[1]?.trim()).filter((value): value is string => Boolean(value));
}

function normalizeTitle(value: string): string {
  return value.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/i, '').trim().toLowerCase();
}

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function sorted<T>(values: readonly T[]): T[] {
  // ES2022 renderer target: keep a non-mutating sort without Array#toSorted.
  // oxlint-disable-next-line unicorn/no-array-sort
  return [...values].sort();
}
