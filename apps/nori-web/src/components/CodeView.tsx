import { useEffect, useState } from 'react';
import { ChatView, type ChatViewProps } from './ChatView';
import { WorkspaceInspector } from './WorkspaceInspector';
import { SplitPane } from './SplitPane';
import { useFilesystem } from '../hooks/useFilesystem';
import type { ApprovalRequest, FsEntry, FsReadResponse, ModelCatalogItem, QuestionAnswer, QuestionRequest, Session, SessionAgentConfig, SessionRealtimeStatus } from '../api/client';
import type { ChatMessage, CodeChange, QueuedPrompt, TodoItem, WorkBlock } from '../hooks/useChatMessages';

interface CodeViewProps {
  session: Session | null;
  allSessions?: Session[];
  messages: ChatMessage[];
  streaming: string;
  thinking: string;
  workBlocks?: WorkBlock[];
  isStreaming: boolean;
  activeAgentCount?: number;
  activeAgentTokens?: number;
  sessionStatus?: SessionRealtimeStatus | null;
  compacting?: boolean;
  models: ModelCatalogItem[];
  modelsLoading: boolean;
  modelError: string | null;
  onRefreshModels: () => void;
  onModelChange: (model: string) => void | Promise<void>;
  onThinkingChange: (effort: string) => void | Promise<void>;
  onPermissionChange: (mode: 'auto' | 'yolo' | 'manual') => void | Promise<void>;
  onTaskModeChange: (mode: 'plan' | 'code') => void | Promise<void>;
  onMainWriteChange: (enabled: boolean) => void | Promise<void>;
  onGoalControl?: (action: 'pause' | 'resume' | 'cancel') => void | Promise<void>;
  onSendMessage: ChatViewProps['onSendMessage'];
  onAbort: () => void;
  onModeChange?: (mode: 'work') => void;
  pendingApprovals?: ApprovalRequest[];
  onResolveApproval?: (approvalId: string, decision: 'approved' | 'rejected' | 'cancelled', options?: { remember?: boolean; feedback?: string; selectedLabel?: string }) => void | Promise<void>;
  pendingQuestions?: QuestionRequest[];
  onResolveQuestion?: (questionId: string, answers: Record<string, QuestionAnswer>) => void | Promise<void>;
  onDismissQuestion?: (questionId: string) => void | Promise<void>;
  queuedPrompts?: QueuedPrompt[];
  todos?: TodoItem[];
  onCancelQueuedPrompt?: (promptId: string) => void | Promise<void>;
  selectedFile?: FsEntry | null;
  codeChanges?: CodeChange[];
  draftAgentConfig?: SessionAgentConfig;
  rewindLimit?: number;
  onRewind?: (count: number) => void | Promise<void>;
}

export function CodeView({
  session,
  allSessions,
  messages,
  streaming,
  thinking,
  workBlocks,
  isStreaming,
  activeAgentCount,
  activeAgentTokens,
  sessionStatus,
  compacting,
  models,
  modelsLoading,
  modelError,
  onRefreshModels,
  onModelChange,
  onThinkingChange,
  onPermissionChange,
  onTaskModeChange,
  onMainWriteChange,
  onGoalControl,
  onSendMessage,
  onAbort,
  onModeChange,
  pendingApprovals,
  onResolveApproval,
  pendingQuestions,
  onResolveQuestion,
  onDismissQuestion,
  queuedPrompts,
  todos,
  onCancelQueuedPrompt,
  selectedFile,
  codeChanges = [],
  draftAgentConfig,
  rewindLimit,
  onRewind,
}: CodeViewProps) {
  const [fileContent, setFileContent] = useState<FsReadResponse | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const { readFile, gitStatus, refreshGitStatus } = useFilesystem(session?.id ?? null);

  useEffect(() => {
    setFileContent(null);
    setFileLoading(false);
  }, [session?.id]);

  useEffect(() => {
    if (!selectedFile) {
      setFileContent(null);
      return;
    }
    let cancelled = false;
    setFileLoading(true);
    void readFile(selectedFile.path).then(content => {
      if (!cancelled) setFileContent(content);
    }).finally(() => { if (!cancelled) setFileLoading(false); });
    return () => { cancelled = true; };
  }, [readFile, selectedFile]);

  return (
    <SplitPane direction="horizontal" defaultSize={60} minSize={30} maxSize={80}>
      <ChatView
        session={session}
        allSessions={allSessions}
        messages={messages}
        streaming={streaming}
        thinking={thinking}
        workBlocks={workBlocks}
        isStreaming={isStreaming}
        activeAgentCount={activeAgentCount}
        activeAgentTokens={activeAgentTokens}
        sessionStatus={sessionStatus}
        compacting={compacting}
        models={models}
        modelsLoading={modelsLoading}
        modelError={modelError}
        onRefreshModels={onRefreshModels}
        onModelChange={onModelChange}
        onThinkingChange={onThinkingChange}
        onPermissionChange={onPermissionChange}
        onTaskModeChange={onTaskModeChange}
        onMainWriteChange={onMainWriteChange}
        onGoalControl={onGoalControl}
        onSendMessage={onSendMessage}
        onAbort={onAbort}
        pendingApprovals={pendingApprovals}
        onResolveApproval={onResolveApproval}
        pendingQuestions={pendingQuestions}
        onResolveQuestion={onResolveQuestion}
        onDismissQuestion={onDismissQuestion}
        queuedPrompts={queuedPrompts}
        todos={todos}
        onCancelQueuedPrompt={onCancelQueuedPrompt}
        draftAgentConfig={draftAgentConfig}
        rewindLimit={rewindLimit}
        onRewind={onRewind}
      />
      <WorkspaceInspector
        sessionId={session?.id ?? null}
        path={selectedFile?.path ?? ''}
        file={fileContent}
        loading={fileLoading}
        messages={messages}
        codeChanges={codeChanges}
        gitStatus={gitStatus}
        refreshGitStatus={refreshGitStatus}
        isStreaming={isStreaming}
      />
    </SplitPane>
  );
}
