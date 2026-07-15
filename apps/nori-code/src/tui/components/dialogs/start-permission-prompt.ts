import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
} from '@nori-code/pi-tui';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';

export type StartPermissionChoice = 'auto' | 'yolo' | 'manual' | 'cancel';

export interface StartPermissionOption<TChoice extends StartPermissionChoice = StartPermissionChoice> {
  readonly value: TChoice;
  readonly label: string;
  readonly description: string;
}

export interface StartPermissionPromptOptions<
  TChoice extends StartPermissionChoice = StartPermissionChoice,
> {
  readonly title: string;
  readonly noticeLines: readonly string[];
  readonly options: readonly StartPermissionOption<TChoice>[];
  readonly onSelect: (choice: TChoice) => void;
  readonly onCancel: () => void;
}

// ---------------------------------------------------------------------------
// Pre-built option sets for goal / swarm permission prompts
// ---------------------------------------------------------------------------

export const GOAL_MANUAL_OPTIONS: readonly StartPermissionOption[] = [
  {
    value: 'auto',
    label: 'Switch to Auto and start',
    description:
      'Best if you want Nori Code to keep working while you are away. Tools are approved automatically, and questions are skipped.',
  },
  {
    value: 'yolo',
    label: 'Switch to YOLO and start',
    description:
      'Tools and plan changes are approved automatically. Nori Code may still ask you questions.',
  },
  {
    value: 'manual',
    label: 'Start in Manual',
    description:
      'Keep approvals on. Nori Code will ask before risky actions, so the goal may stop and wait for you.',
  },
  {
    value: 'cancel',
    label: 'Do not start',
    description: 'Return to the input box with your goal command.',
  },
];

export const GOAL_YOLO_OPTIONS: readonly StartPermissionOption[] = [
  {
    value: 'auto',
    label: 'Switch to Auto and start',
    description:
      'Best if you want Nori Code to keep working while you are away. Tools are approved automatically, and questions are skipped.',
  },
  {
    value: 'yolo',
    label: 'Keep YOLO and start',
    description:
      'Tools and plan changes stay approved automatically. Nori Code may still ask you questions.',
  },
  {
    value: 'cancel',
    label: 'Do not start',
    description: 'Return to the input box with your goal command.',
  },
];

export function goalStartOptions(mode: 'manual' | 'yolo'): readonly StartPermissionOption[] {
  return mode === 'yolo' ? GOAL_YOLO_OPTIONS : GOAL_MANUAL_OPTIONS;
}

export const SWARM_OPTIONS: readonly StartPermissionOption[] = [
  {
    value: 'auto',
    label: 'Switch to Auto and start',
    description:
      'Best for swarm tasks. Tools are approved automatically, and questions are skipped.',
  },
  {
    value: 'yolo',
    label: 'Switch to YOLO and start',
    description:
      'Tools and plan changes are approved automatically. Nori Code may still ask you questions.',
  },
  {
    value: 'manual',
    label: 'Start in Manual',
    description:
      'Keep approvals on. Nori Code may stop and wait for you during the swarm task.',
  },
];

export const GOAL_MANUAL_NOTICE = [
  'Manual mode asks you before Nori Code runs commands, edits files, or takes other risky actions.',
  'Manual mode is not suitable for unattended goal work.',
  'You can go back without losing your command.',
] as const;

export const GOAL_YOLO_NOTICE = [
  'YOLO mode approves tools and plan changes automatically.',
  'YOLO mode can still stop for questions.',
  'Switch to Auto if you want questions skipped during goal work.',
] as const;

export const SWARM_NOTICE = [
  'Manual mode asks you before Nori Code runs commands, edits files, or takes other risky actions.',
  'Manual mode can block swarm work while agents are running.',
  'You can go back without losing your command.',
] as const;

export class StartPermissionPromptComponent<TChoice extends StartPermissionChoice = StartPermissionChoice>
  implements Component, Focusable
{
  focused = false;
  private selectedIndex = 0;

  constructor(private readonly opts: StartPermissionPromptOptions<TChoice>) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(this.opts.options.length - 1, this.selectedIndex + 1);
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
      this.opts.onSelect(this.opts.options[this.selectedIndex]!.value);
    }
  }

  render(width: number): string[] {
    const rule = currentTheme.fg('primary', '─'.repeat(width));
    const lines = [
      rule,
      currentTheme.boldFg('primary', ` ${this.opts.title}`),
      currentTheme.fg('textMuted', ' ↑↓ navigate · Enter select · Esc cancel'),
      '',
    ];

    const textWidth = Math.max(20, width - 2);
    for (const paragraph of this.opts.noticeLines) {
      for (const line of wrapPlain(paragraph, textWidth)) {
        lines.push(` ${styleModeNames(line, 'textMuted')}`);
      }
      lines.push('');
    }

    for (let i = 0; i < this.opts.options.length; i += 1) {
      const option = this.opts.options[i]!;
      const selected = i === this.selectedIndex;
      const pointer = selected ? SELECT_POINTER : ' ';
      lines.push(
        currentTheme.fg(selected ? 'primary' : 'textDim', `  ${pointer} `) +
          styleLabel(option.label, selected),
      );
      for (const line of wrapPlain(option.description, Math.max(20, width - 4))) {
        lines.push(`    ${styleModeNames(line, 'textMuted')}`);
      }
      lines.push('');
    }

    lines.push(rule);
    return lines.map((line) => truncateToWidth(line, width));
  }
}

function styleLabel(label: string, selected: boolean): string {
  if (selected) return currentTheme.boldFg('primary', label);
  return styleModeNames(label, 'text');
}

function styleModeNames(text: string, baseToken: 'text' | 'textMuted'): string {
  return text
    .split(/(\b(?:Manual|Auto|YOLO)\b)/g)
    .map((part) => {
      if (part === 'Manual' || part === 'Auto' || part === 'YOLO') return currentTheme.boldFg('textStrong', part);
      return currentTheme.fg(baseToken, part);
    })
    .join('');
}

function wrapPlain(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (visibleWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (current.length > 0) lines.push(current);
    current = visibleWidth(word) <= width ? word : truncateToWidth(word, width, '…');
  }
  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [''];
}
