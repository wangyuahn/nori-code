import type { Session } from '@nori-code/sdk';

import { AssistantMessageComponent } from '../components/messages/assistant-message';
import { DiscussUtteranceComponent } from '../components/messages/discuss-utterance';
import { currentWorkingTip } from '../components/chrome/working-tips';
import { CompactionComponent } from '../components/dialogs/compaction';
import { ReadGroupComponent } from '../components/messages/read-group';
import { ThinkingComponent } from '../components/messages/thinking';
import { ToolCallComponent } from '../components/messages/tool-call';
import { STREAMING_UI_FLUSH_MS } from '../constant/streaming';
import { hasDispose } from '../utils/component-capabilities';
import { appendStreamingArgsPreview, parseStreamingArgs } from '../utils/event-payload';
import { notifyTerminalOnce } from '../utils/terminal-notification';
import { nextTranscriptId } from '../utils/transcript-id';
import type { TodoItem } from '../components/chrome/todo-panel';
import type {
  AppState,
  LivePaneState,
  QueuedMessage,
  ToolCallBlockData,
  ToolResultBlockData,
  TranscriptEntry,
} from '../types';
import type { TUIState } from '../tui-state';

export interface StreamingUIHost {
  state: TUIState;
  session: Session | undefined;
  setAppState(patch: Partial<AppState>): void;
  patchLivePane(patch: Partial<LivePaneState>): void;
  resetLivePane(): void;
  updateActivityPane(): void;
  updateQueueDisplay(): void;
  requireSession(): Session;
  deferUserMessages: boolean;
  shiftQueuedMessage(): QueuedMessage | undefined;
  pushTranscriptEntry(entry: TranscriptEntry): void;
  mergeCurrentTurnSteps(): void;
}

export class StreamingUIController {
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private lastFlushAt: number | undefined;
  private pendingAssistantFlush = false;
  private pendingThinkingFlush = false;
  readonly pendingToolCallFlushIds = new Set<string>();
  private readonly pendingDiscussFlushIds = new Set<string>();

  // ---------------------------------------------------------------------------
  // Streaming runtime state (private — accessed via semantic methods below)
  // ---------------------------------------------------------------------------

  private _currentTurnId: string | undefined = undefined;
  private _currentStep = 0;
  private _assistantDraft = '';
  private _thinkingDraft = '';
  private _streamingBlock: { component: AssistantMessageComponent; entry: TranscriptEntry } | null = null;
  private readonly _discussBlocks = new Map<
    string,
    { component: DiscussUtteranceComponent; entry: TranscriptEntry; draft: string }
  >();
  private _activeThinkingComponent: ThinkingComponent | undefined = undefined;
  private _activeCompactionBlock: CompactionComponent | undefined = undefined;
  private _activeToolCalls = new Map<string, ToolCallBlockData>();
  private _streamingToolCallArguments = new Map<
    string,
    { name?: string; argumentsText: string; startedAtMs: number }
  >();
  private _pendingToolComponents = new Map<string, ToolCallComponent>();
  private _pendingReadGroup: {
    readonly turnId: string | undefined;
    readonly step: number;
    solo?: ToolCallComponent;
    group?: ReadGroupComponent;
  } | null = null;

  constructor(private readonly host: StreamingUIHost) {}

  // ---------------------------------------------------------------------------
  // Turn context — read/write accessors
  // ---------------------------------------------------------------------------

  getTurnContext(): { turnId: string | undefined; step: number } {
    return { turnId: this._currentTurnId, step: this._currentStep };
  }

  setTurnId(turnId: string | undefined): void {
    this._currentTurnId = turnId;
  }

  setStep(step: number): void {
    this._currentStep = step;
  }

  hasActiveTurn(): boolean {
    return this._currentTurnId !== undefined;
  }

  // ---------------------------------------------------------------------------
  // Text streaming — semantic write accessors
  // ---------------------------------------------------------------------------

  appendThinkingDelta(delta: string): void {
    this._thinkingDraft += delta;
    this.pendingThinkingFlush = true;
  }

  appendAssistantDelta(delta: string): void {
    if (this._streamingBlock === null) {
      this.onStreamingTextStart();
    }
    this._assistantDraft += delta;
    this.pendingAssistantFlush = true;
  }

