import { useCallback, useEffect, useState } from 'react';
import { api, type FsEntry, type FsGitStatus, type FsGitStatusResponse, type FsReadResponse } from '../api/client';

export type { FsEntry, FsGitStatus, FsReadResponse };

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const HIDDEN_BUILD_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'dist-app', 'build', 'coverage', '.next', '.turbo']);

export function useFilesystem(sessionId: string | null) {
  const [error, setError] = useState<string | null>(null);
  const [gitStatuses, setGitStatuses] = useState<Record<string, FsGitStatus>>({});
  const [branch, setBranch] = useState<string | null>(null);
  const [gitStatus, setGitStatus] = useState<FsGitStatusResponse | null>(null);

  const refreshGitStatus = useCallback(async (): Promise<FsGitStatusResponse | null> => {
    if (!sessionId) return null;
    try {
      const status = await api.sessions.fs.gitStatus(sessionId);
      setGitStatuses(status.entries);
      setBranch(status.branch || null);
      setGitStatus(status);
      return status;
    } catch {
      setGitStatuses({});
      setBranch(null);
      setGitStatus(null);
      return null;
    }
  }, [sessionId]);

  useEffect(() => {
    setError(null);
    setGitStatuses({});
    setBranch(null);
    setGitStatus(null);
    if (!sessionId) return;
    void refreshGitStatus();
  }, [refreshGitStatus, sessionId]);

  const readDir = useCallback(async (path: string): Promise<FsEntry[]> => {
    if (!sessionId) return [];
    try {
      const result = await api.sessions.fs.list(sessionId, path);
      setError(null);
      return result.items
        .filter(entry => entry.kind !== 'directory' || !HIDDEN_BUILD_DIRECTORIES.has(entry.name))
        .map(entry => ({
          ...entry,
          git_status: entry.git_status ?? gitStatuses[entry.path],
        }));
    } catch (caught) {
      setError(toErrorMessage(caught));
      return [];
    }
  }, [gitStatuses, sessionId]);

  const readFile = useCallback(async (path: string): Promise<FsReadResponse | null> => {
    if (!sessionId) return null;
    try {
      const result = await api.sessions.fs.read(sessionId, path);
      setError(null);
      return result;
    } catch (caught) {
      setError(toErrorMessage(caught));
      return null;
    }
  }, [sessionId]);

  return { error, branch, gitStatus, gitStatuses, refreshGitStatus, readDir, readFile };
}
