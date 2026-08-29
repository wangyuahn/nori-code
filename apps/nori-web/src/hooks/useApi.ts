import { useState, useEffect, useCallback, useRef } from 'react';
import { api, type Note, type PhaseStatus, type ConfigResponse, type Session, type SessionAgentConfig, type SessionCreateOptions } from '../api/client';

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

/**
 * Resolve the session the SPA should open. Prefer hash/query `session=` —
 * CLI `/web` uses `/#token=...&session=id` so Vite `base: './'` assets
 * resolve from `/`. Path `/sessions/:id` is still accepted for older bookmarks.
 */
export function sessionIdFromLocation(pathname: string, hash = '', search = ''): string | null {
  const hashParams = new URLSearchParams(hash.replace(/^#/, ''));
  const fromHash = hashParams.get('session')?.trim();
  if (fromHash) return fromHash;
  const queryParams = new URLSearchParams(search.replace(/^\?/, ''));
  const fromQuery = queryParams.get('session')?.trim();
  if (fromQuery) return fromQuery;
  const match = /^\/sessions\/([^/]+)\/?$/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function syncSessionLocation(sessionId: string | null): void {
  if (typeof window === 'undefined') return;
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  if (sessionId !== null && sessionId.length > 0) hashParams.set('session', sessionId);
  else hashParams.delete('session');
  const hash = hashParams.toString();
  // Stay on `/` so relative `./assets/*` keep resolving. Path-style
  // `/sessions/:id` is still parsed on first load for older links.
  const path = window.location.pathname.startsWith('/sessions/') ? '/' : (window.location.pathname || '/');
  const next = `${path}${hash.length > 0 ? `#${hash}` : ''}`;
  const current = `${window.location.pathname}${window.location.hash}`;
  if (current !== next) window.history.replaceState(null, '', next);
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
    void refresh();
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
    void poll();

    return () => { active = false; clearTimeout(timer); };
  }, []);

  return { phase, loading, error };
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
    void refresh();
  }, [refresh]);

  const saveConfig = useCallback(async (patch: Record<string, unknown>) => {
    const id = ++saveIdRef.current;
    try {
      setSaving(true);
      setSaveError(null);
      setSaveSuccess(false);
      if (successTimerRef.current !== null) {
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
      if (successTimerRef.current !== null) {
        clearTimeout(successTimerRef.current);
      }
    };
  }, []);

  return { config, loading, error, saving, saveError, saveSuccess, saveConfig, refresh };
}

export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(() => (
    typeof window === 'undefined'
      ? null
      : sessionIdFromLocation(window.location.pathname, window.location.hash, window.location.search)
  ));
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
    void refresh();
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
      syncSessionLocation(created.id);
      void refresh();
      return created.id;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create session');
      return null;
    } finally {
      setCreating(false);
    }
  }, [refresh, sessionId, sessions]);

  const switchSession = useCallback((id: string | null) => {
    setSessionId(id);
    syncSessionLocation(id);
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
    void poll();
    return () => { active = false; };
  }, []);

  return { connected };
}