  appendDiscussDelta(agentId: string, speakerName: string, delta: string, turnId?: string): void {
    this.setDiscussUtterance(agentId, speakerName, delta, { turnId, speaking: true, replace: false });
  }

  setDiscussUtterance(
    agentId: string,
    speakerName: string,
    text: string,
    opts?: { turnId?: string; speaking?: boolean; replace?: boolean },
  ): void {
    let block = this._discussBlocks.get(agentId);
    if (block === undefined) {
      const speaking = opts?.speaking !== false;
      const entry: TranscriptEntry = {
        id: nextTranscriptId(),
        kind: 'discuss_utterance',
        turnId: opts?.turnId,
        renderMode: 'plain',
        content: '',
        speakerName,
        speakerAgentId: agentId,
        speaking,
      };
      const component = new DiscussUtteranceComponent(speakerName, speaking);
      block = { component, entry, draft: '' };
      this._discussBlocks.set(agentId, block);
      this.host.pushTranscriptEntry(entry);
      this.host.state.transcriptContainer.addChild(component);
    }
    block.draft = opts?.replace === true ? text : block.draft + text;
    if (opts?.speaking !== undefined) {
      block.entry.speaking = opts.speaking;
    }
    this.pendingDiscussFlushIds.add(agentId);
  }

  finalizeDiscussUtterance(agentId: string): void {
    this.flushNow();
    const block = this._discussBlocks.get(agentId);
    if (block === undefined) return;
    block.entry.content = block.draft;
    block.entry.speaking = false;
    block.component.updateContent(block.draft, { speaking: false });
    this._discussBlocks.delete(agentId);
    this.pendingDiscussFlushIds.delete(agentId);
    this.host.state.ui.requestRender();
  }

  resetDiscussStreams(): void {
    for (const block of this._discussBlocks.values()) {
      block.entry.speaking = false;
      block.component.updateContent(block.draft, { speaking: false });
    }
    this._discussBlocks.clear();
    this.pendingDiscussFlushIds.clear();
  }

  hasThinkingDraft(): boolean {
    return this._thinkingDraft.length > 0;
  }

  hasActiveThinkingComponent(): boolean {
    return this._activeThinkingComponent !== undefined;
  }

  hasStreamingBlock(): boolean {
    return this._streamingBlock !== null;
  }

  getStreamingBlockComponent(): AssistantMessageComponent | undefined {
    return this._streamingBlock?.component;
  }

  clearAssistantDraft(): void {
    this._assistantDraft = '';
  }

  // ---------------------------------------------------------------------------
  // Tool call state — semantic accessors
  // ---------------------------------------------------------------------------

  getActiveToolCall(id: string): ToolCallBlockData | undefined {
    return this._activeToolCalls.get(id);
  }

  hasActiveToolCall(id: string): boolean {
    return this._activeToolCalls.has(id);
  }

  setActiveToolCall(id: string, toolCall: ToolCallBlockData): void {
    this._activeToolCalls.set(id, toolCall);
  }

  removeActiveToolCall(id: string): void {
    this._activeToolCalls.delete(id);
  }

  getToolComponent(id: string): ToolCallComponent | undefined {
    return this._pendingToolComponents.get(id);
  }

  removeToolComponent(id: string): void {
    this._pendingToolComponents.delete(id);
  }

  hasPendingReadGroup(): boolean {
    return this._pendingReadGroup !== null;
  }

  removeToolComponentIfInactive(toolCallId: string): void {
    if (!this._activeToolCalls.has(toolCallId)) {
      this._pendingToolComponents.delete(toolCallId);
    }
  }

  /** Registers a tool call that arrived via tool.call.started.
   *  Clears any pending streaming state for this id, updates or creates the
   *  component, and returns whether the call was new (no previous entry). */
  registerToolCall(toolCall: ToolCallBlockData): boolean {
    const existing = this._activeToolCalls.get(toolCall.id);
    this._activeToolCalls.set(toolCall.id, toolCall);
    this.pendingToolCallFlushIds.delete(toolCall.id);
    this._streamingToolCallArguments.delete(toolCall.id);
    const existingComponent = this._pendingToolComponents.get(toolCall.id);
    if (existingComponent !== undefined) {
      existingComponent.updateToolCall(toolCall);
    } else if (existing === undefined) {
      this.finalizeLiveTextBuffers('tool');
      this.onToolCallStart(toolCall);
    }
    return existing === undefined;
  }

