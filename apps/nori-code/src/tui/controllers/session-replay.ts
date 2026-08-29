import type {
  AgentReplayRecord,
  ContextMessage,
  GoalChange,
  KimiHarness,
  PermissionMode,
  PromptOrigin,
  ResumedAgentState,
  Session,
  ToolCall,
} from '@nori-code/sdk';

import { ToolCallComponent } from '../components/messages/tool-call';
import { MAIN_AGENT_ID } from '../constant/kimi-tui';
import { currentTheme } from '../theme';
import type { TodoItem } from '../components/chrome/todo-panel';
import type { AppState, ToolResultBlockData, TranscriptEntry } from '../types';
import { formatErrorMessage, isTodoItemShape } from '../utils/event-payload';
import { formatBackgroundTaskTranscript } from '../utils/background-task-status';
import { buildGoalCompletionMessage } from '../utils/goal-completion';
import { formatBashOutputForDisplay } from '../utils/shell-output';
import {
  appStateFromResumeAgent,
  backgroundOrigin,
  collectReplayMessageContent,
  contentPartsToText,
  countActiveBackgroundTasks,
  createReplayRenderContext,
  formatHookResultMessageForTranscript,
  isTerminalBackgroundTask,
  limitReplayRecordsByTurn,
  REPLAY_TURN_LIMIT,
  replayEntry,
  skillActivationFromOrigin,
  pluginCommandFromOrigin,
  toolCallFromReplayMessage,
  toolResultOutput,
  type ReplayRenderContext,
  type SkillActivationProjection,
  type PluginCommandProjection,
} from '../utils/message-replay';
import type { StreamingUIController } from './streaming-ui';
import type { SessionEventHandler } from './session-event-handler';
import type { TUIState } from '../tui-state';

type GoalReplayRecord = Extract<AgentReplayRecord, { type: 'goal_updated' }>;
type CompactionReplayRecord = Extract<AgentReplayRecord, { type: 'compaction' }>;
type GoalReplayLifecycleChange = GoalChange & { readonly kind: 'lifecycle' };

export interface SessionReplayHost {
  state: TUIState;
  readonly harness: KimiHarness;
  readonly streamingUI: StreamingUIController;
  readonly sessionEventHandler: SessionEventHandler;
  setAppState(patch: Partial<AppState>): void;
  showError(msg: string): void;
  showStatus?(msg: string): void;
  appendTranscriptEntry(entry: TranscriptEntry): void;
  mergeAllTurnSteps(): void;
}

function extractBashTag(
  text: string,
  tag: 'bash-input' | 'bash-stdout' | 'bash-stderr',
): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return match?.[1] === undefined ? undefined : unescapeBashXml(match[1]);
}

function unescapeBashXml(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&');
}

export class SessionReplayRenderer {
  constructor(private readonly host: SessionReplayHost) {}

  async hydrateFromReplay(session: Session, agentId: string = MAIN_AGENT_ID): Promise<boolean> {
    this.host.setAppState({ isReplaying: true });
    try {
      const agents = session.getResumeState()?.agents;
      const agent = agents?.[agentId];
      if (agent !== undefined) {
        this.hydrateSnapshot(agent, agentId);
        this.renderRecords(agent);
        this.host.mergeAllTurnSteps();
        return true;
      }

      if (agentId === MAIN_AGENT_ID) {
        this.host.showError('Session history is unavailable for this session.');
        return false;
      }

      const history = await this.loadContextHistory(session, agentId);
      if (history !== undefined && history.length > 0) {
        this.renderHistory(history);
        this.host.mergeAllTurnSteps();
      }
      this.host.showStatus?.(
        'Opened this member. History may be incomplete until the session is reloaded.',
      );
      return true;
    } catch (error) {
      const message = formatErrorMessage(error);
      this.host.showError(`Failed to replay session history: ${message}`);
      return false;
    } finally {
      this.host.setAppState({ isReplaying: false });
    }
  }

  // ---------------------------------------------------------------------------
  // Snapshot hydration
  // ---------------------------------------------------------------------------

