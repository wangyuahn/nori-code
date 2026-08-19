import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { ChatView, type ChatViewProps } from './ChatView';
import { WorkspaceInspector } from './WorkspaceInspector';
import { useFilesystem } from '../hooks/useFilesystem';
import type { ApprovalRequest, FsEntry, FsReadResponse, ModelCatalogItem, QuestionAnswer, QuestionRequest, Session, SessionAgent, SessionAgentConfig, SessionRealtimeStatus } from '../api/client';
import type { BrowserPermissionDecision, BrowserPermissionRequest } from '../hooks/useBrowser';
import type { ChatMessage, CodeChange, QueuedPrompt, TodoItem, WorkBlock } from '../hooks/useChatMessages';
import { useI18n } from '../i18n';

const INSPECTOR_WIDTH_KEY = 'nori-inspector-width';
const INSPECTOR_DEFAULT_WIDTH = 520;
const INSPECTOR_MIN_WIDTH = 360;
const INSPECTOR_MAX_WIDTH = 760;
const CHAT_MIN_WIDTH = 360;
const INSPECTOR_CHAT_GAP = 14;

interface CodeViewProps {
  session: Session | null;
  agentId?: string;
  sessionAgents?: readonly SessionAgent[];
  allSessions?: Session[];
  messages: ChatMessage[];
  messagesLoading?: boolean;
  streaming: string;
  thinking: string;
  workBlocks?: WorkBlock[];
  isStreaming: boolean;
  streamingTurnId?: string | null;
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
  onRunSlashCommand: ChatViewProps['onRunSlashCommand'];
  onGoalControl?: (action: 'pause' | 'resume' | 'cancel') => void | Promise<void>;
  onSendMessage: ChatViewProps['onSendMessage'];
  onAbort: () => boolean | void | Promise<boolean | void>;
  pendingApprovals?: ApprovalRequest[];
  onResolveApproval?: (approvalId: string, decision: 'approved' | 'rejected' | 'cancelled', options?: { remember?: boolean; feedback?: string; selectedLabel?: string }) => void | Promise<void>;
  globalApprovals?: ApprovalRequest[];
  onResolveGlobalApproval?: ChatViewProps['onResolveApproval'];
  onApprovalPermissionChange?: (mode: 'auto' | 'yolo', request?: ApprovalRequest) => void | Promise<void>;
  approvalSessionTitles?: Readonly<Record<string, string>>;
  approvalResolvingIds?: ReadonlySet<string>;
  approvalErrors?: Readonly<Record<string, string>>;
  onOpenApprovalSession?: (sessionId: string, agentId?: string) => void;
  browserPermissionsOverride?: BrowserPermissionRequest[];
  onResolveBrowserPermissionOverride?: (id: string, decision: BrowserPermissionDecision) => void | Promise<void>;
  showApprovalPanel?: boolean;
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
  onSelectFilePath?: (path: string) => void;
}

