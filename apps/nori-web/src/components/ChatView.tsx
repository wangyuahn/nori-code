import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type UIEvent } from 'react';
import { api, type ApprovalRequest, type GoalSnapshot, type ModelCatalogItem, type PromptAttachment, type QuestionAnswer, type QuestionRequest, type Session, type SessionAgentConfig, type SessionRealtimeStatus, type TokenUsage } from '../api/client';
import type { ChatMessage, QueuedPrompt, TodoItem, ToolCall, WorkBlock } from '../hooks/useChatMessages';
import { useI18n } from '../i18n';
import { chatSlashCommandSuggestions, resolveChatSlashCommand, type ChatSlashCommand, type ChatSlashCommandName } from '../utils/chat-slash-commands';
import { Icon } from './Icon';
import { ApprovalPanel } from './ApprovalPanel';
import { MarkdownView } from './MarkdownView';
import { QuestionPanel } from './QuestionPanel';
import { SkillPicker } from './SkillPicker';
import { UsageOverview } from './UsageOverview';

export interface ChatViewProps {
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
  onSendMessage: (text: string, attachments?: PromptAttachment[], behavior?: 'queue' | 'steer') => boolean | void | Promise<boolean | void>;
  onAbort: () => void;
  onRefreshModels: () => void;
  onModelChange: (model: string) => void | Promise<void>;
  onThinkingChange: (effort: string) => void | Promise<void>;
  onPermissionChange: (mode: 'auto' | 'yolo' | 'manual') => void | Promise<void>;
  onTaskModeChange: (mode: 'plan' | 'code') => void | Promise<void>;
  onRunSlashCommand: (command: ChatSlashCommandName, args: string) => boolean | void | Promise<boolean | void>;
  onMainWriteChange: (enabled: boolean) => void | Promise<void>;
  onGoalControl?: (action: 'pause' | 'resume' | 'cancel') => void | Promise<void>;
  pendingApprovals?: ApprovalRequest[];
  onResolveApproval?: (approvalId: string, decision: 'approved' | 'rejected' | 'cancelled', options?: { remember?: boolean; feedback?: string; selectedLabel?: string }) => void | Promise<void>;
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

export function ChatView(props: ChatViewProps) {
  const { session, allSessions = [], messages, messagesLoading = false, streaming, thinking, workBlocks = [], isStreaming, activeAgentCount = 0, activeAgentTokens = 0, sessionStatus, compacting = false, models, modelsLoading, modelError, onSendMessage, onAbort, onRefreshModels, onModelChange, onThinkingChange, onPermissionChange, onTaskModeChange, onRunSlashCommand, onMainWriteChange, onGoalControl, pendingApprovals = [], onResolveApproval, pendingQuestions = [], onResolveQuestion, onDismissQuestion, queuedPrompts = [], todos = [], onCancelQueuedPrompt, draftAgentConfig, rewindLimit = 10, onRewind } = props;
  const { tr } = useI18n();
  const [input, setInput] = useState('');
  const [modelNotice, setModelNotice] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [attachmentsLoading, setAttachmentsLoading] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [commandNotice, setCommandNotice] = useState<string | null>(null);
  const [commandMenuDismissed, setCommandMenuDismissed] = useState(false);
  const [commandSelection, setCommandSelection] = useState(0);
  const [commandRunning, setCommandRunning] = useState(false);
  const [followOutput, setFollowOutput] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const followOutputRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const selectedModelId = session?.agent_config?.model ?? draftAgentConfig?.model ?? '';
  const selectedModel = models.find(model => model.model === selectedModelId);
  const efforts = selectedModel?.support_efforts ?? (selectedModel?.capabilities?.includes('thinking') ? ['low', 'medium', 'high'] : []);
  const selectedThinking = session?.agent_config?.thinking ?? draftAgentConfig?.thinking ?? selectedModel?.default_effort ?? 'off';
  const selectedPermission = session?.agent_config?.permission_mode ?? draftAgentConfig?.permission_mode ?? 'manual';
  const selectedTaskMode = (sessionStatus?.plan_mode ?? session?.agent_config?.plan_mode ?? draftAgentConfig?.plan_mode) ? 'plan' : 'code';
  const selectedMainWrite = sessionStatus?.main_write_enabled ?? session?.agent_config?.main_write_enabled ?? draftAgentConfig?.main_write_enabled ?? false;
  const commandSuggestions = chatSlashCommandSuggestions(input);
  const commandMenuOpen = !commandMenuDismissed && commandSuggestions.length > 0;
  const imageCapable = modelSupportsImageInput(selectedModel);
  const streamingContinuesAssistant = messages.at(-1)?.role === 'assistant';
  const rewindCounts = new Map<string, number>();
  let promptsFromEnd = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    promptsFromEnd++;
    if (promptsFromEnd <= rewindLimit) rewindCounts.set(message.id, promptsFromEnd);
  }

