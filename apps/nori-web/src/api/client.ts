/**
 * API client for Nori backend REST endpoints.
 * In Electron desktop mode, the origin is the local server.
 * In dev mode, Vite proxies /api to the local server.
 */

// === TypeScript Interfaces ===

export interface MessageContent {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'swarm_status';
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  output?: string;
  swarm_id?: string;
  status?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: MessageContent[];
  created_at: string;
  session_id?: string;
  thinking?: string;
  tool_calls?: Array<{ name: string; args?: unknown; result?: string }>;
}

export interface Session {
  id: string;
  title: string;
  status: string;
  created_at: string;
  updated_at: string;
  workspace_id?: string;
  message_count?: number;
}

export interface Snapshot {
  id: string;
  session_id: string;
  created_at: string;
  [key: string]: unknown;
}

export interface ConfigResponse {
  [key: string]: unknown;
}

export interface PhaseStatus {
  phase: 'plan' | 'implement' | 'review' | 'idle';
  step: number;
  mode?: string;
}

export interface Note {
  title: string;
  type: 'analysis' | 'decision' | 'task' | 'review';
  folder: string;
  preview: string;
  date: string;
  path: string;
  content?: string;
}

export interface SwarmStatus {
  swarm_id: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  task_count: number;
  completed_count: number;
}

export interface PromptResponse {
  prompt_id: string;
}

/** Alias for ConfigResponse — used by hook code that expects this name. */
export type ConfigData = ConfigResponse;

/** Alias for Session — used by hook code that expects this name. */
export type SessionData = Session;

// === Internal Helpers ===

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

interface RequestOptions {
  signal?: AbortSignal;
  timeout?: number;
  method?: 'GET' | 'POST';
  body?: unknown;
}

// === Client Factory ===

