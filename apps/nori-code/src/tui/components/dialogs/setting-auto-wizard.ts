/**
 * SettingAutoWizardComponent — multi-step guided setup for /setting auto.
 *
 * Walks the user through 6 sequential steps:
 *   1. Permission mode (yolo / auto / manual)
 *   2. Model selection
 *   3. Swarm depth
 *   4. Coder write permission
 *   5. Plan mode
 *   6. Notification toggle
 *
 * Each step shows a title, description, and a list of choices. Enter
 * selects, Esc goes back one step (or cancels on step 1).
 */

import {
  Container,
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@nori-code/pi-tui';
import type { PermissionMode } from '@nori-code/sdk';
import { currentTheme } from '#/tui/theme';
import { SELECT_POINTER, CURRENT_MARK } from '#/tui/constant/symbols';
import type { AppState } from '../../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WizardAnswers {
  permission: PermissionMode;
  model: string;
  swarmDepth: number;
  coderWrite: boolean;
  planMode: boolean;
  notifications: boolean;
}

interface StepOption {
  value: string;
  label: string;
  description?: string;
}

interface WizardStepDef {
  key: keyof WizardAnswers;
  title: string;
  description: string;
  options: StepOption[];
  currentValue: string;
}

export interface SettingAutoWizardOptions {
  readonly appState: AppState;
  readonly onComplete: (answers: WizardAnswers) => void;
  readonly onCancel: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PERMISSION_OPTIONS: StepOption[] = [
  {
    value: 'yolo',
    label: 'YOLO',
    description: 'Automatically approve all tool actions. Agent can still ask explicit questions. Best for experienced users who want maximum speed.',
  },
  {
    value: 'auto',
    label: 'Auto',
    description: 'Run fully non-interactively. Tools auto-approved, agent questions skipped. The agent decides everything on its own. Recommended for confident delegation.',
  },
  {
    value: 'manual',
    label: 'Manual',
    description: 'Ask before commands, edits, and risky actions. Read/search tools run directly. Best for careful review of every change.',
  },
];

const SWARM_DEPTH_OPTIONS: StepOption[] = [
  { value: '1', label: '1', description: 'No nesting — sub-agents cannot spawn their own sub-agents. Safest, fastest.' },
  { value: '2', label: '2', description: 'One level of nesting. Sub-agents can delegate one level deeper. Good balance.' },
  { value: '3', label: '3', description: 'Two levels of nesting. Suitable for complex multi-file refactors.' },
  { value: '4', label: '4', description: 'Three levels of nesting. For deeply layered tasks.' },
  { value: '5', label: '5', description: 'Maximum depth. Full recursive delegation. Use for the most complex projects.' },
];

const ON_OFF_OPTIONS: StepOption[] = [
  { value: 'on', label: 'On', description: 'Enabled.' },
  { value: 'off', label: 'Off', description: 'Disabled.' },
];

const TOTAL_STEPS = 6;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrapDescription(text: string, width: number): string[] {
  const maxWidth = Math.max(1, width);
  const words = text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (visibleWidth(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current.length > 0) lines.push(current);
    current = visibleWidth(word) <= maxWidth ? word : truncateToWidth(word, maxWidth, '…');
  }

  if (current.length > 0) lines.push(current);
  return lines;
}

function buildModelOptions(appState: AppState): StepOption[] {
  const entries = Object.entries(appState.availableModels);
  if (entries.length === 0) {
    return [{ value: '__none__', label: '(no models available)', description: 'Run /provider to add a model.' }];
  }
  return entries.map(([alias]) => ({
    value: alias,
    label: alias,
  }));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export class SettingAutoWizardComponent extends Container implements Focusable {
  focused = false;
  private stepIndex = 0;
  private selectedIdx = 0;
  private readonly answers: Partial<WizardAnswers> = {};
  private readonly steps: WizardStepDef[];

  constructor(private readonly opts: SettingAutoWizardOptions) {
    super();
    const { appState } = opts;

    const modelOptions = buildModelOptions(appState);

    this.steps = [
      {
        key: 'permission',
        title: 'Permission Mode',
        description:
          'How should tool actions (Write, Edit, Bash) be approved?\n\n' +
          '• YOLO — All tools auto-approved. Agent can still ask you questions.\n' +
          '• Auto  — Fully non-interactive. No questions, all tools auto-approved.\n' +
          '• Manual — Ask before every risky action. Maximum control.',
        options: PERMISSION_OPTIONS,
        currentValue: appState.permissionMode,
      },
      {
        key: 'model',
        title: 'Model',
        description:
          'Which AI model should Nori use for reasoning and coordination?\n\n' +
          'Choose the model that best fits your task complexity and budget.',
        options: modelOptions,
        currentValue: appState.model || '',
      },
      {
        key: 'swarmDepth',
        title: 'Swarm Depth',
        description:
          'How many levels of recursive sub-agent nesting are allowed?\n\n' +
          '• Depth 1 — No nesting. Sub-agents cannot spawn more sub-agents.\n' +
          '• Depth 2–3 — Good for typical multi-file work.\n' +
          '• Depth 4–5 — For very complex, deeply-layered projects.\n\n' +
          'Recommended: 2 for most use cases.',
        options: SWARM_DEPTH_OPTIONS,
        currentValue: String(appState.maxSwarmDepth),
      },
      {
        key: 'coderWrite',
        title: 'Coder Write Permission',
        description:
          'Can the nori-coder sub-agent directly write files and run commands?\n\n' +
          '• On  — Coder can use Write/Edit/Bash directly. Faster, less back-and-forth.\n' +
          '• Off — Coder is read-only and must delegate writes via swarm.\n\n' +
          'Recommended: On for most projects.',
        options: ON_OFF_OPTIONS,
        currentValue: appState.coderWriteEnabled ? 'on' : 'off',
      },
      {
        key: 'planMode',
        title: 'Plan Mode',
        description:
          'Should Nori create a structured plan before implementing changes?\n\n' +
          '• On  — Nori writes a plan file first, then implements. Better for complex tasks.\n' +
          '• Off — Nori acts directly without pre-planning. Faster for simple tasks.\n\n' +
          'Recommended: On for multi-step work, Off for quick fixes.',
        options: ON_OFF_OPTIONS,
        currentValue: appState.planMode ? 'on' : 'off',
      },
      {
        key: 'notifications',
        title: 'Notifications',
        description:
          'Should Nori send desktop notifications when tasks complete?\n\n' +
          '• On  — Get notified when long-running tasks finish.\n' +
          '• Off — No notifications. Check manually.\n\n' +
          'Recommended: On, especially for longer swarms.',
        options: ON_OFF_OPTIONS,
        currentValue: appState.notifications.enabled ? 'on' : 'off',
      },
    ];

    // Set initial selected index to match current value
    const firstStep = this.steps[0]!;
    const currIdx = firstStep.options.findIndex((o) => o.value === firstStep.currentValue);
    if (currIdx >= 0) this.selectedIdx = currIdx;
  }

  // -----------------------------------------------------------------------
  // Input handling
  // -----------------------------------------------------------------------

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.stepIndex === 0) {
        this.opts.onCancel();
      } else {
        this.stepIndex--;
        this.syncSelectedToCurrent();
      }
      return;
    }