  /** Accumulates a streaming tool-call argument delta. */
  accumulateToolCallDelta(
    id: string,
    eventName: string | undefined,
    argumentsPart: string | null | undefined,
  ): void {
    const existing = this._streamingToolCallArguments.get(id);
    const argumentsText = appendStreamingArgsPreview(existing?.argumentsText, argumentsPart);
    const name = eventName ?? existing?.name ?? this._activeToolCalls.get(id)?.name ?? 'Tool';
    const startedAtMs = existing?.startedAtMs ?? Date.now();
    this._streamingToolCallArguments.set(id, { name, argumentsText, startedAtMs });
    this.pendingToolCallFlushIds.add(id);
  }

  /** Keep parsed args but do not paint a collapsed tool-output card. */
  suppressToolCallPreview(id: string): void {
    this.pendingToolCallFlushIds.delete(id);
  }

  discardToolCallStream(id: string): void {
    this.pendingToolCallFlushIds.delete(id);
    this._streamingToolCallArguments.delete(id);
  }

  getStreamingToolCallPreview(
    id: string,
  ): { name: string; args: Record<string, unknown>; argumentsText: string; startedAtMs: number } | undefined {
    const streaming = this._streamingToolCallArguments.get(id);
    if (streaming === undefined) return undefined;
    return {
      name: streaming.name ?? this._activeToolCalls.get(id)?.name ?? 'Tool',
      args: parseStreamingArgs(streaming.argumentsText),
      argumentsText: streaming.argumentsText,
      startedAtMs: streaming.startedAtMs,
    };
  }

  /** Completes a tool call: delivers the result and removes tracking state.
   *  Returns the matched ToolCallBlockData, or undefined if no call was tracked. */
  completeToolResult(toolCallId: string, result: ToolResultBlockData): ToolCallBlockData | undefined {
    const matchedCall = this._activeToolCalls.get(toolCallId);
    if (matchedCall !== undefined) {
      this.onToolCallEnd(toolCallId, result);
    }
    this._activeToolCalls.delete(toolCallId);
    this._streamingToolCallArguments.delete(toolCallId);
    return matchedCall;
  }

  /** Marks in-flight tool calls as truncated when a step hits max_tokens.
   *  Returns the count of tool calls that were truncated. */
  markStepTruncated(turnId: string, step: number): number {
    let count = 0;
    for (const toolCall of this._activeToolCalls.values()) {
      if (toolCall.result !== undefined) continue;
      if (toolCall.streamingArguments === undefined) continue;
      if (toolCall.turnId !== turnId) continue;
      if (toolCall.step !== step) continue;
      toolCall.truncated = true;
      const component = this._pendingToolComponents.get(toolCall.id);
      if (component !== undefined) {
        component.updateToolCall(toolCall);
      }
      count += 1;
    }
    this._streamingToolCallArguments.clear();
    return count;
  }

  /** Tears down replay-specific state after session history has been rendered. */
  cleanupAfterReplay(completedToolCallIds: Set<string>): void {
    this._activeToolCalls.clear();
    for (const toolCallId of completedToolCallIds) {
      this._pendingToolComponents.delete(toolCallId);
    }
    this._pendingReadGroup = null;
    this._currentTurnId = undefined;
    this._currentStep = 0;
    this._streamingToolCallArguments.clear();
    this.pendingToolCallFlushIds.clear();
    this.host.state.ui.requestRender();
  }

  // ---------------------------------------------------------------------------
  // Dispose helpers (moved from KimiTUI)
  // ---------------------------------------------------------------------------

  disposeActiveThinkingComponent(): void {
    if (this._activeThinkingComponent !== undefined) {
      this._activeThinkingComponent.dispose();
      this._activeThinkingComponent = undefined;
    }
  }

  disposeAndClearPendingToolComponents(): void {
    for (const component of this._pendingToolComponents.values()) {
      if (hasDispose(component)) component.dispose();
    }
    this._pendingToolComponents.clear();
  }

