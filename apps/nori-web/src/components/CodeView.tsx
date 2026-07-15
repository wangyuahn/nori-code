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
  messagesLoading?: boolean;
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
  onRunSlashCommand: ChatViewProps['onRunSlashCommand'];
  onMainWriteChange: (enabled: boolean) => void | Promise<void>;
  onGoalControl?: (action: 'pause' | 'resume' | 'cancel') => void | Promise<void>;
  onSendMessage: ChatViewProps['onSendMessage'];
  onAbort: () => void;
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
  onRewind?: (count: number) => string | undefined | Promise<string | undefined>;
  onRefreshMessages?: () => Promise<void>;
}

export function CodeView({
  session,
  allSessions,
  messages,
  messagesLoading,
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
  onRunSlashCommand,
  onMainWriteChange,
  onGoalControl,
  onSendMessage,
  onAbort,
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
  onRefreshMessages,
}: CodeViewProps) {
  const [fileContent, setFileContent] = useState<FsReadResponse | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const { readFile, gitStatus, gitError, gitLoading, refreshGitStatus } = useFilesystem(
    session?.id ?? null,
    session?.metadata?.cwd,
  );

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
        messagesLoading={messagesLoading}
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
        onRunSlashCommand={onRunSlashCommand}
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
        projectPath={session?.metadata?.cwd}
        path={selectedFile?.path ?? ''}
        file={fileContent}
        loading={fileLoading}
        messages={messages}
        codeChanges={codeChanges}
        gitStatus={gitStatus}
        gitError={gitError}
        gitLoading={gitLoading}
        refreshGitStatus={refreshGitStatus}
        refreshMessages={onRefreshMessages}
        isStreaming={isStreaming}
      />
    </SplitPane>
  );
}
