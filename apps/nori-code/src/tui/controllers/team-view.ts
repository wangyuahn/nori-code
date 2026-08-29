import { Spacer } from '@nori-code/pi-tui';
import type { Event, KimiHarness, Session } from '@nori-code/sdk';

import {
  DepartmentPaneComponent,
  type DepartmentPaneLine,
  type DepartmentPaneModel,
} from '../components/panes/department-pane';
import { MAIN_AGENT_ID, NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import type { ColorToken } from '../theme';
import type { AppState } from '../types';
import type { TUIState } from '../tui-state';
import { argsRecord } from '../utils/event-payload';
import {
  currentViewingAgentId,
  departmentChatLeaderId,
  departmentPaneMode,
  extractTeamChatPost,
  extractTeamSpeechText,
  findAgentDiscussion,
  isTeamSpeechTool,
  shouldPaintDiscussUtterance,
  teamChatMessagesFromMetadata,
  upsertTeamChatMessage,
  type TeamAgentSnapshot,
  type TeamChatMessage,
} from '../utils/team-tree';
import type { SessionReplayRenderer } from './session-replay';

export interface TeamViewHost {
  state: TUIState;
  session: Session | undefined;
  readonly harness: KimiHarness;
  readonly sessionReplay: SessionReplayRenderer;
  setAppState(patch: Partial<AppState>): void;
  showStatus(msg: string, color?: ColorToken): void;
  showError(msg: string): void;
  restoreEditor(): void;
  prepareTranscriptForAgentView(agentId: string): void;
}

interface SpeechDraft {
  readonly id: string;
  readonly speakerAgentId: string;
  speakerName: string;
  text: string;
  speaking: boolean;
}

export class TeamViewController {
  private visible = false;
  private pane: DepartmentPaneComponent | undefined;
  private readonly speechLines: SpeechDraft[] = [];
  private chatMessages: TeamChatMessage[] = [];
  private nextLiveChatId = 1;
  private nextSpeechId = 1;

  constructor(private readonly host: TeamViewHost) {}

  viewingAgentId(): string {
    return currentViewingAgentId(this.host.state.appState.viewingAgentId);
  }

  isPaneVisible(): boolean {
    return this.visible;
  }

  withViewingAgent<T>(fn: () => T): T {
    return this.host.harness.withInteractiveAgent(this.viewingAgentId(), fn);
  }

  reset(): void {
    this.speechLines.length = 0;
    this.chatMessages = [];
    this.nextLiveChatId = 1;
    this.nextSpeechId = 1;
    this.visible = false;
    this.pane = undefined;
    this.host.state.departmentPaneContainer.clear();
    if (this.host.state.appState.viewingAgentId !== undefined) {
      this.host.setAppState({ viewingAgentId: MAIN_AGENT_ID });
    }
  }

  reveal(): boolean {
    if (this.visible) {
      this.refreshPane();
      return false;
    }
    this.visible = true;
    this.mount();
    return true;
  }

  hide(): boolean {
    if (!this.visible) return false;
    this.visible = false;
    this.pane = undefined;
    this.host.state.departmentPaneContainer.clear();
    this.host.state.ui.requestRender();
    return true;
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.reveal();
  }

  onDiscussModeChanged(enabled: boolean): void {
    if (enabled) this.reveal();
    else this.refreshPane();
  }

  scrollPane(direction: 'up' | 'down'): boolean {
    if (!this.visible || this.pane === undefined) return false;
    if (!this.pane.scroll(direction)) return false;
    this.host.state.ui.requestRender();
    return true;
  }

  seedFromSession(session: Session): void {
    const metadata = session.getResumeState()?.sessionMetadata;
    const leaderId = this.chatLeaderId();
    if (leaderId !== undefined) {
      this.chatMessages = teamChatMessagesFromMetadata(metadata, leaderId);
      for (const message of this.chatMessages) {
        this.nextLiveChatId = Math.max(this.nextLiveChatId, message.messageId + 1);
      }
    } else {
      this.chatMessages = [];
    }
    this.refreshPane();
  }

  async open(agent: TeamAgentSnapshot): Promise<void> {
    this.host.restoreEditor();
    if (agent.kind === 'discussion') {
      this.reveal();
      this.host.showStatus(
        this.host.state.appState.discussMode ? 'Opened Discuss' : 'Opened Chat',
      );
      return;
    }
    if (agent.kind !== 'main') {
      const current = this.host.state.appState.teamAgents.find(
        (candidate) => candidate.agentId === agent.agentId,
      );
      if (agent.kind !== 'team' || current?.kind !== 'team' || current.archived === true) {
        this.host.showError(`Team member "${agent.name}" is no longer available.`);
        return;
      }
    }
    const agentId = agent.kind === 'main' ? MAIN_AGENT_ID : agent.agentId;
    await this.switchTo(agentId, agent.name);
  }

  async switchTo(agentId: string, name: string): Promise<void> {
    const session = this.host.session;
    if (session === undefined) {
      this.host.showError(NO_ACTIVE_SESSION_MESSAGE);
      return;
    }
    if (
      agentId !== MAIN_AGENT_ID
      && !this.host.state.appState.teamAgents.some((agent) =>
        agent.agentId === agentId
        && agent.kind === 'team'
        && agent.archived !== true,
      )
    ) {
      this.host.showError(`Team member "${name}" is no longer available.`);
      return;
    }
    const previous = this.viewingAgentId();
    if (previous !== agentId) {
      this.host.setAppState({ viewingAgentId: agentId });
      this.host.prepareTranscriptForAgentView(agentId);
      await this.host.sessionReplay.hydrateFromReplay(session, agentId);
    }
    this.seedFromSession(session);
    if (agentId !== MAIN_AGENT_ID || this.host.state.appState.discussMode) {
      this.reveal();
    }
    this.host.showStatus(agentId === MAIN_AGENT_ID ? 'Viewing Main' : `Viewing ${name}`);
  }

  routeEvent(event: Event): void {
    if (event.type === 'session.meta.updated' && event.patch?.['agents'] !== undefined) {
      const session = this.host.session;
      if (session !== undefined) this.seedFromSession(session);
      return;
    }
    if (event.type === 'team.chat.updated' || event.type === 'discussion.updated') {
      this.refreshPane();
      return;
    }
    if (event.type === 'assistant.delta') {
      if (!this.shouldTrackDiscuss(event.agentId)) return;
      this.upsertSpeech(event.agentId, this.speakerName(event.agentId), event.delta, {
        speaking: true,
        replace: false,
      });
      this.refreshPane();
      return;
    }
    if (event.type === 'tool.call.started') {
      this.routeToolStarted(event);
      return;
    }
    if (event.type === 'turn.ended') {
      let changed = false;
      for (const draft of this.speechLines) {
        if (draft.speakerAgentId === event.agentId && draft.speaking) {
          draft.speaking = false;
          changed = true;
        }
      }
      if (changed) this.refreshPane();
    }
  }

  private routeToolStarted(event: Extract<Event, { type: 'tool.call.started' }>): void {
    const args = argsRecord(event.args);
    if (isTeamSpeechTool(event.name) && this.shouldTrackDiscuss(event.agentId, event.name)) {
      const speech = extractTeamSpeechText(event.name, args);
      if (speech !== undefined && speech.length > 0) {
        this.upsertSpeech(event.agentId, this.speakerName(event.agentId), speech, {
          speaking: false,
          replace: true,
        });
        this.refreshPane();
      }
      return;
    }
    const post = extractTeamChatPost(event.name, args);
    if (post === undefined) return;
    this.chatMessages = upsertTeamChatMessage(this.chatMessages, {
      messageId: this.nextLiveChatId,
      agentId: event.agentId,
      name: this.speakerName(event.agentId),
      message: post.message,
      mentions: post.mentions,
      sentAt: new Date().toISOString(),
    });
    this.nextLiveChatId += 1;
    this.refreshPane();
  }

  private shouldTrackDiscuss(agentId: string, toolName?: string): boolean {
    return shouldPaintDiscussUtterance(this.host.state.appState.teamAgents, agentId, {
      discussMode: this.host.state.appState.discussMode,
      toolName,
    });
  }

  private speakerName(agentId: string): string {
    const named = this.host.state.appState.teamAgents.find((agent) => agent.agentId === agentId)
      ?.name;
    if (named !== undefined && named.length > 0) return named;
    return agentId === MAIN_AGENT_ID ? 'Main' : agentId;
  }

  private upsertSpeech(
    agentId: string,
    speakerName: string,
    text: string,
    opts: { speaking: boolean; replace: boolean },
  ): void {
    const last = lastSpeechFor(this.speechLines, agentId);
    if (last !== undefined && last.speaking) {
      last.speakerName = speakerName;
      last.text = opts.replace ? text : last.text + text;
      last.speaking = opts.speaking;
      return;
    }
    this.speechLines.push({
      id: `speech:${String(this.nextSpeechId)}`,
      speakerAgentId: agentId,
      speakerName,
      text,
      speaking: opts.speaking,
    });
    this.nextSpeechId += 1;
  }

  private chatLeaderId(): string | undefined {
    const viewing = this.viewingAgentId();
    const agents = this.host.state.appState.teamAgents;
    const self = agents.find((agent) => agent.agentId === viewing);
    if (self !== undefined) return departmentChatLeaderId(self);
    return viewing === MAIN_AGENT_ID ? undefined : MAIN_AGENT_ID;
  }

  private mount(): void {
    const pane = new DepartmentPaneComponent(this.paneModel(), {
      terminalRows: () => this.host.state.terminal.rows,
      canUseScrollKeys: () => this.host.state.editor.getText().length === 0,
    });
    this.pane = pane;
    this.host.state.departmentPaneContainer.clear();
    this.host.state.departmentPaneContainer.addChild(new Spacer(1));
    this.host.state.departmentPaneContainer.addChild(pane);
    this.host.state.ui.requestRender();
  }

  private refreshPane(): void {
    if (!this.visible) return;
    if (this.pane === undefined) {
      this.mount();
      return;
    }
    this.pane.setModel(this.paneModel());
    this.host.state.ui.requestRender();
  }

  private paneModel(): DepartmentPaneModel {
    const mode = departmentPaneMode(this.host.state.appState.discussMode);
    const agents = this.host.state.appState.teamAgents;
    const discussion = findAgentDiscussion(agents, this.viewingAgentId());
    if (mode === 'discuss') {
      const lines = this.speechLines.flatMap((draft) => {
        if (draft.text.trim().length === 0) return [];
        return [
          {
            id: draft.id,
            speakerName: draft.speakerName,
            text: draft.text,
            speaking: draft.speaking,
          } satisfies DepartmentPaneLine,
        ];
      });
      const speakingName =
        discussion?.turnAgentId === undefined
          ? undefined
          : this.speakerName(discussion.turnAgentId);
      return {
        mode,
        topic: discussion?.topic,
        speakingName: lines.some((line) => line.speaking === true) ? undefined : speakingName,
        lines,
        emptyHint: 'No statements in this round yet.',
      };
    }
    const lines: DepartmentPaneLine[] = this.chatMessages.map((message) => ({
      id: `chat:${String(message.messageId)}`,
      speakerName: message.name,
      text: message.message,
      meta: formatMentions(message.mentions, agents),
    }));
    return {
      mode,
      lines,
      emptyHint:
        this.chatLeaderId() === undefined
          ? 'Chat is for department members. Open a partner from /team.'
          : 'No messages yet — members align here while working.',
    };
  }
}

function lastSpeechFor(lines: readonly SpeechDraft[], agentId: string): SpeechDraft | undefined {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (line?.speakerAgentId === agentId) return line;
  }
  return undefined;
}

function formatMentions(
  mentions: readonly string[],
  agents: readonly TeamAgentSnapshot[],
): string | undefined {
  if (mentions.length === 0) return undefined;
  const labels = mentions.map((mention) => {
    if (mention === 'all') return '@all';
    const named = agents.find((agent) => agent.agentId === mention)?.name;
    return `@${named ?? mention}`;
  });
  return labels.join(' ');
}
