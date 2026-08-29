/**
 * TeamBrowser — searchable department tree for `/team`.
 *
 * Lists main + hired partners + discussion transcripts. Enter opens the
 * selected member's session (or Discuss for a discussion node). Tab shows
 * the member card.
 */

import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  type Focusable,
} from '@nori-code/pi-tui';

import { CURRENT_MARK, SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { SearchableList } from '#/tui/utils/searchable-list';
import {
  flattenTeamTree,
  teamRowSecondaryParts,
  type TeamAgentSnapshot,
  type TeamSecondaryPart,
  type TeamTreeRow,
} from '#/tui/utils/team-tree';

export interface TeamBrowserOptions {
  /** Static snapshot. Prefer {@link getAgents} when the list can change live. */
  readonly agents?: readonly TeamAgentSnapshot[];
  /** Live reader so TeamDismiss / TeamCreate refresh without remounting. */
  readonly getAgents?: () => readonly TeamAgentSnapshot[];
  readonly toolsReadonly: boolean;
  readonly discussMode: boolean;
  readonly currentAgentId?: string;
  readonly onSelect: (agent: TeamAgentSnapshot) => void;
  readonly onDetails?: (agent: TeamAgentSnapshot) => void;
  readonly onCancel: () => void;
}

function rowSearchText(row: TeamTreeRow): string {
  const agent = row.agent;
  return `${agent.name} ${agent.role ?? ''} ${agent.assignedTask ?? ''} ${agent.agentId}`;
}

function agentsFingerprint(agents: readonly TeamAgentSnapshot[]): string {
  return agents
    .map((agent) => [
      agent.agentId,
      agent.kind,
      agent.name,
      agent.role ?? '',
      agent.status ?? '',
      agent.archived === true ? '1' : '0',
      agent.assignedTask ?? '',
      agent.reportStatus ?? '',
    ].join(':'))
    .join('|');
}

export class TeamBrowserComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: TeamBrowserOptions;
  private readonly list: SearchableList<TeamTreeRow>;
  private lastFingerprint = '';

  constructor(opts: TeamBrowserOptions) {
    super();
    this.opts = opts;
    const agents = this.readAgents();
    const rows = flattenTeamTree(agents);
    this.lastFingerprint = agentsFingerprint(agents);
    const currentIdx = rows.findIndex(
      (row) => row.agent.agentId === (opts.currentAgentId ?? 'main'),
    );
    this.list = new SearchableList({
      items: rows,
      toSearchText: rowSearchText,
      initialIndex: Math.max(currentIdx, 0),
      searchable: true,
    });
  }

  handleInput(data: string): void {
    this.syncFromLiveAgents();
    if (matchesKey(data, Key.escape)) {
      if (this.list.clearQuery()) return;
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.list.pageUp();
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.list.pageDown();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const chosen = this.list.selected();
      if (chosen !== undefined) this.opts.onSelect(chosen.agent);
      return;
    }
    if (matchesKey(data, Key.tab)) {
      const chosen = this.list.selected();
      if (chosen !== undefined) this.opts.onDetails?.(chosen.agent);
      return;
    }
    this.list.handleKey(data);
  }

  override render(width: number): string[] {
    this.syncFromLiveAgents();
    const agents = this.readAgents();
    const view = this.list.view();
    const titleSuffix =
      view.query.length === 0 ? currentTheme.fg('textMuted', '  (type to search)') : '';
    const hintParts = ['↑↓ navigate'];
    if (view.page.pageCount > 1) hintParts.push('←→ page');
    if (view.query.length > 0) hintParts.push('Backspace clear');
    hintParts.push('Enter open');
    if (this.opts.onDetails !== undefined) hintParts.push('Tab details');
    hintParts.push('Esc cancel');

    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ' Team') + titleSuffix,
      currentTheme.fg('textMuted', ` ${hintParts.join(' · ')}`),
      '',
    ];

    if (this.opts.toolsReadonly || this.opts.discussMode) {
      const notice = this.opts.discussMode
        ? 'Discuss is on — read-only team meeting until work is assigned.'
        : 'Main is read-only — hire partners with TeamCreate, then assign the work.';
      lines.push(truncateToWidth(currentTheme.fg('warning', ` ${notice}`), width));
      lines.push('');
    }

    if (view.query.length > 0) {
      lines.push(
        currentTheme.fg('primary', ' Search: ') + currentTheme.fg('text', view.query),
      );
    }

    const totalRows = flattenTeamTree(agents).length;
    if (view.items.length === 0) {
      const empty =
        totalRows === 0
          ? 'No team members yet. Ask Nori to hire with TeamCreate.'
          : 'No matches';
      lines.push(currentTheme.fg('textMuted', `   ${empty}`));
    } else {
      for (let i = view.page.start; i < view.page.end; i++) {
        const row = view.items[i];
        if (row === undefined) continue;
        lines.push(...this.renderRow(row, agents, width, i === view.selectedIndex));
      }
    }

    if (view.query.length > 0) {
      lines.push('');
      lines.push(
        currentTheme.fg('textMuted', ` ${String(view.items.length)} / ${String(totalRows)}`),
      );
    } else {
      const below = view.items.length - view.page.end;
      if (below > 0) {
        lines.push('');
        lines.push(currentTheme.fg('textMuted', ` ▼ ${String(below)} more`));
      }
    }

    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width));
  }

  private readAgents(): readonly TeamAgentSnapshot[] {
    return this.opts.getAgents?.() ?? this.opts.agents ?? [];
  }

  private syncFromLiveAgents(): void {
    if (this.opts.getAgents === undefined) return;
    const agents = this.readAgents();
    const fingerprint = agentsFingerprint(agents);
    if (fingerprint === this.lastFingerprint) return;
    this.lastFingerprint = fingerprint;
    this.list.replaceItems(
      flattenTeamTree(agents),
      (left, right) => left.agent.agentId === right.agent.agentId,
    );
  }

  private renderRow(
    row: TeamTreeRow,
    agents: readonly TeamAgentSnapshot[],
    width: number,
    selected: boolean,
  ): string[] {
    const indent = '  '.repeat(row.depth);
    const pointer = selected ? SELECT_POINTER : ' ';
    const name = row.agent.name;
    const isCurrent = row.agent.agentId === (this.opts.currentAgentId ?? 'main');
    const nameStyled = selected
      ? currentTheme.boldFg('primary', name)
      : currentTheme.fg('text', name);
    let line = currentTheme.fg(selected ? 'primary' : 'textDim', `  ${pointer} `);
    line += indent + nameStyled;
    const secondary = teamRowSecondaryParts(row.agent, agents);
    if (secondary.length > 0) {
      line += '  ' + renderSecondaryParts(secondary);
    }
    if (isCurrent) {
      line += ' ' + currentTheme.fg('success', CURRENT_MARK);
    }
    const lines = [truncateToWidth(line, width)];
    const role = row.agent.role ?? row.agent.assignedTask;
    if (role !== undefined && role.trim().length > 0) {
      lines.push(
        truncateToWidth(currentTheme.fg('textMuted', `     ${indent}${role}`), width),
      );
    }
    return lines;
  }
}

function renderSecondaryParts(parts: readonly TeamSecondaryPart[]): string {
  return parts
    .map((part, index) => {
      const text = index === 0 ? part.text : ` · ${part.text}`;
      switch (part.tone) {
        case 'success':
          return currentTheme.fg('success', text);
        case 'warning':
          return currentTheme.fg('warning', text);
        case 'error':
          return currentTheme.fg('error', text);
        default:
          return currentTheme.fg('textMuted', text);
      }
    })
    .join('');
}
