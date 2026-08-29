import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands';
import { handleSettingCommand } from '#/tui/commands/config';
import { CURRENT_MARK } from '#/tui/constant/symbols';
import { darkColors } from '#/tui/theme/colors';

const ANSI = /\u001B\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');

type ConfigShape = {
  providers: Record<string, unknown>;
  defaultDiscussMode?: boolean;
  loopControl?: {
    maxStepsPerTurn?: number;
    goalMaxTurns?: number;
    goalBackgroundIdleMinutes?: number;
  };
  memory?: {
    vectorEnabled?: boolean;
    providerType?: 'openai' | 'openai_responses';
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  };
};

function makeHost(initial: ConfigShape = { providers: {} }) {
  let config: ConfigShape = { ...initial };
  const host = {
    state: {
      theme: { palette: darkColors },
      appState: {},
    },
    harness: {
      getConfig: vi.fn(async () => config),
      setConfig: vi.fn(async (patch: Record<string, unknown>) => {
        config = {
          ...config,
          ...patch,
          loopControl: {
            ...config.loopControl,
            ...((patch['loopControl'] as ConfigShape['loopControl']) ?? {}),
          },
          memory: {
            ...config.memory,
            ...((patch['memory'] as ConfigShape['memory']) ?? {}),
          },
        };
        return config;
      }),
    },
    session: undefined,
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    showStatus: vi.fn(),
    showError: vi.fn(),
  } as unknown as SlashCommandHost & {
    harness: {
      getConfig: ReturnType<typeof vi.fn>;
      setConfig: ReturnType<typeof vi.fn>;
    };
    mountEditorReplacement: ReturnType<typeof vi.fn>;
    restoreEditor: ReturnType<typeof vi.fn>;
    showStatus: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
  };
  return host;
}

function lastPanel(host: ReturnType<typeof makeHost>): {
  render(width: number): string[];
  handleInput(data: string): void;
} {
  const panel = host.mountEditorReplacement.mock.calls.at(-1)?.[0] as
    | { render(width: number): string[]; handleInput(data: string): void }
    | undefined;
  if (panel === undefined) throw new Error('expected a mounted panel');
  return panel;
}

function panelText(host: ReturnType<typeof makeHost>): string {
  return lastPanel(host).render(120).map(strip).join('\n');
}

describe('setting command: loop / memory / default-discuss', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('opens the settings list including Loop limits and Memory', async () => {
    const host = makeHost();
    await handleSettingCommand(host, '');
    const out = panelText(host);
    expect(out).toContain('Settings');
    expect(out).toContain('Loop limits');
    expect(out).toContain('Memory');
  });

  it('applies /setting loop steps <n> through harness.setConfig', async () => {
    const host = makeHost();
    await handleSettingCommand(host, 'loop steps 32');
    expect(host.harness.setConfig).toHaveBeenCalledWith({
      loopControl: { maxStepsPerTurn: 32 },
    });
    expect(host.showStatus).toHaveBeenCalledWith('Steps per turn: 32');
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('opens loop presets and marks a custom current value', async () => {
    const host = makeHost({
      providers: {},
      loopControl: { maxStepsPerTurn: 24 },
    });
    await handleSettingCommand(host, 'loop steps');
    const out = panelText(host);
    expect(out).toContain('Steps per turn');
    expect(out).toContain('Unlimited');
    expect(out).toContain('24');
    expect(out).toContain(CURRENT_MARK);
    expect(out).not.toContain('(current)');
  });

  it('treats unset idle minutes as 5 in the picker', async () => {
    const host = makeHost();
    await handleSettingCommand(host, 'loop idle');
    const out = panelText(host);
    expect(out).toContain('Background idle');
    expect(out).toContain('5');
    expect(out).toContain(CURRENT_MARK);
    expect(out).toContain('Off');
  });

  it('rejects a non-integer loop value', async () => {
    const host = makeHost();
    await handleSettingCommand(host, 'loop steps abc');
    expect(host.showError).toHaveBeenCalledWith('Usage: /setting loop steps <n>');
    expect(host.harness.setConfig).not.toHaveBeenCalled();
  });

  it('opens the Memory menu from /setting memory', async () => {
    const host = makeHost({
      providers: {},
      memory: {
        vectorEnabled: false,
        providerType: 'openai',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-stored',
        model: 'text-embedding-3-small',
      },
    });
    await handleSettingCommand(host, 'memory');
    const out = panelText(host);
    expect(out).toContain('Memory');
    expect(out).toContain('Vector search: Off');
    expect(out).toContain('OpenAI compatible');
    expect(out).toContain('https://api.example.com/v1');
    expect(out).toContain('API Key: stored');
    expect(out).toContain('text-embedding-3-small');
    expect(out).not.toContain('sk-stored');
  });

  it('opens the loop menu from /setting loop', async () => {
    const host = makeHost({
      providers: {},
      loopControl: { maxStepsPerTurn: 0, goalMaxTurns: 10, goalBackgroundIdleMinutes: 5 },
    });
    await handleSettingCommand(host, 'loop');
    const out = panelText(host);
    expect(out).toContain('Loop limits');
    expect(out).toContain('Steps per turn: Unlimited');
    expect(out).toContain('Goal turns: 10');
    expect(out).toContain('Background idle: 5');
  });

  it('blocks enabling vector search until Base URL / key / model are set', async () => {
    const host = makeHost();
    await handleSettingCommand(host, 'memory');
    lastPanel(host).handleInput('\r');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const up = `${String.fromCodePoint(27)}[A`;
    lastPanel(host).handleInput(up);
    lastPanel(host).handleInput('\r');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.showError).toHaveBeenCalledWith('Vector search needs an http(s) Base URL.');
    expect(host.harness.setConfig).not.toHaveBeenCalled();
    expect(panelText(host)).toContain('Memory Base URL');
    expect(panelText(host)).toContain('Enter submit · Esc cancel');
  });

  it('applies /setting default-discuss off', async () => {
    const host = makeHost({ providers: {}, defaultDiscussMode: true });
    await handleSettingCommand(host, 'default-discuss off');
    expect(host.harness.setConfig).toHaveBeenCalledWith({ defaultDiscussMode: false });
    expect(host.showStatus).toHaveBeenCalledWith('Default Discuss: OFF');
  });

  it('opens the Default Discuss picker without an argument', async () => {
    const host = makeHost({ providers: {}, defaultDiscussMode: true });
    await handleSettingCommand(host, 'default-discuss');
    const out = panelText(host);
    expect(out).toContain('Default Discuss');
    expect(out).toContain('On');
    expect(out).toContain(CURRENT_MARK);
  });
});