  private hydrateSnapshot(agent: ResumedAgentState, agentId: string = MAIN_AGENT_ID): void {
    const snapshot = appStateFromResumeAgent(agent);
    if (agentId !== MAIN_AGENT_ID) {
      this.host.setAppState({
        contextTokens: snapshot.contextTokens,
        maxContextTokens: snapshot.maxContextTokens,
        contextUsage: snapshot.contextUsage,
      });
      this.hydrateTodoPanel(agent);
      this.hydrateBackgroundState(agent);
      return;
    }
    this.host.setAppState(snapshot);
    this.hydrateTodoPanel(agent);
    this.hydrateBackgroundState(agent);
  }

  private async loadContextHistory(
    session: Session,
    agentId: string,
  ): Promise<readonly ContextMessage[] | undefined> {
    if (typeof session.getContext !== 'function') return undefined;
    try {
      const context = await this.host.harness.withInteractiveAgent(agentId, () =>
        session.getContext(),
      );
      return context.history;
    } catch {
      return undefined;
    }
  }

  private renderHistory(history: readonly ContextMessage[]): void {
    const context = createReplayRenderContext();
    const records: AgentReplayRecord[] = history.map((message) => ({
      type: 'message',
      time: 0,
      message,
    }));
    for (const record of limitReplayRecordsByTurn(records, REPLAY_TURN_LIMIT)) {
      this.renderRecord(context, record);
    }
    this.flushAssistant(context);
    this.cleanupRuntime(context);
  }

  private hydrateTodoPanel(agent: ResumedAgentState): void {
    const rawTodos = agent.toolStore?.['todo'];
    if (!Array.isArray(rawTodos)) {
      this.host.streamingUI.setTodoList([]);
      return;
    }

    const todos = rawTodos
      .filter((todo): todo is TodoItem => isTodoItemShape(todo))
      .map((todo) => ({ title: todo.title, status: todo.status }));
    if (todos.length > 0 && todos.every((todo) => todo.status === 'done')) {
      this.host.streamingUI.setTodoList([]);
      return;
    }

    this.host.streamingUI.setTodoList(todos);
  }

  private hydrateBackgroundState(agent: ResumedAgentState): void {
    const { state, sessionEventHandler } = this.host;
    sessionEventHandler.backgroundTasks.clear();
    for (const info of agent.background) {
      sessionEventHandler.backgroundTasks.set(info.taskId, info);
    }
    sessionEventHandler.backgroundTaskTranscriptedTerminal.clear();
    for (const info of agent.background) {
      if (isTerminalBackgroundTask(info)) {
        sessionEventHandler.backgroundTaskTranscriptedTerminal.add(info.taskId);
      }
    }
    state.footer.setBackgroundCounts(countActiveBackgroundTasks(sessionEventHandler.backgroundTasks));
    state.ui.requestRender();
  }

  // ---------------------------------------------------------------------------
  // Record rendering
  // ---------------------------------------------------------------------------

  private renderRecords(agent: ResumedAgentState): void {
    const context = createReplayRenderContext();
    for (const record of limitReplayRecordsByTurn(agent.replay, REPLAY_TURN_LIMIT)) {
      this.renderRecord(context, record);
    }
    this.flushAssistant(context);
    this.cleanupRuntime(context);
  }

  private renderRecord(context: ReplayRenderContext, record: AgentReplayRecord): void {
    switch (record.type) {
      case 'message':
        this.renderMessage(context, record.message);
        return;
      case 'compaction':
        this.renderCompaction(context, record);
        return;
      case 'goal_updated':
        this.renderGoalReplayRecord(context, record);
        return;
      case 'discuss_updated':
        this.flushAssistant(context);
        this.host.appendTranscriptEntry(
          replayEntry(context, 'status', `Discuss: ${record.enabled ? 'ON' : 'OFF'}`, 'notice'),
        );
        return;
      case 'permission_updated':
        this.flushAssistant(context);
        this.renderPermissionUpdate(context, record.mode);
        return;
      case 'approval_result':
        this.flushAssistant(context);
        this.renderApprovalResult(context, record.record);
        return;
      case 'config_updated':
        return;
    }
  }

