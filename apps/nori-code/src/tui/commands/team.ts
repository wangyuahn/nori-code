import { TeamBrowserComponent } from '../components/dialogs/team-browser';
import { TeamMemberDetailComponent } from '../components/dialogs/team-member-detail';
import { currentViewingAgentId, teamAgentsFromMountedChildren, type TeamAgentSnapshot } from '../utils/team-tree';
import { mountMandateOf, mountRoleOf, sessionMapLabel } from '../utils/session-map-tree';
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
    const children = graph.edges
      .filter((edge) => edge.parentSessionId === sessionId)
      .map((edge) => graph.nodes.find((node) => node.id === edge.childSessionId))
      .filter((node): node is NonNullable<typeof node> => node !== undefined);
    host.setAppState({
      teamAgents: teamAgentsFromMountedChildren(
        hostNode === undefined ? (host.state.appState.sessionTitle ?? 'Main') : sessionMapLabel(hostNode),
        children.map((child) => ({
          id: child.id,
          title: child.title,
          name: typeof child.metadata?.['mount_name'] === 'string' ? child.metadata['mount_name'] : child.title,
          role: mountRoleOf(child),
          mandate: mountMandateOf(child),
        })),
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
        if (agent.mountedSessionId !== undefined && agent.mountedSessionId.length > 0) {
          void (async () => {
            try {
              const session = await host.harness.resumeSession({ id: agent.mountedSessionId! });
              await host.switchToSession(session, `Opened session (${session.id}).`);
              host.restoreEditor();
            } catch (error) {
              host.showError(String(error));
              showTeamBrowser(host);
            }
          })();
          return;
        }
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
