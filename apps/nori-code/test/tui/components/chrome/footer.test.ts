import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FooterComponent } from '#/tui/components/chrome/footer';
import { setRainbowDance, type RainbowDanceController } from '#/tui/easter-eggs/dance';
import { currentTheme, darkColors, lightColors } from '#/tui/theme';
import type { ModelAlias } from '@nori-code/sdk';
import type { AppState } from '#/tui/types';

const TRUECOLOR_PATTERN = /\[38;2;(\d+);(\d+);(\d+)m/g;

function truecolorCodes(text: string): Set<string> {
  const codes = new Set<string>();
  for (const match of text.matchAll(TRUECOLOR_PATTERN)) {
    codes.add(`${match[1]},${match[2]},${match[3]}`);
  }
  return codes;
}

// Dark dance colors the footer never uses outside of /dance.
const RAINBOW_CYAN = '91,192,190';
const RAINBOW_GREEN = '78,200,126';

function setDanceView(colored: boolean, phase: number): void {
  const dance: RainbowDanceController = {
    colored,
    phase,
    start: () => {},
    stop: () => {},
    dispose: () => {},
  };
  setRainbowDance(dance);
}

const appState: AppState = {
  version: '1.2.3',
  workDir: '/tmp/project',
  additionalDirs: [],
  sessionId: 'ses-1',
  sessionTitle: null,
  model: 'kimi-k2',
  permissionMode: 'manual',
  thinkingEffort: 'off',
  contextUsage: 0,
  contextTokens: 0,
  maxContextTokens: 0,
  isCompacting: false,
  isReplaying: false,
  streamingPhase: 'idle',
  streamingStartTime: 0,
  discussMode: false,
  inputMode: 'prompt',
  coderWriteEnabled: false,
  toolsReadonly: true,
  theme: 'dark',
  editorCommand: null,
  notifications: { enabled: true, condition: 'unfocused' },
  upgrade: { autoInstall: true },
  availableModels: {},
  availableProviders: {},
  mcpServersSummary: null,
  teamAgents: [],
};

describe('FooterComponent', () => {
  const previousChalkLevel = chalk.level;

  beforeEach(() => {
    chalk.level = 3;
  });

  afterEach(() => {
    chalk.level = previousChalkLevel;
    setRainbowDance(undefined);
  });

  it('paints the model name in rainbow while colored', () => {
    setDanceView(true, 0);
    const footer = new FooterComponent(appState);

    const codes = truecolorCodes(footer.render(120).join('\n'));

    // "kimi-k2" spreads across the palette, pulling in colors the footer
    // never renders on its own.
    expect(codes.has(RAINBOW_CYAN)).toBe(true);
    expect(codes.has(RAINBOW_GREEN)).toBe(true);
  });

  it('renders the model name in its normal color when not dancing', () => {
    const footer = new FooterComponent(appState);

    const codes = truecolorCodes(footer.render(120).join('\n'));

    expect(codes.has(RAINBOW_CYAN)).toBe(false);
    expect(codes.has(RAINBOW_GREEN)).toBe(false);
  });

  it('repaints from the active palette on the next render (no setColors needed)', () => {
    const footer = new FooterComponent(appState);
    const before = footer.render(120).join('\n');

    currentTheme.setPalette(lightColors);
    try {
      const after = footer.render(120).join('\n');
      // Reads currentTheme live, so a palette swap changes the emitted colours.
      expect(after).not.toBe(before);
    } finally {
      currentTheme.setPalette(darkColors);
    }
  });

  it('shows the effort for an effort-capable model', () => {
    const effortModel: ModelAlias = {
      provider: 'managed:kimi-code',
      model: 'kimi-k2',
      maxContextSize: 262144,
      supportEfforts: ['low', 'high', 'max'],
      defaultEffort: 'high',
    };
    const state: AppState = {
      ...appState,
      thinkingEffort: 'max',
      availableModels: { 'kimi-k2': effortModel },
    };
    const footer = new FooterComponent(state);

    expect(footer.render(120).join('\n')).toContain('thinking: max');
  });

  it('does not show the effort for a legacy boolean model', () => {
    const plainModel: ModelAlias = {
      provider: 'managed:kimi-code',
      model: 'kimi-k2',
      maxContextSize: 262144,
      capabilities: ['thinking'],
    };
    const state: AppState = {
      ...appState,
      thinkingEffort: 'high',
      availableModels: { 'kimi-k2': plainModel },
    };
    const footer = new FooterComponent(state);
    const rendered = footer.render(120).join('\n');

    expect(rendered).toContain('thinking');
    expect(rendered).not.toContain('thinking:high');
  });
});

describe('FooterComponent overrides', () => {
  it('shows the overridden effort list', () => {
    const effortModelWithOverride: ModelAlias = {
      provider: 'managed:kimi-code',
      model: 'kimi-k2',
      maxContextSize: 262144,
      supportEfforts: ['low', 'high', 'max'],
      defaultEffort: 'max',
      overrides: { supportEfforts: ['low', 'high'], defaultEffort: 'high' },
    };
    const state: AppState = {
      ...appState,
      thinkingEffort: 'high',
      availableModels: { 'kimi-k2': effortModelWithOverride },
    };
    const footer = new FooterComponent(state);

    expect(footer.render(120).join('\n')).toContain('thinking: high');
  });
});

describe('FooterComponent displayName override', () => {
  it('renders the overridden display name', () => {
    const state: AppState = {
      ...appState,
      model: 'kimi-k2',
      availableModels: {
        'kimi-k2': {
          provider: 'managed:kimi-code',
          model: 'kimi-k2',
          maxContextSize: 262144,
          displayName: 'Remote Name',
          overrides: { displayName: 'Custom Name' },
        },
      },
    };
    const footer = new FooterComponent(state);

    expect(footer.render(120).join('\n')).toContain('Custom Name');
    expect(footer.render(120).join('\n')).not.toContain('Remote Name');
  });

  it('shows readonly and a team count when partners are hired', () => {
    const footer = new FooterComponent({
      ...appState,
      toolsReadonly: true,
      discussMode: false,
      teamAgents: [
        { agentId: 'main', kind: 'main', name: 'Main', parentAgentId: null },
        { agentId: 'reviewer', kind: 'team', name: 'Reviewer', parentAgentId: 'main' },
      ],
    });
    const out = footer.render(160).join('\n').replaceAll(/\u001B\[[0-9;]*m/g, '');
    expect(out).toContain('readonly');
    expect(out).toContain('[team 1]');
  });

  it('shows the viewed partner name in the footer', () => {
    const footer = new FooterComponent({
      ...appState,
      viewingAgentId: 'reviewer',
      teamAgents: [
        { agentId: 'main', kind: 'main', name: 'Main', parentAgentId: null },
        { agentId: 'reviewer', kind: 'team', name: 'Reviewer', parentAgentId: 'main' },
      ],
    });
    const out = footer.render(160).join('\n').replaceAll(/\u001B\[[0-9;]*m/g, '');
    expect(out).toContain('Reviewer');
  });

  it('shows the department speaker without lighting an outsider', () => {
    const footer = new FooterComponent({
      ...appState,
      teamAgents: [
        { agentId: 'main', kind: 'main', name: 'Main', parentAgentId: null },
        { agentId: 'reviewer', kind: 'team', name: 'Reviewer', parentAgentId: 'main' },
        {
          agentId: 'discuss-1',
          kind: 'discussion',
          name: 'Discussion',
          parentAgentId: 'main',
          discussionTurnAgentId: 'reviewer',
        },
      ],
    });
    const out = footer.render(160).join('\n').replaceAll(/\u001B\[[0-9;]*m/g, '');
    expect(out).toContain('speak:Reviewer');
  });

  it('keeps discuss, team, speak, and model on an 80-column row', () => {
    const footer = new FooterComponent({
      ...appState,
      discussMode: true,
      toolsReadonly: false,
      workDir: '/home/user/very/long/project/path/that/should/drop',
      teamAgents: [
        { agentId: 'main', kind: 'main', name: 'Main', parentAgentId: null },
        { agentId: 'reviewer', kind: 'team', name: 'Reviewer', parentAgentId: 'main' },
        {
          agentId: 'discuss-1',
          kind: 'discussion',
          name: 'Discussion',
          parentAgentId: 'main',
          discussionTurnAgentId: 'reviewer',
        },
      ],
      availableModels: {
        'kimi-k2': {
          provider: 'managed:kimi-code',
          model: 'kimi-k2',
          maxContextSize: 262144,
          displayName: 'Kimi K2',
        },
      },
      goal: {
        goalId: 'g1',
        objective: 'Ship the footer',
        status: 'active',
        turnsUsed: 7,
        tokensUsed: 1000,
        wallClockMs: 240_000,
        budget: {
          tokenBudget: null,
          turnBudget: 20,
          wallClockBudgetMs: null,
          remainingTokens: null,
          remainingTurns: 13,
          remainingWallClockMs: null,
          tokenBudgetReached: false,
          turnBudgetReached: false,
          wallClockBudgetReached: false,
          overBudget: false,
        },
      },
    });
    footer.setBackgroundCounts({ processTasks: 3, questionTasks: 2 });
    const out = footer.render(80).join('\n').replaceAll(/\u001B\[[0-9;]*m/g, '');
    expect(out).toContain('discuss');
    expect(out).toContain('[team 1]');
    expect(out).toContain('speak:Reviewer');
    expect(out).toContain('Kimi K2');
  });

  it('shows a warning report badge when a partner is blocked', () => {
    const footer = new FooterComponent({
      ...appState,
      teamAgents: [
        { agentId: 'main', kind: 'main', name: 'Main', parentAgentId: null },
        {
          agentId: 'reviewer',
          kind: 'team',
          name: 'Reviewer',
          parentAgentId: 'main',
          reportStatus: 'blocked',
        },
      ],
    });
    const out = footer.render(160).join('\n').replaceAll(/\u001B\[[0-9;]*m/g, '');
    expect(out).toContain('[report!]');
  });
});