export function CodeView({
  session,
  agentId = 'main',
  sessionAgents,
  allSessions,
  messages,
  messagesLoading,
  streaming,
  thinking,
  workBlocks,
  isStreaming,
  streamingTurnId,
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
  onRunSlashCommand,
  onGoalControl,
  onSendMessage,
  onAbort,
  pendingApprovals,
  onResolveApproval,
  globalApprovals,
  onResolveGlobalApproval,
  onApprovalPermissionChange,
  approvalSessionTitles,
  approvalResolvingIds,
  approvalErrors,
  onOpenApprovalSession,
  browserPermissionsOverride,
  onResolveBrowserPermissionOverride,
  showApprovalPanel,
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
  onSelectFilePath,
}: CodeViewProps) {
  const { tr } = useI18n();
  const [fileContent, setFileContent] = useState<FsReadResponse | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [inspectorWidth, setInspectorWidth] = useState(loadInspectorWidth);
  const fileRequestRef = useRef(0);
  const layoutRef = useRef<HTMLDivElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const { readFile, gitStatus, gitError, gitLoading, refreshGitStatus } = useFilesystem(
    session?.id ?? null,
    session?.metadata?.cwd,
  );

  useEffect(() => {
    fileRequestRef.current++;
    setFileContent(null);
    setFileLoading(false);
  }, [session?.id]);

  const refreshSelectedFile = useCallback(async () => {
    const requestId = ++fileRequestRef.current;
    if (!selectedFile) {
      setFileContent(null);
      setFileLoading(false);
      return;
    }
    setFileLoading(true);
    try {
      const content = await readFile(selectedFile.path);
      if (fileRequestRef.current === requestId) setFileContent(content);
    } finally {
      if (fileRequestRef.current === requestId) setFileLoading(false);
    }
  }, [readFile, selectedFile]);

  useEffect(() => {
    void refreshSelectedFile();
    return () => { fileRequestRef.current++; };
  }, [refreshSelectedFile]);

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  const availableInspectorWidth = useCallback(() => layoutRef.current?.getBoundingClientRect().width ?? window.innerWidth, []);
  const updateInspectorWidth = useCallback((nextWidth: number, persist = false) => {
    const width = clampInspectorWidth(nextWidth, availableInspectorWidth());
    setInspectorWidth(width);
    if (persist) {
      try { localStorage.setItem(INSPECTOR_WIDTH_KEY, String(width)); } catch { /* Keep the width in memory. */ }
    }
    return width;
  }, [availableInspectorWidth]);

  const startInspectorResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizeCleanupRef.current?.();
    const layout = layoutRef.current;
    if (!layout) return;

    const startX = event.clientX;
    const startWidth = inspectorWidth;
    let latestWidth = inspectorWidth;
    let finished = false;
    const resizeHandle = event.currentTarget;
    const pointerId = event.pointerId;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    resizeHandle.setPointerCapture(pointerId);
    layout.classList.add('inspector-resizing');
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';

    const move = (moveEvent: PointerEvent) => {
      latestWidth = updateInspectorWidth(startWidth + startX - moveEvent.clientX);
    };
    const cleanup = (persist: boolean) => {
      if (finished) return;
      finished = true;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      if (resizeHandle.hasPointerCapture(pointerId)) resizeHandle.releasePointerCapture(pointerId);
      layout.classList.remove('inspector-resizing');
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      if (persist) {
        try { localStorage.setItem(INSPECTOR_WIDTH_KEY, String(latestWidth)); } catch { /* Keep the width in memory. */ }
      }
      resizeCleanupRef.current = null;
    };
    const finish = () => cleanup(true);

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish, { once: true });
    window.addEventListener('pointercancel', finish, { once: true });
    resizeCleanupRef.current = () => cleanup(false);
  }, [inspectorWidth, updateInspectorWidth]);

  const resizeInspectorWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    updateInspectorWidth(inspectorWidth + (event.key === 'ArrowLeft' ? 24 : -24), true);
  }, [inspectorWidth, updateInspectorWidth]);

  return (
    <div
      ref={layoutRef}
      className="workspace-chat-layout"
      style={{ '--inspector-panel-width': `${inspectorWidth}px` } as CSSProperties}
    >
      <ChatView
        session={session}
        agentId={agentId}
        sessionAgents={sessionAgents}
        allSessions={allSessions}
        messages={messages}
        messagesLoading={messagesLoading}
        streaming={streaming}
        thinking={thinking}
        workBlocks={workBlocks}
        isStreaming={isStreaming}
        streamingTurnId={streamingTurnId}
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
        onRunSlashCommand={onRunSlashCommand}
        onGoalControl={onGoalControl}
        onSendMessage={onSendMessage}
        onAbort={onAbort}
        pendingApprovals={pendingApprovals}
        onResolveApproval={onResolveApproval}
        globalApprovals={globalApprovals}
        onResolveGlobalApproval={onResolveGlobalApproval}
        onApprovalPermissionChange={onApprovalPermissionChange}
        approvalSessionTitles={approvalSessionTitles}
        approvalResolvingIds={approvalResolvingIds}
        approvalErrors={approvalErrors}
        onOpenApprovalSession={onOpenApprovalSession}
        browserPermissionsOverride={browserPermissionsOverride}
        onResolveBrowserPermissionOverride={onResolveBrowserPermissionOverride}
        showApprovalPanel={showApprovalPanel}
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
      <div
        className="workspace-inspector-resizer"
        role="separator"
        aria-label={tr('Resize tool sidebar', '调整工具侧栏宽度')}
        aria-orientation="vertical"
        aria-valuemin={INSPECTOR_MIN_WIDTH}
        aria-valuemax={INSPECTOR_MAX_WIDTH}
        aria-valuenow={inspectorWidth}
        tabIndex={0}
        onPointerMove={event => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const y = Math.max(0, Math.min(bounds.height, event.clientY - bounds.top));
          event.currentTarget.style.setProperty('--resize-highlight-y', `${y}px`);
        }}
        onPointerDown={startInspectorResize}
        onKeyDown={resizeInspectorWithKeyboard}
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
        refreshFile={refreshSelectedFile}
        isStreaming={isStreaming}
        activeAgentCount={activeAgentCount}
        activeAgentTokens={activeAgentTokens}
        mainWorking={isStreaming}
        goal={sessionStatus?.goal ?? null}
        todos={todos}
        onGoalControl={onGoalControl}
        onSelectFilePath={onSelectFilePath}
        overviewFirst
      />
    </div>
  );
}

function loadInspectorWidth(): number {
  try {
    const stored = Number(localStorage.getItem(INSPECTOR_WIDTH_KEY));
    if (Number.isFinite(stored) && stored > 0) return clampInspectorWidth(stored, Number.POSITIVE_INFINITY);
  } catch { /* Use the default width. */ }
  return INSPECTOR_DEFAULT_WIDTH;
}

function clampInspectorWidth(width: number, availableWidth: number): number {
  const availableMaximum = Math.max(INSPECTOR_MIN_WIDTH, availableWidth - CHAT_MIN_WIDTH - INSPECTOR_CHAT_GAP);
  return Math.max(INSPECTOR_MIN_WIDTH, Math.min(INSPECTOR_MAX_WIDTH, availableMaximum, width));
}