export function createClient(serverOrigin?: string, token?: string) {
  // Auto-detect from URL hash/query params when not provided explicitly
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const queryParams = new URLSearchParams(window.location.search);
  const origin =
    serverOrigin ??
    (hashParams.get('server') ||
    queryParams.get('server') ||
    window.location.origin);
  const authToken =
    token ??
    (hashParams.get('token') ||
    queryParams.get('token') ||
    undefined);

  const API_BASE = `${origin}/api/v1`;

  async function request<T>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
    options?: RequestOptions,
  ): Promise<T> {
    const url = new URL(`${API_BASE}${path}`, window.location.origin);
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined) url.searchParams.set(k, String(v));
      });
    }

    const controller = new AbortController();

    // Wire external signal to abort the internal controller
    if (options?.signal) {
      if (options.signal.aborted) {
        controller.abort();
      } else {
        options.signal.addEventListener(
          'abort',
          () => { controller.abort(); },
          { once: true },
        );
      }
    }

    // Apply timeout (always aborts the internal controller used by fetch)
    const timeout = options?.timeout ?? 15_000;
    const timeoutId = setTimeout(() => { controller.abort(); }, timeout);

    try {
      const method = options?.method ?? 'GET';
      const headers: Record<string, string> = {};
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      if (method === 'POST' && options?.body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }

      const init: RequestInit = {
        method,
        signal: controller.signal,
        headers,
      };
      if (method === 'POST' && options?.body !== undefined) {
        init.body = JSON.stringify(options.body);
      }

      const res = await fetch(url.toString(), init);
      clearTimeout(timeoutId);

      if (!res.ok) {
        throw new Error(`API ${method} ${path} failed: ${res.status}`);
      }

      // Handle empty responses (204, or empty body)
      const text = await res.text();
      if (!text) return undefined as unknown as T;

      const envelope: Envelope<T> = JSON.parse(text);
      if (envelope.code !== 0) {
        throw new Error(`API error: ${envelope.msg}`);
      }
      return envelope.data;
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  // === Public API ===

  return {
    // --- Vault ---
    vault: {
      search: (q: string, types?: string[], signal?: AbortSignal) =>
        request<Note[]>(
          '/vault/search',
          { q, ...(types ? { types: types.join(',') } : {}) },
          { signal },
        ),
      list: (type?: string, signal?: AbortSignal) =>
        request<Note[]>('/vault/notes', type ? { type } : {}, { signal }),
      get: (noteId: string, signal?: AbortSignal) =>
        request<Note & { content: string } | null>(
          `/vault/notes/${encodeURIComponent(noteId)}`,
          undefined,
          { signal },
        ),
    },

    // --- Swarm ---
    swarm: {
      status: (swarmId: string, signal?: AbortSignal) =>
        request<SwarmStatus>(`/swarm/status/${encodeURIComponent(swarmId)}`, undefined, { signal }),
    },

    // --- Phase ---
    phase: {
      status: (signal?: AbortSignal) =>
        request<PhaseStatus>('/phase/status', undefined, { signal }),
    },

    // --- Sessions ---
    sessions: {
      create: (cwd?: string) =>
        request<{ id: string }>(
          '/sessions',
          undefined,
          {
            method: 'POST',
            body: { metadata: { cwd } },
          },
        ),

      list: (params?: { status?: string; include_archive?: boolean; exclude_empty?: boolean }) =>
        request<{ items: Session[] }>('/sessions', {
          status: params?.status,
          include_archive: params?.include_archive,
          exclude_empty: params?.exclude_empty,
        }),

      get: (id: string) =>
        request<Session>(`/sessions/${encodeURIComponent(id)}`),

      getSnapshot: (id: string) =>
        request<Snapshot>(`/sessions/${encodeURIComponent(id)}/snapshot`),

      getMessages: (id: string, params?: { before_id?: string; page_size?: number }) =>
        request<{ items: Message[] }>(`/sessions/${encodeURIComponent(id)}/messages`, {
          before_id: params?.before_id,
          page_size: params?.page_size,
        }),

      sendPrompt: (sessionId: string, text: string) =>
        request<PromptResponse>(
          `/sessions/${encodeURIComponent(sessionId)}/prompts`,
          undefined,
          {
            method: 'POST',
            body: { content: [{ type: 'text', text }] },
          },
        ),

      rename: (id: string, title: string) =>
        request<void>(
          `/sessions/${encodeURIComponent(id)}/profile`,
          undefined,
          {
            method: 'POST',
            body: { title },
          },
        ),

      abort: (id: string) =>
        request<void>(
          `/sessions/${encodeURIComponent(id)}:abort`,
          undefined,
          { method: 'POST' },
        ),

      archive: (id: string) =>
        request<void>(
          `/sessions/${encodeURIComponent(id)}:archive`,
          undefined,
          { method: 'POST' },
        ),
    },

    // --- Config ---
    config: {
      get: () =>
        request<ConfigResponse>('/config'),

      update: (patch: Record<string, unknown>) =>
        request<ConfigResponse>(
          '/config',
          undefined,
          {
            method: 'POST',
            body: patch,
          },
        ),
    },

    // --- Convenience Methods ---
    getPhaseStatus: (signal?: AbortSignal) =>
      request<PhaseStatus>('/phase/status', undefined, { signal }),

    createSession: (cwd?: string) =>
      request<{ id: string }>(
        '/sessions',
        undefined,
        {
          method: 'POST',
          body: { metadata: { cwd } },
        },
      ),

    listSessions: (params?: { status?: string; include_archive?: boolean; exclude_empty?: boolean }) =>
      request<{ items: Session[] }>('/sessions', {
        status: params?.status,
        include_archive: params?.include_archive,
        exclude_empty: params?.exclude_empty,
      }),

    getSession: (id: string) =>
      request<Session>(`/sessions/${encodeURIComponent(id)}`),

    getSnapshot: (id: string) =>
      request<Snapshot>(`/sessions/${encodeURIComponent(id)}/snapshot`),

    getMessages: (id: string, params?: { before_id?: string; page_size?: number }) =>
      request<{ items: Message[] }>(`/sessions/${encodeURIComponent(id)}/messages`, {
        before_id: params?.before_id,
        page_size: params?.page_size,
      }),

    sendPrompt: (sessionId: string, text: string) =>
      request<PromptResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/prompts`,
        undefined,
        {
          method: 'POST',
          body: { content: [{ type: 'text', text }] },
        },
      ),

    renameSession: (id: string, title: string) =>
      request<void>(
        `/sessions/${encodeURIComponent(id)}/profile`,
        undefined,
        {
          method: 'POST',
          body: { title },
        },
      ),

    abortSession: (id: string) =>
      request<void>(
        `/sessions/${encodeURIComponent(id)}:abort`,
        undefined,
        { method: 'POST' },
      ),

    archiveSession: (id: string) =>
      request<void>(
        `/sessions/${encodeURIComponent(id)}:archive`,
        undefined,
        { method: 'POST' },
      ),

    getConfig: () =>
      request<ConfigResponse>('/config'),

    updateConfig: (patch: Record<string, unknown>) =>
      request<ConfigResponse>(
        '/config',
        undefined,
        {
          method: 'POST',
          body: patch,
        },
      ),

    healthz: () => request<{ ok: boolean }>('/healthz'),

    getWsUrl: (): string => {
      const url = new URL(origin);
      const protocol = url.protocol === 'https:' ? 'wss' : 'ws';
      const host = url.host;
      const params = new URLSearchParams();
      if (authToken) params.set('token', authToken);
      const qs = params.toString();
      return `${protocol}://${host}/api/v1/ws${qs ? `?${qs}` : ''}`;
    },
  };
}

export type ApiClient = ReturnType<typeof createClient>;

// === Default Client Instance ===

// Read server origin and auth token from URL hash or query params (set by Electron desktop)
const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
const queryParams = new URLSearchParams(window.location.search);
const SERVER_ORIGIN =
  hashParams.get('server') || queryParams.get('server') || window.location.origin;
const TOKEN = hashParams.get('token') || queryParams.get('token') || undefined;

/** Default pre-configured API client instance. */
export const api: ApiClient = createClient(SERVER_ORIGIN, TOKEN);
