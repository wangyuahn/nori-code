import { useEffect, useState } from 'react';
import { api, type BackgroundTask } from '../api/client';

export interface BackgroundTasksState {
  tasks: BackgroundTask[];
  loading: boolean;
  error: string | null;
  markCancelled: (taskId: string) => void;
}

/** Polls the current session's non-conversation work for the agent tree. */
export function useBackgroundTasks(sessionId: string | null | undefined): BackgroundTasksState {
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  const [loading, setLoading] = useState(Boolean(sessionId));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setTasks([]);
    setError(null);
    setLoading(Boolean(sessionId));
    if (!sessionId) return () => { cancelled = true; };

    const refresh = async () => {
      try {
        const result = await api.sessions.tasks.list(sessionId);
        if (!cancelled) {
          setTasks(result.items);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(() => void refresh(), 2_000);
        }
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId]);

  return {
    tasks,
    loading,
    error,
    markCancelled: (taskId) => setTasks(previous => previous.map(item =>
      item.id === taskId ? { ...item, status: 'cancelled' } : item,
    )),
  };
}

/** Retains the last known task list for sessions that are not currently selected. */
export function rememberSessionBackgroundTasks(
  previous: ReadonlyMap<string, BackgroundTask[]>,
  sessionId: string | null | undefined,
  tasks: readonly BackgroundTask[],
  loading = false,
): Map<string, BackgroundTask[]> {
  if (!sessionId) return previous instanceof Map ? previous : new Map(previous);
  if (loading && tasks.length === 0) return previous instanceof Map ? previous : new Map(previous);
  const current = previous.get(sessionId);
  if (current !== undefined && JSON.stringify(current) === JSON.stringify(tasks)) {
    return previous instanceof Map ? previous : new Map(previous);
  }
  const next = new Map(previous);
  next.set(sessionId, [...tasks]);
  return next;
}

export function flattenBackgroundTasks(
  bySession: ReadonlyMap<string, readonly BackgroundTask[]>,
): BackgroundTask[] {
  return [...bySession.values()].flatMap(tasks => [...tasks]);
}
