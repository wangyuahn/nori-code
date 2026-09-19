import { TeamBrowserComponent } from '../components/dialogs/team-browser';
import { TeamMemberDetailComponent } from '../components/dialogs/team-member-detail';
import { currentViewingAgentId, teamAgentsFromSessionGraph, teamMemberSessionId, type TeamAgentSnapshot } from '../utils/team-tree';
import { sessionMapLabel } from '../utils/session-map-tree';
import { formatErrorMessage } from '../utils/event-payload';
import type { TranscriptEntry } from '../types';
import { showTeamSettingsPicker } from './config';
import type { SlashCommandHost } from './dispatch';

export async function handleTeamCommand(host: SlashCommandHost, args: string): Promise<void> {
  const sub = args.trim().toLowerCase();
  if (sub === 'settings' || sub === 'config' || sub === 'depth' || sub === 'max-depth') {
    await showTeamSettingsPicker(host);
    return;
  }
  await refreshDepartmentFromGraph(host);
  showTeamBrowser(host);
}

async function refreshDepartmentFromGraph(host: SlashCommandHost): Promise<void> {
  const sessionId = host.session?.id;
  if (sessionId === undefined) return;
  try {
    const graph = await host.harness.getSessionGraph({ workDir: host.state.appState.workDir });
    const hostNode = graph.nodes.find((node) => node.id === sessionId);
    host.setAppState({
      teamAgents: teamAgentsFromSessionGraph(
        sessionId,
        hostNode === undefined ? (host.state.appState.sessionTitle ?? 'Main') : sessionMapLabel(hostNode),
        graph,
      ),
    });
  } catch (error) {
    host.showError(formatErrorMessage(error));
  }
}

function showTeamBrowser(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new TeamBrowserComponent({
      getAgents: () => host.state.appState.teamAgents,
      toolsReadonly: host.state.appState.toolsReadonly,
      discussMode: host.state.appState.discussMode,
      currentAgentId: currentViewingAgentId(host.state.appState.viewingAgentId),
      onSelect: (agent) => {
        if (agent.kind === 'main') {
          host.restoreEditor();
          return;
        }
        const sessionId = teamMemberSessionId(agent);
        if (sessionId === undefined) {
          host.showError('This member is no longer a session.');
          showTeamBrowser(host);
          return;
        }
        void (async () => {
          try {
            const session = await host.harness.resumeSession({ id: sessionId });
            await host.switchToSession(session, `Opened session (${session.id}).`);
            host.restoreEditor();
          } catch (error) {
            host.showError(String(error));
            showTeamBrowser(host);
          }
        })();
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
