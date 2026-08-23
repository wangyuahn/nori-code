import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type UIEvent } from 'react';
import { api, type ApprovalRequest, type GoalSnapshot, type ModelCatalogItem, type PromptAttachment, type PromptExecutionOptions, type QuestionAnswer, type QuestionRequest, type Session, type SessionAgent, type SessionAgentConfig, type SessionRealtimeStatus, type TokenUsage } from '../api/client';
import { mergeWorkBlocks, type ChatMessage, type QueuedPrompt, type TodoItem, type ToolCall, type WorkBlock } from '../hooks/useChatMessages';
import { useBrowserPermissions, type BrowserPermissionRequest, type BrowserPermissionDecision } from '../hooks/useBrowser';
import { useI18n } from '../i18n';
import { chatSlashCommandSuggestions, resolveChatSlashCommand, type ChatSlashCommand, type ChatSlashCommandName } from '../utils/chat-slash-commands';
import { modelThinkingOptions } from '../utils/model-thinking';
import { PROJECT_FILE_REFERENCE_EVENT, projectFileMention } from '../projectFileReference';
import { BROWSER_REFERENCE_EVENT } from '../browserReference';
import { Icon, type IconName } from './Icon';
import { ApprovalPanel } from './ApprovalPanel';
import { MarkdownView } from './MarkdownView';
import { QuestionPanel } from './QuestionPanel';
import { SkillPicker } from './SkillPicker';
import { UsageOverview } from './UsageOverview';
import { detectImageMime, isLikelyImageFile } from '../utils/image-mime';
import { toolCallDetailFields } from '../utils/tool-call-detail';
import { editLineOperationStats } from '../utils/edit-line-ops';
import { sessionAgentDisplayName } from '../utils/session-agent';

export interface ChatViewProps {
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
  onSendMessage: (text: string, attachments?: PromptAttachment[], behavior?: 'queue' | 'steer', options?: PromptExecutionOptions) => boolean | void | Promise<boolean | void>;
  onAbort: () => boolean | void | Promise<boolean | void>;
  onRefreshModels: () => void;
  onModelChange: (model: string) => void | Promise<void>;
  onThinkingChange: (effort: string) => void | Promise<void>;
  onPermissionChange: (mode: 'auto' | 'yolo' | 'manual') => void | Promise<void>;
  onRunSlashCommand: (command: ChatSlashCommandName, args: string, options?: PromptExecutionOptions) => boolean | void | Promise<boolean | void>;
  onGoalControl?: (action: 'pause' | 'resume' | 'cancel') => void | Promise<void>;
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
  draftAgentConfig?: SessionAgentConfig;
  rewindLimit?: number;
  onRewind?: (count: number) => string | undefined | Promise<string | undefined>;
}

interface ComposerAttachment {
  id: string;
  name: string;
  preview?: string;
  attachment: PromptAttachment;
}

const STARTERS = [
  { title: 'Understand this project', titleZh: '了解此项目', prompt: 'Summarize this codebase, its architecture, and the most important entry points.', promptZh: '总结这个代码库、整体架构和最重要的入口。' },
  { title: 'Find the next improvement', titleZh: '寻找下一项改进', prompt: 'Review the current project and suggest the highest-impact improvement to implement next.', promptZh: '审查当前项目，并建议下一项最值得实现的改进。' },
  { title: 'Check recent changes', titleZh: '检查最近的更改', prompt: 'Review the current uncommitted changes for bugs, regressions, and missing tests.', promptZh: '审查当前未提交的更改，查找缺陷、回归和缺失的测试。' },
];

/**
 * Loop mode is remembered per chat (`sessionId` + `agentId`), the same scope the
 * rest of the composer uses. It rewrites the next send into a Goal, so a single
 * toggle must not stay silently on for every other conversation — which is what
 * the old single global key did.
 */
const LOOP_MODE_STORAGE_PREFIX = 'nori-composer-loop-mode:';
/**
 * The pre-scoping key: one value shared by every chat. It is dropped on mount
 * rather than migrated, because a single global flag holds no per-chat choice to
 * carry over — seeding every chat from it would just re-create the stickiness.
 */
const LEGACY_LOOP_MODE_STORAGE_KEY = 'nori-composer-loop-mode';
const COMPOSER_MIN_HEIGHT = 42;
const COMPOSER_MAX_HEIGHT = 260;
const TURN_PREVIEW_MAX_LENGTH = 220;

function loopModeStorageKey(sessionId: string, agentId: string): string {
  return `${LOOP_MODE_STORAGE_PREFIX}${sessionId}:${agentId}`;
}

function loadLoopMode(sessionId: string | null, agentId: string): boolean {
  if (sessionId === null) return false;
  try {
    return localStorage.getItem(loopModeStorageKey(sessionId, agentId)) === 'true';
  } catch {
    return false;
  }
}

/** Only chats with Loop actually on keep a key, so browsing chats cannot litter
 *  storage with one entry per conversation opened. */
function persistLoopMode(sessionId: string, agentId: string, enabled: boolean): void {
  try {
    const key = loopModeStorageKey(sessionId, agentId);
    if (enabled) localStorage.setItem(key, 'true');
    else localStorage.removeItem(key);
  } catch {
    // Keep the preference in memory when storage is unavailable.
  }
}

function compactTurnPreview(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= TURN_PREVIEW_MAX_LENGTH) return compact;
  return `${compact.slice(0, TURN_PREVIEW_MAX_LENGTH - 1).trimEnd()}…`;
}

function workBlockPreview(blocks: WorkBlock[] | undefined): string {
  if (!blocks) return '';
  for (const block of blocks) {
    if ((block.type === 'progress' || block.type === 'thinking') && block.text.trim()) {
      return compactTurnPreview(block.text);
    }
    if (block.type === 'tool') {
      return compactTurnPreview(block.tool.result || block.tool.name);
    }
    if (block.type === 'context') {
      return compactTurnPreview(block.source);
    }
  }
  return '';
}

export function modelSupportsImageInput(model: ModelCatalogItem | undefined): boolean {
  if (!model) return false;
  const mappedCapability = model.capabilities?.some(
    capability => capability.trim().toLowerCase() === 'image_in',
  ) ?? false;
  const imageInputModality = model.modalities?.input?.some(
    modality => modality.trim().toLowerCase() === 'image',
  ) ?? false;
  return mappedCapability
    || model.supports_image_in === true
    || model.capability?.image_in === true
    || model.model_capabilities?.image_in === true
    || imageInputModality;
}

function imageUnsupportedMessage(
  hasSelectedModel: boolean,
  tr: (english: string, chinese: string) => string,
): string {
  return hasSelectedModel
    ? tr('The selected model does not support image input. Choose a multimodal model to attach images.', '所选模型不支持图片输入，请选择多模态模型后再添加图片。')
    : tr('Select a multimodal model before attaching images.', '请先选择支持图片输入的多模态模型。');
}

interface ComposerSettingChoice {
  value: string;
  label: string;
  disabled?: boolean;
}

function ComposerSettingPicker({ id, label, ariaLabel, value, choices, open, disabled, invalid = false, accent = false, nativeClassName, onToggle, onChange }: {
  id: string;
  label: string;
  ariaLabel: string;
  value: string;
  choices: ComposerSettingChoice[];
  open: boolean;
  disabled: boolean;
  invalid?: boolean;
  accent?: boolean;
  nativeClassName: string;
  onToggle: () => void;
  onChange: (value: string) => void;
}) {
  const selectedChoice = choices.find(choice => choice.value === value);
  const selectedLabel = selectedChoice?.label || value;
  return <div className={`composer-setting-picker${open ? ' open' : ''}${invalid ? ' invalid' : ''}`} data-composer-setting={id}>
    <button type="button" className="composer-setting-trigger" onClick={onToggle} disabled={disabled} aria-label={`${ariaLabel}: ${selectedLabel}`} aria-haspopup="listbox" aria-expanded={open}>
      <span>{label}</span><strong className={accent ? 'accent' : undefined}>{selectedLabel}</strong><Icon name="chevron-right" size={14}/>
    </button>
    <select className={`${nativeClassName} composer-native-select`} value={value} disabled={disabled} onChange={event => onChange(event.target.value)} tabIndex={-1} aria-hidden="true">
      {choices.map(choice => <option key={choice.value} value={choice.value} disabled={choice.disabled}>{choice.label}</option>)}
    </select>
    <div className="composer-setting-options" role="listbox" aria-label={ariaLabel} aria-hidden={!open}>
      {choices.map(choice => <button type="button" role="option" aria-selected={choice.value === value} data-value={choice.value} key={choice.value} disabled={choice.disabled} onClick={() => onChange(choice.value)}>
        <span>{choice.label}</span>{choice.value === value && <Icon name="check" size={13}/>}
      </button>)}
    </div>
  </div>;
}

