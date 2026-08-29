export interface ToolbarTip {
  readonly text: string;
  /**
   * Long/important tips render on their own. They never pair with a
   * neighbour and never appear as the second half of someone else's pair.
   */
  readonly solo?: boolean;
  /**
   * Rotation weight: a higher value makes the tip recur more often. Defaults
   * to 1. Used to give newer/important features more airtime.
   */
  readonly priority?: number;
}

/**
 * Subset of toolbar tips shown behind the composing spinner.
 */
export const WORKING_TIPS: readonly ToolbarTip[] = [
  { text: 'ctrl-s to add guidance without waiting for the turn to finish', priority: 2, solo: true },
  { text: '/tasks to check progress and status for background tasks', priority: 2 },
  { text: '/init: generate AGENTS.md', priority: 2 },
  { text: 'Try /dance for a hidden Easter egg' },
  { text: '/plugins: manage plugins — try the "superpowers" plugin', solo: true, priority: 3 },
  {
    text: '/plugins: manage installed plugins and discover new capabilities',
    solo: true,
    priority: 3,
  },
  { text: 'ask Nori to schedule tasks, e.g. "remind me at 5pm"', solo: true, priority: 3 },
  { text: '/sessions to browse and resume earlier sessions', solo: true },
  { text: '/goal for multi-step work with a clear finish line', priority: 2, solo: true  },
  { text: '/goal next to queue follow-up work while the current goal keeps running', solo: true },
  { text: '/web to open the current session in the Web UI', solo: true },
  { text: '/team to open a partner session, or Ctrl-Y for Discuss / Chat', priority: 2 },
  { text: '/map to browse session mounts and open partner sessions', priority: 2 },
  { text: '@: mention files', priority: 2 },
  { text: '! to run a shell command', priority: 2 },
];

export const ALL_TIPS: readonly ToolbarTip[] = [
  ...WORKING_TIPS,
  { text: 'shift+enter: newline' },
  { text: 'ctrl+c: cancel' },
  { text: '/theme to switch the terminal UI theme' },
  { text: '/permission to choose how tool actions are approved' },
  { text: '/settings to open TUI settings' },
  { text: '/help: show commands' },
  { text: '/compact compresses context when it gets long', priority: 2 },
  { text: 'ctrl-o to hide or reveal tool output switching between a clean chat view and full execution details', priority: 2 },
  { text: 'shift-tab to Discuss for a read-only team meeting before Nori edits files.', priority: 2 },
  { text: '/model: switch model', priority: 2 },
];
