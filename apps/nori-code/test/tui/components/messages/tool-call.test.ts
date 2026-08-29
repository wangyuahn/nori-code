import { visibleWidth, type TUI } from '@nori-code/pi-tui';
import chalk from 'chalk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { darkColors } from '#/tui/theme/colors';

import { captureProcessWrite } from '../../../helpers/process';

const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);

function strip(text: string): string {
  return text
    .replaceAll(/\u001B\[[0-9;]*m/g, '')
    .replaceAll(new RegExp(`${ESC}\\]8;;[^${BEL}]*${BEL}`, 'g'), '');
}

function stubTui(rows: number): TUI {
  return {
    terminal: { rows },
    requestRender: () => {},
  } as unknown as TUI;
}

describe('ToolCallComponent', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the shared non-emoji tool status bullet', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_read_marker',
        name: 'Read',
        args: { path: 'foo.ts' },
      },
      {
        tool_call_id: 'call_read_marker',
        output: 'content',
        is_error: false,
      },
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain(`${STATUS_BULLET}Used Read`);
    expect(out).not.toContain(`\u23FA Used Read`);
    expect(out).not.toContain(`${String.fromCodePoint(0x23fa, 0xfe0e)} Used Read`);
  });

  describe('detach hint for long-running foreground Bash/Agent', () => {
    it('shows the Ctrl+B hint after 10s for a running Bash call', () => {
      vi.useFakeTimers();
      const component = new ToolCallComponent(
        { id: 'call_bash_long', name: 'Bash', args: { command: 'sleep 30' } },
        undefined,
        stubTui(30),
      );

      expect(strip(component.render(100).join('\n'))).not.toContain(
        'Press Ctrl+B to run in background',
      );

      vi.advanceTimersByTime(10_000);
      expect(strip(component.render(100).join('\n'))).toContain(
        'Press Ctrl+B to run in background',
      );

      component.dispose();
    });

    it('does not show the hint for non-detachable tools', () => {
      vi.useFakeTimers();
      const component = new ToolCallComponent(
        { id: 'call_read_long', name: 'Read', args: { path: 'foo.ts' } },
        undefined,
        stubTui(30),
      );

      vi.advanceTimersByTime(15_000);
      expect(strip(component.render(100).join('\n'))).not.toContain(
        'Press Ctrl+B to run in background',
      );

      component.dispose();
    });

    it('does not show the hint when the result lands before 10s', () => {
      vi.useFakeTimers();
      const component = new ToolCallComponent(
        { id: 'call_bash_short', name: 'Bash', args: { command: 'echo hi' } },
        undefined,
        stubTui(30),
      );

      vi.advanceTimersByTime(5_000);
      component.setResult({ tool_call_id: 'call_bash_short', output: 'hi', is_error: false });
      vi.advanceTimersByTime(10_000);

      expect(strip(component.render(100).join('\n'))).not.toContain(
        'Press Ctrl+B to run in background',
      );

      component.dispose();
    });
  });

  it('keeps collapsed tool-call lines within very narrow widths', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_narrow_read',
        name: 'Read',
        args: { path: 'very/long/path/to/foo.ts' },
      },
      {
        tool_call_id: 'call_narrow_read',
        output: 'content',
        is_error: false,
      },
    );

    for (const width of [1, 2, 4, 10, 39]) {
      for (const line of component.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('keeps collapsed tool results short and expands on demand', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_shell',
        name: 'Bash',
        args: { command: 'printf output' },
      },
      {
        tool_call_id: 'call_shell',
        output: ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n'),
        is_error: false,
      },
    );

    const collapsed = strip(component.render(100).join('\n'));
    expect(collapsed).toContain('line1');
    expect(collapsed).toContain('line2');
    expect(collapsed).toContain('line3');
    expect(collapsed).not.toContain('line4');
    expect(collapsed).toContain('... (2 more lines, ctrl+o to expand)');

    component.setExpanded(true);

    const expandedLines = component.render(100);
    const expanded = strip(expandedLines.join('\n'));
    expect(expanded).toContain('line4');
    expect(expanded).toContain('line5');
    expect(expanded).not.toContain('ctrl+o to expand');

    component.setExpanded(false);
    const recollapsedLines = component.render(100);
    const recollapsed = strip(recollapsedLines.join('\n'));
    expect(recollapsed).toContain('line1');
    expect(recollapsed).toContain('line3');
    expect(recollapsed).not.toContain('line4');
    expect(recollapsed).toContain('... (2 more lines, ctrl+o to expand)');
    expect(recollapsedLines.length).toBeLessThan(expandedLines.length);
  });

  it('renders live Bash output while the command is running', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_shell_live',
        name: 'Bash',
        args: { command: 'printf output' },
      },
      undefined,
    );

    component.appendLiveOutput('line1\n');
    component.appendLiveOutput('line2\n');

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Using Bash');
    expect(out).toContain('line1');
    expect(out).toContain('line2');
  });

  it('strips terminal control sequences from live Bash output', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_shell_live_control',
        name: 'Bash',
        args: { command: 'printf output' },
      },
      undefined,
    );

    component.appendLiveOutput(`before${ESC}[2J${ESC}[?1049hafter\n`);

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('beforeafter');
    expect(out).not.toContain(`${ESC}[2J`);
    expect(out).not.toContain(`${ESC}[?1049h`);
  });

  it('strips terminal control sequences from final Bash results', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_shell_result_control',
        name: 'Bash',
        args: { command: 'printf output' },
      },
      {
        tool_call_id: 'call_shell_result_control',
        output: `done${ESC}[2J${ESC}[?1049hnow`,
        is_error: false,
      },
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('donenow');
    expect(out).not.toContain(`${ESC}[2J`);
    expect(out).not.toContain(`${ESC}[?1049h`);
  });

  it('clears live Bash output when the final result arrives', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_shell_live_done',
        name: 'Bash',
        args: { command: 'printf output' },
      },
      undefined,
    );

    component.appendLiveOutput('streamed-only\n');
    component.setResult({
      tool_call_id: 'call_shell_live_done',
      output: 'final-only\n',
      is_error: false,
    });

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Used Bash');
    expect(out).toContain('final-only');
    expect(out).not.toContain('streamed-only');
  });

  describe('in-flight Bash command preview (args finalized, no result yet)', () => {
    const longCommand = Array.from({ length: 15 }, (_, i) => `echo step${String(i + 1)}`).join(
      '\n',
    );

    it('shows the truncated command while running and reveals the rest when expanded', () => {
      const component = new ToolCallComponent(
        { id: 'call_bash_running', name: 'Bash', args: { command: longCommand } },
        undefined,
      );

      const collapsed = strip(component.render(100).join('\n'));
      expect(collapsed).toContain('Using Bash');
      expect(collapsed).toContain('echo step1');
      expect(collapsed).toContain('echo step10');
      expect(collapsed).not.toContain('echo step11');

      component.setExpanded(true);

      const expanded = strip(component.render(100).join('\n'));
      expect(expanded).toContain('echo step11');
      expect(expanded).toContain('echo step15');
    });

    it('yields command rendering to the result renderer once the result lands', () => {
      const component = new ToolCallComponent(
        { id: 'call_bash_done', name: 'Bash', args: { command: longCommand } },
        undefined,
      );

      // Sanity: while running, the in-flight preview shows the command.
      expect(strip(component.render(100).join('\n'))).toContain('$ echo step1');

      component.setResult({ tool_call_id: 'call_bash_done', output: 'done', is_error: false });

      // Collapsed result view delegates to shellExecutionResultRenderer, which
      // hides the command — so the in-flight buildCallPreview preview must be
      // gone, otherwise the command would render twice when expanded.
      const out = strip(component.render(100).join('\n'));
      expect(out).toContain('Used Bash');
      expect(out).not.toContain('$ echo step1');
    });
  });

  it('hides tool output bodies that start with a <system tag', () => {
    const reminderOutput =
      '<system-reminder>\nThe task tools have not been used recently.\n</system-reminder>';
    const component = new ToolCallComponent(
      {
        id: 'call_hidden',
        name: 'Bash',
        args: { command: 'echo hi' },
      },
      {
        tool_call_id: 'call_hidden',
        output: reminderOutput,
        is_error: false,
      },
    );

    const collapsed = strip(component.render(100).join('\n'));
    expect(collapsed).toContain(`${STATUS_BULLET}Used Bash`);
    expect(collapsed).not.toContain('system-reminder');
    expect(collapsed).not.toContain('task tools');

    component.setExpanded(true);
    const expanded = strip(component.render(100).join('\n'));
    expect(expanded).not.toContain('system-reminder');
    expect(expanded).not.toContain('task tools');
  });

  it('hides <system-prefixed output even when the tool result is an error', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_hidden_err',
        name: 'Bash',
        args: { command: 'false' },
      },
      {
        tool_call_id: 'call_hidden_err',
        output: '<system-reminder>do not show</system-reminder>',
        is_error: true,
      },
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).not.toContain('system-reminder');
    expect(out).not.toContain('do not show');
  });

  it('still renders tool output when the body merely contains <system later on', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_inline',
        name: 'Bash',
        args: { command: 'echo hi' },
      },
      {
        tool_call_id: 'call_inline',
        output: 'first line\n<system-reminder>nope</system-reminder>',
        is_error: false,
      },
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('first line');
  });

  it('renders AskUserQuestion with a friendly header instead of the raw tool name', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_question',
        name: 'AskUserQuestion',
        args: {},
      },
      {
        tool_call_id: 'call_question',
        output: JSON.stringify({
          answers: {
            'Favorite editor?': 'Vim',
          },
        }),
        is_error: false,
      },
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Collected your answers');
    expect(out).toContain('Favorite editor?');
    expect(out).toContain('Vim');
    expect(out).not.toContain('AskUserQuestion');
  });

  it('renders background AskUserQuestion as a started task', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_background_question',
        name: 'AskUserQuestion',
        args: { background: true },
      },
      {
        tool_call_id: 'call_background_question',
        output: [
          'task_id: question-aaaaaaaa',
          'description: Which database?',
          'status: running',
        ].join('\n'),
        is_error: false,
      },
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Started background question');
    expect(out).toContain('question-aaaaaaaa');
    expect(out).not.toContain('Collected your answers');
  });

  it('renders GetGoal as a goal check without raw JSON', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_get_goal',
        name: 'GetGoal',
        args: {},
      },
      {
        tool_call_id: 'call_get_goal',
        output: JSON.stringify({
          goal: {
            goalId: 'g1',
            objective: 'Ship feature X',
            status: 'active',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            startedBy: 'model',
            updatedBy: 'model',
            turnsUsed: 1,
            tokensUsed: 800,
            wallClockMs: 5000,
            budget: {
              tokenBudget: null,
              turnBudget: null,
              wallClockBudgetMs: null,
              remainingTokens: null,
              remainingTurns: null,
              remainingWallClockMs: null,
              tokenBudgetReached: false,
              turnBudgetReached: false,
              wallClockBudgetReached: false,
              overBudget: false,
            },
          },
        }),
        is_error: false,
      },
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Checked goal');
    expect(out).toContain('Goal active: Ship feature X');
    expect(out).not.toContain('Used GetGoal');
    expect(out).not.toContain('"objective"');
  });

  it('renders SetGoalBudget with a readable budget argument', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_goal_budget',
        name: 'SetGoalBudget',
        args: { value: 10, unit: 'turns' },
      },
      {
        tool_call_id: 'call_goal_budget',
        output: 'Goal budget set: 10 turns.',
        is_error: false,
      },
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Set goal budget (10 turns)');
    expect(out).not.toContain('Set goal budget (10 turns) · 10 turns');
    expect(out).not.toContain('Used SetGoalBudget (turns)');
    expect(out).not.toContain('Goal budget set: 10 turns.');
  });

  it('renders successful SetGoalBudget headers with the primary goal marker', () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      const component = new ToolCallComponent(
        {
          id: 'call_goal_budget',
          name: 'SetGoalBudget',
          args: { value: 10, unit: 'turns' },
        },
        {
          tool_call_id: 'call_goal_budget',
          output: 'Goal budget set: 10 turns.',
          is_error: false,
        },
      );

      const out = component.render(100).join('\n');
      expect(out).toContain(chalk.hex(darkColors.primary)(STATUS_BULLET));
      expect(out).not.toContain(chalk.hex(darkColors.success)(STATUS_BULLET));
    } finally {
      chalk.level = previousLevel;
    }
  });

  it('renders UpdateGoal as a model-reported status, not a user lifecycle marker', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_update_goal',
        name: 'UpdateGoal',
        args: { status: 'blocked' },
      },
      {
        tool_call_id: 'call_update_goal',
        output: 'Goal marked blocked.',
        is_error: false,
      },
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Reported goal blocked');
    expect(out).not.toContain('Updated goal (blocked)');
    expect(out).not.toContain('· blocked');
    expect(out).not.toContain('Goal marked blocked.');
    expect(out).not.toContain('● Goal blocked');
  });

  it('renders successful UpdateGoal report headers entirely in the primary goal color', () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      for (const status of ['complete', 'blocked']) {
        const component = new ToolCallComponent(
          {
            id: `call_update_goal_${status}`,
            name: 'UpdateGoal',
            args: { status },
          },
          {
            tool_call_id: `call_update_goal_${status}`,
            output: `Goal marked ${status}.`,
            is_error: false,
          },
        );

        const out = component.render(100).join('\n');
        expect(out).toContain(chalk.hex(darkColors.primary)(STATUS_BULLET));
        expect(out).not.toContain(chalk.hex(darkColors.success)(STATUS_BULLET));
      }
    } finally {
      chalk.level = previousLevel;
    }
  });

  it('appends a chip to the header once a result arrives', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_read',
        name: 'Read',
        args: { path: 'foo.ts' },
      },
      {
        tool_call_id: 'call_read',
        output: '1\tfoo\n2\tbar\n3\tbaz',
        is_error: false,
      },
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Used Read');
    expect(out).toContain('· 3 lines');
  });

  it('truncates a long file path from the head so the filename stays visible', () => {
    const longPath =
      'apps/nori-code/src/tui/components/messages/tool-renderers/long-path/example/final-file.ts';
    const component = new ToolCallComponent(
      {
        id: 'call_long_path',
        name: 'Read',
        args: { path: longPath },
      },
      undefined,
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('final-file.ts');
    expect(out).toContain('…');
    expect(out).not.toContain('apps/nori-code/src/tui/components/messages/tool-renderers/long-pa…');
  });

  it('shows Read paths relative to the active workspace', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_workspace_read',
        name: 'Read',
        args: { path: '/tmp/proj-a/apps/nori-code/src/main.ts' },
      },
      {
        tool_call_id: 'call_workspace_read',
        output: '1\tcontent',
        is_error: false,
      },
      undefined,
      '/tmp/proj-a',
    );

    const out = strip(component.render(100).join('\n'));
    const expectedReadPath =
      process.platform === 'win32' ? 'apps\\nori-code\\src\\main.ts' : 'apps/nori-code/src/main.ts';
    expect(out).toContain(`Used Read (${expectedReadPath})`);
    expect(out).not.toContain('/tmp/proj-a/apps');
    expect(component.getReadSnapshot().filePath).toBe(expectedReadPath);
  });

  it('keeps Read paths outside the active workspace absolute', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_external_read',
        name: 'Read',
        args: { path: '/tmp/proj-ab/src/main.ts' },
      },
      undefined,
      undefined,
      '/tmp/proj-a',
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Using Read (/tmp/proj-ab/src/main.ts)');
    expect(component.getReadSnapshot().filePath).toBe('/tmp/proj-ab/src/main.ts');
  });

  it('does not append a chip while a tool is still running', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_pending',
        name: 'Read',
        args: { path: 'foo.ts' },
      },
      undefined,
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Using Read');
    expect(out).not.toContain('lines');
  });

  it('scrolls the Write streaming preview to the last COMMAND_PREVIEW_LINES', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) lines.push(`line${String(i)}`);
    const escaped = lines.join('\\n');
    const component = new ToolCallComponent(
      {
        id: 'call_write_stream',
        name: 'Write',
        args: { file_path: 'foo.ts', content: lines.join('\n') },
        streamingArguments: `{"file_path":"foo.ts","content":"${escaped}`,
      },
      undefined,
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Using Write');
    // Streaming preview caps at COMMAND_PREVIEW_LINES (10) and shows the tail.
    expect(out).not.toContain('line1');
    expect(out).not.toContain('line20');
    expect(out).toContain('line21');
    expect(out).toContain('line30');
    // Line numbers should reflect actual file positions.
    expect(out).toContain('  21');
    expect(out).toContain('  30');
    expect(out).not.toContain('ctrl+o to expand');
  });

  it('switches a streaming tool call to Truncated when the step ended with max_tokens', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 10; i++) lines.push(`line${String(i)}`);
    const escaped = lines.join('\\n');
    const component = new ToolCallComponent(
      {
        id: 'call_write_truncated',
        name: 'Write',
        args: { file_path: 'foo.ts', content: lines.join('\n') },
        streamingArguments: `{"file_path":"foo.ts","content":"${escaped}`,
        truncated: true,
      },
      undefined,
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Truncated Write');
    expect(out).not.toContain('Preparing Write');
    expect(out).toContain('Tool call arguments truncated by max_tokens');
    // The live argument preview must NOT render once the call is
    // truncated — leaving the half-streamed Write content on screen
    // was the original "preparing write" bug.
    expect(out).not.toContain('line1');
    expect(out).not.toContain('line10');
  });

  it('renders a stable Edit progress placeholder during the streaming delta window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(4000);
    const newLines: string[] = [];
    for (let i = 1; i <= 20; i++) {
      newLines.push(`new${String(i)}`);
    }
    const newEscaped = newLines.join('\\n');
    const streaming = `{"file_path":"foo.ts","expected_tag":"A1B2","line_ops":[{"op":"swap","start":1,"end":20,"content":"${newEscaped}`;
    const component = new ToolCallComponent(
      {
        id: 'call_edit_stream',
        name: 'Edit',
        args: {
          file_path: 'foo.ts',
          expected_tag: 'A1B2',
          line_ops: [{ op: 'swap', start: 1, end: 20, content: newLines.join('\n') }],
        },
        streamingArguments: streaming,
        streamingStartedAtMs: 0,
      },
      undefined,
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('Using Edit');
    expect(out).toContain('foo.ts');
    expect(out).toContain('Preparing changes for foo.ts...');
    expect(out).toContain('4s elapsed');
    expect(out).toMatch(/\d+(?:\.\d+)? (?:B|KB|MB)/);
    expect(out).not.toContain('new20');
    expect(out).not.toMatch(/^\s*\d+\s+[+-]\s/m);
    expect(out).not.toContain('ctrl+o to expand');
  });

  it('caps the Write preview between finalized args and result to keep transcript height stable', () => {
    // The wire sequence is: tool.call.delta → ... → tool.call (final
    // args, no streamingArguments) → tool.result. Between tool.call and
    // tool.result we briefly sit with finalized args and no result yet —
    // even without an approval panel, at least one render tick can land
    // in this state. The preview must stay capped so the transcript
    // height does not balloon and then snap back when the result lands;
    // a big shrink triggers pi-tui's full-redraw path which wipes the
    // terminal scrollback (history before TUI start).
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) lines.push(`line${String(i)}`);
    const component = new ToolCallComponent(
      {
        id: 'call_write_pending',
        name: 'Write',
        args: { file_path: 'foo.ts', content: lines.join('\n') },
        // No streamingArguments → finalized args; no result yet.
      },
      undefined,
    );
    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('line1');
    expect(out).toContain('line10');
    expect(out).not.toContain('line11');
    expect(out).not.toContain('line25');
    expect(out).toContain('ctrl+o to expand');
  });

  it('snaps a long Write preview to the collapsed cap when the result arrives', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) lines.push(`line${String(i)}`);
    const escaped = lines.join('\\n');
    const component = new ToolCallComponent(
      {
        id: 'call_write_snap',
        name: 'Write',
        args: { file_path: 'big.txt', content: lines.join('\n') },
        streamingArguments: `{"file_path":"big.txt","content":"${escaped}"}`,
      },
      undefined,
    );
    expect(strip(component.render(100).join('\n'))).toContain('line25');

    component.setResult({
      tool_call_id: 'call_write_snap',
      output: 'Wrote big.txt',
      is_error: false,
    });

    const after = strip(component.render(100).join('\n'));
    expect(after).toContain('line1');
    expect(after).not.toContain('line25');
    expect(after).toContain('ctrl+o to expand');
  });

  it('refreshes the header when file_path arrives in a later streaming delta', () => {
    // First delta: only an opening brace, no file_path yet.
    const component = new ToolCallComponent(
      {
        id: 'call_write_path',
        name: 'Write',
        args: {},
        streamingArguments: '{',
      },
      undefined,
    );
    const before = strip(component.render(100).join('\n'));
    expect(before).toContain('Using Write');
    expect(before).not.toContain('foo.ts');

    // Later delta: file_path is now parseable from streamingArguments.
    component.updateToolCall({
      id: 'call_write_path',
      name: 'Write',
      args: { file_path: 'foo.ts' },
      streamingArguments: '{"file_path":"foo.ts","content":"hello',
    });
    const after = strip(component.render(100).join('\n'));
    expect(after).toContain('foo.ts');
  });

  it('builds the call preview when finalized args arrive after streaming', () => {
    // Mimic the wire sequence: tool.call.delta → ... → tool.call (finalized).
    const component = new ToolCallComponent(
      {
        id: 'call_write_seq',
        name: 'Write',
        args: { file_path: 'foo.ts', content: 'a\nb' },
        streamingArguments: '{"file_path":"foo.ts","content":"a\\nb',
      },
      undefined,
    );
    // While streaming, body is rendered live from streamingArguments.
    expect(strip(component.render(100).join('\n'))).toMatch(/^\s*1\s+a\s*$/m);

    // Finalized tool.call: streamingArguments is undefined; the body
    // re-renders from finalized args, content unchanged.
    component.updateToolCall({
      id: 'call_write_seq',
      name: 'Write',
      args: { file_path: 'foo.ts', content: 'a\nb' },
    });
    const out = strip(component.render(100).join('\n'));
    expect(out).toMatch(/^\s*1\s+a\s*$/m);
    expect(out).toMatch(/^\s*2\s+b\s*$/m);
  });

  it('builds the Edit line-operation preview when finalized args arrive after streaming', () => {
    const component = new ToolCallComponent(
      {
        id: 'call_edit_seq',
        name: 'Edit',
        args: { file_path: 'foo.ts' },
        streamingArguments: '{"file_path":"foo.ts","expected_tag":"A1B2","line_ops":[{"op":"swap","start":2,"end":2,"content":"B',
        streamingStartedAtMs: Date.now(),
      },
      undefined,
    );
    expect(strip(component.render(100).join('\n'))).toContain('Preparing changes');
    expect(strip(component.render(100).join('\n'))).not.toMatch(/^\s*\d+\s+[+-]\s/m);

    component.updateToolCall({
      id: 'call_edit_seq',
      name: 'Edit',
      args: {
        file_path: 'foo.ts',
        expected_tag: 'A1B2',
        line_ops: [{ op: 'swap', start: 2, end: 2, content: 'B' }],
      },
    });
    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('foo.ts');
    expect(out).toContain('replace lines 2-2');
    expect(out).toMatch(/^\s*\+ B\s*$/m);
  });

  it('refreshes and stops the Edit streaming progress timer', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ui = { requestRender: vi.fn() };
    const component = new ToolCallComponent(
      {
        id: 'call_edit_timer',
        name: 'Edit',
        args: { file_path: 'foo.ts' },
        streamingArguments: '{"file_path":"foo.ts","expected_tag":"A1B2","line_ops":[{"op":"swap","start":1,"end":1,"content":"a',
        streamingStartedAtMs: 0,
      },
      undefined,
      ui as never,
    );

    expect(strip(component.render(100).join('\n'))).toContain('0s elapsed');
    vi.advanceTimersByTime(1000);
    expect(ui.requestRender).toHaveBeenCalled();
    expect(strip(component.render(100).join('\n'))).toContain('1s elapsed');

    ui.requestRender.mockClear();
    component.setResult({
      tool_call_id: 'call_edit_timer',
      output: 'Replaced 1 occurrence in foo.ts',
      is_error: false,
    });
    vi.advanceTimersByTime(1000);
    expect(ui.requestRender).not.toHaveBeenCalled();

    const componentToDispose = new ToolCallComponent(
      {
        id: 'call_edit_dispose',
        name: 'Edit',
        args: { file_path: 'bar.ts' },
        streamingArguments: '{"file_path":"bar.ts","expected_tag":"A1B2","line_ops":[{"op":"swap","start":1,"end":1,"content":"a',
        streamingStartedAtMs: 0,
      },
      undefined,
      ui as never,
    );
    ui.requestRender.mockClear();
    componentToDispose.dispose();
    vi.advanceTimersByTime(1000);
    expect(ui.requestRender).not.toHaveBeenCalled();
  });

  it('expands the Write call preview when ctrl+o expansion is set', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) lines.push(`line${String(i)}`);
    const component = new ToolCallComponent(
      {
        id: 'call_write_done',
        name: 'Write',
        args: { file_path: 'big.txt', content: lines.join('\n') },
      },
      {
        tool_call_id: 'call_write_done',
        output: 'Wrote big.txt',
        is_error: false,
      },
    );

    const collapsed = strip(component.render(100).join('\n'));
    expect(collapsed).toContain('line1');
    expect(collapsed).toContain('line10');
    expect(collapsed).not.toContain('line25');
    expect(collapsed).toContain('ctrl+o to expand');

    component.setExpanded(true);

    const expanded = strip(component.render(100).join('\n'));
    expect(expanded).toContain('line25');
    expect(expanded).toContain('line30');
    expect(expanded).not.toContain('ctrl+o to expand');
  });

  it('renders unknown Write file extensions as plain text without stderr noise', () => {
    const stderr = captureProcessWrite('stderr');
    try {
      const component = new ToolCallComponent(
        {
          id: 'call_write_unknown_ext',
          name: 'Write',
          args: { file_path: 'demo.abcxyz', content: 'hello\nworld' },
        },
        {
          tool_call_id: 'call_write_unknown_ext',
          output: 'Wrote demo.abcxyz',
          is_error: false,
        },
      );

      const collapsed = strip(component.render(100).join('\n'));
      expect(collapsed).toContain('hello');

      component.setExpanded(true);
      const expanded = strip(component.render(100).join('\n'));
      expect(expanded).toContain('world');
      expect(stderr.text()).not.toContain('Could not find the language');
    } finally {
      stderr.restore();
    }
  });
});
