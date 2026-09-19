import type { SessionGraphSummary, SessionSummary } from '@nori-code/sdk';

import { SessionMapBrowserComponent } from '../components/dialogs/session-map-browser';
import { TextInputDialogComponent } from '../components/dialogs/text-input-dialog';
import { formatErrorMessage } from '../utils/event-payload';
import { parentSessionIdOf, mountRoleOf, mountMandateOf, sessionMapLabel } from '../utils/session-map-tree';
import { teamAgentsFromMountedChildren, type TeamAgentSnapshot } from '../utils/team-tree';
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
          void openSession(host, session.id, render);
        },
        onMount: (child, parent) => {
          void applyMount(host, child, parent, async () => {
            graph = await host.harness.getSessionGraph({ workDir: host.state.appState.workDir });
            mappedTeamAgents = await refreshTeamAgents(host, graph);
            render();
          }, render);
        },
        onUnmount: (session) => {
          void applyUnmount(host, session, async () => {
            graph = await host.harness.getSessionGraph({ workDir: host.state.appState.workDir });
            mappedTeamAgents = await refreshTeamAgents(host, graph);
            render();
          }, render);
        },
        onCancel: () => {
          host.restoreEditor();
        },
      }),
    );
  };

  mappedTeamAgents = await refreshTeamAgents(host, graph);
  render();
}

async function refreshTeamAgents(
  host: SlashCommandHost,
  graph: SessionGraphSummary,
): Promise<MappedTeamAgent[]> {
  const mapped: MappedTeamAgent[] = [];
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const childrenByParent = new Map<string, SessionSummary[]>();
  for (const edge of graph.edges) {
    const child = byId.get(edge.childSessionId);
    if (child === undefined) continue;
    const list = childrenByParent.get(edge.parentSessionId) ?? [];
    list.push(child);
    childrenByParent.set(edge.parentSessionId, list);
  }
  for (const node of graph.nodes) {
    const children = childrenByParent.get(node.id) ?? [];
    mapped.push(
      ...teamAgentsFromMountedChildren(sessionMapLabel(node), children.map((child) => ({
        id: child.id,
        title: child.title,
        name: typeof child.metadata?.['mount_name'] === 'string' ? child.metadata['mount_name'] : child.title,
        role: mountRoleOf(child),
        mandate: mountMandateOf(child),
      }))).map((agent) => ({
        ...agent,
        hostSessionId: node.id,
      })),
    );
  }
  const currentSessionId = host.session?.id;
  host.setAppState({
    teamAgents: mapped.filter((agent) => agent.hostSessionId === currentSessionId),
  });
  return mapped;
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
