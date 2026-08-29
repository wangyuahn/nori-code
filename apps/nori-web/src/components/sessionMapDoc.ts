/**
 * Conversation-map chrome (UE note boxes). Soft-bound to session ids;
 * persisted in localStorage so nori-web stays off agent-core.
 *
 * `labels` / `sessionLabels` remain in the doc schema for forward compatibility,
 * but SessionMapPage does not surface a labels UI.
 */

export const SESSION_MAP_DOC_KEY = 'nori-session-map-doc';

export interface MapAnnotationBox {
  readonly id: string;
  title: string;
  color: string;
  /** Soft binding — missing ids are ignored; empty boxes keep a free rect. */
  nodeIds: string[];
  rect?: { x: number; y: number; width: number; height: number };
}

export interface MapLabelDef {
  readonly id: string;
  name: string;
  color: string;
}

export interface SessionMapDoc {
  version: 1;
  annotations: MapAnnotationBox[];
  labels: MapLabelDef[];
  /** sessionId → label ids */
  sessionLabels: Record<string, string[]>;
  /** Force-node id (`session:…` / `agent:…`) → pinned world center. */
  positions?: Record<string, { x: number; y: number }>;
}

export const DEFAULT_ANNOTATION_COLORS = [
  '#3b82f6',
  '#22c55e',
  '#eab308',
  '#ef4444',
  '#a855f7',
  '#06b6d4',
] as const;

export function emptySessionMapDoc(): SessionMapDoc {
  return { version: 1, annotations: [], labels: [], sessionLabels: {} };
}

export function parseSessionMapDoc(raw: string | null | undefined): SessionMapDoc {
  if (raw === null || raw === undefined || raw.trim() === '') return emptySessionMapDoc();
  try {
    const parsed = JSON.parse(raw) as Partial<SessionMapDoc>;
    if (parsed.version !== 1) return emptySessionMapDoc();
    return {
      version: 1,
      annotations: Array.isArray(parsed.annotations)
        ? parsed.annotations.filter(isAnnotationBox)
        : [],
      labels: Array.isArray(parsed.labels) ? parsed.labels.filter(isLabelDef) : [],
      sessionLabels:
        parsed.sessionLabels !== undefined && typeof parsed.sessionLabels === 'object'
          ? Object.fromEntries(
            Object.entries(parsed.sessionLabels).filter(
              ([, ids]) => Array.isArray(ids) && ids.every((id) => typeof id === 'string'),
            ),
          )
          : {},
      positions: parsePositions(parsed.positions),
    };
  } catch {
    return emptySessionMapDoc();
  }
}

export function loadSessionMapDoc(
  storage: Pick<Storage, 'getItem'> = localStorage,
): SessionMapDoc {
  return parseSessionMapDoc(storage.getItem(SESSION_MAP_DOC_KEY));
}

export function saveSessionMapDoc(
  doc: SessionMapDoc,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  storage.setItem(SESSION_MAP_DOC_KEY, JSON.stringify(doc));
}

function isAnnotationBox(value: unknown): value is MapAnnotationBox {
  if (value === null || typeof value !== 'object') return false;
  const box = value as MapAnnotationBox;
  return typeof box.id === 'string'
    && typeof box.title === 'string'
    && typeof box.color === 'string'
    && Array.isArray(box.nodeIds)
    && box.nodeIds.every((id) => typeof id === 'string');
}

function isLabelDef(value: unknown): value is MapLabelDef {
  if (value === null || typeof value !== 'object') return false;
  const label = value as MapLabelDef;
  return typeof label.id === 'string' && typeof label.name === 'string' && typeof label.color === 'string';
}

function parsePositions(
  value: unknown,
): Record<string, { x: number; y: number }> | undefined {
  if (value === null || value === undefined || typeof value !== 'object') return undefined;
  const out: Record<string, { x: number; y: number }> = {};
  for (const [id, pos] of Object.entries(value as Record<string, unknown>)) {
    if (pos === null || typeof pos !== 'object') continue;
    const point = pos as { x?: unknown; y?: unknown };
    if (typeof point.x === 'number' && typeof point.y === 'number' && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      out[id] = { x: point.x, y: point.y };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function newAnnotationId(): string {
  return `ann_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function newLabelId(): string {
  return `lbl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface PlacedBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Bounds for a note box: union of soft-bound nodes, else free rect / default empty box.
 */
export function annotationBounds(
  box: MapAnnotationBox,
  placed: ReadonlyArray<{ session: { id: string }; x: number; y: number }>,
  nodeSize: { width: number; height: number },
): PlacedBounds {
  const bound = placed.filter((node) => box.nodeIds.includes(node.session.id));
  if (bound.length === 0) {
    return box.rect ?? { x: 40, y: 40, width: nodeSize.width + 48, height: nodeSize.height + 48 };
  }
  const pad = 18;
  const titleRoom = 22;
  const minX = Math.min(...bound.map((n) => n.x)) - pad;
  const minY = Math.min(...bound.map((n) => n.y)) - pad - titleRoom;
  const maxX = Math.max(...bound.map((n) => n.x + nodeSize.width)) + pad;
  const maxY = Math.max(...bound.map((n) => n.y + nodeSize.height)) + pad;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Keep sessions that carry any of the active label filters (empty filter = all). */
export function sessionMatchesLabelFilter(
  sessionId: string,
  sessionLabels: Record<string, string[]>,
  activeLabelIds: readonly string[],
): boolean {
  if (activeLabelIds.length === 0) return true;
  const owned = sessionLabels[sessionId] ?? [];
  return activeLabelIds.some((id) => owned.includes(id));
}

export function toggleSessionLabel(
  doc: SessionMapDoc,
  sessionId: string,
  labelId: string,
): SessionMapDoc {
  const current = doc.sessionLabels[sessionId] ?? [];
  const next = current.includes(labelId)
    ? current.filter((id) => id !== labelId)
    : [...current, labelId];
  return {
    ...doc,
    sessionLabels: {
      ...doc.sessionLabels,
      [sessionId]: next,
    },
  };
}
