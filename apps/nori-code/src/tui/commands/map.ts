import type { SessionGraphSummary, SessionSummary } from '@nori-code/sdk';

import { SessionMapBrowserComponent } from '../components/dialogs/session-map-browser';
import { TextInputDialogComponent } from '../components/dialogs/text-input-dialog';
import { formatErrorMessage } from '../utils/event-payload';
import { parentSessionIdOf } from '../utils/session-map-tree';
import { teamAgentsFromSessionMetadata, type TeamAgentSnapshot } from '../utils/team-tree';
import type { SlashCommandHost } from './dispatch';

type MappedTeamAgent = TeamAgentSnapshot & { readonly hostSessionId: string };

export async function handleMapCommand(host: SlashCommandHost): Promise<void> {
  let graph: SessionGraphSummary;
  try {
    graph = await host.harness.getSessionGraph({ workDir: host.state.appState.workDir });
  } catch (error) {
    host.showError(formatErrorMessage(error));
    return;
  }

  let mappedTeamAgents: MappedTeamAgent[] = [];
  const render = (): void => {
    host.mountEditorReplacement(
      new SessionMapBrowserComponent({
        nodes: graph.nodes,
        edges: graph.edges,
        currentSessionId: host.session?.id,
        onOpen: (session) => {
          const parentId = parentSessionIdOf(session.metadata as Record<string, unknown> | undefined);
          if (parentId !== undefined) {
            void (async () => {
              let member = mappedTeamAgents.find(
                (agent) =>
                  agent.kind === 'team'
                  && agent.mountedSessionId === session.id
                  && agent.hostSessionId === parentId,
              );
              if (member === undefined) {
                mappedTeamAgents = await refreshTeamAgents(host, graph.nodes);
                member = mappedTeamAgents.find(
                  (agent) =>
                    agent.kind === 'team'
                    && agent.mountedSessionId === session.id
                    && agent.hostSessionId === parentId,
                );
              }
              if (member === undefined) {
                host.showError(`Mounted session "${session.id}" has no owning Team agent.`);
                render();
                return;
              }
              await openMountedTeamAgent(host, member, render);
            })().catch((error) => {
              host.showError(formatErrorMessage(error));
              render();
            });
            return;
          }
          void openSession(host, session.id, render);
        },
        onMount: (child, parent) => {
          void applyMount(host, child, parent, async () => {
            graph = await host.harness.getSessionGraph({ workDir: host.state.appState.workDir });
            mappedTeamAgents = await refreshTeamAgents(host, graph.nodes);
            render();
          }, render);
        },
        onUnmount: (session) => {
          void applyUnmount(host, session, async () => {
            graph = await host.harness.getSessionGraph({ workDir: host.state.appState.workDir });
            mappedTeamAgents = await refreshTeamAgents(host, graph.nodes);
            render();
          }, render);
        },
        onCancel: () => {
          host.restoreEditor();
        },
      }),
    );
  };

  mappedTeamAgents = await refreshTeamAgents(host, graph.nodes);
  render();
}

async function refreshTeamAgents(
  host: SlashCommandHost,
  nodes: readonly SessionSummary[],
): Promise<MappedTeamAgent[]> {
  const mapped: MappedTeamAgent[] = [];
  for (const node of nodes) {
    try {
      const metadata = await host.harness.getSessionMetadata(node.id);
      mapped.push(
        ...teamAgentsFromSessionMetadata(metadata).map((agent) => ({
          ...agent,
          hostSessionId: node.id,
        })),
      );
    } catch {
      // The graph update is still useful when one session's metadata is unavailable.
    }
  }
  const currentSessionId = host.session?.id;
  host.setAppState({
    teamAgents: mapped.filter((agent) => agent.hostSessionId === currentSessionId),
  });
  return mapped;
}

async function openMountedTeamAgent(
  host: SlashCommandHost,
  member: MappedTeamAgent,
  reopen: () => void,
): Promise<void> {
  try {
    host.restoreEditor();
    let session = host.session;
    if (session?.id !== member.hostSessionId) {
      session = await host.harness.resumeSession({ id: member.hostSessionId });
      await host.switchToSession(session, `Opened team session (${session.id}).`);
    }
    if (session === undefined) {
      throw new Error(`Team member host session "${member.hostSessionId}" is unavailable.`);
    }
    const metadata = await session.getSessionMetadata();
    const currentMember = teamAgentsFromSessionMetadata(metadata).find(
      (agent) =>
        agent.kind === 'team'
        && agent.agentId === member.agentId
        && agent.mountedSessionId === member.mountedSessionId,
    );
    if (currentMember === undefined) {
      throw new Error(`Team member "${member.name}" is no longer available.`);
    }
    await host.teamViewController.open(currentMember);
  } catch (error) {
    host.showError(formatErrorMessage(error));
    reopen();
  }
}

async function openSession(
  host: SlashCommandHost,
  sessionId: string,
  reopen: () => void,
): Promise<void> {
  try {
    const session = await host.harness.resumeSession({ id: sessionId });
    await host.switchToSession(session, `Opened session (${session.id}).`);
    host.restoreEditor();
  } catch (error) {
    host.showError(formatErrorMessage(error));
    reopen();
  }
}

async function applyMount(
  host: SlashCommandHost,
  child: SessionSummary,
  parent: SessionSummary,
  refresh: () => Promise<void>,
  reopen: () => void,
): Promise<void> {
  const role = await promptText(host, {
    title: 'Mount role (optional)',
    allowEmpty: true,
  });
  if (role === undefined) {
    reopen();
    return;
  }
  const mandate = await promptText(host, {
    title: 'Mount mandate (optional)',
    allowEmpty: true,
  });
  if (mandate === undefined) {
    reopen();
    return;
  }
  try {
    const payload = {
      sessionId: child.id,
      parentSessionId: parent.id,
      role: role.length > 0 ? role : undefined,
      mandate: mandate.length > 0 ? mandate : undefined,
    };
    const existingParent = parentSessionIdOf(child.metadata as Record<string, unknown> | undefined);
    if (existingParent !== undefined && existingParent !== parent.id) {
      await host.harness.remountSession(payload);
    } else {
      await host.harness.mountSession(payload);
    }
    await refresh();
    host.showStatus(`Mounted ${child.id} under ${parent.id}.`);
  } catch (error) {
    host.showError(formatErrorMessage(error));
    reopen();
  }
}

async function applyUnmount(
  host: SlashCommandHost,
  session: SessionSummary,
  refresh: () => Promise<void>,
  reopen: () => void,
): Promise<void> {
  try {
    await host.harness.unmountSession({ sessionId: session.id });
    await refresh();
    host.showStatus(`Unmounted ${session.id}.`);
  } catch (error) {
    host.showError(formatErrorMessage(error));
    reopen();
  }
}

function promptText(
  host: SlashCommandHost,
  opts: { readonly title: string; readonly allowEmpty?: boolean },
): Promise<string | undefined> {
  return new Promise((resolve) => {
    host.mountEditorReplacement(
      new TextInputDialogComponent({
        title: opts.title,
        allowEmpty: opts.allowEmpty,
        onDone: (result) => {
          if (result.kind === 'cancel') {
            resolve(undefined);
            return;
          }
          resolve(result.value);
        },
      }),
    );
  });
}
