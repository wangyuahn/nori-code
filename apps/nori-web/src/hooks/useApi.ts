import { useState, useEffect, useCallback, useRef } from 'react';
import { api, type Note, type SwarmStatus, type PhaseStatus, type ConfigResponse, type Session } from '../api/client';

export function useVaultNotes(typeFilter?: string) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    // Abort any previous in-flight request before starting a new one
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    try {
      setLoading(true);
      setError(null);
      const data = await api.vault.list(typeFilter, controller.signal);
      if (!controller.signal.aborted) {
        setNotes(data);
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(e instanceof Error ? e.message : 'Unknown error');
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [typeFilter]);

  useEffect(() => {
    refresh();
    return () => { controllerRef.current?.abort(); };
  }, [refresh]);

  return { notes, loading, error, refresh };
}

export function usePhaseStatus() {
  const [phase, setPhase] = useState<PhaseStatus>({ phase: 'idle', step: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const data = await api.phase.status();
        if (active) { setPhase(data); setLoading(false); setError(null); }
      } catch (e) {
        if (active) { setError(e instanceof Error ? e.message : 'Unknown error'); setLoading(false); }
      }
      if (active) {
        timer = setTimeout(poll, 3000);
      }
    };
    poll();

    return () => { active = false; clearTimeout(timer); };
  }, []);

  return { phase, loading, error };
}

export function useSwarmWebSocket() {
  const [swarmStatuses, setSwarmStatuses] = useState<Map<string, SwarmStatus>>(new Map());
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Read server origin and token from URL hash (set by Electron desktop for file:// loads)
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const serverOrigin = hashParams.get('server');
    const token = hashParams.get('token');

    // Build WebSocket URL: use server origin when available, otherwise fall back to current host
    let wsUrl: string;
    if (serverOrigin) {
      const wsOrigin = serverOrigin.replace(/^http/, 'ws');
      const base = `${wsOrigin}/api/v1/swarm/ws`;
      wsUrl = token ? `${base}?token=${encodeURIComponent(token)}` : base;
    } else {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl = `${protocol}//${window.location.host}/api/v1/swarm/ws`;
    }
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let unmounted = false;

    const connect = () => {
      if (unmounted) return;
      try {
        ws = new WebSocket(wsUrl);
        ws.onopen = () => { setConnected(true); setError(null); };
        ws.onclose = () => {
          setConnected(false);
          if (!unmounted) {
            reconnectTimer = setTimeout(connect, 3000);
          }
        };
        ws.onerror = () => {
          setError('WebSocket connection error');
          ws?.close();
        };
        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'swarm_status' && typeof msg.swarm_id === 'string' && msg.swarm_id.length > 0) {
              setSwarmStatuses(prev => {
                const next = new Map(prev);
                next.set(msg.swarm_id, {
                  swarm_id: msg.swarm_id,
                  status: msg.status ?? 'pending',
                  task_count: typeof msg.task_count === 'number' ? msg.task_count : 0,
                  completed_count: typeof msg.completed_count === 'number' ? msg.completed_count : 0,
                });
                return next;
              });
            }
          } catch { /* ignore malformed messages */ }
        };
      } catch {
        if (!unmounted) {
          reconnectTimer = setTimeout(connect, 3000);
        }
      }
    };
    connect();

    return () => {
      unmounted = true;
      clearTimeout(reconnectTimer);
      if (ws) {
        ws.onclose = null; // prevent reconnect from firing after unmount
        ws.close();
      }
    };
  }, []);

  return { swarmStatuses, connected, error };
}

export function useConfig() {
  const [config, setConfig] = useState<ConfigResponse>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const saveIdRef = useRef(0);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.config.get();
      setConfig(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const saveConfig = useCallback(async (patch: Record<string, unknown>) => {
    const id = ++saveIdRef.current;
    try {
      setSaving(true);
      setSaveError(null);
      setSaveSuccess(false);
      if (successTimerRef.current != null) {
        clearTimeout(successTimerRef.current);
        successTimerRef.current = null;
      }
      const updated = await api.config.update(patch);
      // Only apply if this is still the latest save
      if (id !== saveIdRef.current) return;
      setConfig(updated);
      setSaveSuccess(true);
      // Clear success indicator after 2s
      successTimerRef.current = setTimeout(() => {
        setSaveSuccess(false);
        successTimerRef.current = null;
      }, 2000);
    } catch (e) {
      if (id !== saveIdRef.current) return;
      setSaveError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      if (id === saveIdRef.current) {
        setSaving(false);
      }
    }
  }, []);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (successTimerRef.current != null) {
        clearTimeout(successTimerRef.current);
      }
    };
  }, []);

  return { config, loading, error, saving, saveError, saveSuccess, saveConfig, refresh };
}

export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.sessions.list();
      setSessions(data?.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const createNewSession = useCallback(async () => {
    try {
      setCreating(true);
      const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
      const cwd = hashParams.get('cwd') || undefined;
      const created = await api.sessions.create(cwd);
      const sessionId = created?.id;
      if (sessionId) {
        setSessionId(sessionId);
        // Re-fetch to get the full session object
        await refresh();
      }
      return sessionId ?? null;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create session');
      return null;
    } finally {
      setCreating(false);
    }
  }, [refresh]);

  const switchSession = useCallback((id: string) => {
    setSessionId(id);
  }, []);

  return { sessionId, sessions, isLoading: loading, error, creating, createNewSession, switchSession };
}

export function useServerStatus() {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        await api.healthz();
        if (active) setConnected(true);
      } catch {
        if (active) setConnected(false);
      }
      if (active) setTimeout(poll, 5000);
    };
    poll();
    return () => { active = false; };
  }, []);

  return { connected };
}