  disposeActiveCompactionBlock(): void {
    if (this._activeCompactionBlock !== undefined) {
      this._activeCompactionBlock.dispose();
      this._activeCompactionBlock = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Flush control
  // ---------------------------------------------------------------------------

  hasPending(): boolean {
    return (
      this.pendingAssistantFlush ||
      this.pendingThinkingFlush ||
      this.pendingToolCallFlushIds.size > 0 ||
      this.pendingDiscussFlushIds.size > 0
    );
  }

  clearFlushTimer(): void {
    if (this.flushTimer === undefined) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }

  private clearFlushTimerIfIdle(): void {
    if (this.hasPending()) return;
    this.clearFlushTimer();
  }

  discardPending(): void {
    this.clearFlushTimer();
    this.pendingAssistantFlush = false;
    this.pendingThinkingFlush = false;
    this.pendingToolCallFlushIds.clear();
    this.pendingDiscussFlushIds.clear();
  }

  scheduleFlush(): void {
    if (!this.hasPending()) return;
    if (this.flushTimer !== undefined) return;
    const delay =
      this.lastFlushAt === undefined
        ? 0
        : Math.max(0, STREAMING_UI_FLUSH_MS - (Date.now() - this.lastFlushAt));
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, delay);
  }

  flushNow(): void {
    this.clearFlushTimer();
    this.flush();
  }

  private flush(): void {
    if (!this.hasPending()) return;
    this.lastFlushAt = Date.now();
    const shouldFlushThinking = this.pendingThinkingFlush;
    const shouldFlushAssistant = this.pendingAssistantFlush;
    const toolCallIds = [...this.pendingToolCallFlushIds];
    const discussIds = [...this.pendingDiscussFlushIds];
    this.pendingThinkingFlush = false;
    this.pendingAssistantFlush = false;
    this.pendingToolCallFlushIds.clear();
    this.pendingDiscussFlushIds.clear();

    if (shouldFlushThinking && this._thinkingDraft.length > 0) {
      this.onThinkingUpdate(this._thinkingDraft);
    }
    if (shouldFlushAssistant) {
      this.onStreamingTextUpdate(this._assistantDraft);
    }
    for (const id of discussIds) {
      const block = this._discussBlocks.get(id);
      if (block === undefined) continue;
      block.entry.content = block.draft;
      block.component.updateContent(block.draft, { speaking: block.entry.speaking === true });
    }
    for (const id of toolCallIds) {
      this.flushToolCallPreview(id);
    }
    if (discussIds.length > 0) {
      this.host.state.ui.requestRender();
    }
  }

  markAssistantDirty(): void {
    this.pendingAssistantFlush = true;
  }

  markThinkingDirty(): void {
    this.pendingThinkingFlush = true;
  }

  // ---------------------------------------------------------------------------
  // Text streaming
  // ---------------------------------------------------------------------------

  flushThinkingToTranscript(nextMode: LivePaneState['mode'] = 'idle'): void {
    this.flushNow();
    this._thinkingDraft = '';
    this.onThinkingEnd();
    this.host.patchLivePane({ mode: nextMode });
  }

  finalizeAssistantStream(): void {
    this.flushNow();
    if (this._streamingBlock !== null) {
      this.onStreamingTextEnd();
    }
    this._assistantDraft = '';
    this.host.updateActivityPane();
    this.host.state.ui.requestRender();
  }

  resetLiveText(): void {
    this.pendingAssistantFlush = false;
    this.pendingThinkingFlush = false;
    this.clearFlushTimerIfIdle();
    this._assistantDraft = '';
    this._streamingBlock = null;
    this._thinkingDraft = '';
    this.resetDiscussStreams();
    this.disposeActiveThinkingComponent();
  }

  resetToolUi(): void {
    this.pendingToolCallFlushIds.clear();
    this.clearFlushTimerIfIdle();
    this._streamingToolCallArguments.clear();
    this.disposeAndClearPendingToolComponents();
    this._pendingReadGroup = null;
    this.resetToolCallState();
  }

  resetToolCallState(): void {
    this._activeToolCalls.clear();
  }

  finalizeLiveTextBuffers(nextMode: LivePaneState['mode'] = 'idle'): void {
    this.flushThinkingToTranscript(nextMode);
    this.finalizeAssistantStream();
  }

  finalizeTurn(sendQueued: (item: QueuedMessage) => void): void {
    const { state } = this.host;
    if (state.appState.streamingPhase === 'idle') return;
    this.host.deferUserMessages = false;
    const completedTurnKey =
      this._currentTurnId ?? `local:${String(state.appState.streamingStartTime)}`;
    this.finalizeLiveTextBuffers('idle');
    this.resetDiscussStreams();
    this.resetToolCallState();
    this._currentTurnId = undefined;

    const next = this.host.shiftQueuedMessage();
    if (next !== undefined) {
      this.host.setAppState({ streamingPhase: 'idle' });
      this.host.resetLivePane();
      setTimeout(() => {
        sendQueued(next);
      }, 0);
      return;
    }

    this.host.setAppState({ streamingPhase: 'idle' });
    this.host.resetLivePane();
    notifyTerminalOnce(state, `turn-complete:${completedTurnKey}`, {
      title: 'Nori Code task complete',
      body: state.appState.sessionTitle ?? undefined,
    });
  }

  // ---------------------------------------------------------------------------
  // Live Render Hooks
  // ---------------------------------------------------------------------------

  onStreamingTextStart(): void {
    const { state } = this.host;
    this._pendingReadGroup = null;
    const entry = {
      id: nextTranscriptId(),
      kind: 'assistant' as const,
      turnId: this._currentTurnId,
      renderMode: 'markdown' as const,
      content: '',
    };
    const component = new AssistantMessageComponent();
    this._streamingBlock = { component, entry };
    this.host.pushTranscriptEntry(entry);
    state.transcriptContainer.addChild(component);
    state.ui.requestRender();
  }

  onStreamingTextUpdate(fullText: string): void {
    const block = this._streamingBlock;
    if (block !== null) {
      block.entry.content = fullText;
      block.component.updateContent(fullText, { transient: true });
      this.host.state.ui.requestRender();
    }
  }

  onStreamingTextEnd(): void {
    const block = this._streamingBlock;
    if (block !== null) {
      block.component.updateContent(block.entry.content, { transient: false });
    }
    this._streamingBlock = null;
  }

  onThinkingUpdate(fullText: string): void {
    if (fullText.length === 0 && this._activeThinkingComponent === undefined) return;
    const { state } = this.host;
    if (this._activeThinkingComponent === undefined) {
      this._pendingReadGroup = null;
      this._activeThinkingComponent = new ThinkingComponent(
        fullText,
        true,
        'live',
        state.ui,
      );
      if (state.toolOutputExpanded) this._activeThinkingComponent.setExpanded(true);
      state.transcriptContainer.addChild(this._activeThinkingComponent);
    } else {
      this._activeThinkingComponent.setText(fullText);
    }
    state.ui.requestRender();
  }

  onThinkingEnd(): void {
    if (this._activeThinkingComponent === undefined) return;
    this._activeThinkingComponent.finalize();
    this._activeThinkingComponent = undefined;
    this.host.state.ui.requestRender();
    this.host.mergeCurrentTurnSteps();
  }

  onToolCallStart(toolCall: ToolCallBlockData): void {
    if (toolCall.name === 'AskUserQuestion') return;

    const { state } = this.host;
    const tc = new ToolCallComponent(
      toolCall,
      undefined,
      state.ui,
      state.appState.workDir,
    );
    if (state.toolOutputExpanded) tc.setExpanded(true);
    this._pendingToolComponents.set(toolCall.id, tc);

    if (toolCall.name !== 'Read') this._pendingReadGroup = null;

    if (!this.tryAttachReadToolCall(toolCall, tc)) {
      state.transcriptContainer.addChild(tc);
      state.ui.requestRender();
    }

  }

  onToolCallEnd(toolCallId: string, result: ToolResultBlockData): void {
    const { state } = this.host;
    const matchedCall = this._activeToolCalls.get(toolCallId);
    const tc = this._pendingToolComponents.get(toolCallId);
    if (tc) {
      tc.setResult(result);
      this._pendingToolComponents.delete(toolCallId);
      state.ui.requestRender();
      this.host.mergeCurrentTurnSteps();
      return;
    }

    if (matchedCall?.name === 'AskUserQuestion') {
      const completed = new ToolCallComponent(
        matchedCall,
        result,
        state.ui,
        state.appState.workDir,
      );
      if (state.toolOutputExpanded) completed.setExpanded(true);
      state.transcriptContainer.addChild(completed);
      state.ui.requestRender();
    }
    this.host.mergeCurrentTurnSteps();
  }

  setTodoList(todos: readonly TodoItem[]): void {
    const { state } = this.host;
    state.todoPanel.setTodos(todos);
    state.todoPanelContainer.clear();
    if (!state.todoPanel.isEmpty()) {
      state.todoPanelContainer.addChild(state.todoPanel);
    }
    state.ui.requestRender();
  }

  beginCompaction(instruction?: string): void {
    const { state } = this.host;
    if (this._activeCompactionBlock !== undefined) {
      this._activeCompactionBlock.markDone();
      this._activeCompactionBlock = undefined;
    }
    const block = new CompactionComponent(state.ui, instruction, currentWorkingTip()?.text);
    this._activeCompactionBlock = block;
    state.transcriptContainer.addChild(block);
    state.ui.requestRender();
  }

  endCompaction(tokensBefore?: number, tokensAfter?: number): void {
    const block = this._activeCompactionBlock;
    if (block === undefined) return;
    block.markDone(tokensBefore, tokensAfter);
    this._activeCompactionBlock = undefined;
    this.host.state.ui.requestRender();
  }

  cancelCompaction(): void {
    const block = this._activeCompactionBlock;
    if (block === undefined) return;
    block.markCanceled();
    this._activeCompactionBlock = undefined;
    this.host.state.ui.requestRender();
  }

  // ---------------------------------------------------------------------------
  // Tool call grouping
  // ---------------------------------------------------------------------------

  private flushToolCallPreview(id: string): void {
    const streaming = this._streamingToolCallArguments.get(id);
    if (streaming === undefined) return;
    const toolCall: ToolCallBlockData = {
      id,
      name: streaming.name ?? this._activeToolCalls.get(id)?.name ?? 'Tool',
      args: parseStreamingArgs(streaming.argumentsText),
      streamingArguments: streaming.argumentsText,
      streamingStartedAtMs: streaming.startedAtMs,
      step: this._currentStep,
      turnId: this._currentTurnId,
    };
    this._activeToolCalls.set(id, toolCall);

    if (this._thinkingDraft.length > 0 || this._streamingBlock !== null) {
      this.finalizeLiveTextBuffers('tool');
    }

    const existingComponent = this._pendingToolComponents.get(id);
    if (existingComponent !== undefined) {
      existingComponent.updateToolCall(toolCall);
    } else {
      this.onToolCallStart(toolCall);
    }
  }

  private tryAttachReadToolCall(toolCall: ToolCallBlockData, tc: ToolCallComponent): boolean {
    const { state } = this.host;
    if (toolCall.name !== 'Read') {
      this._pendingReadGroup = null;
      return false;
    }

    const step = toolCall.step ?? this._currentStep;
    const turnId = toolCall.turnId ?? this._currentTurnId;
    const pending = this._pendingReadGroup;

    if (pending !== null && (pending.step !== step || pending.turnId !== turnId)) {
      this._pendingReadGroup = null;
    }

    const cur = this._pendingReadGroup;
    if (cur === null) {
      this._pendingReadGroup = { step, turnId, solo: tc };
      state.transcriptContainer.addChild(tc);
      state.ui.requestRender();
      return true;
    }

    if (cur.group !== undefined) {
      cur.group.attach(toolCall.id, tc);
      return true;
    }

    const solo = cur.solo;
    if (solo === undefined) {
      this._pendingReadGroup = { step, turnId, solo: tc };
      state.transcriptContainer.addChild(tc);
      state.ui.requestRender();
      return true;
    }
    const group = this.upgradeSoloReadToGroup(solo);
    group.attach(toolCall.id, tc);
    this._pendingReadGroup = { step, turnId, group };
    state.ui.requestRender();
    return true;
  }

  private upgradeSoloReadToGroup(solo: ToolCallComponent): ReadGroupComponent {
    const { state } = this.host;
    const group = new ReadGroupComponent(state.ui);
    const children = state.transcriptContainer.children;
    const idx = children.indexOf(solo);
    if (idx >= 0) {
      children[idx] = group;
      state.transcriptContainer.invalidate();
    } else {
      state.transcriptContainer.addChild(group);
    }
    group.attach(solo.toolCallView.id, solo);
    return group;
  }
}