  useEffect(() => {
    if (followOutputRef.current) messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [messages, streaming, thinking]);
  useEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = Math.min(element.scrollHeight, 180) + 'px';
  }, [input]);
  useEffect(() => { setModelNotice(false); }, [selectedModelId, session?.id]);
  useEffect(() => {
    setAttachments([]);
    setAttachmentsLoading(false);
    setAttachmentError(null);
    setCommandNotice(null);
    setCommandMenuDismissed(false);
    setCommandSelection(0);
  }, [session?.id]);
  const addFiles = useCallback(async (files: FileList | File[]) => {
    const available = Math.max(0, 6 - attachments.length);
    const selected = Array.from(files).slice(0, available);
    if (selected.length === 0) return;
    const unsupportedImages = selected.filter(file => file.type.startsWith('image/'));
    const filesToLoad = imageCapable
      ? selected
      : selected.filter(file => !file.type.startsWith('image/'));
    setAttachmentError(unsupportedImages.length > 0 && !imageCapable
      ? imageUnsupportedMessage(Boolean(selectedModelId), tr)
      : null);
    if (filesToLoad.length === 0) return;
    setAttachmentsLoading(true);
    try {
      const results = await Promise.allSettled(filesToLoad.map(file => file.type.startsWith('image/')
        ? readImageAttachment(file)
        : uploadFileAttachment(file)));
      const loaded = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
      const failed = results.filter(result => result.status === 'rejected');
      if (loaded.length > 0) setAttachments(previous => [...previous, ...loaded].slice(0, 6));
      if (failed.length > 0 && unsupportedImages.length === 0) {
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
    if (attachmentsLoading) return;
    const accepted = await onSendMessage(text, attachments.map(item => item.attachment), behavior);
    if (accepted !== false) {
      setInput('');
      setAttachments([]);
      setAttachmentError(null);
      for (const item of attachments) {
        if (item.attachment.kind === 'file') void api.files.delete(item.attachment.file_id).catch(() => undefined);
      }
    }
  }, [attachments, attachmentsLoading, imageCapable, input, onSendMessage, selectedModelId, tr]);

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
      const accepted = await onRunSlashCommand(resolution.value.command.name, resolution.value.args);
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
    if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !isStreaming && pendingApprovals.length === 0 && pendingQuestions.length === 0) {
      event.preventDefault();
      void onTaskModeChange(selectedTaskMode === 'plan' ? 'code' : 'plan');
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (input.trim().startsWith('/')) void runSlashCommand();
      else void handleSend();
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (event.clipboardData.files.length === 0) return;
    const hasImage = Array.from(event.clipboardData.files).some(file => file.type.startsWith('image/'));
    if (!hasImage) return;
    event.preventDefault();
    if (!imageCapable) {
      setAttachmentError(imageUnsupportedMessage(Boolean(selectedModelId), tr));
      return;
    }
    void addFiles(event.clipboardData.files);
  };

  const handleModelChange = (modelId: string) => {
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
    void onModelChange(modelId);
  };

  const handleRewind = useCallback(async (count: number) => {
    if (!onRewind) return;
    const prompt = await onRewind(count);
    if (prompt === undefined) return;
    setInput(prompt);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [onRewind]);

  const handleMessagesScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
    if (atBottom === followOutputRef.current) return;
    followOutputRef.current = atBottom;
    setFollowOutput(atBottom);
  };

  const jumpToLatest = () => {
    followOutputRef.current = true;
    setFollowOutput(true);
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  return <section className="chat-view" aria-label={tr('Conversation', '对话')}>
    <div className="chat-header"><div><span className="eyebrow">{session ? tr('Active conversation', '当前对话') : tr('Start here', '从这里开始')}</span><h1>{session ? session.title || tr('Untitled conversation', '未命名会话') : tr('Start a new conversation', '开始新的对话')}</h1></div><div className="chat-header-meta"><span className={'status-dot' + (session ? ' active' : ' idle')}/>{session ? tr(messages.length + ' messages', messages.length + ' 条消息') : tr('Choose a project or conversation', '选择项目或已有对话')}</div></div>

    <div className="chat-messages" ref={messagesScrollRef} onScroll={handleMessagesScroll}>
      {messagesLoading ? <div className="chat-history-loading" role="status"><span className="spinner"/><strong>{tr('Loading conversation…', '正在加载会话…')}</strong></div> : messages.length === 0 ? <div className="chat-welcome"><div className="welcome-mark"><Icon name="sparkles" size={27}/></div><span className="eyebrow">{tr('Your thoughtful coding partner', '你的智能编程伙伴')}</span><h2>{session ? tr('What should we make better?', '我们要改进什么？') : tr('What would you like to work on?', '你想从哪里开始？')}</h2><p>{session ? tr('Ask Nori to inspect code, plan a feature, fix a bug, or validate an API integration.', '让 Nori 检查代码、规划功能、修复缺陷或验证 API 集成。') : tr('Choose a project folder to start a new task, or open an existing conversation from the sidebar. You can also type below now.', '选择一个项目文件夹开始新任务，或从左侧打开已有对话。你也可以直接在下方输入。')}</p><UsageOverview sessions={allSessions} models={models}/><div className="starter-grid">{STARTERS.map(item => <button key={item.title} className="starter-card" onClick={() => void handleSend(tr(item.prompt, item.promptZh))}><Icon name="sparkles" size={16}/><span><strong>{tr(item.title, item.titleZh)}</strong><small>{tr(item.prompt, item.promptZh)}</small></span></button>)}</div></div> : messages.map(message => <MessageBubble key={message.id} message={message} rewindCount={rewindCounts.get(message.id)} onRewind={handleRewind}/>) }

      {isStreaming && <div className={`chat-message chat-message-assistant chat-message-streaming${streamingContinuesAssistant ? ' continuation' : ''}`}>{!streamingContinuesAssistant && <div className="message-avatar"><span>N</span></div>}<div className="message-body">{!streamingContinuesAssistant && <div className="chat-message-role">Nori <span>{pendingApprovals.length > 0 ? tr('waiting for permission', '等待授权') : tr('working', '工作中')}</span></div>}{(workBlocks.length > 0 || thinking) && <WorkProcess blocks={workBlocks.length > 0 ? workBlocks : [{ id: 'live-thinking', type: 'thinking', text: thinking }]} live/>}<div className="chat-message-content">{streaming ? <MarkdownView content={streaming} /> : (!thinking && workBlocks.length === 0 && <span className="thinking-label">{tr('Waiting for model output…', '等待模型输出…')}</span>)}<span className="streaming-cursor"/></div>{streaming && <div className="message-token-usage">{tr('Live output', '实时输出')} ~{formatTokens(estimateStreamingTokens(streaming))} tokens</div>}<button className="chat-abort-btn" onClick={onAbort}><Icon name="stop" size={13}/> {tr('Stop response', '停止回复')}</button></div></div>}
      <div ref={messagesEndRef}/>
    </div>

    <div className="chat-composer-wrap">
      {!followOutput && <button className="chat-jump-latest" onClick={jumpToLatest} title={tr('Jump to latest', '回到最新消息')} aria-label={tr('Jump to latest', '回到最新消息')}><Icon name="chevron-down" size={16}/></button>}
      <ActivityIsland mainWorking={isStreaming} agentCount={activeAgentCount} agentTokens={activeAgentTokens} goal={sessionStatus?.goal ?? null} todos={todos} onGoalControl={onGoalControl}/>
      {pendingQuestions.length > 0 && onResolveQuestion && onDismissQuestion && <QuestionPanel requests={pendingQuestions} onSubmit={onResolveQuestion} onDismiss={onDismissQuestion}/>}
      {pendingApprovals.length > 0 && onResolveApproval && <ApprovalPanel requests={pendingApprovals} onResolve={(id, decision, options) => { void onResolveApproval(id, decision, options); }} />}
      <div className={'chat-input-area' + (input || attachments.length > 0 ? ' has-value' : '') + (modelNotice ? ' missing-model' : '')}>
      {queuedPrompts.length > 0 && <div className="composer-queue"><span>{tr('Queued', '排队中')} {queuedPrompts.length}</span>{queuedPrompts.map(prompt => <div key={prompt.id} title={prompt.text}><span>{prompt.text}</span>{onCancelQueuedPrompt && <button type="button" onClick={() => void onCancelQueuedPrompt(prompt.id)} title={tr('Remove queued prompt', '移除排队消息')} aria-label={tr('Remove queued prompt', '移除排队消息')}><Icon name="close" size={11}/></button>}</div>)}</div>}
      {(attachments.length > 0 || attachmentsLoading) && <div className="composer-attachments">{attachments.map(item => <div className={`composer-attachment attachment-${item.attachment.kind}`} key={item.id}>{item.preview ? <img src={item.preview} alt={item.name}/> : <span className="composer-file-icon"><Icon name="files" size={19}/></span>}<span title={item.name}>{item.name}</span><button type="button" onClick={() => removeAttachment(item)} aria-label={tr('Remove file', '移除文件')}><Icon name="close" size={12}/></button></div>)}{attachmentsLoading && <div className="composer-attachment composer-attachment-loading"><span className="composer-file-icon"><span className="spinner spinner-small"/></span><span>{tr('Uploading…', '正在上传…')}</span></div>}</div>}
      {commandMenuOpen && <div className="composer-command-menu" id="composer-command-menu" role="listbox" aria-label={tr('Slash commands', '斜杠命令')}>
        {commandSuggestions.map((command, index) => <button key={command.name} type="button" id={`composer-command-${command.name}`} role="option" aria-selected={index === commandSelection} className={index === commandSelection ? 'active' : ''} onMouseDown={event => event.preventDefault()} onClick={() => selectSlashCommand(command)}><code>/{command.name}{command.argumentHint ? ` ${command.argumentHint}` : ''}</code><span>{tr(command.description, command.descriptionZh)}</span></button>)}
      </div>}
      <textarea ref={inputRef} className="chat-input" placeholder={session ? tr('Ask Nori about this project…', '向 Nori 询问此项目…') : tr('Describe what you want to work on…', '告诉 Nori 你想做什么…')} value={input} onChange={event => { setInput(event.target.value); setCommandMenuDismissed(false); setCommandSelection(0); setCommandNotice(null); }} onKeyDown={handleKeyDown} onPaste={handlePaste} rows={1} aria-label={tr('Message Nori', '向 Nori 发送消息')} aria-autocomplete="list" aria-expanded={commandMenuOpen} aria-controls={commandMenuOpen ? 'composer-command-menu' : undefined} aria-activedescendant={commandMenuOpen ? `composer-command-${commandSuggestions[commandSelection]?.name ?? commandSuggestions[0]?.name}` : undefined}/>
      <SessionUsageBar status={sessionStatus} compacting={compacting} />
      <div className="composer-mode-row"><div className="composer-task-mode" role="group" aria-label={tr('Task mode', '任务模式')}><button type="button" className={selectedTaskMode === 'plan' ? 'active' : ''} onClick={() => void onTaskModeChange('plan')} disabled={isStreaming}>{tr('Plan', '规划')}</button><button type="button" className={selectedTaskMode === 'code' ? 'active' : ''} onClick={() => void onTaskModeChange('code')} disabled={isStreaming}>{tr('Code', '执行')}</button></div>{selectedTaskMode === 'code' && <label className="main-write-toggle" title={tr('Allow the main model to use Edit and Write directly.', '允许主模型直接使用 Edit 和 Write。')}><input type="checkbox" checked={selectedMainWrite} disabled={isStreaming} onChange={event => void onMainWriteChange(event.target.checked)}/><span>{tr('Main edits', '主模型编辑')}</span></label>}</div>
      <div className="composer-footer"><div className="composer-model-controls">
        <select className={'composer-select model-select' + (!selectedModelId ? ' invalid' : '')} value={selectedModelId} disabled={isStreaming || modelsLoading} onChange={e => handleModelChange(e.target.value)} aria-label={tr('Model', '模型')}><option value="">{modelsLoading ? tr('Loading models…', '正在加载模型…') : tr('Select model', '选择模型')}</option>{models.map(model => <option key={model.model} value={model.model}>{model.display_name || model.model}</option>)}</select>
        {efforts.length > 0 && <select className="composer-select thinking-select" value={selectedThinking} disabled={isStreaming} onChange={e => void onThinkingChange(e.target.value)} aria-label={tr('Thinking effort', '思考等级')}><option value="off">{tr('Thinking off', '关闭思考')}</option>{efforts.map(effort => <option key={effort} value={effort}>{tr('Thinking', '思考')} · {effort}</option>)}</select>}
        <select className={`composer-select permission-select permission-${selectedPermission}`} value={selectedPermission} disabled={isStreaming} onChange={event => void onPermissionChange(event.target.value as 'auto' | 'yolo' | 'manual')} aria-label={tr('Permission mode', '权限模式')} title={tr('Auto approves normal tools; YOLO asks nothing; Manual asks before commands and changes.', '自动模式放行常规工具；YOLO 不询问；手动模式在命令和更改前询问。')}><option value="auto">AUTO</option><option value="yolo">YOLO</option><option value="manual">MANUAL</option></select>
        <SkillPicker sessionId={session?.id ?? null} disabled={isStreaming}/>
        <button className="composer-refresh" onClick={onRefreshModels} disabled={modelsLoading} title={tr('Refresh model list', '刷新模型列表')} aria-label={tr('Refresh model list', '刷新模型列表')}><Icon name="refresh" size={14}/></button>
      </div><div className="composer-submit-actions"><input ref={imageInputRef} className="composer-image-input" type="file" multiple onChange={event => { if (event.target.files) void addFiles(event.target.files); event.target.value = ''; }}/><button type="button" className="composer-image-button" onClick={() => imageInputRef.current?.click()} disabled={attachmentsLoading || attachments.length >= 6 || commandRunning} title={tr('Attach files', '添加文件')} aria-label={tr('Attach files', '添加文件')}><Icon name="paperclip" size={15}/></button>{isStreaming && <button className="chat-steer-btn" onClick={() => void handleSend(undefined, 'steer')} disabled={attachmentsLoading || (!input.trim() && attachments.length === 0)} title={tr('Steer the active task now', '立即调整当前任务')} aria-label={tr('Steer the active task now', '立即调整当前任务')}><Icon name="sparkles" size={15}/></button>}<button className="chat-send-btn" onClick={() => input.trim().startsWith('/') ? void runSlashCommand() : void handleSend()} disabled={commandRunning || attachmentsLoading || (!input.trim() && attachments.length === 0)} title={isStreaming ? tr('Queue message', '排队发送') : tr('Send message', '发送消息')} aria-label={isStreaming ? tr('Queue message', '排队发送') : tr('Send message', '发送消息')}><Icon name="send" size={16}/></button></div></div>
      {(modelNotice || modelError || attachmentError) && <div className="composer-error" role="status">{modelNotice ? tr('Select a model before sending.', '请先选择模型') : attachmentError ?? modelError}</div>}
      {commandNotice && <div className="composer-command-notice" role="status">{commandNotice}</div>}
    </div></div>
  </section>;
}

function ActivityIsland({ mainWorking, agentCount, agentTokens, goal, todos, onGoalControl }: { mainWorking: boolean; agentCount: number; agentTokens: number; goal: GoalSnapshot | null; todos: TodoItem[]; onGoalControl?: (action: 'pause' | 'resume' | 'cancel') => void | Promise<void> }) {
  const { tr } = useI18n();
  const [phraseIndex, setPhraseIndex] = useState(0);
  const mainPhrases = [
    tr('Nori is tracing the threads…', 'Nori 正在理清线索…'),
    tr('Nori is sharpening the answer…', 'Nori 正在打磨答案…'),
    tr('Nori is fitting the pieces together…', 'Nori 正在拼好思路…'),
    tr('Nori is checking the gears…', 'Nori 正在检查齿轮…'),
  ];
  const agentPhrases = [
    tr('Agents are exploring in parallel…', '智能体正在并行探索…'),
    tr('Agents are comparing notes…', '智能体正在交换发现…'),
    tr('Agents are mapping the code…', '智能体正在绘制代码脉络…'),
    tr('Agents are gathering results…', '智能体正在汇总成果…'),
  ];
  useEffect(() => {
    if (!mainWorking && agentCount === 0) return;
    setPhraseIndex(0);
    const timer = setInterval(() => setPhraseIndex(current => current + 1), 3_200);
    return () => clearInterval(timer);
  }, [agentCount, mainWorking]);

  if (!mainWorking && agentCount === 0 && goal === null && todos.length === 0) return null;
  const headline = mainWorking
    ? mainPhrases[phraseIndex % mainPhrases.length]
    : agentCount > 0
      ? agentPhrases[phraseIndex % agentPhrases.length]
      : goal?.objective ?? todos.find(todo => todo.status === 'in_progress')?.title ?? todos[0]?.title ?? '';
  const completedTodos = todos.filter(todo => todo.status === 'done').length;
  const summaryParts = [
    mainWorking ? tr('Nori active', 'Nori 工作中') : '',
    agentCount > 0 ? tr(`${agentCount} agents`, `${agentCount} 个智能体`) : '',
    goal ? tr('Goal tracked', '目标跟踪中') : '',
    todos.length > 0 ? tr(`${completedTodos}/${todos.length} todos`, `${completedTodos}/${todos.length} 待办`) : '',
  ].filter(Boolean);
  const icon = mainWorking ? 'sparkles' : agentCount > 0 ? 'swarm' : 'target';

  const goalStatusLabel = goal === null
    ? ''
    : goal.status === 'active'
      ? tr('Active', '进行中')
      : goal.status === 'paused'
        ? tr('Paused', '已暂停')
        : goal.status === 'blocked'
          ? tr('Blocked', '受阻')
          : tr('Complete', '已完成');
  const budgetItems = goal === null ? [] : [
    goal.budget.turnBudget === null ? tr(`${goal.turnsUsed} turns`, `${goal.turnsUsed} 轮`) : tr(`${goal.turnsUsed}/${goal.budget.turnBudget} turns`, `${goal.turnsUsed}/${goal.budget.turnBudget} 轮`),
    goal.budget.tokenBudget === null ? `${formatTokens(goal.tokensUsed)} tokens` : `${formatTokens(goal.tokensUsed)}/${formatTokens(goal.budget.tokenBudget)} tokens`,
    formatGoalTime(goal.wallClockMs, tr),
  ];

  return <details className={`activity-island${goal ? ` goal-${goal.status}` : ''}`}>
    <summary>
      <span className="activity-island-icon"><Icon name={icon} size={14}/></span>
      <span className="activity-island-copy"><small>{summaryParts.join(' · ')}</small><strong>{headline}</strong></span>
      <span className="activity-island-stats">{agentTokens > 0 ? `${formatTokens(agentTokens)} tokens` : goal ? goalStatusLabel : tr('Live', '实时')}</span>
      <Icon name="chevron-down" size={13}/>
    </summary>
    <div className="activity-island-details">
      {mainWorking && <p><span>{tr('Main model', '主模型')}</span><strong>{mainPhrases[phraseIndex % mainPhrases.length]}</strong></p>}
      {agentCount > 0 && <p><span>{tr('Background agents', '后台智能体')}</span><strong>{agentPhrases[phraseIndex % agentPhrases.length]} {agentTokens > 0 ? `· ${formatTokens(agentTokens)} tokens` : ''}</strong></p>}
      {todos.length > 0 && <div className="activity-island-todos"><span>{tr('Todo list', '待办')}</span><ol>{todos.map((todo, index) => <li key={`${todo.title}-${index}`} className={`todo-${todo.status}`}><Icon name={todo.status === 'done' ? 'check' : todo.status === 'in_progress' ? 'sparkles' : 'target'} size={12}/><strong>{todo.title}</strong></li>)}</ol></div>}
      {goal && <><p><span>{tr('Goal', '目标')}</span><strong>{goal.objective}</strong></p><p><span>{tr('Status', '状态')}</span><strong>{goalStatusLabel}</strong></p><p><span>{tr('Budget', '预算')}</span><strong>{budgetItems.join(' · ')}</strong></p>{goal.completionCriterion && <p><span>{tr('Done when', '完成标准')}</span><strong>{goal.completionCriterion}</strong></p>}{goal.terminalReason && <p><span>{tr('Status note', '状态说明')}</span><strong>{goal.terminalReason}</strong></p>}{onGoalControl && goal.status !== 'complete' && <div className="activity-island-actions">{goal.status === 'active' ? <button type="button" onClick={() => void onGoalControl('pause')}>{tr('Pause', '暂停')}</button> : <button type="button" onClick={() => void onGoalControl('resume')}>{tr('Resume', '继续')}</button>}<button type="button" className="danger" onClick={() => { if (window.confirm(tr('Cancel this goal?', '取消这个目标吗？'))) void onGoalControl('cancel'); }}>{tr('Cancel goal', '取消目标')}</button></div>}</>}
    </div>
  </details>;
}

function formatGoalTime(milliseconds: number, tr: (en: string, zh: string) => string): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 1) return tr('<1 min', '<1 分钟');
  if (minutes < 60) return tr(`${minutes} min`, `${minutes} 分钟`);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return tr(`${hours}h ${remainder}m`, `${hours} 小时 ${remainder} 分钟`);
}