  private renderMessage(context: ReplayRenderContext, message: ContextMessage): void {
    switch (message.role) {
      case 'user':
        this.renderUserMessage(context, message);
        return;
      case 'assistant':
        if (message.origin?.kind === 'hook_result') {
          this.renderHookResult(context, message);
          this.renderToolCalls(context, message.toolCalls);
          return;
        }
        collectReplayMessageContent(context.assistant, message.content);
        this.flushAssistant(context);
        this.renderToolCalls(context, message.toolCalls);
        return;
      case 'tool':
        this.flushAssistant(context);
        this.renderToolResult(context, message);
        return;
      case 'system':
        return;
      default:
        return;
    }
  }

  private renderUserMessage(context: ReplayRenderContext, message: ContextMessage): void {
    const origin = backgroundOrigin(message);
    if (origin !== undefined) {
      this.flushAssistant(context);
      this.renderBackgroundTaskNotification(context, origin);
      return;
    }
    if (message.origin?.kind === 'hook_result') {
      this.renderHookResult(context, message);
      return;
    }
    if (message.origin?.kind === 'injection') {
      return;
    }
    if (message.origin?.kind === 'shell_command') {
      // A `!` command, replayed from records. Unwrap the XML tags back into the
      // same `$ cmd` + output view the live editor produced. (Must NOT fall into
      // the `injection` branch above — that returns without rendering.)
      this.flushAssistant(context);
      const text = contentPartsToText(message.content);
      if (message.origin.phase === 'input') {
        const cmd = (extractBashTag(text, 'bash-input') ?? text).trim();
        this.advanceTurn(context);
        this.host.appendTranscriptEntry(
          replayEntry(context, 'user', currentTheme.fg('shellMode', `$ ${cmd}`), 'plain', {
            bullet: '',
          }),
        );
      } else {
        const stdout = (extractBashTag(text, 'bash-stdout') ?? '').trim();
        const stderr = (extractBashTag(text, 'bash-stderr') ?? '').trim();
        const out = formatBashOutputForDisplay(stdout, stderr, message.origin.isError);
        this.host.appendTranscriptEntry(replayEntry(context, 'status', out, 'plain'));
      }
      return;
    }
    if (message.origin?.kind === 'cron_job') {
      this.renderCronJob(context, message);
      return;
    }
    if (message.origin?.kind === 'cron_missed') {
      this.renderCronMissed(context, message);
      return;
    }
    if (isGoalForkClearedSystemReminder(message)) {
      return;
    }
    const goalReminder = goalOutcomeReminderFromSystemMessage(message);
    if (goalReminder !== null) {
      if (goalReminder !== undefined) {
        this.flushAssistant(context);
        this.host.appendTranscriptEntry(
          replayEntry(context, 'assistant', goalReminder, 'markdown'),
        );
      }
      return;
    }

    this.flushAssistant(context);
    const skill = skillActivationFromOrigin(message.origin);
    if (skill !== undefined) {
      this.renderSkillActivation(context, skill);
      if (message.origin?.kind === 'skill_activation' && message.origin.trigger === 'user-slash') {
        this.advanceTurn(context);
      }
      return;
    }
    const pluginCommand = pluginCommandFromOrigin(message.origin);
    if (pluginCommand !== undefined) {
      this.renderPluginCommand(context, pluginCommand);
      if (message.origin?.kind === 'plugin_command' && message.origin.trigger === 'user-slash') {
        this.advanceTurn(context);
      }
      return;
    }

    this.advanceTurn(context);
    this.host.appendTranscriptEntry(
      replayEntry(context, 'user', contentPartsToText(message.content), 'plain'),
    );
  }

  private renderToolCalls(context: ReplayRenderContext, toolCalls: readonly ToolCall[]): void {
    if (toolCalls.length === 0) return;
    const { streamingUI } = this.host;
    context.stepIndex += 1;
    this.applyStepContext(context);
    for (const rawToolCall of toolCalls) {
      const toolCall = toolCallFromReplayMessage(rawToolCall, context);
      if (toolCall === undefined) continue;
      context.toolCalls.set(toolCall.id, toolCall);
      streamingUI.setActiveToolCall(toolCall.id, toolCall);
      streamingUI.onToolCallStart(toolCall);
    }
  }

