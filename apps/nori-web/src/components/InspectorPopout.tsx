import { useCallback, useEffect, useRef, useState } from 'react';

import { api, type FsReadResponse, type Session } from '../api/client';
import { useChatMessages } from '../hooks/useChatMessages';
import { useFilesystem } from '../hooks/useFilesystem';
import { WorkspaceInspector, type InspectorTab } from './WorkspaceInspector';

export function InspectorPopout({ tab, sessionId, path }: { tab: InspectorTab; sessionId: string | null; path: string }) {
  const [session, setSession] = useState<Session | null>(null);
  const [file, setFile] = useState<FsReadResponse | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const fileRequestRef = useRef(0);
  const chat = useChatMessages(sessionId, session?.title);
  const filesystem = useFilesystem(sessionId, session?.metadata?.cwd);

  const refreshFile = useCallback(async () => {
    const requestId = ++fileRequestRef.current;
    if (!path) { setFile(null); setLoading(false); return; }
    setLoading(true);
    try {
      const value = await filesystem.readFile(path);
      if (fileRequestRef.current === requestId) setFile(value);
    } finally {
      if (fileRequestRef.current === requestId) setLoading(false);
    }
  }, [filesystem.readFile, path]);

  useEffect(() => {
    if (!sessionId) { setSession(null); return; }
    let cancelled = false;
    void api.sessions.get(sessionId).then(value => { if (!cancelled) setSession(value); });
    return () => { cancelled = true; };
  }, [sessionId]);

  useEffect(() => {
    void refreshFile();
    return () => { fileRequestRef.current++; };
  }, [refreshFile]);

  return <main className="inspector-popout-window"><WorkspaceInspector
    sessionId={sessionId}
    projectPath={session?.metadata?.cwd}
    path={path}
    file={file}
    loading={loading}
    messages={chat.messages}
    codeChanges={chat.codeChanges}
    gitStatus={filesystem.gitStatus}
    gitError={filesystem.gitError}
    gitLoading={filesystem.gitLoading}
    refreshGitStatus={filesystem.refreshGitStatus}
    refreshMessages={chat.refreshMessages}
    refreshFile={refreshFile}
    isStreaming={chat.isStreaming}
    initialTab={tab}
    standalone
  /></main>;
}
