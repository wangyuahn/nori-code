import { describe, expect, it, vi } from 'vitest';

import { createTUIState } from '#/tui/kimi-tui';
import { TeamViewController, type TeamViewHost } from '#/tui/controllers/team-view';
import type { AppState } from '#/tui/types';
import type { TeamAgentSnapshot } from '#/tui/utils/team-tree';
import type { Event } from '@nori-code/sdk';

const reviewer: TeamAgentSnapshot = {
  agentId: 'reviewer',
  kind: 'team',
  name: 'Reviewer',
  parentAgentId: 'main',
};

const discussion: TeamAgentSnapshot = {
  agentId: 'discuss-1',
  kind: 'discussion',
  name: 'Discussion',
  parentAgentId: 'main',
};

function fakeAppState(overrides: Partial<AppState> = {}): AppState {
  return {
    model: 'test-model',
    workDir: '/tmp/kimi-test',
    additionalDirs: [],
    sessionId: 'sess-1',
    permissionMode: 'manual',
    discussMode: false,
    inputMode: 'prompt',
    coderWriteEnabled: false,
    toolsReadonly: true,
    thinkingEffort: 'off',
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    isCompacting: false,
    isReplaying: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    theme: 'dark',
    version: '0.0.0-test',
    editorCommand: null,
    notifications: { enabled: true, condition: 'unfocused' },
    upgrade: { autoInstall: true },
    availableModels: {},
    availableProviders: {},
    sessionTitle: null,
    mcpServersSummary: null,
    teamAgents: [
      { agentId: 'main', kind: 'main', name: 'Main', parentAgentId: null },
      reviewer,
      discussion,
    ],
    viewingAgentId: 'main',
    ...overrides,
  };
}

function createController(overrides: Partial<AppState> = {}) {
  const state = createTUIState({
    initialAppState: fakeAppState(overrides),
    startup: { continueLast: false, permission: undefined, discuss: false },
  });
  const hydrateFromReplay = vi.fn(async () => true);
  const prepareTranscriptForAgentView = vi.fn();
  const showStatus = vi.fn();
  const setAppState = vi.fn((patch: Partial<AppState>) => {
    Object.assign(state.appState, patch);
  });
  const session = {
    getResumeState: vi.fn(() => ({ sessionMetadata: {}, agents: {} })),
  };
  const host = {
    state,
    session,
    harness: { withInteractiveAgent: (_id: string, fn: () => unknown) => fn() },
    sessionReplay: { hydrateFromReplay },
    setAppState,
    showStatus,
    showError: vi.fn(),
    restoreEditor: vi.fn(),
    prepareTranscriptForAgentView,
  };
  return {
    controller: new TeamViewController(host as unknown as TeamViewHost),
    state,
    hydrateFromReplay,
    prepareTranscriptForAgentView,
    showStatus,
    setAppState,
  };
}

function paneText(state: ReturnType<typeof createTUIState>): string {
  return state.departmentPaneContainer
    .render(80)
    .join('\n')
    .replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('TeamViewController', () => {
  it('opens a member session and hydrates that agent, not main', async () => {
    const { controller, state, hydrateFromReplay, prepareTranscriptForAgentView } = createController();
    await controller.open(reviewer);
    expect(state.appState.viewingAgentId).toBe('reviewer');
    expect(prepareTranscriptForAgentView).toHaveBeenCalledWith('reviewer');
    expect(hydrateFromReplay).toHaveBeenCalledWith(expect.anything(), 'reviewer');
    expect(controller.isPaneVisible()).toBe(true);
    expect(paneText(state)).toContain('Chat');
  });

  it('opens a discussion node by revealing the pane without switching agents', async () => {
    const { controller, state, hydrateFromReplay, prepareTranscriptForAgentView } = createController();
    await controller.open(discussion);
    expect(state.appState.viewingAgentId).toBe('main');
    expect(prepareTranscriptForAgentView).not.toHaveBeenCalled();
    expect(hydrateFromReplay).not.toHaveBeenCalled();
    expect(controller.isPaneVisible()).toBe(true);
  });

  it('forces the Discuss meeting track while Discuss is on, and hide only closes the pane', () => {
    const { controller, state, setAppState } = createController({ discussMode: true });
    controller.onDiscussModeChanged(true);
    expect(controller.isPaneVisible()).toBe(true);
    expect(paneText(state)).toContain('Discuss');
    expect(paneText(state)).not.toContain('Chat');

    expect(controller.hide()).toBe(true);
    expect(controller.isPaneVisible()).toBe(false);
    expect(state.appState.discussMode).toBe(true);
    expect(paneText(state).trim()).toBe('');

    controller.toggle();
    expect(controller.isPaneVisible()).toBe(true);
    expect(paneText(state)).toContain('Discuss');
    expect(setAppState).not.toHaveBeenCalledWith(expect.objectContaining({ discussMode: false }));
  });

  it('shows Chat when Discuss is off and can hide the pane', () => {
    const { controller, state } = createController();
    controller.reveal();
    expect(paneText(state)).toContain('Chat');
    expect(controller.hide()).toBe(true);
    expect(controller.isPaneVisible()).toBe(false);
  });

  it('appends live TeamSpeak into the Discuss pane without treating hide as leaving Discuss', () => {
    const { controller, state } = createController({ discussMode: true });
    controller.reveal();
    controller.routeEvent({
      type: 'tool.call.started',
      agentId: 'reviewer',
      sessionId: 'sess-1',
      turnId: 1,
      toolCallId: 'ts-1',
      name: 'TeamSpeak',
      args: { message: 'Ship the footer first.' },
    } as Event);
    expect(paneText(state)).toContain('Ship the footer first.');
    controller.hide();
    expect(state.appState.discussMode).toBe(true);
  });
});
