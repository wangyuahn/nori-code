import { visibleWidth } from '@nori-code/pi-tui';
import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NORI_TERMINAL_LOGO, NORI_TERMINAL_LOGO_COLOR } from '#/constant/app';
import { WelcomeComponent } from '#/tui/components/chrome/welcome';
import { setRainbowDance, type RainbowDanceController } from '#/tui/easter-eggs/dance';
import { darkColors } from '#/tui/theme/colors';
import type { AppState } from '#/tui/types';

const TRUECOLOR_PATTERN = /\u001B\[38;2;(\d+);(\d+);(\d+)m/g;

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

function truecolorCodes(text: string): Set<string> {
  const codes = new Set<string>();
  for (const match of text.matchAll(TRUECOLOR_PATTERN)) {
    codes.add(`${match[1]},${match[2]},${match[3]}`);
  }
  return codes;
}

function truecolorCodeFromHex(hex: string): string {
  const value = hex.replace(/^#/, '');
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ].join(',');
}

/** The two header rows (logo + title) of the rendered welcome box. */
function headerOf(lines: string[]): string {
  return [lines[3], lines[4]].join('\n');
}

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

describe('WelcomeComponent', () => {
  const previousChalkLevel = chalk.level;

  beforeEach(() => {
    chalk.level = 3;
  });

  afterEach(() => {
    chalk.level = previousChalkLevel;
    setRainbowDance(undefined);
  });

  it('renders the banner in a single brand color by default', () => {
    const codes = truecolorCodes(headerOf(new WelcomeComponent(appState).render(80)));

    // No rainbow by default: cyan logo, primary title, and dim tagline.
    expect(codes).toContain(truecolorCodeFromHex(NORI_TERMINAL_LOGO_COLOR));
    expect(codes.size).toBeLessThanOrEqual(3);
  });

  it('renders the Nori terminal logo', () => {
    const output = new WelcomeComponent(appState).render(80).join('\n');

    expect(output).toContain(NORI_TERMINAL_LOGO[0]);
    expect(output).toContain(NORI_TERMINAL_LOGO[1]);
    expect(output).toContain(NORI_TERMINAL_LOGO[2]);
    // Reject the old letter-N block logo and the prior Kimi banner glyph.
    expect(output).not.toContain('█   █');
    expect(output).not.toContain('▐█▛█▛█▌');
  });

  it('paints the banner in rainbow while colored', () => {
    setDanceView(true, 0);
    const codes = truecolorCodes(headerOf(new WelcomeComponent(appState).render(80)));

    expect(codes.size).toBeGreaterThanOrEqual(5);
  });

  it('renders exactly the default banner when not colored', () => {
    const base = headerOf(new WelcomeComponent(appState).render(80));
    setDanceView(false, 5);
    const off = headerOf(new WelcomeComponent(appState).render(80));

    expect(off).toBe(base);
  });

  it('keeps every line within the requested width on narrow terminals', () => {
    for (const width of [0, 1, 2, 4, 10, 39, 80]) {
      for (const line of new WelcomeComponent(appState).render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('omits the team line when nobody is hired', () => {
    const output = new WelcomeComponent(appState).render(80).join('\n');
    expect(output).not.toContain('Team:');
    expect(output).not.toContain('Discuss on');
    expect(output).not.toContain('Discuss off');
  });

  it('shows hired team count and discuss state', () => {
    const hired: AppState = {
      ...appState,
      discussMode: true,
      teamAgents: [
        { agentId: 'main', kind: 'main', name: 'Main', parentAgentId: null },
        { agentId: 'reviewer', kind: 'team', name: 'Reviewer', parentAgentId: 'main' },
        { agentId: 'archived', kind: 'team', name: 'Old', parentAgentId: 'main', archived: true },
      ],
    };
    const output = new WelcomeComponent(hired).render(80).join('\n').replaceAll(/\u001B\[[0-9;]*m/g, '');
    expect(output).toContain('Team: 1 · Discuss on');

    const off = new WelcomeComponent({ ...hired, discussMode: false }).render(80).join('\n').replaceAll(/\u001B\[[0-9;]*m/g, '');
    expect(off).toContain('Team: 1 · Discuss off');
  });

  it('truncates the team line on a narrow terminal', () => {
    const hired: AppState = {
      ...appState,
      discussMode: true,
      teamAgents: [
        { agentId: 'reviewer', kind: 'team', name: 'Reviewer', parentAgentId: 'main' },
      ],
    };
    const narrow = new WelcomeComponent(hired).render(20).join('\n');
    expect(narrow).toMatch(/Team:/);
    for (const width of [0, 1, 2, 4, 10, 20]) {
      for (const line of new WelcomeComponent(hired).render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});
