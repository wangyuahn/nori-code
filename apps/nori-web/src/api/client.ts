/**
 * API client for Nori backend REST endpoints.
 * In Electron desktop mode, the origin is the local server.
 * In dev mode, Vite proxies /api to the local server.
 */

// === TypeScript Interfaces ===

export interface MessageContent {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'swarm_status' | 'image' | 'video' | 'file';
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  output?: string;
  swarm_id?: string;
  status?: string;
  tool_call_id?: string;
  tool_name?: string;
  source?: PromptImageSource;
  file_id?: string;
  media_type?: string;
  size?: number;
}

export interface PromptImageSource {
  kind: 'base64';
  media_type: string;
  data: string;
}

export interface PromptImage {
  kind: 'image';
  name: string;
  source: PromptImageSource;
}

export interface PromptFile {
  kind: 'file';
  name: string;
  file_id: string;
  media_type: string;
  size: number;
}

export type PromptAttachment = PromptImage | PromptFile;

export interface FileMeta {
  id: string;
  name: string;
  media_type: string;
  size: number;
  created_at: string;
  expires_at?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: MessageContent[];
  created_at: string;
  session_id?: string;
  thinking?: string;
  tool_calls?: Array<{ id?: string; name: string; args?: unknown; result?: string }>;
  metadata?: {
    origin?: { kind?: string; [key: string]: unknown };
    [key: string]: unknown;
  };
}

export interface SessionAgentConfig {
  model?: string;
  thinking?: string;
  permission_mode?: 'manual' | 'yolo' | 'auto';
  plan_mode?: boolean;
  main_write_enabled?: boolean;
  [key: string]: unknown;
}

export interface Session {
  id: string;
  title: string;
  status: string;
  created_at: string;
  updated_at: string;
  workspace_id?: string;
  message_count?: number;
  current_prompt_id?: string;
  metadata?: { cwd?: string; [key: string]: unknown };
  agent_config?: SessionAgentConfig;
  archived?: boolean;
}

export interface TokenUsage {
  input_other: number;
  output: number;
  input_cache_read: number;
  input_cache_creation: number;
}

export type GoalStatus = 'active' | 'paused' | 'blocked' | 'complete';

export interface GoalSnapshot {
  goalId: string;
  objective: string;
  completionCriterion?: string;
  status: GoalStatus;
  turnsUsed: number;
  tokensUsed: number;
  wallClockMs: number;
  budget: {
    tokenBudget: number | null;
    turnBudget: number | null;
    wallClockBudgetMs: number | null;
    remainingTokens: number | null;
    remainingTurns: number | null;
    remainingWallClockMs: number | null;
    tokenBudgetReached: boolean;
    turnBudgetReached: boolean;
    wallClockBudgetReached: boolean;
    overBudget: boolean;
  };
  terminalReason?: string;
}

export interface SessionRealtimeStatus {
  status: string;
  model?: string;
  thinking_level: string;
  permission: string;
  plan_mode: boolean;
  main_write_enabled: boolean;
  swarm_mode: boolean;
  goal: GoalSnapshot | null;
  context_tokens: number;
  max_context_tokens: number;
  context_usage: number;
  usage?: {
    by_model?: Record<string, TokenUsage>;
    current_turn?: TokenUsage;
    total?: TokenUsage;
  };
}

export interface SessionCreateOptions {
  cwd: string;
  agent_config?: SessionAgentConfig;
  smart_title?: boolean;
}

export interface WorkspaceFolderEntry {
  name: string;
  path: string;
  is_dir: true;
  is_git_repo: boolean;
  branch?: string;
}

export interface WorkspaceFolderBrowseResponse {
  path: string;
  parent: string | null;
  entries: WorkspaceFolderEntry[];
}

export interface WorkspaceFolderHomeResponse {
  home: string;
  recent_roots: string[];
}

export type FsGitStatus = 'clean' | 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'ignored' | 'conflicted';

export interface FsEntry {
  path: string;
  name: string;
  kind: 'file' | 'directory' | 'symlink';
  size?: number;
  modified_at: string;
  mime?: string;
  language_id?: string;
  is_binary?: boolean;
  git_status?: FsGitStatus;
  child_count?: number;
}

export interface FsListResponse {
  items: FsEntry[];
  truncated: boolean;
}

