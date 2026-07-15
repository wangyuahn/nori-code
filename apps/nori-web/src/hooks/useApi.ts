import { useState, useEffect, useCallback, useRef } from 'react';
import { api, getServerOrigin, getServerToken, type Note, type SwarmStatus, type PhaseStatus, type ConfigResponse, type Session, type SessionAgentConfig, type SessionCreateOptions } from '../api/client';

const SESSION_PROFILE_CACHE_KEY = 'nori-session-agent-configs';

function loadSessionProfileCache(): Record<string, SessionAgentConfig> {
  try {
    const value = JSON.parse(localStorage.getItem(SESSION_PROFILE_CACHE_KEY) ?? '{}') as unknown;
    return value && typeof value === 'object' ? value as Record<string, SessionAgentConfig> : {};
  } catch {
    return {};
  }
}

function saveSessionProfileCache(cache: Record<string, SessionAgentConfig>): void {
  try {
    localStorage.setItem(SESSION_PROFILE_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Local storage can be disabled in hardened browser contexts.
  }
}

function mergeAgentConfig(
  remote: SessionAgentConfig | undefined,
  fallback: SessionAgentConfig | undefined,
): SessionAgentConfig {
  const merged = { ...fallback, ...remote };
  if (!remote?.model?.trim() && fallback?.model?.trim()) merged.model = fallback.model;
  return merged;
}

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

export interface SwarmConnectionState {
  swarmStatuses: Map<string, SwarmStatus>;
  connected: boolean;
  error: string | null;
}

export function useSwarmWebSocket(): SwarmConnectionState {
  const [swarmStatuses, setSwarmStatuses] = useState<Map<string, SwarmStatus>>(new Map());
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let unmounted = false;

    const connect = (wsUrl: string) => {
      if (unmounted) return;
      try {
        ws = new WebSocket(wsUrl);
        ws.onopen = () => { setConnected(true); setError(null); };
        ws.onclose = () => {
          setConnected(false);
          if (!unmounted) {
            reconnectTimer = setTimeout(() => connect(wsUrl), 3000);
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
                const current = next.get(msg.swarm_id);
                next.set(msg.swarm_id, {
                  ...current,
                  swarm_id: msg.swarm_id,
                  status: msg.status ?? 'pending',
                  task_count: typeof msg.task_count === 'number' ? msg.task_count : 0,
                  completed_count: typeof msg.completed_count === 'number' ? msg.completed_count : 0,
                  session_id: typeof msg.session_id === 'string' ? msg.session_id : current?.session_id,
                  task_id: typeof msg.task_id === 'string' ? msg.task_id : current?.task_id,
                  description: typeof msg.description === 'string' ? msg.description : current?.description,
                  owner_agent_id: typeof msg.owner_agent_id === 'string' ? msg.owner_agent_id : current?.owner_agent_id,
                  round: typeof msg.round === 'number' ? msg.round : current?.round,
                  started_at: typeof msg.started_at === 'string' ? msg.started_at : current?.started_at,
                  usage: msg.usage ?? current?.usage,
                });
                return next;
              });
            }
          } catch { /* ignore malformed messages */ }
        };
      } catch {
        if (!unmounted) {
          reconnectTimer = setTimeout(() => connect(wsUrl), 3000);
        }
      }
    };

    const buildUrlAndConnect = async () => {
      const serverOrigin = getServerOrigin();
      const token = await getServerToken();
      let wsUrl: string;
      if (serverOrigin !== window.location.origin) {
        const wsOrigin = serverOrigin.replace(/^http/, 'ws');
        const base = `${wsOrigin}/api/v1/swarm/ws`;
        wsUrl = token ? `${base}?token=${encodeURIComponent(token)}` : base;
      } else {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        wsUrl = `${protocol}//${window.location.host}/api/v1/swarm/ws`;
      }
      connect(wsUrl);
    };

    buildUrlAndConnect();

    return () => {
      unmounted = true;
      clearTimeout(reconnectTimer);
      if (ws) {
        ws.onclose = null; // prevent reconnect from firing after unmount
        ws.close();
      }
    };
  }, []);

  const allIdsKey = Array.from(swarmStatuses.keys()).sort().join('|');
  const activeIdsKey = Array.from(swarmStatuses.values())
    .filter(status => status.status === 'running' || status.status === 'pending')
    .map(status => status.swarm_id)
    .sort()
    .join('|');

  useEffect(() => {
    const allIds = allIdsKey ? allIdsKey.split('|') : [];
    const activeIds = activeIdsKey ? activeIdsKey.split('|') : [];
    if (allIds.length === 0) return;
    let cancelled = false;
    let refreshing = false;

    const refresh = async (ids: string[]) => {
      if (refreshing || ids.length === 0) return;
      refreshing = true;
      try {
        const settled = await Promise.allSettled(ids.map(id => api.swarm.status(id)));
        if (cancelled) return;
        setSwarmStatuses(previous => {
          const next = new Map(previous);
          settled.forEach((result, index) => {
            if (result.status !== 'fulfilled') return;
            const id = ids[index];
            if (id === undefined) return;
            next.set(id, { ...next.get(id), ...result.value });
          });
          return next;
        });
      } finally {
        refreshing = false;
      }
    };

    void refresh(allIds);
    const timer = activeIds.length > 0
      ? setInterval(() => void refresh(activeIds), 1_000)
      : undefined;
    return () => {
      cancelled = true;
      if (timer !== undefined) clearInterval(timer);
    };
  }, [activeIdsKey, allIdsKey]);

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
  const profileCacheRef = useRef<Record<string, SessionAgentConfig>>(loadSessionProfileCache());
  const profileSaveSeqRef = useRef(new Map<string, number>());

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.sessions.list({ include_archive: true });
      setSessions(previous => {
        const previousById = new Map(previous.map(session => [session.id, session]));
        return (data?.items ?? []).map(session => ({
          ...session,
          agent_config: mergeAgentConfig(
            session.agent_config,
            previousById.get(session.id)?.agent_config ?? profileCacheRef.current[session.id],
          ),
        }));
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const onTitleChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; title?: string }>).detail;
      if (!detail?.sessionId || !detail.title) return;
      const title = detail.title;
      setSessions(previous => previous.map(session => session.id === detail.sessionId
        ? { ...session, title }
        : session));
    };
    window.addEventListener('nori:session-title-changed', onTitleChanged);
    return () => window.removeEventListener('nori:session-title-changed', onTitleChanged);
  }, []);

  const createNewSession = useCallback(async (options?: SessionCreateOptions) => {
    try {
      setCreating(true);
      const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
      const activeSession = sessions.find(session => session.id === sessionId);
      const cwd =
        options?.cwd?.trim() ||
        hashParams.get('cwd')?.trim() ||
        activeSession?.metadata?.cwd?.trim();
      if (!cwd) {
        throw new Error('请先选择一个项目文件夹。');
      }
      let created = await api.sessions.create({
        cwd,
        agent_config: options?.agent_config,
        smart_title: options?.smart_title ?? true,
      });
      if (!created?.id) return null;
      if (options?.agent_config) {
        created = await api.sessions.updateProfile(created.id, { agent_config: options.agent_config });
      }
      setSessions(previous => [created, ...previous.filter(session => session.id !== created.id)]);
      setSessionId(created.id);
      void refresh();
      return created.id;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create session');
      return null;
    } finally {
      setCreating(false);
    }
  }, [refresh, sessionId, sessions]);

  const switchSession = useCallback((id: string) => {
    setSessionId(id);
  }, []);

  const archiveSession = useCallback(async (id: string) => {
    setError(null);
    await api.sessions.archive(id);
    setSessions(previous => previous.map(session => session.id === id ? { ...session, archived: true } : session));
    setSessionId(previous => previous === id
      ? sessions.find(session => session.id !== id && !session.archived)?.id ?? null
      : previous);
  }, [sessions]);

  const deleteSession = useCallback(async (id: string) => {
    setError(null);
    await api.sessions.delete(id);
    setSessions(previous => previous.filter(session => session.id !== id));
    setSessionId(previous => previous === id
      ? sessions.find(session => session.id !== id && !session.archived)?.id ?? null
      : previous);
  }, [sessions]);

  const renameSession = useCallback(async (id: string, title: string) => {
    const updated = await api.sessions.rename(id, title);
    setSessions(previous => previous.map(session => session.id === id ? { ...session, ...updated, title } : session));
  }, []);

  const forkSession = useCallback(async (id: string, title?: string) => {
    const forked = await api.sessions.fork(id, title);
    setSessions(previous => [forked, ...previous.filter(session => session.id !== forked.id)]);
    setSessionId(forked.id);
    return forked;
  }, []);

  const updateSessionProfile = useCallback(async (
    id: string,
    patch: { title?: string; agent_config?: SessionAgentConfig },
  ) => {
    const requestSeq = (profileSaveSeqRef.current.get(id) ?? 0) + 1;
    profileSaveSeqRef.current.set(id, requestSeq);
    let rollback: Session | undefined;

    setSessions(previous => previous.map(session => {
      if (session.id !== id) return session;
      rollback = session;
      return {
        ...session,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        agent_config: mergeAgentConfig(patch.agent_config, session.agent_config),
      };
    }));

    if (patch.agent_config !== undefined) {
      profileCacheRef.current[id] = mergeAgentConfig(
        patch.agent_config,
        profileCacheRef.current[id],
      );
      saveSessionProfileCache(profileCacheRef.current);
    }

    try {
      setError(null);
      const updated = await api.sessions.updateProfile(id, patch);
      if (profileSaveSeqRef.current.get(id) !== requestSeq) return updated;
      setSessions(previous => previous.map(session => session.id === id ? {
        ...updated,
        agent_config: mergeAgentConfig(
          updated.agent_config,
          mergeAgentConfig(patch.agent_config, session.agent_config),
        ),
      } : session));
      return updated;
    } catch (e) {
      if (profileSaveSeqRef.current.get(id) === requestSeq && rollback !== undefined) {
        setSessions(previous => previous.map(session => session.id === id ? rollback! : session));
      }
      setError(e instanceof Error ? e.message : 'Failed to update session');
      throw e;
    }
  }, []);

  return {
    sessionId,
    sessions,
    isLoading: loading,
    error,
    creating,
    createNewSession,
    switchSession,
    archiveSession,
    deleteSession,
    renameSession,
    forkSession,
    updateSessionProfile,
    refresh,
  };
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