  private renderToolResult(context: ReplayRenderContext, message: ContextMessage): void {
    const toolCallId = message.toolCallId;
    if (toolCallId === undefined) return;
    const call = context.toolCalls.get(toolCallId);
    if (call === undefined) return;

    const result: ToolResultBlockData = {
      tool_call_id: toolCallId,
      output: toolResultOutput(message.content),
      is_error: message.isError,
    };
    call.result = result;
    this.applyStepContext(context);
    this.host.streamingUI.onToolCallEnd(toolCallId, result);
    this.host.streamingUI.removeActiveToolCall(toolCallId);
    context.completedToolCallIds.add(toolCallId);
  }

  private advanceTurn(context: ReplayRenderContext): void {
    context.turnIndex += 1;
    context.stepIndex = 0;
    context.currentTurnId = `replay:${String(context.turnIndex)}`;
    this.applyStepContext(context);
  }

  private applyStepContext(context: ReplayRenderContext): void {
    this.host.streamingUI.setTurnId(context.currentTurnId);
    this.host.streamingUI.setStep(context.stepIndex);
  }

  private flushAssistant(context: ReplayRenderContext): void {
    const { streamingUI } = this.host;
    const thinking = context.assistant.thinking.join('');
    const text = context.assistant.text.join('');
    context.assistant = { thinking: [], text: [] };
    this.applyStepContext(context);

    if (thinking.length > 0) {
      streamingUI.onThinkingUpdate(thinking);
      streamingUI.onThinkingEnd();
    }
    if (text.length > 0) {
      streamingUI.onStreamingTextStart();
      streamingUI.onStreamingTextUpdate(text);
      streamingUI.onStreamingTextEnd();
      streamingUI.clearAssistantDraft();
    }
  }

  private cleanupRuntime(context: ReplayRenderContext): void {
    this.flushAssistant(context);
    this.host.streamingUI.cleanupAfterReplay(context.completedToolCallIds);
  }

  // ---------------------------------------------------------------------------
  // Special content renderers
  // ---------------------------------------------------------------------------

  private renderSkillActivation(
    context: ReplayRenderContext,
    skill: SkillActivationProjection,
  ): void {
    const { sessionEventHandler } = this.host;
    if (context.skillActivationIds.has(skill.activationId)) return;
    if (sessionEventHandler.renderedSkillActivationIds.has(skill.activationId)) return;
    context.skillActivationIds.add(skill.activationId);
    sessionEventHandler.renderedSkillActivationIds.add(skill.activationId);
    this.host.appendTranscriptEntry({
      ...replayEntry(context, 'skill_activation', `Activated skill: ${skill.skillName}`, 'plain'),
      skillActivationId: skill.activationId,
      skillName: skill.skillName,
      skillArgs: skill.skillArgs,
      skillTrigger: skill.trigger,
    });
  }

  private renderPluginCommand(
    context: ReplayRenderContext,
    command: PluginCommandProjection,
  ): void {
    const { sessionEventHandler } = this.host;
    if (context.pluginCommandActivationIds.has(command.activationId)) return;
    if (sessionEventHandler.renderedPluginCommandActivationIds.has(command.activationId)) return;
    context.pluginCommandActivationIds.add(command.activationId);
    sessionEventHandler.renderedPluginCommandActivationIds.add(command.activationId);
    this.host.appendTranscriptEntry({
      ...replayEntry(
        context,
        'plugin_command',
        `/${command.pluginId}:${command.commandName}`,
        'plain',
      ),
      pluginCommandData: {
        activationId: command.activationId,
        pluginId: command.pluginId,
        commandName: command.commandName,
        args: command.commandArgs,
        trigger: command.trigger,
      },
    });
  }