export interface FsReadResponse {
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  size: number;
  truncated: boolean;
  mime: string;
  language_id?: string;
  is_binary: boolean;
}

export interface FsGitStatusResponse {
  branch: string;
  ahead: number;
  behind: number;
  entries: Record<string, FsGitStatus>;
  additions: number;
  deletions: number;
  pullRequest?: { number: number; state: 'open' | 'merged' | 'closed' | 'draft'; url: string } | null;
}

export interface FsDiffResponse {
  path: string;
  diff: string;
  truncated: boolean;
}

export interface FsGitCommitResponse {
  committed: true;
  commit: string;
  summary: string;
}

export interface FsGitPushResponse {
  pushed: true;
  remote: string;
  branch: string;
  summary: string;
}

export interface ModelCatalogItem {
  provider: string;
  model: string;
  display_name?: string;
  max_context_size: number;
  max_output_size?: number;
  capabilities?: string[];
  support_efforts?: string[];
  default_effort?: string;
}

export interface ProviderCatalogItem {
  id: string;
  type: string;
  base_url?: string;
  default_model?: string;
  has_api_key: boolean;
  status: 'connected' | 'error' | 'unconfigured';
  models?: string[];
}

export interface ProviderPreset {
  id: string;
  name: string;
  type: 'anthropic' | 'openai' | 'kimi' | 'google-genai' | 'openai_responses' | 'vertexai';
  base_url?: string;
  env: string[];
  model_count: number;
}

export interface ProviderRefreshResult {
  changed: Array<{ provider_id: string; provider_name: string; added: number; removed: number }>;
  unchanged: string[];
  failed: Array<{ provider: string; reason: string }>;
}

export interface Snapshot {
  as_of_seq: number;
  epoch: string;
  session: Session;
  messages: { items: Message[]; has_more: boolean };
  in_flight_turn: {
    turn_id: number;
    assistant_text: string;
    thinking_text: string;
    running_tools: Array<{ tool_call_id: string; name: string; args?: unknown }>;
    current_prompt_id?: string;
  } | null;
  pending_approvals?: ApprovalRequest[];
  pending_questions?: QuestionRequest[];
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
  links?: string[];
}

export interface SwarmStatus {
  swarm_id: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  task_count: number;
  completed_count: number;
  session_id?: string;
  task_id?: string;
  description?: string;
  owner_agent_id?: string;
  round?: number;
  started_at?: string;
  usage?: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
    total: number;
  };
  tasks?: Array<{
    id: string;
    label: string;
    status: string;
    agent_id?: string;
    parent_agent_id?: string;
    profile?: string;
    output?: string;
    output_bytes?: number;
    usage?: {
      input: number;
      output: number;
      cache_read: number;
      cache_write: number;
      total: number;
    };
    context_tokens?: number;
  }>;
}

export interface BackgroundTask {
  id: string;
  session_id: string;
  kind: 'subagent' | 'bash' | 'tool';
  description: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  command?: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  output_preview?: string;
  output_bytes?: number;
}

export interface SkillDescriptor {
  name: string;
  description: string;
  path: string;
  source: string;
  type?: string;
  disable_model_invocation?: boolean;
}

export interface PromptResponse {
  prompt_id: string;
  user_message_id: string;
  status: 'running' | 'queued';
  content: MessageContent[];
  created_at: string;
}

export interface PromptListResponse {
  active: PromptResponse | null;
  queued: PromptResponse[];
}

export interface UndoSessionResponse {
  messages: { items: Message[]; has_more?: boolean; next_cursor?: string };
  status: { status?: string; [key: string]: unknown };
}

export interface ApprovalRequest {
  approval_id: string;
  session_id: string;
  turn_id?: number;
  tool_call_id: string;
  tool_name: string;
  action: string;
  tool_input_display: unknown;
  created_at: string;
  expires_at: string;
}

export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface QuestionItem {
  id: string;
  question: string;
  header?: string;
  body?: string;
  options: QuestionOption[];
  multi_select?: boolean;
  allow_other?: boolean;
  other_label?: string;
  other_description?: string;
}

export interface QuestionRequest {
  question_id: string;
  session_id: string;
  turn_id?: number;
  tool_call_id?: string;
  questions: QuestionItem[];
  created_at: string;
}

