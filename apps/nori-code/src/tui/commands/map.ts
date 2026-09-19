import type { SessionGraphSummary, SessionSummary } from '@nori-code/sdk';

import { SessionMapBrowserComponent } from '../components/dialogs/session-map-browser';
import { TextInputDialogComponent } from '../components/dialogs/text-input-dialog';
import { formatErrorMessage } from '../utils/event-payload';
import { parentSessionIdOf, sessionMapLabel } from '../utils/session-map-tree';
import { buildDepartmentSnapshot } from '../utils/team-tree';
import type { SlashCommandHost } from './dispatch';

export async function handleMapCommand(host: SlashCommandHost): Promise<void> {
  let graph: SessionGraphSummary;
  try {
    graph = await host.harness.getSessionGraph({ workDir: host.state.appState.workDir });
  } catch (error) {
    host.showError(formatErrorMessage(error));
    return;
  }

  const render = (): void => {
    host.mountEditorReplacement(
      new SessionMapBrowserComponent({
        nodes: graph.nodes,
        edges: graph.edges,
        currentSessionId: host.session?.id,
        onOpen: (session) => {
          void openSession(host, session.id, render);
        },
        onMount: (child, parent) => {
          void applyMount(host, child, parent, async () => {
            graph = await host.harness.getSessionGraph({ workDir: host.state.appState.workDir });
            refreshTeamAgents(host, graph);
            render();
          }, render);
        },
        onUnmount: (session) => {
          void applyUnmount(host, session, async () => {
            graph = await host.harness.getSessionGraph({ workDir: host.state.appState.workDir });
            refreshTeamAgents(host, graph);
            render();
          }, render);
        },
        onCancel: () => {
          host.restoreEditor();
        },
      }),
    );
  };

  refreshTeamAgents(host, graph);
  render();
}

function refreshTeamAgents(host: SlashCommandHost, graph: SessionGraphSummary): void {
  const currentSessionId = host.session?.id;
  if (currentSessionId === undefined) return;
  const hostNode = graph.nodes.find((node) => node.id === currentSessionId);
  host.setAppState({
    teamAgents: buildDepartmentSnapshot({
      hostSessionId: currentSessionId,
      hostTitle: hostNode === undefined
        ? (host.state.appState.sessionTitle ?? 'Main')
        : sessionMapLabel(hostNode),
      graph,
      metadata: host.session?.getResumeState()?.sessionMetadata,
      live: host.state.appState.teamAgents,
    }),
  });
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