  private renderCompaction(context: ReplayRenderContext, record: CompactionReplayRecord): void {
    this.flushAssistant(context);
    if (record.result === undefined) return;
    if (record.result === 'cancelled') {
      this.host.appendTranscriptEntry({
        ...replayEntry(context, 'status', 'Compaction cancelled', 'plain'),
        compactionData: {
          result: 'cancelled',
          instruction: record.instruction,
        },
      });
      return;
    }

    this.host.appendTranscriptEntry({
      ...replayEntry(context, 'status', 'Compaction complete', 'plain'),
      compactionData: {
        tokensBefore: record.result.tokensBefore,
        tokensAfter: record.result.tokensAfter,
        instruction: record.instruction,
      },
    });
  }

  private renderGoalReplayRecord(context: ReplayRenderContext, record: GoalReplayRecord): void {
    this.flushAssistant(context);
    const { change } = record;
    switch (change.kind) {
      case 'created':
        this.host.appendTranscriptEntry({
          ...replayEntry(context, 'goal', 'Goal set', 'plain'),
          goalData: { kind: 'created' },
        });
        return;
      case 'completion':
        this.host.appendTranscriptEntry(
          replayEntry(context, 'assistant', buildGoalCompletionMessage(record.snapshot), 'markdown'),
        );
        return;
      case 'lifecycle': {
        const lifecycleChange: GoalReplayLifecycleChange = { ...change, kind: 'lifecycle' };
        if (isResumeNormalizationGoalPause(lifecycleChange)) return;
        if (isModelBlockedGoalLifecycle(lifecycleChange)) {
          return;
        }
        this.appendGoalLifecycleReplayEntry(context, lifecycleChange);
        return;
      }
    }
  }

  private appendGoalLifecycleReplayEntry(
    context: ReplayRenderContext,
    change: GoalReplayLifecycleChange,
  ): void {
    this.host.appendTranscriptEntry({
      ...replayEntry(context, 'goal', goalLifecycleReplayContent(change), 'plain'),
      goalData: { kind: 'lifecycle', change },
    });
  }

  private renderHookResult(context: ReplayRenderContext, message: ContextMessage): void {
    if (message.origin?.kind !== 'hook_result') return;
    this.flushAssistant(context);
    this.host.appendTranscriptEntry(
      replayEntry(
        context,
        'assistant',
        formatHookResultMessageForTranscript(
          contentPartsToText(message.content),
          message.origin.event,
          message.origin.blocked === true,
        ),
        'markdown',
      ),
    );
  }

  private renderCronJob(context: ReplayRenderContext, message: ContextMessage): void {
    if (message.origin?.kind !== 'cron_job') return;
    this.flushAssistant(context);
    this.host.appendTranscriptEntry({
      ...replayEntry(
        context,
        'cron',
        extractCronPrompt(contentPartsToText(message.content)),
        'plain',
      ),
      cronData: {
        jobId: message.origin.jobId,
        cron: message.origin.cron,
        recurring: message.origin.recurring,
        coalescedCount: message.origin.coalescedCount,
        stale: message.origin.stale,
      },
    });
  }

  private renderCronMissed(context: ReplayRenderContext, message: ContextMessage): void {
    if (message.origin?.kind !== 'cron_missed') return;
    this.flushAssistant(context);
    this.host.appendTranscriptEntry({
      ...replayEntry(context, 'cron', stripCronEnvelope(contentPartsToText(message.content)), 'plain'),
      cronData: {
        missedCount: message.origin.count,
      },
    });
  }

  private renderPermissionUpdate(context: ReplayRenderContext, mode: PermissionMode): void {
    if (mode === 'yolo') {
      this.host.appendTranscriptEntry(
        replayEntry(context, 'status', 'YOLO mode: ON', 'notice', {
          detail: 'All actions will be approved automatically. Use with caution.',
        }),
      );
      return;
    }
    this.host.appendTranscriptEntry(
      replayEntry(
        context,
        'status',
        mode === 'manual' ? 'YOLO mode: OFF' : `Permission mode: ${mode}`,
        'notice',
      ),
    );
  }