export type QuestionAnswer =
  | { kind: 'single'; option_id: string }
  | { kind: 'multi'; option_ids: string[] }
  | { kind: 'other'; text: string }
  | { kind: 'multi_with_other'; option_ids: string[]; other_text: string }
  | { kind: 'skipped' };

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
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  acceptedCodes?: number[];
}

// === Client Factory ===

export async function getServerToken(): Promise<string | undefined> {
  if (!window.noriDesktop?.getServerToken) return undefined;
  try {
    return await window.noriDesktop.getServerToken();
  } catch {
    return undefined;
  }

}

export function getServerOrigin(): string {
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const queryParams = new URLSearchParams(window.location.search);
  return hashParams.get('server') || queryParams.get('server') || window.location.origin;
}

export function createClient(
  serverOrigin?: string,
  token?: string | (() => Promise<string | undefined>),
) {
  // Auto-detect from URL hash/query params when not provided explicitly
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const queryParams = new URLSearchParams(window.location.search);
  const origin =
    serverOrigin ??
    (hashParams.get('server') ||
    queryParams.get('server') ||
    window.location.origin);
  const getToken = typeof token === 'function' ? token : async () => token;

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
      let currentToken: string | undefined;
      try {
        currentToken = await getToken();
      } catch {
        currentToken = undefined;
      }
      if (currentToken) headers['Authorization'] = `Bearer ${currentToken}`;
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
      if (envelope.code !== 0 && !options?.acceptedCodes?.includes(envelope.code)) {
        throw new Error(`API error: ${envelope.msg}`);
      }
      return envelope.data;
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  async function uploadFile(file: File): Promise<FileMeta> {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('name', file.name);
    const headers: Record<string, string> = {};
    const currentToken = await getToken().catch(() => undefined);
    if (currentToken) headers['Authorization'] = `Bearer ${currentToken}`;
    const response = await fetch(`${API_BASE}/files`, { method: 'POST', headers, body: form });
    if (!response.ok) throw new Error(`File upload failed: ${response.status}`);
    const envelope = await response.json() as Envelope<FileMeta>;
    if (envelope.code !== 0) throw new Error(`File upload failed: ${envelope.msg}`);
    return envelope.data;
  }

  // === Public API ===

  return {
    files: {
      upload: uploadFile,
      delete: (fileId: string) => request<{ deleted: true }>(
        `/files/${encodeURIComponent(fileId)}`,
        undefined,
        { method: 'DELETE' },
      ),
    },
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
      create: (options: SessionCreateOptions) =>
        request<Session>(
          '/sessions',
          undefined,
          {
            method: 'POST',
            body: {
              metadata: {
                cwd: options.cwd,
                ...(options.smart_title ? { nori_smart_title: true } : {}),
              },
              ...(options.agent_config ? { agent_config: options.agent_config } : {}),
            },
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

      getStatus: (id: string) =>
        request<SessionRealtimeStatus>(`/sessions/${encodeURIComponent(id)}/status`),

      getSnapshot: (id: string) =>
        request<Snapshot>(`/sessions/${encodeURIComponent(id)}/snapshot`),

      getMessages: (id: string, params?: { before_id?: string; page_size?: number }) =>
        request<{ items: Message[] }>(`/sessions/${encodeURIComponent(id)}/messages`, {
          before_id: params?.before_id,
          page_size: params?.page_size,
        }),

      sendPrompt: (sessionId: string, text: string, attachments: PromptAttachment[] = []) =>
        request<PromptResponse>(
          `/sessions/${encodeURIComponent(sessionId)}/prompts`,
          undefined,
          {
            method: 'POST',
            body: {
              content: [
                ...(text ? [{ type: 'text' as const, text }] : []),
                ...attachments.map(attachment => attachment.kind === 'image'
                  ? { type: 'image' as const, source: attachment.source }
                  : { type: 'file' as const, file_id: attachment.file_id, name: attachment.name, media_type: attachment.media_type, size: attachment.size }),
              ],
            },
          },
        ),

      updateProfile: (id: string, patch: { title?: string; agent_config?: SessionAgentConfig }) =>
        request<Session>(
          `/sessions/${encodeURIComponent(id)}/profile`,
          undefined,
          { method: 'POST', body: patch },
        ),

      rename: (id: string, title: string) =>
        request<Session>(
          `/sessions/${encodeURIComponent(id)}/profile`,
          undefined,
          { method: 'POST', body: { title } },
        ),

      fork: (id: string, title?: string) => request<Session>(
        `/sessions/${encodeURIComponent(id)}:fork`,
        undefined,
        { method: 'POST', body: title?.trim() ? { title: title.trim() } : {} },
      ),

      abort: (id: string) =>
        request<void>(
          `/sessions/${encodeURIComponent(id)}:abort`,
          undefined,
          { method: 'POST' },
        ),

      compact: (id: string) =>
        request<Record<string, never>>(
          `/sessions/${encodeURIComponent(id)}:compact`,
          undefined,
          { method: 'POST', body: {} },
        ),

      undo: (id: string, count: number) =>
        request<UndoSessionResponse>(
          `/sessions/${encodeURIComponent(id)}:undo`,
          undefined,
          { method: 'POST', body: { count, page_size: 100 } },
        ),

      archive: (id: string) =>
        request<void>(
          `/sessions/${encodeURIComponent(id)}:archive`,
          undefined,
          { method: 'POST' },
        ),

      delete: (id: string) =>
        request<{ deleted: true }>(
          `/sessions/${encodeURIComponent(id)}:delete`,
          undefined,
          { method: 'POST' },
        ),

      fs: {
        list: (id: string, path = '.') => request<FsListResponse>(
          `/sessions/${encodeURIComponent(id)}/fs:list`,
          undefined,
          {
            method: 'POST',
            body: {
              path,
              depth: 1,
              limit: 500,
              show_hidden: true,
              follow_gitignore: true,
              include_git_status: true,
              exclude_globs: ['**/.git/**', '**/node_modules/**', '**/dist/**', '**/build/**'],
            },
          },
        ),
        read: (id: string, path: string) => request<FsReadResponse>(
          `/sessions/${encodeURIComponent(id)}/fs:read`,
          undefined,
          { method: 'POST', body: { path, encoding: 'auto', length: 10_485_760 } },
        ),
        gitStatus: (id: string) => request<FsGitStatusResponse>(
          `/sessions/${encodeURIComponent(id)}/fs:git_status`,
          undefined,
          { method: 'POST', body: {} },
        ),
        diff: (id: string, path: string) => request<FsDiffResponse>(
          `/sessions/${encodeURIComponent(id)}/fs:diff`,
          undefined,
          { method: 'POST', body: { path } },
        ),
        commit: (id: string, message: string) => request<FsGitCommitResponse>(
          `/sessions/${encodeURIComponent(id)}/fs:git_commit`,
          undefined,
          { method: 'POST', body: { message } },
        ),
        push: (id: string, options: { remote?: string; branch?: string } = {}) => request<FsGitPushResponse>(
          `/sessions/${encodeURIComponent(id)}/fs:git_push`,
          undefined,
          { method: 'POST', body: options },
        ),
      },

      approvals: {
        list: (id: string) => request<{ items: ApprovalRequest[] }>(
          `/sessions/${encodeURIComponent(id)}/approvals`,
          { status: 'pending' },
        ),
        resolve: (id: string, approvalId: string, input: { decision: 'approved' | 'rejected' | 'cancelled'; remember?: boolean; feedback?: string; selected_label?: string }) => request<{ resolved: true }>(
          `/sessions/${encodeURIComponent(id)}/approvals/${encodeURIComponent(approvalId)}`,
          undefined,
          { method: 'POST', body: {
            decision: input.decision,
            ...(input.remember ? { scope: 'session' } : {}),
            ...(input.feedback?.trim() ? { feedback: input.feedback.trim() } : {}),
            ...(input.selected_label ? { selected_label: input.selected_label } : {}),
          } },
        ),
      },

      questions: {
        list: (id: string) => request<{ items: QuestionRequest[] }>(
          `/sessions/${encodeURIComponent(id)}/questions`,
          { status: 'pending' },
        ),
        resolve: (id: string, questionId: string, answers: Record<string, QuestionAnswer>) => request<{ resolved: true; resolved_at: string }>(
          `/sessions/${encodeURIComponent(id)}/questions/${encodeURIComponent(questionId)}`,
          undefined,
          { method: 'POST', body: { answers, method: 'click' } },
        ),
        dismiss: (id: string, questionId: string) => request<{ dismissed: true; dismissed_at: string }>(
          `/sessions/${encodeURIComponent(id)}/questions/${encodeURIComponent(questionId)}:dismiss`,
          undefined,
          { method: 'POST', body: {}, acceptedCodes: [40909] },
        ),
      },

      prompts: {
        list: (id: string) => request<PromptListResponse>(`/sessions/${encodeURIComponent(id)}/prompts`),
        steer: (id: string, promptIds: string[]) => request<{ steered: true; prompt_ids: string[] }>(
          `/sessions/${encodeURIComponent(id)}/prompts::steer`,
          undefined,
          { method: 'POST', body: { prompt_ids: promptIds } },
        ),
        abort: (id: string, promptId: string) => request<{ aborted: boolean }>(
          `/sessions/${encodeURIComponent(id)}/prompts/${encodeURIComponent(promptId)}:abort`,
          undefined,
          { method: 'POST' },
        ),
      },

      tasks: {
        list: (id: string) => request<{ items: BackgroundTask[] }>(`/sessions/${encodeURIComponent(id)}/tasks`),
        get: (id: string, taskId: string, outputBytes = 65_536) => request<BackgroundTask>(
          `/sessions/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}`,
          { with_output: true, output_bytes: outputBytes },
        ),
        cancel: (id: string, taskId: string) => request<{ cancelled: true }>(
          `/sessions/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}:cancel`,
          undefined,
          { method: 'POST', body: {} },
        ),
      },

      skills: {
        list: (id: string) => request<{ skills: SkillDescriptor[] }>(`/sessions/${encodeURIComponent(id)}/skills`),
        activate: (id: string, skillName: string, args?: string) => request<{ activated: true; skill_name: string }>(
          `/sessions/${encodeURIComponent(id)}/skills/${encodeURIComponent(skillName)}:activate`,
          undefined,
          { method: 'POST', body: args?.trim() ? { args: args.trim() } : {} },
        ),
      },
    },

    workspaceFolders: {
      home: () => request<WorkspaceFolderHomeResponse>('/fs:home'),
      browse: (path?: string) => request<WorkspaceFolderBrowseResponse>(
        '/fs:browse',
        path ? { path } : undefined,
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

    // --- Model catalog and providers ---
    models: {
      list: () => request<{ items: ModelCatalogItem[] }>('/models'),
    },

    providers: {
      list: () => request<{ items: ProviderCatalogItem[] }>('/providers'),
      refresh: (id: string) => request<ProviderRefreshResult>(
        `/providers/${encodeURIComponent(id)}:refresh`,
        undefined,
        { method: 'POST' },
      ),
      refreshAll: () => request<ProviderRefreshResult>(
        '/providers:refresh',
        undefined,
        { method: 'POST' },
      ),
    },

    providerPresets: {
      list: () => request<{ items: ProviderPreset[]; source: string; warning?: string }>('/provider-presets'),
    },

    // --- Convenience Methods ---
    getPhaseStatus: (signal?: AbortSignal) =>
      request<PhaseStatus>('/phase/status', undefined, { signal }),

    createSession: (cwd?: string) =>
      request<Session>(
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

    sendPrompt: (sessionId: string, text: string, attachments: PromptAttachment[] = []) =>
      request<PromptResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/prompts`,
        undefined,
        {
          method: 'POST',
          body: {
            content: [
              ...(text ? [{ type: 'text' as const, text }] : []),
              ...attachments.map(attachment => attachment.kind === 'image'
                ? { type: 'image' as const, source: attachment.source }
                : { type: 'file' as const, file_id: attachment.file_id, name: attachment.name, media_type: attachment.media_type, size: attachment.size }),
            ],
          },
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

    deleteSession: (id: string) =>
      request<{ deleted: true }>(
        `/sessions/${encodeURIComponent(id)}:delete`,
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

    getWsUrl: async (): Promise<string> => {
      const url = new URL(origin);
      const protocol = url.protocol === 'https:' ? 'wss' : 'ws';
      const host = url.host;
      const params = new URLSearchParams();
      let token: string | undefined;
      try {
        token = await getToken();
      } catch {
        token = undefined;
      }
      if (token) params.set('token', token);
      const qs = params.toString();
      return `${protocol}://${host}/api/v1/ws${qs ? `?${qs}` : ''}`;
    },
  };
}

export type ApiClient = ReturnType<typeof createClient>;

// === Default Client Instance ===

/** Default pre-configured API client instance. */
export const api: ApiClient = createClient(getServerOrigin(), getServerToken);
