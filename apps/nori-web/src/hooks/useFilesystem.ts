import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type FsEntry, type FsGitStatus, type FsGitStatusResponse, type FsReadResponse } from '../api/client';

export type { FsEntry, FsGitStatus, FsReadResponse };

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const HIDDEN_BUILD_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'dist-app', 'build', 'coverage', '.next', '.turbo']);

const PROJECT_GIT_CACHE_LIMIT = 12;
const projectGitStatusCache = new Map<string, FsGitStatusResponse>();
const projectGitStatusRequests = new Map<string, Promise<FsGitStatusResponse>>();

export interface GitStatusRefreshOptions {
  force?: boolean;
}

export function useFilesystem(sessionId: string | null, projectPath?: string) {
  const projectKey = normalizeProjectKey(projectPath, sessionId);
  const initialStatus = projectKey === null ? null : projectGitStatusCache.get(projectKey) ?? null;
  const [error, setError] = useState<string | null>(null);
  const [gitStatuses, setGitStatuses] = useState<Record<string, FsGitStatus>>(initialStatus?.entries ?? {});
  const [branch, setBranch] = useState<string | null>(initialStatus?.branch || null);
  const [gitStatus, setGitStatus] = useState<FsGitStatusResponse | null>(initialStatus);
  const [gitError, setGitError] = useState<string | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const gitStatusesRef = useRef<Record<string, FsGitStatus>>(initialStatus?.entries ?? {});
  const projectKeyRef = useRef(projectKey);
  const appliedProjectKeyRef = useRef(projectKey);
  const gitRefreshGenerationRef = useRef(0);

  projectKeyRef.current = projectKey;

  const refreshGitStatus = useCallback((options: GitStatusRefreshOptions = {}): Promise<FsGitStatusResponse | null> => {
    if (!sessionId || projectKey === null) return Promise.resolve(null);

    const generation = ++gitRefreshGenerationRef.current;
    setGitLoading(true);
    return loadProjectGitStatus(projectKey, sessionId, options.force === true)
      .then(status => {
        if (projectKeyRef.current !== projectKey || gitRefreshGenerationRef.current !== generation) {
          return status;
        }
        gitStatusesRef.current = status.entries;
        setGitStatuses(previous => sameValue(previous, status.entries) ? previous : status.entries);
        setBranch(status.branch || null);
        setGitStatus(previous => sameValue(previous, status) ? previous : status);
        setGitError(null);
        return status;
      })
      .catch(error => {
        if (projectKeyRef.current === projectKey && gitRefreshGenerationRef.current === generation) {
          // Keep the last successful status visible. A transient process/API
          // failure must not turn a known repository into a non-repository.
          setGitError(toErrorMessage(error));
        }
        return null;
      })
      .finally(() => {
        if (projectKeyRef.current === projectKey && gitRefreshGenerationRef.current === generation) {
          setGitLoading(false);
        }
      });
  }, [projectKey, sessionId]);

  useEffect(() => {
    const projectChanged = appliedProjectKeyRef.current !== projectKey;
    if (projectChanged) {
      appliedProjectKeyRef.current = projectKey;
      gitRefreshGenerationRef.current++;
      const cached = projectKey === null ? undefined : projectGitStatusCache.get(projectKey);
      const entries = cached?.entries ?? {};
      setError(null);
      gitStatusesRef.current = entries;
      setGitStatuses(entries);
      setBranch(cached?.branch || null);
      setGitStatus(cached ?? null);
      setGitError(null);
      setGitLoading(false);
    }
    if (!sessionId) return;
    if (projectKey !== null && projectGitStatusCache.has(projectKey)) return;
    void refreshGitStatus();
  }, [projectKey, refreshGitStatus, sessionId]);

  const readDir = useCallback(async (path: string): Promise<FsEntry[]> => {
    if (!sessionId) return [];
    try {
      const result = await api.sessions.fs.list(sessionId, path);
      setError(null);
      return result.items
        .filter(entry => entry.kind !== 'directory' || !HIDDEN_BUILD_DIRECTORIES.has(entry.name))
        .map(entry => ({
          ...entry,
          git_status: entry.git_status ?? gitStatusesRef.current[entry.path],
        }));
    } catch (error) {
      setError(toErrorMessage(error));
      return [];
    }
  }, [sessionId]);

  const readFile = useCallback(async (path: string): Promise<FsReadResponse | null> => {
    if (!sessionId) return null;
    try {
      const result = await api.sessions.fs.read(sessionId, path);
      setError(null);
      return result;
    } catch (error) {
      setError(toErrorMessage(error));
      return null;
    }
  }, [sessionId]);

  return { error, branch, gitStatus, gitError, gitLoading, gitStatuses, refreshGitStatus, readDir, readFile };
}

function normalizeProjectKey(projectPath: string | undefined, sessionId: string | null): string | null {
  const normalized = projectPath?.trim().replaceAll('\\', '/').replace(/\/+$/, '').toLocaleLowerCase();
  return normalized || (sessionId ? `session:${sessionId}` : null);
}

function rememberProjectGitStatus(projectKey: string, status: FsGitStatusResponse): void {
  projectGitStatusCache.delete(projectKey);
  projectGitStatusCache.set(projectKey, status);
  while (projectGitStatusCache.size > PROJECT_GIT_CACHE_LIMIT) {
    const oldest = projectGitStatusCache.keys().next().value;
    if (oldest === undefined) break;
    projectGitStatusCache.delete(oldest);
  }
}

function loadProjectGitStatus(projectKey: string, sessionId: string, force = false): Promise<FsGitStatusResponse> {
  const existing = force ? undefined : projectGitStatusRequests.get(projectKey);
  if (existing) return existing;

  let request!: Promise<FsGitStatusResponse>;
  request = api.sessions.fs.gitStatus(sessionId).then(status => {
    const newer = projectGitStatusRequests.get(projectKey);
    if (newer !== undefined && newer !== request) return newer;
    rememberProjectGitStatus(projectKey, status);
    return status;
  }).finally(() => {
    if (projectGitStatusRequests.get(projectKey) === request) {
      projectGitStatusRequests.delete(projectKey);
    }
  });
  projectGitStatusRequests.set(projectKey, request);
  return request;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