    if (matchesKey(data, Key.up) || matchesKey(data, Key.left)) {
      const step = this.steps[this.stepIndex]!;
      this.selectedIdx = (this.selectedIdx - 1 + step.options.length) % step.options.length;
      return;
    }

    if (matchesKey(data, Key.down) || matchesKey(data, Key.right)) {
      const step = this.steps[this.stepIndex]!;
      this.selectedIdx = (this.selectedIdx + 1) % step.options.length;
      return;
    }

    if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
      const step = this.steps[this.stepIndex]!;
      const chosen = step.options[this.selectedIdx];
      if (chosen === undefined) return;

      this.recordAnswer(step.key, chosen.value);

      if (this.stepIndex >= TOTAL_STEPS - 1) {
        // All steps done — complete
        this.opts.onComplete(this.answers as WizardAnswers);
      } else {
        this.stepIndex++;
        this.syncSelectedToCurrent();
      }
      return;
    }
  }

  private recordAnswer(key: keyof WizardAnswers, value: string): void {
    switch (key) {
      case 'permission':
        this.answers.permission = value as PermissionMode;
        break;
      case 'model':
        this.answers.model = value;
        break;
      case 'swarmDepth':
        this.answers.swarmDepth = Number(value);
        break;
      case 'coderWrite':
        this.answers.coderWrite = value === 'on';
        break;
      case 'planMode':
        this.answers.planMode = value === 'on';
        break;
      case 'notifications':
        this.answers.notifications = value === 'on';
        break;
    }
  }

  private syncSelectedToCurrent(): void {
    const step = this.steps[this.stepIndex]!;
    const idx = step.options.findIndex((o) => o.value === step.currentValue);
    this.selectedIdx = idx >= 0 ? idx : 0;
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  override render(width: number): string[] {
    const step = this.steps[this.stepIndex]!;
    const lines: string[] = [];

    // Top border
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));

    // Title with step counter
    const titleText = ` Step ${this.stepIndex + 1}/${TOTAL_STEPS}: ${step.title}`;
    lines.push(currentTheme.boldFg('primary', titleText));

    // Progress bar
    const barWidth = Math.min(width - 2, 40);
    const filled = Math.round((barWidth * (this.stepIndex + 1)) / TOTAL_STEPS);
    const empty = barWidth - filled;
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    lines.push(currentTheme.fg('primary', ` ${bar}`));

    lines.push('');

    // Description — multi-line
    const descWidth = Math.max(1, width - 2);
    for (const descLine of step.description.split('\n')) {
      for (const wrapped of wrapDescription(descLine, descWidth)) {
        lines.push(currentTheme.fg('text', ` ${wrapped}`));
      }
    }

    lines.push('');

    // Navigation hint
    const backHint = this.stepIndex > 0 ? 'Esc back · ' : 'Esc cancel · ';
    lines.push(currentTheme.fg('textMuted', ` ${backHint}↑↓ choose · Enter select`));

    lines.push('');

    // Options
    for (let i = 0; i < step.options.length; i++) {
      const opt = step.options[i]!;
      const isSelected = i === this.selectedIdx;
      const isCurrent = opt.value === step.currentValue;
      const pointer = isSelected ? SELECT_POINTER : ' ';

      let line = currentTheme.fg(isSelected ? 'primary' : 'textDim', `  ${pointer} `);
      line += isSelected
        ? currentTheme.boldFg('primary', opt.label)
        : currentTheme.fg('text', opt.label);

      if (isCurrent) {
        line += ' ' + currentTheme.fg('success', CURRENT_MARK);
      }

      lines.push(line);

      if (opt.description !== undefined && opt.description.length > 0) {
        const optDescWidth = Math.max(1, width - 4);
        for (const descLine of wrapDescription(opt.description, optDescWidth)) {
          lines.push(currentTheme.fg('textMuted', `    ${descLine}`));
        }
      }
    }

    lines.push('');
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));

    return lines.map((line) => truncateToWidth(line, width));
  }
}
