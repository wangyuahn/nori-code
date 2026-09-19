import { describe, expect, it, vi } from 'vitest';

import { createTUIState } from '#/tui/kimi-tui';
import { TeamViewController, type TeamViewHost } from '#/tui/controllers/team-view';
import type { AppState } from '#/tui/types';
import type { TeamAgentSnapshot } from '#/tui/utils/team-tree';
import type { Event } from '@nori-code/sdk';

const reviewer: TeamAgentSnapshot = {
  agentId: 'sess_reviewer',
  kind: 'team',
  name: 'Reviewer',
  parentAgentId: 'main',
  mountedSessionId: 'sess_reviewer',
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
  const showStatus = vi.fn();
  const setAppState = vi.fn((patch: Partial<AppState>) => {
    Object.assign(state.appState, patch);
  });
  const session = {
    getResumeState: vi.fn(() => ({
      sessionMetadata: {
        agents: {
          main: {
            chat: {
              messages: [
                {
                  messageId: 1,
                  agentId: 'sess_reviewer',
                  name: 'Reviewer',
                  message: 'Taking the footer.',
                },
              ],
            },
          },
        },
      },
    })),
  };
  const host = {
    state,
    session,
    harness: { withInteractiveAgent: (_id: string, fn: () => unknown) => fn() },
    setAppState,
    showStatus,
    showError: vi.fn(),
    restoreEditor: vi.fn(),
  };
  return {
    controller: new TeamViewController(host as unknown as TeamViewHost),
    state,
    session,
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
  it('loads department Chat from the current session lead, not a member view', () => {
    const { controller, state, session } = createController();
    controller.reveal();
    controller.seedFromSession(session as never);
    expect(state.appState.viewingAgentId).toBe('main');
    expect(paneText(state)).toContain('Chat');
    expect(paneText(state)).toContain('Taking the footer.');
  });

  it('tells a mounted child that Chat lives on the parent session', () => {
    const { controller, state } = createController({
      teamAgents: [{ agentId: 'main', kind: 'main', name: 'Reviewer', parentAgentId: null }],
      parentSessionId: 'sess_parent',
      sessionTitle: 'Reviewer',
    });
    controller.reveal();
    expect(paneText(state)).toContain('parent session');
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
      agentId: 'sess_reviewer',
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