  private renderApprovalResult(
    context: ReplayRenderContext,
    record: Extract<AgentReplayRecord, { type: 'approval_result' }>['record'],
  ): void {
    const { result } = record;
    const parts: string[] = [];
    switch (result.decision) {
      case 'approved':
        parts.push(result.scope === 'session' ? 'Approved for session' : 'Approved');
        break;
      case 'rejected':
        parts.push('Rejected');
        break;
      case 'cancelled':
        parts.push('Cancelled');
        break;
    }
    parts.push(`: ${record.action}`);
    if (result.feedback !== undefined && result.feedback.length > 0) {
      parts.push(` — "${result.feedback}"`);
    }
    this.host.appendTranscriptEntry(replayEntry(context, 'status', parts.join(''), 'notice'));
  }

  private removeToolCall(toolCallId: string): void {
    const { state, streamingUI } = this.host;
    streamingUI.removeActiveToolCall(toolCallId);
    streamingUI.removeToolComponent(toolCallId);
    const index = state.transcriptEntries.findIndex(
      (entry) => entry.toolCallData?.id === toolCallId,
    );
    if (index >= 0) state.transcriptEntries.splice(index, 1);
    const children = state.transcriptContainer.children;
    const childIndex = children.findIndex(
      (child) => child instanceof ToolCallComponent && child.toolCallView.id === toolCallId,
    );
    if (childIndex >= 0) {
      children.splice(childIndex, 1);
      state.transcriptContainer.invalidate();
    }
  }

  private renderBackgroundTaskNotification(
    context: ReplayRenderContext,
    origin: Extract<PromptOrigin, { kind: 'background_task' }>,
  ): void {
    const { sessionEventHandler } = this.host;
    const task = sessionEventHandler.backgroundTasks.get(origin.taskId);
    if (task === undefined) return;
    const status = formatBackgroundTaskTranscript({ ...task, status: origin.status });
    this.host.appendTranscriptEntry({
      ...replayEntry(context, 'status', status.headline, 'plain'),
      detail: status.detail,
      backgroundAgentStatus: status,
    });
    sessionEventHandler.backgroundTaskTranscriptedTerminal.add(origin.taskId);
  }
}

const RESUME_NORMALIZATION_GOAL_PAUSE_REASONS = new Set([
  'Paused after agent resume',
  'Paused after session resume',
]);

function isResumeNormalizationGoalPause(change: GoalReplayLifecycleChange): boolean {
  return (
    change.status === 'paused' &&
    change.reason !== undefined &&
    RESUME_NORMALIZATION_GOAL_PAUSE_REASONS.has(change.reason)
  );
}

function goalLifecycleReplayContent(change: GoalReplayLifecycleChange): string {
  switch (change.status) {
    case 'paused':
      return 'Goal paused';
    case 'active':
      return 'Goal resumed';
    case 'blocked':
      return 'Goal blocked';
    case 'complete':
    case undefined:
      return 'Goal updated';
  }
}

function isModelBlockedGoalLifecycle(change: GoalReplayLifecycleChange): boolean {
  return change.status === 'blocked' && change.actor === 'model';
}

function goalOutcomeReminderFromSystemMessage(message: ContextMessage): string | undefined | null {
  if (message.origin?.kind !== 'system_trigger') return null;
  if (message.origin.name !== 'goal_completion' && message.origin.name !== 'goal_blocked') {
    return null;
  }
  return undefined;
}

function isGoalForkClearedSystemReminder(message: ContextMessage): boolean {
  return message.origin?.kind === 'system_trigger' && message.origin.name === 'goal_fork_cleared';
}

function extractCronPrompt(text: string): string {
  const open = '<prompt>\n';
  const close = '\n</prompt>';
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start >= 0 && end >= start + open.length) {
    return text.slice(start + open.length, end);
  }
  return stripCronEnvelope(text);
}

function stripCronEnvelope(text: string): string {
  const lines = text.split('\n');
  if (
    lines.length >= 2 &&
    lines[0]?.startsWith('<cron-fire ') &&
    lines.at(-1) === '</cron-fire>'
  ) {
    return lines.slice(1, -1).join('\n');
  }
  return text;
}
