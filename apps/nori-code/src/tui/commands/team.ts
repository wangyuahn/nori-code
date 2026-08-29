import { TeamBrowserComponent } from '../components/dialogs/team-browser';
import { TeamMemberDetailComponent } from '../components/dialogs/team-member-detail';
import { currentViewingAgentId, type TeamAgentSnapshot } from '../utils/team-tree';
import type { TranscriptEntry } from '../types';
import { showTeamSettingsPicker } from './config';
import type { SlashCommandHost } from './dispatch';

export async function handleTeamCommand(host: SlashCommandHost, args: string): Promise<void> {
  const sub = args.trim().toLowerCase();
  if (sub === 'settings' || sub === 'config' || sub === 'depth' || sub === 'max-depth') {
    await showTeamSettingsPicker(host);
    return;
  }
  showTeamBrowser(host);
}

function showTeamBrowser(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new TeamBrowserComponent({
      getAgents: () => host.state.appState.teamAgents,
      toolsReadonly: host.state.appState.toolsReadonly,
      discussMode: host.state.appState.discussMode,
      currentAgentId: currentViewingAgentId(host.state.appState.viewingAgentId),
      onSelect: (agent) => {
        void host.teamViewController.open(agent);
      },
      onDetails: (agent) => {
        showTeamMemberDetail(host, agent);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

function showTeamMemberDetail(host: SlashCommandHost, agent: TeamAgentSnapshot): void {
  host.mountEditorReplacement(
    new TeamMemberDetailComponent({
      agent,
      agents: host.state.appState.teamAgents,
      recentSpeech: discussSpeechForAgent(host.state.transcriptEntries, agent),
      onCancel: () => {
        showTeamBrowser(host);
      },
    }),
  );
}

function discussSpeechForAgent(
  entries: readonly TranscriptEntry[],
  agent: TeamAgentSnapshot,
): string[] {
  const speech: string[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'discuss_utterance') continue;
    const text = entry.content.trim();
    if (text.length === 0) continue;
    if (agent.kind === 'discussion') {
      speech.push(text);
      continue;
    }
    if (entry.speakerAgentId === agent.agentId || entry.speakerName === agent.name) {
      speech.push(text);
    }
  }
  return speech;
}
