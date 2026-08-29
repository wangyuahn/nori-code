/**
 * TeamMemberDetail — read-only member card opened from `/team`.
 *
 * Enter on the team list mounts this dialog; Esc returns to the list.
 */

import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  type Focusable,
} from '@nori-code/pi-tui';

import { currentTheme } from '#/tui/theme';
import { formatTeamAgentDetails, type TeamAgentSnapshot } from '#/tui/utils/team-tree';

export interface TeamMemberDetailOptions {
  readonly agent: TeamAgentSnapshot;
  readonly agents: readonly TeamAgentSnapshot[];
  readonly recentSpeech?: readonly string[];
  readonly onCancel: () => void;
  readonly maxVisible?: number;
}

export class TeamMemberDetailComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: TeamMemberDetailOptions;
  private scrollTop = 0;

  constructor(opts: TeamMemberDetailOptions) {
    super();
    this.opts = opts;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.scrollTop = Math.max(0, this.scrollTop - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.scrollTop += 1;
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollTop = Math.max(0, this.scrollTop - 10);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollTop += 10;
    }
  }

  override render(width: number): string[] {
    const body = formatTeamAgentDetails(
      this.opts.agent,
      this.opts.agents,
      this.opts.recentSpeech ?? [],
    );
    const bodyLines = body.split('\n').map((line) => ` ${line}`);
    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ` ${this.opts.agent.name}`),
      currentTheme.fg('textMuted', ' ↑↓ scroll · Esc cancel'),
      '',
      ...bodyLines.map((line) => currentTheme.fg('text', line)),
      currentTheme.fg('primary', '─'.repeat(width)),
    ];

    const content = lines.slice(1, lines.length - 1);
    const maxVisible = Math.max(5, this.opts.maxVisible ?? 24);
    if (content.length > maxVisible) {
      this.scrollTop = Math.max(0, Math.min(this.scrollTop, content.length - maxVisible));
      const slice = content.slice(this.scrollTop, this.scrollTop + maxVisible);
      return [lines[0] ?? '', ...slice, lines.at(-1) ?? ''].map((line) =>
        truncateToWidth(line, width),
      );
    }
    this.scrollTop = 0;
    return lines.map((line) => truncateToWidth(line, width));
  }
}