function MessageBubble({ message, rewindCount, onRewind }: { message: ChatMessage; rewindCount?: number; onRewind?: (count: number) => void | Promise<void> }) {
  const { tr } = useI18n();
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const tools = message.toolCalls ?? [];
  const blocks = message.workBlocks ?? [
    ...(message.thinking ? [{ id: `${message.id}-thinking`, type: 'thinking' as const, text: message.thinking }] : []),
    ...tools.map((tool, index) => ({ id: tool.id ?? `${message.id}-tool-${index}`, type: 'tool' as const, tool })),
  ];
  const hasWork = !isUser && !isSystem && blocks.length > 0;
  return <article className={'chat-message ' + (isUser ? 'chat-message-user' : isSystem ? 'chat-message-system' : 'chat-message-assistant')}>
    <div className="message-avatar"><span>{isUser ? 'Y' : isSystem ? '!' : 'N'}</span></div><div className="message-body"><div className="chat-message-role">{isUser ? tr('You', '你') : isSystem ? tr('System', '系统') : 'Nori'}{isUser && rewindCount && onRewind && <button className="message-rewind-btn" onClick={() => {
      if (!window.confirm(tr('Rewind the conversation and workspace to before this prompt?', '将对话和代码回溯到此提问之前？'))) return;
      void onRewind(rewindCount);
    }} title={tr('Rewind to before this prompt', '回溯到此提问之前')}><Icon name="refresh" size={12}/>{tr('Rewind', '回溯')}</button>}</div>
      {hasWork && <WorkProcess blocks={blocks}/>}
      {message.images && message.images.length > 0 && <div className="chat-message-images">{message.images.map((image, index) => <img key={`${image.src.slice(0, 80)}-${String(index)}`} src={image.src} alt={image.alt} loading="lazy" />)}</div>}
      {message.text && <div className="chat-message-content">{isUser || isSystem ? message.text : <MarkdownView content={message.text} />}</div>}{message.usage && <TokenUsageLine usage={message.usage} />}{message.createdAt && <time className="chat-message-time">{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>}
    </div>
  </article>;
}

function WorkProcess({ blocks, live = false }: { blocks: WorkBlock[]; live?: boolean }) {
  const { tr } = useI18n();
  const toolCount = blocks.filter(block => block.type === 'tool').length;
  const reasoningCount = blocks.filter(block => block.type === 'thinking').length;
  const label = [
    reasoningCount > 0 ? tr('reasoning', '推理') : '',
    toolCount > 0 ? tr(`${toolCount} tool calls`, `${toolCount} 次工具调用`) : '',
  ].filter(Boolean).join(' + ');
  return <details className="chat-work-process">
    <summary><Icon name="settings" size={14}/><span>{tr('Work process', '工作过程')}</span><small>{live ? tr('Live', '实时') : label}</small></summary>
    <div className="chat-work-process-body">{blocks.map(block => block.type === 'thinking'
      ? <section className="work-reasoning-block" key={block.id}><strong>{tr('Reasoning', '推理')}</strong><pre>{block.text}</pre></section>
      : <CompactToolCall key={block.id} tool={block.tool}/>)}</div>
  </details>;
}

function CompactToolCall({ tool }: { tool: ToolCall }) {
  const { tr } = useI18n();
  const summary = summarizeToolCall(tool, tr);
  return <div className={`compact-tool-call tool-${tool.name.toLowerCase()}`} title={tool.result?.slice(0, 600)}>
    <span className="compact-tool-icon"><Icon name="settings" size={12}/></span>
    <strong>{tool.name}</strong>
    {summary && <span>{summary}</span>}
    <small className={tool.result === undefined ? 'running' : 'done'}>{tool.result === undefined ? tr('Running', '运行中') : tr('Done', '完成')}</small>
  </div>;
}

function summarizeToolCall(tool: ToolCall, tr: (english: string, chinese: string) => string): string {
  const args = typeof tool.args === 'object' && tool.args !== null ? tool.args as Record<string, unknown> : {};
  const normalized = tool.name.toLowerCase();
  const path = firstString(args.path, args.file_path, args.filename, args.file);
  if (normalized === 'edit' || normalized === 'write') {
    const oldText = firstString(args.old_string, args.old_text) ?? '';
    const newText = firstString(args.new_string, args.content, args.new_text) ?? '';
    const resultCounts = diffCounts(tool.result);
    const additions = resultCounts?.additions ?? countLines(newText);
    const deletions = resultCounts?.deletions ?? (normalized === 'edit' ? countLines(oldText) : 0);
    return [path, `+${additions} -${deletions}`].filter(Boolean).join(' · ');
  }
  if (normalized === 'agentswarm' || normalized === 'agent_swarm') {
    const tasks = Array.isArray(args.tasks) ? args.tasks : Array.isArray(args.items) ? args.items : [];
    const resumed = Array.isArray(args.resume_agent_ids) ? args.resume_agent_ids.length : 0;
    const count = tasks.length + resumed;
    return count > 0 ? tr(`${count} agents launched`, `调用 ${count} 个智能体`) : tr('Agent collaboration', '智能体协作');
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
    reader.onerror = () => reject(reader.error ?? new Error(`Unable to read ${file.name}.`));
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
  if (comma < 0) throw new Error(`Unable to encode ${file.name}.`);
  return {
    id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
    name: file.name,
    preview,
    attachment: {
      kind: 'image',
      name: file.name,
      source: {
        kind: 'base64',
        media_type: file.type || 'image/png',
        data: preview.slice(comma + 1),
      },
    },
  };
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

function SessionUsageBar({ status, compacting }: { status?: SessionRealtimeStatus | null; compacting: boolean }) {
  const { tr } = useI18n();
  if (!status) return null;
  const total = status.usage?.total;
  const totalTokens = total ? total.input_other + total.input_cache_read + total.input_cache_creation + total.output : undefined;
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