export function ChatView(props: ChatViewProps) {
  const { session, agentId = 'main', sessionAgents = [], allSessions = [], messages, messagesLoading = false, streaming, thinking, workBlocks = [], isStreaming, streamingTurnId = null, activeAgentTokens, sessionStatus, compacting = false, models, modelsLoading, modelError, onSendMessage, onAbort, onRefreshModels, onModelChange, onThinkingChange, onPermissionChange, onRunSlashCommand, pendingApprovals = [], onResolveApproval, globalApprovals = [], onResolveGlobalApproval, onApprovalPermissionChange, approvalSessionTitles = {}, approvalResolvingIds = new Set(), approvalErrors = {}, onOpenApprovalSession, showApprovalPanel = true, pendingQuestions = [], onResolveQuestion, onDismissQuestion, queuedPrompts = [], onCancelQueuedPrompt, todos = [], onGoalControl, draftAgentConfig, rewindLimit = 10, onRewind, browserPermissionsOverride, onResolveBrowserPermissionOverride } = props;
  const { tr } = useI18n();
  const localBrowserPermissions = useBrowserPermissions();
  const browserPermissions = browserPermissionsOverride === undefined
    ? localBrowserPermissions
    : { pending: browserPermissionsOverride, resolvePermission: onResolveBrowserPermissionOverride ?? localBrowserPermissions.resolvePermission };
  const approvalRequests = useMemo(() => {
    const byId = new Map<string, ApprovalRequest>();
    for (const request of [...pendingApprovals, ...globalApprovals]) byId.set(request.approval_id, request);
    return [...byId.values()];
  }, [globalApprovals, pendingApprovals]);
  const resolveDisplayedApproval = useCallback((approvalId: string, decision: 'approved' | 'rejected' | 'cancelled', options?: { remember?: boolean; feedback?: string; selectedLabel?: string }) => {
    const globalRequest = globalApprovals.find(request => request.approval_id === approvalId);
    if (globalRequest && onResolveGlobalApproval) return onResolveGlobalApproval(approvalId, decision, options);
    return onResolveApproval?.(approvalId, decision, options);
  }, [globalApprovals, onResolveApproval, onResolveGlobalApproval]);
  const [input, setInput] = useState('');
  const [modelNotice, setModelNotice] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [attachmentsLoading, setAttachmentsLoading] = useState(false);
  const [steering, setSteering] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [rewindRequest, setRewindRequest] = useState<number | null>(null);
  const [rewinding, setRewinding] = useState(false);
  const [rewindError, setRewindError] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [commandNotice, setCommandNotice] = useState<string | null>(null);
  const [commandMenuDismissed, setCommandMenuDismissed] = useState(false);
  const [commandSelection, setCommandSelection] = useState(0);
  const [commandRunning, setCommandRunning] = useState(false);
  const [composerRevision, setComposerRevision] = useState(0);
  const [loopEnabled, setLoopEnabled] = useState(() => loadLoopMode(session?.id ?? null, agentId));
  const [followOutput, setFollowOutput] = useState(true);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [hoveredTurnId, setHoveredTurnId] = useState<string | null>(null);
  const [modelOverride, setModelOverride] = useState<string | null>(null);
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelSettingOpen, setModelSettingOpen] = useState<'model' | 'thinking' | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const modelOverrideSessionRef = useRef<string | null>(null);
  const followOutputRef = useRef(true);
  const turnSyncFrameRef = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const rewindCaretRef = useRef<number | null>(null);
  const rewindSessionIdRef = useRef<string | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const previousScopeRef = useRef<string | null>(null);
  const loopScopeRef = useRef<string | null>(null);
  const permissionMenuRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const currentSessionId = session?.id ?? null;
  const currentScope = currentSessionId === null ? null : `${currentSessionId}\u0000${agentId}`;
  rewindSessionIdRef.current = currentScope;
  const activeModelOverride = modelOverrideSessionRef.current === currentScope ? modelOverride : null;
  const runtimeModelValue = sessionStatus?.model?.trim();
  const runtimeModelId = runtimeModelValue === '' ? undefined : runtimeModelValue;
  const selectedModelId = activeModelOverride ?? runtimeModelId ?? session?.agent_config?.model ?? draftAgentConfig?.model ?? '';
  const selectedModel = models.find(model => model.model === selectedModelId);
  const thinkingOptions = modelThinkingOptions(selectedModel);
  const requestedThinking = session?.agent_config?.thinking ?? draftAgentConfig?.thinking ?? thinkingOptions.defaultValue;
  const selectedPermission = session?.agent_config?.permission_mode ?? draftAgentConfig?.permission_mode ?? 'manual';
  const selectedPermissionLabel = selectedPermission === 'auto' ? 'AUTO' : selectedPermission === 'yolo' ? 'YOLO' : tr('Manual', '手动');
  const selectedModelLabel = selectedModel
    ? `${selectedModel.display_name || selectedModel.model} · ${selectedModel.provider_name || selectedModel.provider}`
    : selectedModelId || tr('Select model', '选择模型');
  const selectedThinkingChoice = thinkingOptions.choices.find(choice => choice.value === requestedThinking)
    ?? thinkingOptions.choices.find(choice => choice.value === thinkingOptions.defaultValue)
    ?? thinkingOptions.choices[0];
  const selectedThinking = selectedThinkingChoice?.value ?? requestedThinking;
  const selectedThinkingLabel = selectedThinkingChoice?.value ?? '';
  const modelChoices: ComposerSettingChoice[] = [
    { value: '', label: modelsLoading ? tr('Loading models…', '正在加载模型…') : tr('Select model', '选择模型'), disabled: true },
    ...(selectedModelId !== '' && !selectedModel ? [{ value: selectedModelId, label: selectedModelId }] : []),
    ...models.map(model => ({
      value: model.model,
      label: `${model.display_name || model.model} · ${model.provider_name || model.provider}`,
    })),
  ];
  const thinkingChoices: ComposerSettingChoice[] = thinkingOptions.choices.map(choice => ({ value: choice.value, label: choice.value }));
  const commandSuggestions = chatSlashCommandSuggestions(input);
  const commandMenuOpen = !commandMenuDismissed && commandSuggestions.length > 0;
  const imageCapable = modelSupportsImageInput(selectedModel);
  const imageCapableRef = useRef(imageCapable);
  imageCapableRef.current = imageCapable;
  const continuationMessageId = isStreaming && streamingTurnId !== null
    ? [...messages].reverse().find(message => message.role === 'assistant' && message.turnId === streamingTurnId)?.id
    : undefined;
  const streamingContinuesAssistant = continuationMessageId !== undefined;
  const standaloneLiveProgressId = streaming.trim() ? 'standalone-live-progress' : undefined;
  const standaloneLiveBlocks: WorkBlock[] = [
    ...(workBlocks.length > 0
      ? workBlocks
      : thinking
        ? [{ id: 'live-thinking', type: 'thinking' as const, text: thinking }]
        : []),
    ...(standaloneLiveProgressId === undefined
      ? []
      : [{ id: standaloneLiveProgressId, type: 'progress' as const, text: streaming }]),
  ];
  const turnPreviews: Array<{ turn: ChatMessage; response: string }> = [];
  for (const message of messages) {
    if (message.role === 'user') {
      turnPreviews.push({ turn: message, response: '' });
      continue;
    }
    if (message.role !== 'assistant') continue;
    const currentTurn = turnPreviews.at(-1);
    if (!currentTurn || currentTurn.response) continue;
    currentTurn.response = compactTurnPreview(message.text) || workBlockPreview(message.workBlocks);
  }
  const latestTurnId = turnPreviews.at(-1)?.turn.id ?? null;
  const highlightedTurnId = hoveredTurnId ?? activeTurnId ?? latestTurnId;
  let latestUserStartedAt: number | undefined;
  const presentedMessages = messages.map(message => {
    const timestamp = parseMessageTimestamp(message.createdAt);
    if (message.role === 'user') latestUserStartedAt = timestamp;
    return { message, workStartedAt: message.role === 'assistant' ? latestUserStartedAt : undefined };
  });

  useEffect(() => {
    if (selectedPermission === 'manual') return;
    for (const request of browserPermissions.pending) {
      void browserPermissions.resolvePermission(request.id, 'allow_once');
    }
  }, [browserPermissions.pending, browserPermissions.resolvePermission, selectedPermission]);
  useEffect(() => {
    if (!permissionMenuOpen && !modelMenuOpen) return;
    const closeMenus = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!permissionMenuRef.current?.contains(target)) setPermissionMenuOpen(false);
      if (!modelMenuRef.current?.contains(target)) {
        setModelMenuOpen(false);
        setModelSettingOpen(null);
      }
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setPermissionMenuOpen(false);
      setModelMenuOpen(false);
      setModelSettingOpen(null);
    };
    document.addEventListener('pointerdown', closeMenus);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeMenus);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [modelMenuOpen, permissionMenuOpen]);
  const rewindCounts = new Map<string, number>();
  let promptsFromEnd = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    promptsFromEnd++;
    if (promptsFromEnd <= rewindLimit) rewindCounts.set(message.id, promptsFromEnd);
  }

  const syncActiveTurn = useCallback((scrollContainer: HTMLDivElement) => {
    const anchors = [...scrollContainer.querySelectorAll<HTMLElement>('[data-chat-turn-id]')];
    if (anchors.length === 0) {
      setActiveTurnId(null);
      return;
    }
    const containerRect = scrollContainer.getBoundingClientRect();
    const focusY = containerRect.top + Math.min(containerRect.height * 0.35, 180);
    let nearest = anchors[0]!;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const anchor of anchors) {
      const distance = Math.abs(anchor.getBoundingClientRect().top - focusY);
      if (distance >= nearestDistance) continue;
      nearest = anchor;
      nearestDistance = distance;
    }
    const turnId = nearest.dataset.chatTurnId ?? null;
    setActiveTurnId(current => current === turnId ? current : turnId);
  }, []);

  const scheduleTurnSync = useCallback((scrollContainer: HTMLDivElement) => {
    if (turnSyncFrameRef.current !== 0) return;
    turnSyncFrameRef.current = requestAnimationFrame(() => {
      turnSyncFrameRef.current = 0;
      syncActiveTurn(scrollContainer);
    });
  }, [syncActiveTurn]);

  useEffect(() => () => {
    if (turnSyncFrameRef.current !== 0) cancelAnimationFrame(turnSyncFrameRef.current);
  }, []);

  useLayoutEffect(() => {
    const scrollContainer = messagesScrollRef.current;
    if (!scrollContainer) return;
    // The welcome screen can be taller than the transcript viewport. It has no
    // turn to follow, so bottom-scrolling would hide its heading above the fold.
    if (messages.length === 0 && !isStreaming) {
      scrollContainer.scrollTop = 0;
      setActiveTurnId(current => current === null ? current : null);
      return;
    }
    if (!followOutputRef.current) return;
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
    setActiveTurnId(current => current === latestTurnId ? current : latestTurnId);
  }, [isStreaming, latestTurnId, messages, streaming, thinking, workBlocks]);
  useLayoutEffect(() => {
    followOutputRef.current = true;
    setFollowOutput(true);
    setHoveredTurnId(null);
    setActiveTurnId(latestTurnId);
  }, [currentScope]);
  const resizeComposer = useCallback(() => {
    const element = inputRef.current;
    if (!element) return;
    element.style.height = 'auto';
    const nextHeight = Math.max(COMPOSER_MIN_HEIGHT, Math.min(element.scrollHeight, COMPOSER_MAX_HEIGHT));
    element.style.height = `${nextHeight}px`;
    element.style.overflowY = element.scrollHeight > COMPOSER_MAX_HEIGHT ? 'auto' : 'hidden';
  }, []);
  useLayoutEffect(() => {
    resizeComposer();
  }, [input, resizeComposer]);
  useEffect(() => {
    const element = inputRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(entries => {
      const nextWidth = entries[0]?.contentRect.width ?? element.clientWidth;
      if (Math.abs(nextWidth - width) < 0.5) return;
      width = nextWidth;
      resizeComposer();
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [resizeComposer]);
  const restoreRewindFocus = useCallback(() => {
    const caret = rewindCaretRef.current;
    const editor = inputRef.current;
    if (caret === null || editor === null) return false;
    try {
      editor.focus({ preventScroll: true });
      editor.setSelectionRange(caret, caret);
    } catch {
      // The renderer can briefly reject focus while a native dialog is closing.
    }
    if (document.activeElement !== editor) return false;
    rewindCaretRef.current = null;
    return true;
  }, []);

  useLayoutEffect(() => {
    if (rewindCaretRef.current === null) return;
    let attempts = 0;
    let frame = 0;
    let timer: number | undefined;

    const restoreFocus = () => {
      if (restoreRewindFocus() || attempts >= 60) return;
      attempts += 1;
      frame = requestAnimationFrame(restoreFocus);
    };
    const retryOnWindowReady = () => {
      if (restoreRewindFocus()) return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(restoreFocus, 0);
    };

    // Keep the caret restoration alive across renderer focus/visibility changes
    // instead of dropping it after a single animation frame.
    window.addEventListener('focus', retryOnWindowReady);
    window.addEventListener('pageshow', retryOnWindowReady);
    document.addEventListener('visibilitychange', retryOnWindowReady);
    restoreFocus();
    return () => {
      window.removeEventListener('focus', retryOnWindowReady);
      window.removeEventListener('pageshow', retryOnWindowReady);
      document.removeEventListener('visibilitychange', retryOnWindowReady);
      if (timer !== undefined) window.clearTimeout(timer);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [composerRevision, restoreRewindFocus]);
  useEffect(() => { setModelNotice(false); }, [currentScope, selectedModelId]);
  useEffect(() => { setModelOverride(null); }, [currentScope]);
  useEffect(() => {
    setPermissionMenuOpen(false);
    setModelMenuOpen(false);
    setModelSettingOpen(null);
  }, [currentScope]);
  useEffect(() => {
    setRewindRequest(null);
    setRewinding(false);
    setRewindError(null);
  }, [currentScope]);
  useEffect(() => {
    if (rewindRequest === null) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setRewindRequest(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [rewindRequest]);
  useEffect(() => {
    if (activeModelOverride !== null && runtimeModelId === activeModelOverride) setModelOverride(null);
  }, [activeModelOverride, runtimeModelId]);
  useEffect(() => {
    const reference = (event: Event) => {
      const path = (event as CustomEvent<{ path?: string }>).detail?.path;
      if (!path) return;
      const mention = projectFileMention(path);
      setInput(previous => `${previous.trimEnd()}${previous.trim() ? ' ' : ''}${mention} `);
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener(PROJECT_FILE_REFERENCE_EVENT, reference);
    return () => window.removeEventListener(PROJECT_FILE_REFERENCE_EVENT, reference);
  }, []);
  useEffect(() => {
    const reference = (event: Event) => {
      const text = (event as CustomEvent<{ text?: string }>).detail?.text;
      if (!text) return;
      setInput(previous => `${previous.trimEnd()}${previous.trim() ? '\n\n' : ''}${text}\n`);
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener(BROWSER_REFERENCE_EVENT, reference);
    return () => window.removeEventListener(BROWSER_REFERENCE_EVENT, reference);
  }, []);
  useEffect(() => {
    const previousScope = previousScopeRef.current;
    previousScopeRef.current = currentScope;
    setAttachments([]);
    setAttachmentsLoading(false);
    setAttachmentError(null);
    setCommandNotice(null);
    setCommandMenuDismissed(false);
    setCommandSelection(0);
    if (!previousScope && currentScope) setInput('');
  }, [currentScope]);
  const addFiles = useCallback(async (files: FileList | File[]) => {
    const available = Math.max(0, 6 - attachments.length);
    const selected = Array.from(files).slice(0, available);
    if (selected.length === 0) return;
    const imageCandidates = selected.filter(isLikelyImageFile);
    const filesToLoad = imageCapable
      ? selected
      : selected.filter(file => !isLikelyImageFile(file));
    setAttachmentError(imageCandidates.length > 0 && !imageCapable
      ? imageUnsupportedMessage(Boolean(selectedModelId), tr)
      : null);
    if (filesToLoad.length === 0) return;
    setAttachmentsLoading(true);
    try {
      const results = await Promise.allSettled(filesToLoad.map(file => isLikelyImageFile(file)
        ? readImageAttachment(file)
        : uploadFileAttachment(file)));
      const loaded = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
      const failed = results.filter(result => result.status === 'rejected');
      const stillImageCapable = imageCapableRef.current;
      const accepted = stillImageCapable
        ? loaded
        : loaded.filter(item => item.attachment.kind !== 'image');
      if (accepted.length > 0) setAttachments(previous => [...previous, ...accepted].slice(0, 6));
      if (!stillImageCapable && loaded.some(item => item.attachment.kind === 'image')) {
        setAttachmentError(tr(
          'That model does not support image input. Attached images were removed.',
          '该模型不支持图片输入，已移除附加的图片。',
        ));
      } else if (failed.length > 0 && (stillImageCapable || imageCandidates.length === 0)) {
        setAttachmentError(tr(
          `${failed.length} file${failed.length === 1 ? '' : 's'} could not be attached.`,
          `${failed.length} 个文件添加失败。`,
        ));
      }
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : tr('Unable to attach file.', '无法添加文件。'));
    } finally { setAttachmentsLoading(false); }
  }, [attachments.length, imageCapable, selectedModelId, tr]);

  const removeAttachment = (item: ComposerAttachment) => {
    setAttachments(previous => previous.filter(candidate => candidate.id !== item.id));
    if (item.attachment.kind === 'file') void api.files.delete(item.attachment.file_id).catch(() => undefined);
  };

  const handleSend = useCallback(async (override?: string, behavior: 'queue' | 'steer' = 'queue') => {
    const text = (override ?? input).trim();
    if (!text && attachments.length === 0) return;
    if (!selectedModelId) { setModelNotice(true); return; }
    if (!imageCapable && attachments.some(item => item.attachment.kind === 'image')) {
      setAttachmentError(imageUnsupportedMessage(true, tr));
      return;
    }
    followOutputRef.current = true;
    setFollowOutput(true);
    if (attachmentsLoading || (behavior === 'steer' && steering)) return;
    if (behavior === 'steer') setSteering(true);
    try {
      const promptAttachments = attachments.map(item => item.attachment);
      const executionOptions: PromptExecutionOptions = {
        model: selectedModelId,
        thinking: selectedThinking,
        loopMode: loopEnabled ? true : undefined,
      };
      const accepted = await onSendMessage(text, promptAttachments, behavior, executionOptions);
      if (accepted !== false) {
        setInput('');
        setAttachments([]);
        setAttachmentError(null);
      }
    } finally {
      if (behavior === 'steer') setSteering(false);
    }
  }, [attachments, attachmentsLoading, imageCapable, input, loopEnabled, onSendMessage, selectedModelId, selectedThinking, steering, tr]);

  const handleLoopToggle = useCallback((enabled: boolean) => {
    setLoopEnabled(enabled);
    if (currentSessionId !== null) persistLoopMode(currentSessionId, agentId, enabled);
  }, [agentId, currentSessionId]);

  useEffect(() => {
    const previousScope = loopScopeRef.current;
    // Same chat: the toggle handler already persisted, so there is nothing to
    // reconcile and reloading here would fight the click that just happened.
    if (previousScope === currentScope) return;
    loopScopeRef.current = currentScope;
    if (previousScope === null) {
      // Either the first render of an existing chat (value already loaded) or a
      // draft composer that just became a real chat. Give the toggle the user
      // set before the session existed a home instead of resetting it on send.
      if (currentSessionId !== null) persistLoopMode(currentSessionId, agentId, loopEnabled);
      return;
    }
    setLoopEnabled(loadLoopMode(currentSessionId, agentId));
  }, [agentId, currentScope, currentSessionId, loopEnabled]);

  useEffect(() => {
    try {
      localStorage.removeItem(LEGACY_LOOP_MODE_STORAGE_KEY);
    } catch {
      // Nothing to clean up when storage is unavailable.
    }
  }, []);

  useEffect(() => {
    if (!isStreaming) setStopping(false);
  }, [isStreaming]);

  const handleAbort = async () => {
    if (stopping) return;
    setStopping(true);
    const stopped = await onAbort();
    if (stopped === false) setStopping(false);
  };

  const selectSlashCommand = (command: ChatSlashCommand) => {
    setInput(`/${command.name}${command.argumentHint ? ' ' : ''}`);
    setCommandSelection(0);
    setCommandNotice(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const runSlashCommand = async () => {
    const resolution = resolveChatSlashCommand(input);
    if (resolution.kind === 'none') {
      setCommandNotice(tr('Unknown slash command.', '未知的斜杠命令。'));
      return;
    }
    if (resolution.kind === 'error') {
      setCommandNotice(tr(resolution.message, resolution.messageZh));
      return;
    }
    if (!session) {
      setCommandNotice(tr('Open a conversation before running this command.', '请先打开一个会话再执行此命令。'));
      return;
    }
    if (isStreaming || compacting) {
      setCommandNotice(tr('Wait for the current task to finish before running this command.', '请等当前任务完成后再执行此命令。'));
      return;
    }
    if (attachments.length > 0) {
      setCommandNotice(tr('Remove attachments before running a slash command.', '执行斜杠命令前请先移除附件。'));
      return;
    }
    if (resolution.value.command.name !== 'compact' && !selectedModelId) {
      setModelNotice(true);
      return;
    }
    setCommandRunning(true);
    setCommandNotice(null);
    try {
      const slashOptions: PromptExecutionOptions | undefined = resolution.value.command.name === 'compact'
        ? undefined
        : {
            model: selectedModelId,
            thinking: selectedThinking,
            goalObjective: resolution.value.command.name === 'goal' ? resolution.value.args : undefined,
          };
      const accepted = await onRunSlashCommand(
        resolution.value.command.name,
        resolution.value.args,
        slashOptions,
      );
      if (accepted === false) return;
      setInput('');
      setCommandMenuDismissed(false);
      setCommandNotice(resolution.value.command.name === 'compact'
        ? tr('Conversation context compacted.', '已压缩对话上下文。')
        : null);
    } catch (error) {
      setCommandNotice(error instanceof Error ? error.message : tr('Command failed.', '命令执行失败。'));
    } finally {
      setCommandRunning(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (commandMenuOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        setCommandSelection(current => (current + direction + commandSuggestions.length) % commandSuggestions.length);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setCommandMenuDismissed(true);
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        const command = commandSuggestions[commandSelection] ?? commandSuggestions[0];
        if (command) selectSlashCommand(command);
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        const firstToken = input.trim().split(/\s+/, 1)[0]?.slice(1).toLowerCase();
        const command = commandSuggestions[commandSelection] ?? commandSuggestions[0];
        if (command && firstToken !== command.name) selectSlashCommand(command);
        else void runSlashCommand();
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (input.trim().startsWith('/')) void runSlashCommand();
      else void handleSend(undefined, isStreaming ? 'steer' : 'queue');
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (event.clipboardData.files.length === 0) return;
    const hasImage = Array.from(event.clipboardData.files).some(isLikelyImageFile);
    if (!hasImage) return;
    event.preventDefault();
    if (!imageCapable) {
      setAttachmentError(imageUnsupportedMessage(Boolean(selectedModelId), tr));
      return;
    }
    void addFiles(event.clipboardData.files);
  };

  const handleModelChange = async (modelId: string) => {
    modelOverrideSessionRef.current = currentScope;
    setModelOverride(modelId);
    const nextModel = models.find(model => model.model === modelId);
    if (!modelSupportsImageInput(nextModel) && attachments.some(item => item.attachment.kind === 'image')) {
      setAttachments(previous => previous.filter(item => item.attachment.kind !== 'image'));
      setAttachmentError(tr(
        'That model does not support image input. Attached images were removed.',
        '该模型不支持图片输入，已移除附加的图片。',
      ));
    } else {
      setAttachmentError(null);
    }
    try {
      await onModelChange(modelId);
    } catch {
      setModelOverride(current => modelOverrideSessionRef.current === currentScope && current === modelId ? null : current);
    }
  };

  const requestRewind = useCallback((count: number) => {
    if (!onRewind || rewinding) return;
    setRewindError(null);
    setRewindRequest(count);
  }, [onRewind, rewinding]);

  const confirmRewind = useCallback(async () => {
    const count = rewindRequest;
    if (!onRewind || count === null || rewinding) return;
    const rewindSessionId = rewindSessionIdRef.current;
    setRewindRequest(null);
    setRewindError(null);
    setRewinding(true);
    try {
      const prompt = await onRewind(count);
      if (rewindSessionIdRef.current !== rewindSessionId) return;
      if (prompt === undefined) {
        throw new Error(tr('Rewind is unavailable while this conversation is busy.', '当前会话繁忙，暂时无法回溯。'));
      }
      setInput(prompt);
      setCommandMenuDismissed(true);
      setCommandSelection(0);
      setCommandNotice(null);
      rewindCaretRef.current = prompt.length;
      setComposerRevision(current => current + 1);
    } catch (error) {
      if (rewindSessionIdRef.current !== rewindSessionId) return;
      setRewindError(error instanceof Error ? error.message : tr('Rewind failed.', '回溯失败。'));
      requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    } finally {
      if (rewindSessionIdRef.current === rewindSessionId) setRewinding(false);
    }
  }, [onRewind, rewindRequest, rewinding, tr]);

  const handleMessagesScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
    scheduleTurnSync(element);
    if (atBottom !== followOutputRef.current) {
      followOutputRef.current = atBottom;
      setFollowOutput(atBottom);
    }
  };

  const scrollToTurn = (turnId: string) => {
    const scrollContainer = messagesScrollRef.current;
    if (!scrollContainer) return;
    const target = [...scrollContainer.querySelectorAll<HTMLElement>('[data-chat-turn-id]')]
      .find(element => element.dataset.chatTurnId === turnId);
    if (!target) return;
    const containerRect = scrollContainer.getBoundingClientRect();
    const targetTop = target.getBoundingClientRect().top - containerRect.top + scrollContainer.scrollTop - 18;
    followOutputRef.current = false;
    setFollowOutput(false);
    setActiveTurnId(turnId);
    const reduceMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    scrollContainer.scrollTo({
      top: Math.max(0, targetTop),
      behavior: reduceMotion ? 'auto' : 'smooth',
    });
  };

  const jumpToLatest = () => {
    followOutputRef.current = true;
    setFollowOutput(true);
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  return <section className="chat-view" aria-label={tr('Conversation', '对话')}>
    <div className="chat-messages-shell">
    <div className="chat-messages" ref={messagesScrollRef} onScroll={handleMessagesScroll}>
      {messagesLoading ? <div className="chat-history-loading" role="status"><span className="spinner"/><strong>{tr('Loading conversation…', '正在加载会话…')}</strong></div> : messages.length === 0 ? <div className="chat-welcome"><div className="welcome-mark"><Icon name="sparkles" size={27}/></div><span className="eyebrow">{tr('Your thoughtful coding partner', '你的智能编程伙伴')}</span><h2>{session ? tr('What should we make better?', '我们要改进什么？') : tr('What would you like to work on?', '你想从哪里开始？')}</h2><p>{session ? tr('Ask Nori to inspect code, plan a feature, fix a bug, or validate an API integration.', '让 Nori 检查代码、规划功能、修复缺陷或验证 API 集成。') : tr('Choose a project folder to start a new task, or open an existing conversation from the sidebar. You can also type below now.', '选择一个项目文件夹开始新任务，或打开已有对话。你也可以直接在下方输入。')}</p><UsageOverview sessions={allSessions} models={models}/><div className="starter-grid">{STARTERS.map(item => <button key={item.title} className="starter-card" onClick={() => void handleSend(tr(item.prompt, item.promptZh))}><Icon name="sparkles" size={16}/><span><strong>{tr(item.title, item.titleZh)}</strong><small>{tr(item.prompt, item.promptZh)}</small></span></button>)}</div></div> : presentedMessages.map(({ message, workStartedAt }) => <MessageBubble key={message.id} message={message} sessionAgents={sessionAgents} workStartedAt={workStartedAt} rewindCount={rewindCounts.get(message.id)} rewindDisabled={isStreaming || rewinding} onRewind={requestRewind} live={message.id === continuationMessageId ? { streaming, thinking, workBlocks, stopping, onAbort: handleAbort } : undefined}/>) }

      {isStreaming && !streamingContinuesAssistant && <div className="chat-message chat-message-assistant chat-message-streaming"><div className="message-body"><div className="chat-message-role">Nori <span>{pendingApprovals.length > 0 || browserPermissions.pending.length > 0 ? tr('waiting for permission', '等待授权') : tr('working', '工作中')}</span></div>{standaloneLiveBlocks.length > 0 ? <WorkStream blocks={standaloneLiveBlocks} live activeProgressId={standaloneLiveProgressId} startedAt={latestUserStartedAt}/> : <div className="chat-message-content"><span className="thinking-label">{tr('Waiting for model output…', '等待模型输出…')}</span><span className="streaming-cursor"/></div>}{streaming && <div className="message-token-usage">{tr('Live output', '实时输出')} ~{formatTokens(estimateStreamingTokens(streaming))} tokens</div>}<button className="chat-abort-btn" onClick={() => void handleAbort()} disabled={stopping}><Icon name="stop" size={13}/> {stopping ? tr('Stopping…', '正在停止…') : tr('Stop response', '停止回复')}</button></div></div>}
      <div ref={messagesEndRef}/>
    </div>
    {turnPreviews.length > 0 && <nav className="chat-turn-rail" style={{ height: `${Math.min(360, Math.max(54, turnPreviews.length * 14))}px` }} aria-label={tr('Conversation turns', '对话轮次')} onPointerMove={event => {
      const bounds = event.currentTarget.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (event.clientY - bounds.top) / Math.max(1, bounds.height)));
      const index = Math.min(turnPreviews.length - 1, Math.round(ratio * (turnPreviews.length - 1)));
      setHoveredTurnId(turnPreviews[index]?.turn.id ?? null);
    }} onPointerLeave={() => setHoveredTurnId(null)}>
      {turnPreviews.map(({ turn, response }, index) => {
        const prompt = compactTurnPreview(turn.text) || (turn.images?.length ? tr('Image message', '图片消息') : tr('Empty message', '空消息'));
        const previewOpen = hoveredTurnId === turn.id;
        const previewId = `chat-turn-preview-${index}`;
        return <button type="button" key={turn.id} data-turn-id={turn.id} className={highlightedTurnId === turn.id ? 'active' : ''} aria-current={activeTurnId === turn.id ? 'step' : undefined} aria-describedby={previewOpen ? previewId : undefined} onPointerEnter={() => setHoveredTurnId(turn.id)} onFocus={() => setHoveredTurnId(turn.id)} onBlur={() => setHoveredTurnId(null)} onClick={() => scrollToTurn(turn.id)} aria-label={tr(`Go to turn ${index + 1}: ${prompt}`, `跳转到第 ${index + 1} 轮：${prompt}`)}><i/>{previewOpen && <span id={previewId} className="chat-turn-preview" role="tooltip"><strong>{prompt}</strong>{response && <span>{response}</span>}</span>}</button>;
      })}
    </nav>}
    </div>

    <ComposerContextStrip goal={sessionStatus?.goal ?? null} todos={todos} onGoalControl={onGoalControl}/>
    <div className="chat-composer-wrap">
      {!followOutput && <button className="chat-jump-latest" onClick={jumpToLatest} title={tr('Jump to latest', '回到最新消息')} aria-label={tr('Jump to latest', '回到最新消息')}><Icon name="chevron-down" size={16}/></button>}
      {pendingQuestions.length > 0 && onResolveQuestion && onDismissQuestion && <QuestionPanel requests={pendingQuestions} onSubmit={onResolveQuestion} onDismiss={onDismissQuestion}/>}
      {showApprovalPanel && ((approvalRequests.length > 0 && (onResolveApproval !== undefined || onResolveGlobalApproval !== undefined)) || browserPermissions.pending.length > 0) && <ApprovalPanel
        requests={approvalRequests}
        onResolve={resolveDisplayedApproval}
        onPermissionChange={onApprovalPermissionChange ?? onPermissionChange}
        browserPermissions={browserPermissions.pending}
        onResolveBrowserPermission={browserPermissions.resolvePermission}
        sessionTitles={approvalSessionTitles}
        onOpenSession={onOpenApprovalSession}
        resolvingIds={approvalResolvingIds}
        errors={approvalErrors}
      />}
      {rewinding && <div className="chat-rewind-status" role="status" aria-live="polite"><span className="spinner spinner-small"/><span>{tr('Rewinding conversation and workspace…', '正在回溯对话和工作区…')}</span></div>}
      {rewindError && <div className="chat-rewind-status error" role="alert"><Icon name="alert" size={14}/><span>{rewindError}</span><button type="button" onClick={() => setRewindError(null)} aria-label={tr('Dismiss rewind error', '关闭回溯错误')}><Icon name="close" size={12}/></button></div>}
      <div className={'chat-input-area' + (input || attachments.length > 0 ? ' has-value' : '') + (modelNotice ? ' missing-model' : '')}>
      {queuedPrompts.length > 0 && <div className="composer-queue"><span>{tr('Queued', '排队中')} {queuedPrompts.length}</span>{queuedPrompts.map(prompt => <div key={prompt.id} title={prompt.text}><span>{prompt.text}</span>{onCancelQueuedPrompt && <button type="button" onClick={() => void onCancelQueuedPrompt(prompt.id)} title={tr('Remove queued prompt', '移除排队消息')} aria-label={tr('Remove queued prompt', '移除排队消息')}><Icon name="close" size={11}/></button>}</div>)}</div>}
      {(attachments.length > 0 || attachmentsLoading) && <div className="composer-attachments">{attachments.map(item => <div className={`composer-attachment attachment-${item.attachment.kind}`} key={item.id}>{item.preview ? <img src={item.preview} alt={item.name}/> : <span className="composer-file-icon"><Icon name="files" size={19}/></span>}<span title={item.name}>{item.name}</span><button type="button" onClick={() => removeAttachment(item)} aria-label={tr('Remove file', '移除文件')}><Icon name="close" size={12}/></button></div>)}{attachmentsLoading && <div className="composer-attachment composer-attachment-loading"><span className="composer-file-icon"><span className="spinner spinner-small"/></span><span>{tr('Uploading…', '正在上传…')}</span></div>}</div>}
      {commandMenuOpen && <div className="composer-command-menu" id="composer-command-menu" role="listbox" aria-label={tr('Slash commands', '斜杠命令')}>
        {commandSuggestions.map((command, index) => <button key={command.name} type="button" id={`composer-command-${command.name}`} role="option" aria-selected={index === commandSelection} className={index === commandSelection ? 'active' : ''} onMouseDown={event => event.preventDefault()} onClick={() => selectSlashCommand(command)}><code>/{command.name}{command.argumentHint ? ` ${command.argumentHint}` : ''}</code><span>{tr(command.description, command.descriptionZh)}</span></button>)}
      </div>}
      <textarea ref={inputRef} className="chat-input" placeholder={session ? tr('Ask Nori about this project…', '向 Nori 询问此项目…') : tr('Describe what you want to work on…', '告诉 Nori 你想做什么…')} value={input} onFocus={() => { void restoreRewindFocus(); }} onChange={event => { rewindCaretRef.current = null; setInput(event.target.value); setCommandMenuDismissed(false); setCommandSelection(0); setCommandNotice(null); }} onKeyDown={handleKeyDown} onPaste={handlePaste} rows={1} aria-label={tr('Message Nori', '向 Nori 发送消息')} aria-autocomplete="list" aria-expanded={commandMenuOpen} aria-controls={commandMenuOpen ? 'composer-command-menu' : undefined} aria-activedescendant={commandMenuOpen ? `composer-command-${commandSuggestions[commandSelection]?.name ?? commandSuggestions[0]?.name}` : undefined}/>
      <SessionUsageBar status={sessionStatus} compacting={compacting} treeTokens={activeAgentTokens} />
      <div className="composer-toolbar">
        <div className="composer-toolbar-left">
          <input ref={imageInputRef} className="composer-image-input" type="file" multiple onChange={event => { if (event.target.files) void addFiles(event.target.files); event.target.value = ''; }}/>
          <button type="button" className="composer-image-button" onClick={() => imageInputRef.current?.click()} disabled={attachmentsLoading || attachments.length >= 6 || commandRunning} title={tr('Attach files', '添加文件')} aria-label={tr('Attach files', '添加文件')}><Icon name="plus" size={18}/></button>
          <div className={`composer-control-popover composer-permission-menu${permissionMenuOpen ? ' open' : ''}`} ref={permissionMenuRef}>
            <button type="button" className={`composer-icon-trigger permission-${selectedPermission}`} onClick={() => { setPermissionMenuOpen(previous => !previous); setModelMenuOpen(false); setModelSettingOpen(null); }} title={tr(`Permission: ${selectedPermissionLabel}`, `权限：${selectedPermissionLabel}`)} aria-label={tr(`Permission: ${selectedPermissionLabel}`, `权限：${selectedPermissionLabel}`)} aria-expanded={permissionMenuOpen}><Icon name="shield" size={16}/></button>
            <div className="composer-permission-popover" role="menu" aria-hidden={!permissionMenuOpen}>
              {([
                { value: 'auto' as const, label: 'AUTO', detail: tr('Approve routine tools automatically', '自动放行常规工具') },
                { value: 'yolo' as const, label: 'YOLO', detail: tr('Run without permission prompts', '不显示权限询问') },
                { value: 'manual' as const, label: tr('Manual', '手动'), detail: tr('Ask before commands and edits', '命令和更改前询问') },
              ]).map(option => <button type="button" role="menuitemradio" aria-checked={selectedPermission === option.value} key={option.value} disabled={isStreaming} onClick={() => { void onPermissionChange(option.value); setPermissionMenuOpen(false); }}><span className={`permission-option-icon permission-${option.value}`}><Icon name="shield" size={14}/></span><span><strong>{option.label}</strong><small>{option.detail}</small></span>{selectedPermission === option.value && <Icon name="check" size={13}/>}</button>)}
            </div>
          </div>
          <div className="composer-mode-options">
            <label className="loop-mode-toggle" title={tr('Create a goal before this request so Nori continues through the Loop state machine.', '发送后先创建 Goal，并由 Loop 状态机持续执行。')}><input type="checkbox" checked={loopEnabled} onChange={event => handleLoopToggle(event.target.checked)}/><span>Loop</span></label>
          </div>
          <SkillPicker sessionId={session?.id ?? null} disabled={isStreaming}/>
        </div>
        <div className="composer-toolbar-right">
          <div className="composer-model-controls">
            <div className={`composer-control-popover composer-model-menu${modelMenuOpen ? ' open' : ''}`} ref={modelMenuRef}>
              <button type="button" className={`composer-model-trigger${!selectedModelId ? ' invalid' : ''}`} onClick={() => { setModelMenuOpen(previous => !previous); setModelSettingOpen(null); setPermissionMenuOpen(false); }} aria-busy={modelsLoading} title={tr('Model and reasoning settings', '模型和推理设置')} aria-label={tr('Model and reasoning settings', '模型和推理设置')} aria-expanded={modelMenuOpen}><span>{selectedModelLabel}</span>{selectedThinkingLabel && <em>{selectedThinkingLabel}</em>}<Icon name="chevron-down" size={13}/></button>
              <div className="composer-model-popover" aria-hidden={!modelMenuOpen}>
                <ComposerSettingPicker id="model" label={tr('Model', '模型')} ariaLabel={tr('Model', '模型')} value={selectedModelId} choices={modelChoices} open={modelSettingOpen === 'model'} disabled={isStreaming || modelsLoading} invalid={!selectedModelId} nativeClassName="model-select" onToggle={() => setModelSettingOpen(previous => previous === 'model' ? null : 'model')} onChange={value => { void handleModelChange(value); setModelSettingOpen(null); }}/>
                {thinkingChoices.length > 0 && <ComposerSettingPicker
                  id="thinking"
                  label={tr('Reasoning effort', '推理强度')}
                  ariaLabel={tr('Thinking effort', '思考等级')}
                  value={selectedThinking}
                  choices={thinkingChoices}
                  open={modelSettingOpen === 'thinking'}
                  disabled={isStreaming}
                  accent
                  nativeClassName="thinking-select"
                  onToggle={() => setModelSettingOpen(previous => previous === 'thinking' ? null : 'thinking')}
                  onChange={value => { void onThinkingChange(value); setModelSettingOpen(null); }}
                />}
                <button type="button" className="composer-model-refresh" onClick={onRefreshModels} disabled={modelsLoading}><span>{tr('Refresh model list', '刷新模型列表')}</span><Icon name="refresh" size={14}/></button>
              </div>
            </div>
          </div>
          <div className="composer-submit-actions"><button className={`chat-send-btn${isStreaming ? ' chat-guide-btn' : ''}`} onClick={() => input.trim().startsWith('/') ? void runSlashCommand() : void handleSend(undefined, isStreaming ? 'steer' : 'queue')} disabled={rewinding || commandRunning || steering || attachmentsLoading || (!input.trim() && attachments.length === 0)} title={isStreaming ? tr('Insert guidance into the current task', '插入引导到当前任务') : tr('Send message', '发送消息')} aria-label={isStreaming ? tr('Guide current task', '引导当前任务') : tr('Send message', '发送消息')}><Icon name={isStreaming ? 'sparkles' : 'send'} size={18}/>{isStreaming && <span>{tr('Guide', '引导')}</span>}</button></div>
        </div>
      </div>
        {(modelNotice || modelError || attachmentError) && <div className="composer-error" role="status" aria-live="polite">{modelNotice ? tr('Select a model before sending.', '请先选择模型') : attachmentError ?? modelError}</div>}
      {commandNotice && <div className="composer-command-notice" role="status">{commandNotice}</div>}
    </div></div>
    {rewindRequest !== null && <div className="rewind-dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setRewindRequest(null); }}>
      <section className="rewind-dialog" role="dialog" aria-modal="true" aria-labelledby="rewind-dialog-title" aria-describedby="rewind-dialog-description">
        <header><span className="rewind-dialog-icon"><Icon name="refresh" size={16}/></span><div><h2 id="rewind-dialog-title">{tr('Rewind conversation?', '确认回溯？')}</h2><p id="rewind-dialog-description">{tr('Messages, Goal, Todo List, and workspace files after this prompt will return to their earlier state.', '此提问之后的消息、Goal、Todo List 和工作区文件将恢复到当时状态。')}</p></div></header>
        <footer><button type="button" onClick={() => setRewindRequest(null)}>{tr('Cancel', '取消')}</button><button type="button" className="primary" autoFocus onClick={() => void confirmRewind()}>{tr('Rewind', '回溯')}</button></footer>
      </section>
    </div>}
  </section>;
}

function parseMessageTimestamp(value: string | undefined): number | undefined {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : undefined;
}

interface LiveAssistantContinuation {
  streaming: string;
  thinking: string;
  workBlocks: WorkBlock[];
  stopping: boolean;
  onAbort: () => void | Promise<void>;
}

function formatElapsedDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 1) return `${totalSeconds}s`;
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours < 1) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
}

function discussionSpeakerDisplayName(
  speaker: ChatMessage['speaker'],
  agents: readonly SessionAgent[],
  tr: (english: string, chinese: string) => string,
): string {
  if (speaker?.id) {
    const agent = agents.find(candidate => candidate.agent_id === speaker.id);
    if (agent !== undefined) return sessionAgentDisplayName(agent);
    return speaker.from === 'lead' ? tr('Main lead', '主代理') : tr('Discussion member', '讨论成员');
  }
  return speaker?.from === 'lead' ? tr('Main lead', '主代理') : tr('Discussion member', '讨论成员');
}

/**
 * 发言人角色标签。`sub` 是子代理向上问的那一路（nori_ask_parent），
 * 原来会掉到 else 分支被标成「主持」，反了。
 */
function discussionSpeakerRoleLabel(
  from: NonNullable<ChatMessage['speaker']>['from'] | undefined,
  tr: (english: string, chinese: string) => string,
): string {
  switch (from) {
    case 'team':
      return tr('Team', '团队');
    case 'sub':
      return tr('Subagent', '子代理');
    case 'user':
      return tr('User', '用户');
    case 'system':
      return tr('System', '系统');
    case 'lead':
    case undefined:
      return tr('Lead', '主持');
  }
}

function MessageBubble({ message, sessionAgents, workStartedAt, rewindCount, rewindDisabled = false, onRewind, live }: { message: ChatMessage; sessionAgents: readonly SessionAgent[]; workStartedAt?: number; rewindCount?: number; rewindDisabled?: boolean; onRewind?: (count: number) => void | Promise<void>; live?: LiveAssistantContinuation }) {
  const { tr } = useI18n();
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const isDiscussion = message.kind === 'discussion';
  const tools = message.toolCalls ?? [];
  const storedBlocks = (message.workBlocks ?? [
    ...(message.thinking ? [{ id: `${message.id}-thinking`, type: 'thinking' as const, text: message.thinking }] : []),
    ...tools.map((tool, index) => ({ id: tool.id ?? `${message.id}-tool-${index}`, type: 'tool' as const, tool })),
  ]).map(normalizeWorkBlock);
  const liveProgressId = live?.streaming.trim() ? `${message.id}-live-progress` : undefined;
  const liveBlocks: WorkBlock[] = live === undefined ? [] : [
    ...(live.workBlocks.length > 0
      ? live.workBlocks
      : live.thinking ? [{ id: `${message.id}-live-thinking`, type: 'thinking' as const, text: live.thinking }] : []),
    ...(liveProgressId === undefined ? [] : [{ id: liveProgressId, type: 'progress' as const, text: live.streaming }]),
  ];
  const displayedBlocks = mergeWorkBlocks(storedBlocks, liveBlocks).map(normalizeWorkBlock);
  const text = message.text;
  const hasWork = !isUser && !isSystem && displayedBlocks.length > 0;
  const onlyContext = live === undefined && hasWork && displayedBlocks.every(block => block.type === 'context');
  const completedAt = parseMessageTimestamp(message.createdAt);
  const workDurationMs = workStartedAt !== undefined && completedAt !== undefined
    ? Math.max(0, completedAt - workStartedAt)
    : undefined;
  const discussionName = discussionSpeakerDisplayName(message.speaker, sessionAgents, tr);
  return <article data-chat-turn-id={isUser ? message.id : undefined} className={'chat-message ' + (isUser ? 'chat-message-user' : isDiscussion ? 'chat-message-discussion' : isSystem ? 'chat-message-system' : 'chat-message-assistant')}>
    {isSystem && <div className="message-avatar"><span>{isDiscussion ? '·' : '!'}</span></div>}<div className="message-body">{(!isUser || (rewindCount !== undefined && onRewind !== undefined)) && <div className="chat-message-role">{!isUser && (isDiscussion ? `${discussionName} · ${discussionSpeakerRoleLabel(message.speaker?.from, tr)}` : isSystem ? tr('System', '系统') : 'Nori')}{isUser && rewindCount && onRewind && <button className="message-rewind-btn" disabled={rewindDisabled} onClick={() => { void onRewind(rewindCount); }} title={tr('Rewind to before this prompt', '回溯到此提问之前')}><Icon name="refresh" size={12}/>{tr('Rewind', '回溯')}</button>}</div>}
      {onlyContext
        ? displayedBlocks.map(block => block.type === 'context' ? <ContextInjectionRow key={block.id} block={block}/> : null)
        : hasWork ? <WorkStream blocks={displayedBlocks} live={live !== undefined} activeProgressId={liveProgressId} startedAt={workStartedAt} durationMs={live === undefined ? workDurationMs : undefined}/> : null}
      {message.images && message.images.length > 0 && <div className="chat-message-images">{message.images.map((image, index) => <img key={`${image.src.slice(0, 80)}-${String(index)}`} src={image.src} alt={image.alt} loading="lazy" />)}</div>}
      {message.files && message.files.length > 0 && <div className="composer-attachments chat-message-attachments">{message.files.map((file, index) => <div className="composer-attachment attachment-file" key={`${file.name}-${String(file.size ?? 0)}-${String(index)}`}><span className="composer-file-icon"><Icon name="files" size={19}/></span><span title={file.name}>{file.name}</span></div>)}</div>}
      {text && <div className="chat-message-content">{isUser || isSystem ? text : <MarkdownView content={text} />}</div>}{message.usage && <TokenUsageLine usage={message.usage} />}{live && <button className="chat-abort-btn" onClick={() => void live.onAbort()} disabled={live.stopping}><Icon name="stop" size={13}/> {live.stopping ? tr('Stopping…', '正在停止…') : tr('Stop response', '停止回复')}</button>}{message.createdAt && <time className="chat-message-time">{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>}
    </div>
  </article>;
}

function normalizeWorkBlock(block: WorkBlock): WorkBlock {
  if (block.type !== 'tool' || block.tool.name !== 'ContextInjection') return block;
  return {
    id: block.id,
    type: 'context',
    source: summarizeContextSource(block.tool.args),
    content: block.tool.result,
    isError: block.tool.isError,
  };
}

function summarizeContextSource(args: unknown): string {
  if (typeof args === 'object' && args !== null) {
    const source = (args as { source?: unknown }).source;
    if (typeof source === 'string' && source.length > 0) return source;
    const variant = (args as { variant?: unknown }).variant;
    if (typeof variant === 'string' && variant.length > 0) return variant;
  }
  return 'harness';
}

/**
 * 工作流水：不再有“工作过程”折叠层，所有块都平铺成一条条行——
 * 思考直接就地显示，输出内容原样显示，工具调用各自是一行可展开的折叠行。
 */
function WorkStream({ blocks, live = false, activeProgressId, startedAt, durationMs }: { blocks: WorkBlock[]; live?: boolean; activeProgressId?: string; startedAt?: number; durationMs?: number }) {
  const { tr } = useI18n();
  const fallbackStartedAtRef = useRef(Date.now());
  const [clockNow, setClockNow] = useState(Date.now);
  useEffect(() => {
    if (!live) return;
    setClockNow(Date.now());
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live, startedAt]);
  const elapsedMs = durationMs ?? Math.max(0, clockNow - (startedAt ?? fallbackStartedAtRef.current));
  const elapsedLabel = live || durationMs !== undefined ? formatElapsedDuration(elapsedMs) : undefined;

  return <div className={`chat-work-stream${live ? ' live' : ''}`}>
    {elapsedLabel && <div className="work-stream-status">
      {live && <><Icon name="sparkles" size={12}/><span>{tr('Working', '处理中')}</span></>}
      <time className="work-stream-elapsed" title={tr(`Elapsed ${elapsedLabel}`, `耗时 ${elapsedLabel}`)}>{elapsedLabel}</time>
    </div>}
    {segmentWorkBlocks(blocks).map((segment, index, all) => segment.kind === 'output'
      ? <TranscriptOutput key={segment.id} text={segment.text} streaming={live && segment.id === activeProgressId}/>
      : <WorkGroup key={segment.id} blocks={segment.blocks} live={live && index === all.length - 1}/>)}
  </div>;
}

/**
 * 一段工作 = 连续的思考 / 工具调用 / 上下文注入；模型的输出文本自己单独成段，
 * 所以输出永远留在它真实发生的位置，不会被推到所有工具行的后面。
 */
export type WorkSegment =
  | { kind: 'work'; id: string; blocks: WorkBlock[] }
  | { kind: 'output'; id: string; text: string };

export function segmentWorkBlocks(blocks: WorkBlock[]): WorkSegment[] {
  const segments: WorkSegment[] = [];
  for (const block of blocks) {
    if (block.type === 'progress') {
      segments.push({ kind: 'output', id: block.id, text: block.text });
      continue;
    }
    const last = segments.at(-1);
    if (last?.kind === 'work') last.blocks.push(block);
    else segments.push({ kind: 'work', id: block.id, blocks: [block] });
  }
  return segments;
}

/** 连续的思考与工具调用收进一个可折叠的框，折叠时只留一行汇总。 */
function WorkGroup({ blocks, live = false }: { blocks: WorkBlock[]; live?: boolean }) {
  const { tr } = useI18n();
  const [open, setOpen] = useState(live);
  useEffect(() => { if (!live) setOpen(false); }, [live]);
  const running = blocks.some(block => block.type === 'tool'
    && block.tool.result === undefined && block.tool.endedAt === undefined && block.tool.isError !== true);
  return <details className={`chat-work-group${live ? ' live' : ''}`} open={open} onToggle={event => { setOpen(event.currentTarget.open); }}>
    <summary>
      <span className="work-group-icon"><Icon name={running ? 'sparkles' : 'check'} size={12}/></span>
      <span className="work-group-headline">{summarizeWorkGroup(blocks, tr)}</span>
      <Icon className="work-group-chevron" name="chevron-right" size={11}/>
    </summary>
    <div className="work-group-body">
      {blocks.map(block => {
        if (block.type === 'thinking') return <ThinkingLine key={block.id} text={block.text} live={live}/>;
        if (block.type === 'context') return <ContextInjectionRow key={block.id} block={block}/>;
        if (block.type === 'tool') return <CompactToolCall key={block.id} tool={block.tool}/>;
        return null;
      })}
    </div>
  </details>;
}

function isCommandToolName(name: string): boolean {
  return /bash|shell|terminal|command|exec/i.test(name);
}

/** 折叠时那一行汇总：跑了几条命令、动了几个文件、一共几次工具调用。 */
function summarizeWorkGroup(blocks: WorkBlock[], tr: (en: string, zh: string) => string): string {
  const tools = blocks.flatMap(block => block.type === 'tool' ? [block.tool] : []);
  const commands = tools.filter(tool => isCommandToolName(tool.name)).length;
  const created = tools.filter(tool => /^(write|createfile)$/i.test(tool.name)).length;
  const edited = tools.filter(tool => /^(edit|multiedit|notebookedit|apply_?patch)$/i.test(tool.name)).length;
  const thoughts = blocks.filter(block => block.type === 'thinking').length;
  const contexts = blocks.filter(block => block.type === 'context').length;
  const parts: string[] = [];
  if (commands > 0) parts.push(tr(`Ran ${String(commands)} command${commands === 1 ? '' : 's'}`, `运行 ${String(commands)} 条命令`));
  if (created > 0) parts.push(tr(`created ${String(created)} file${created === 1 ? '' : 's'}`, `新建 ${String(created)} 个文件`));
  if (edited > 0) parts.push(tr(`edited ${String(edited)} file${edited === 1 ? '' : 's'}`, `编辑 ${String(edited)} 处`));
  if (tools.length > 0) parts.push(tr(`used ${String(tools.length)} tool${tools.length === 1 ? '' : 's'}`, `共 ${String(tools.length)} 次工具调用`));
  if (thoughts > 0) parts.push(tr(`${String(thoughts)} thought${thoughts === 1 ? '' : 's'}`, `${String(thoughts)} 段思考`));
  if (contexts > 0) parts.push(tr(`${String(contexts)} context injection${contexts === 1 ? '' : 's'}`, `${String(contexts)} 次上下文注入`));
  if (parts.length === 0) return tr('Worked quietly', '静默处理');
  return parts.join(tr(', ', '、'));
}

function TranscriptOutput({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return <div className="chat-message-content transcript-assistant-output"><MarkdownView content={text} streaming={streaming}/>{streaming && <span className="streaming-cursor"/>}</div>;
}

function ThinkingLine({ text, live = false }: { text: string; live?: boolean }) {
  const { tr } = useI18n();
  const [open, setOpen] = useState(live);
  useEffect(() => { if (!live) setOpen(false); }, [live]);
  const preview = text.trim().split('\n').find(line => line.trim().length > 0) ?? '';
  return <details className={`work-thinking-line${live ? ' live' : ''}`} open={open} onToggle={event => { setOpen(event.currentTarget.open); }}>
    <summary>
      <span className="work-thinking-label"><Icon name="sparkles" size={11}/>{tr('Thinking', '思考')}</span>
      <span className="work-thinking-preview">{preview}</span>
      <Icon className="work-thinking-chevron" name="chevron-right" size={11}/>
    </summary>
    <p>{text}</p>
  </details>;
}

function ContextInjectionRow({ block }: { block: Extract<WorkBlock, { type: 'context' }> }) {
  const { tr } = useI18n();
  const hasContent = Boolean(block.content?.trim());
  return <details className={`context-injection-row${block.isError ? ' error' : ''}`}>
    <summary>
      <Icon name="document" size={13}/>
      <span>{tr('Context injection', '上下文注入')}</span>
      <span className="context-injection-separator">·</span>
      <span className="context-injection-source">{block.source}</span>
      {hasContent && <Icon className="context-injection-chevron" name="chevron-right" size={11}/>}
    </summary>
    {hasContent && <pre>{block.content}</pre>}
  </details>;
}

function CompactToolCall({ tool }: { tool: ToolCall }) {
  const { tr } = useI18n();
  const summary = summarizeToolCall(tool, tr);
  const running = tool.result === undefined && tool.endedAt === undefined && tool.isError !== true;
  const statusLabel = tool.isError === true
    ? tr('Failed', '失败')
    : running
      ? tr('Running', '运行中')
      : tr('Done', '完成');
  const fields = toolCallDetailFields(tool, tr);
  const isEdit = tool.name.toLowerCase() === 'edit';
  return <details className={`compact-tool-call tool-${tool.name.toLowerCase()}${tool.isError ? ' error' : ''}`}>
    <summary title={tool.result?.slice(0, 600)}>
      <span className="compact-tool-icon"><Icon name={toolCallIcon(tool.name)} size={12}/></span>
      <span className="compact-tool-copy"><strong>{tool.name}</strong>{summary && <span>{summary}</span>}</span>
      <small className={running ? 'running' : tool.isError ? 'error' : 'done'}>{statusLabel}</small>
      <Icon className="compact-tool-chevron" name="chevron-right" size={11}/>
    </summary>
    <dl className="compact-tool-detail">
      {fields.map(field => (
        <div key={field.key} className={`compact-tool-detail-row${isEdit && (field.key === 'before' || field.key === 'after' || field.key === 'diff') ? ` tool-edit-${field.key}` : ''}`}>
          <dt>{field.label}</dt>
          <dd>{field.value}</dd>
        </div>
      ))}
    </dl>
  </details>;
}

function toolCallIcon(name: string): IconName {
  const normalized = name.toLowerCase();
  if (normalized === 'contextinjection') return 'document';
  if (normalized.includes('bash') || normalized.includes('terminal') || normalized.includes('command')) return 'terminal';
  if (normalized.startsWith('team')) return 'git-branch';
  if (normalized.includes('browser') || normalized.includes('web')) return 'globe';
  if (normalized.includes('read') || normalized.includes('write') || normalized.includes('edit') || normalized.includes('file')) return 'files';
  return 'settings';
}

function summarizeToolCall(tool: ToolCall, tr: (english: string, chinese: string) => string): string {
  const args = typeof tool.args === 'object' && tool.args !== null ? tool.args as Record<string, unknown> : {};
  const normalized = tool.name.toLowerCase();
  if (normalized === 'contextinjection') {
    return firstString(args.source) ?? tr('Context injection', '上下文注入');
  }
  const path = firstString(args.path, args.file_path, args.filename, args.file);
  if (normalized === 'edit' || normalized === 'write') {
    const oldText = firstString(args.old_string, args.old_text) ?? '';
    const newText = firstString(args.new_string, args.content, args.new_text) ?? '';
    const resultCounts = diffCounts(tool.result);
    const operationCounts = normalized === 'edit' ? editLineOperationStats(args.line_ops) : undefined;
    const additions = resultCounts?.additions
      ?? (operationCounts !== undefined && (operationCounts.additions > 0 || operationCounts.deletions > 0)
        ? operationCounts.additions
        : countLines(newText));
    const deletions = resultCounts?.deletions
      ?? (operationCounts !== undefined && (operationCounts.additions > 0 || operationCounts.deletions > 0)
        ? operationCounts.deletions
        : normalized === 'edit' ? countLines(oldText) : 0);
    return [path, `+${additions} -${deletions}`].filter(Boolean).join(' · ');
  }
  return path ?? firstString(args.description, args.query, args.command) ?? '';
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function countLines(value: string): number {
  if (!value) return 0;
  return value.split(/\r?\n/).length;
}

function diffCounts(value: string | undefined): { additions: number; deletions: number } | undefined {
  if (!value?.includes('\n')) return undefined;
  let additions = 0;
  let deletions = 0;
  for (const line of value.split(/\r?\n/)) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return additions > 0 || deletions > 0 ? { additions, deletions } : undefined;
}

async function readImageAttachment(file: File): Promise<ComposerAttachment> {
  const maxBytes = 12 * 1024 * 1024;
  if (file.size > maxBytes) {
    throw new Error(`${file.name} is larger than 12 MB.`);
  }
  const preview = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(reader.error ?? new Error(`Unable to read ${file.name}.`));
    };
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
        return;
      }
      reject(new Error(`Unable to read ${file.name}.`));
    };
    reader.readAsDataURL(file);
  });
  const comma = preview.indexOf(',');
  if (comma < 0) throw new Error('Unable to encode ' + file.name + '.');
  const data = preview.slice(comma + 1);
  const mediaType = detectImageMime(decodeBase64Prefix(data), file.type);
  if (mediaType === null) throw new Error(file.name + ' is not a supported image.');
  const normalizedPreview = 'data:' + mediaType + ';base64,' + data;
  return {
    id:
      file.name +
      '-' +
      String(file.size) +
      '-' +
      String(file.lastModified) +
      '-' +
      Math.random().toString(36).slice(2, 8),
    name: file.name,
    preview: normalizedPreview,
    attachment: {
      kind: 'image',
      name: file.name,
      source: {
        kind: 'base64',
        media_type: mediaType,
        data,
      },
    },
  };
}

function decodeBase64Prefix(base64: string): Uint8Array {
  const encodedPrefix = base64.slice(0, Math.min(base64.length, 4096));
  try {
    const binary = globalThis.atob(encodedPrefix);
    return Uint8Array.from(binary, character => character.codePointAt(0) ?? 0);
  } catch {
    return new Uint8Array();
  }
}

async function uploadFileAttachment(file: File): Promise<ComposerAttachment> {
  const maxBytes = 50 * 1024 * 1024;
  if (file.size > maxBytes) throw new Error(`${file.name} is larger than 50 MB.`);
  const uploaded = await api.files.upload(file);
  return {
    id: uploaded.id,
    name: uploaded.name,
    attachment: {
      kind: 'file',
      name: uploaded.name,
      file_id: uploaded.id,
      media_type: uploaded.media_type,
      size: uploaded.size,
    },
  };
}

function TokenUsageLine({ usage }: { usage: TokenUsage }) {
  const { tr } = useI18n();
  const input = usage.input_other + usage.input_cache_read + usage.input_cache_creation;
  return <div className="message-token-usage">{tr('This response', '本轮')} {formatTokens(input + usage.output)} tokens <span>{tr('input', '输入')} {formatTokens(input)} · {tr('output', '输出')} {formatTokens(usage.output)}</span></div>;
}

function SessionUsageBar({ status, compacting, treeTokens }: { status?: SessionRealtimeStatus | null; compacting: boolean; treeTokens?: number }) {
  const { tr } = useI18n();
  if (!status) return null;
  const total = status.usage?.total;
  const statusTokens = total ? total.input_other + total.input_cache_read + total.input_cache_creation + total.output : undefined;
  const totalTokens = treeTokens !== undefined && treeTokens > 0 ? treeTokens : statusTokens;
  const percentage = Math.min(100, Math.max(0, Math.round(status.context_usage * 100)));
  return <div className="composer-usage" title={`${formatTokens(status.context_tokens)} / ${formatTokens(status.max_context_tokens)} tokens`}>
    <span>{tr('Session usage', '会话用量')} {totalTokens === undefined ? '--' : `${formatTokens(totalTokens)} tokens`}</span>
    <span className={percentage >= 80 ? 'warning' : ''}>{tr('Context', '上下文')} {percentage}%</span>
    <i aria-hidden="true"><b style={{ width: `${percentage}%` }} /></i>
    {compacting && <span>{tr('Compacting context…', '正在压缩上下文…')}</span>}
  </div>;
}

function estimateStreamingTokens(text: string): number {
  return Math.max(1, Math.ceil(new TextEncoder().encode(text).length / 4));
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);
}

/** 输入框上方的 Goal / Todo 平铺条：一行目标 + 扁平待办列表，无卡片装饰。 */
function ComposerContextStrip({ goal, todos, onGoalControl }: {
  goal: GoalSnapshot | null;
  todos: TodoItem[];
  onGoalControl?: (action: 'pause' | 'resume' | 'cancel') => void | Promise<void>;
}) {
  const { tr } = useI18n();
  if (goal === null && todos.length === 0) return null;
  const goalStatusLabel = goal === null
    ? ''
    : goal.status === 'active'
      ? tr('Active', '进行中')
      : goal.status === 'paused'
        ? tr('Paused', '已暂停')
        : goal.status === 'blocked'
          ? tr('Blocked', '受阻')
          : tr('Complete', '已完成');
  const done = todos.filter(todo => todo.status === 'done').length;
  return (
    <div className="composer-context-strip">
      {goal !== null && <div className={`composer-goal-row goal-${goal.status}`}>
        <Icon name="target" size={13}/>
        <strong>{tr('Goal', '目标')}</strong>
        <span className="composer-goal-objective" title={goal.objective}>{goal.objective}</span>
        <em className="composer-goal-status">{goalStatusLabel}</em>
        {onGoalControl !== undefined && goal.status !== 'complete' && (
          <span className="composer-goal-actions">
            {goal.status === 'active'
              ? <button type="button" onClick={() => void onGoalControl('pause')}>{tr('Pause', '暂停')}</button>
              : <button type="button" onClick={() => void onGoalControl('resume')}>{tr('Resume', '继续')}</button>}
            <button type="button" className="danger" onClick={() => { if (window.confirm(tr('Cancel this goal?', '取消这个目标吗？'))) void onGoalControl('cancel'); }}>{tr('Cancel', '取消')}</button>
          </span>
        )}
      </div>}
      {todos.length > 0 && (
        <div className="composer-todos">
          <div className="composer-todos-head"><Icon name="list" size={12}/><strong>{tr('Todo list', '待办')}</strong><em>{done}/{todos.length}</em></div>
          <ul>
            {todos.map((todo, index) => (
              <li key={`${todo.title}-${index}`} className={`todo-${todo.status}`}>
                <i aria-hidden="true">{todo.status === 'done' ? '✓' : todo.status === 'in_progress' ? '▸' : '○'}</i>
                <span>{todo.title}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

