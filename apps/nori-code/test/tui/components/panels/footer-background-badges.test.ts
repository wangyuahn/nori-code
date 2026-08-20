import { describe, expect, it } from 'vitest';

import { FooterComponent } from '#/tui/components/chrome/footer';
import type { AppState } from '#/tui/types';

const ANSI_SGR = /\[[0-9;]*m/g;
function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

function baseState(overrides: Partial<AppState> = {}): AppState {
  return {
    model: 'k2',
    workDir: '/tmp/proj',
    additionalDirs: [],
    sessionId: 'sess_1',
    permissionMode: 'manual',
    discussMode: false,
    thinkingEffort: 'off',
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 200_000,
    isCompacting: false,
    isReplaying: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    theme: 'dark',
    version: 'test',
    editorCommand: null,
    notifications: { enabled: true, condition: 'unfocused' },
    availableModels: {},
    ...overrides,
  } as AppState;
}

describe('FooterComponent background task badges', () => {
  it('omits both badges when counts are 0', () => {
    const footer = new FooterComponent(baseState());
    const [line1] = footer.render(120);
    expect(line1).toBeDefined();
    expect(strip(line1!)).not.toMatch(/tasks? running/);
    expect(strip(line1!)).not.toMatch(/questions? pending/);
  });

  it('renders the task badge alone when only shell processes are running', () => {
    const footer = new FooterComponent(baseState());
    footer.setBackgroundCounts({ processTasks: 1, questionTasks: 0 });
    const out = strip(footer.render(120)[0]!);
    expect(out).toMatch(/\[1 task running\]/);
    expect(out).not.toMatch(/questions? pending/);
  });

  it('renders the question badge alone when only questions are pending', () => {
    const footer = new FooterComponent(baseState());
    footer.setBackgroundCounts({ processTasks: 0, questionTasks: 1 });
    const out = strip(footer.render(120)[0]!);
    expect(out).toMatch(/\[1 question pending\]/);
    expect(out).not.toMatch(/tasks? running/);
  });

  it('renders both badges side by side when both are non-zero', () => {
    const footer = new FooterComponent(baseState());
    footer.setBackgroundCounts({ processTasks: 2, questionTasks: 3 });
    const out = strip(footer.render(120)[0]!);
    expect(out).toMatch(/\[2 tasks running\]/);
    expect(out).toMatch(/\[3 questions pending\]/);
    expect(out.indexOf('2 tasks')).toBeLessThan(out.indexOf('3 questions'));
  });

  it('pluralizes correctly across both badges', () => {
    const footer = new FooterComponent(baseState());
    footer.setBackgroundCounts({ processTasks: 1, questionTasks: 1 });
    const out = strip(footer.render(120)[0]!);
    expect(out).toMatch(/\[1 task running\]/);
    expect(out).toMatch(/\[1 question pending\]/);
  });

  it('updates badges live via setBackgroundCounts', () => {
    const footer = new FooterComponent(baseState());
    footer.setBackgroundCounts({ processTasks: 2, questionTasks: 1 });
    expect(strip(footer.render(120)[0]!)).toMatch(/\[2 tasks running\]/);
    footer.setBackgroundCounts({ processTasks: 0, questionTasks: 0 });
    const after = strip(footer.render(120)[0]!);
    expect(after).not.toMatch(/tasks? running/);
    expect(after).not.toMatch(/questions? pending/);
  });

  it('clamps negative counts to 0', () => {
    const footer = new FooterComponent(baseState());
    footer.setBackgroundCounts({ processTasks: -5, questionTasks: -2 });
    const out = strip(footer.render(120)[0]!);
    expect(out).not.toMatch(/tasks? running/);
    expect(out).not.toMatch(/questions? pending/);
  });

  it('drops the badges when terminal is too narrow to fit them', () => {
    const footer = new FooterComponent(baseState());
    footer.setBackgroundCounts({ processTasks: 4, questionTasks: 3 });
    // Extremely narrow width: footer primary content fills the line, so leftLine wins.
    const [line1] = footer.render(20);
    expect(line1).toBeDefined();
    expect(strip(line1!)).not.toMatch(/\[4 tasks running\]/);
    expect(strip(line1!)).not.toMatch(/\[3 questions pending\]/);
  });
});
