/**
 * SessionMapBrowser — searchable mount forest for `/map`.
 *
 * Enter opens the session. M starts a mount (member then parent). U unmounts.
 */

import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  type Focusable,
} from '@nori-code/pi-tui';

import type { SessionSummary } from '@nori-code/sdk';

import { CURRENT_MARK, SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { SearchableList } from '#/tui/utils/searchable-list';
import { printableChar } from '#/tui/utils/printable-key';
import {
  flattenSessionMapTree,
  mountMandateOf,
  mountRoleOf,
  parentSessionIdOf,
  sessionMapLabel,
  type SessionMapRow,
} from '#/tui/utils/session-map-tree';

export interface SessionMapBrowserOptions {
  readonly nodes: readonly SessionSummary[];
  readonly edges: ReadonlyArray<{ readonly childSessionId: string; readonly parentSessionId: string }>;
  readonly currentSessionId?: string;
  readonly onOpen: (session: SessionSummary) => void;
  readonly onMount: (child: SessionSummary, parent: SessionSummary) => void;
  readonly onUnmount: (session: SessionSummary) => void;
  readonly onCancel: () => void;
}

function rowSearchText(row: SessionMapRow): string {
  const session = row.session;
  const meta = session.metadata as Record<string, unknown> | undefined;
  return [
    sessionMapLabel(session),
    session.id,
    session.lastPrompt ?? '',
    mountRoleOf(session) ?? '',
    mountMandateOf(session) ?? '',
    parentSessionIdOf(meta) ?? '',
  ].join(' ');
}

export class SessionMapBrowserComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: SessionMapBrowserOptions;
  private readonly list: SearchableList<SessionMapRow>;
  private mountChild: SessionSummary | undefined;

  constructor(opts: SessionMapBrowserOptions) {
    super();
    this.opts = opts;
    const rows = flattenSessionMapTree({ nodes: opts.nodes, edges: opts.edges });
    const currentIdx = rows.findIndex((row) => row.session.id === opts.currentSessionId);
    this.list = new SearchableList({
      items: rows,
      toSearchText: rowSearchText,
      initialIndex: Math.max(currentIdx, 0),
      searchable: true,
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.mountChild !== undefined) {
        this.mountChild = undefined;
        return;
      }
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
      if (chosen === undefined) return;
      if (this.mountChild !== undefined) {
        if (this.mountChild.id === chosen.session.id) {
          this.mountChild = undefined;
          return;
        }
        this.opts.onMount(this.mountChild, chosen.session);
        this.mountChild = undefined;
        return;
      }
      this.opts.onOpen(chosen.session);
      return;
    }
    if (matchesKey(data, Key.ctrl('m'))) {
      const chosen = this.list.selected();
      if (chosen === undefined) return;
      this.mountChild = chosen.session;
      return;
    }
    const ch = printableChar(data);
    if (ch === 'm' || ch === 'M') {
      const chosen = this.list.selected();
      if (chosen === undefined) return;
      this.mountChild = chosen.session;
      return;
    }
    if (matchesKey(data, Key.ctrl('u'))) {
      const chosen = this.list.selected();
      if (chosen === undefined) return;
      if (chosen.parentSessionId !== undefined) {
        this.opts.onUnmount(chosen.session);
      }
      return;
    }
    if (ch === 'u' || ch === 'U') {
      const chosen = this.list.selected();
      if (chosen === undefined) return;
      if (chosen.parentSessionId !== undefined) {
        this.opts.onUnmount(chosen.session);
      }
      return;
    }
    this.list.handleKey(data);
  }

  override render(width: number): string[] {
    const view = this.list.view();
    const titleSuffix =
      view.query.length === 0 ? currentTheme.fg('textMuted', '  (type to search)') : '';
    const hintParts = ['↑↓ navigate'];
    if (view.page.pageCount > 1) hintParts.push('←→ page');
    if (view.query.length > 0) hintParts.push('Backspace clear');
    hintParts.push('Enter open');
    hintParts.push('M mount');
    hintParts.push('U unmount');
    hintParts.push('Esc cancel');

    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ' Conversation map') + titleSuffix,
      currentTheme.fg('textMuted', ` ${hintParts.join(' · ')}`),
      '',
    ];

    if (this.mountChild !== undefined) {
      lines.push(
        truncateToWidth(
          currentTheme.fg(
            'warning',
            ` Mount member: ${sessionMapLabel(this.mountChild)} — pick parent, Enter confirm`,
          ),
          width,
        ),
      );
      lines.push('');
    }

    if (view.query.length > 0) {
      lines.push(
        currentTheme.fg('primary', ' Search: ') + currentTheme.fg('text', view.query),
      );
    }

    if (view.items.length === 0) {
      lines.push(currentTheme.fg('textMuted', '  No sessions in this workspace.'));
    } else {
      for (let i = view.page.start; i < view.page.end; i++) {
        const row = view.items[i];
        if (row === undefined) continue;
        const selected = i === view.selectedIndex;
        const current = row.session.id === this.opts.currentSessionId;
        const mountMark =
          this.mountChild?.id === row.session.id
            ? currentTheme.fg('warning', ' [member]')
            : '';
        const indent = '  '.repeat(row.depth);
        const name = sessionMapLabel(row.session);
        const role = mountRoleOf(row.session);
        const secondary = role ?? (row.parentSessionId !== undefined ? 'mounted' : 'top-level');
        const pointer = selected ? currentTheme.fg('primary', SELECT_POINTER) : '  ';
        const nameStyled = selected
          ? currentTheme.boldFg('primary', `${indent}${name}`)
          : currentTheme.fg('text', `${indent}${name}`);
        const secondaryStyled = currentTheme.fg('textMuted', secondary);
        const currentMark = current ? currentTheme.fg('success', CURRENT_MARK) : '';
        const line =
          pointer
          + nameStyled
          + mountMark
          + '  '
          + secondaryStyled
          + currentMark;
        lines.push(truncateToWidth(line, width));
      }
    }

    lines.push('');
    if (view.query.length > 0) {
      lines.push(
        currentTheme.fg('textMuted', ` ${String(view.items.length)} / ${String(this.opts.nodes.length)}`),
      );
    } else {
      const below = view.items.length - view.page.end;
      if (below > 0) {
        lines.push(currentTheme.fg('textMuted', ` ▼ ${String(below)} more`));
      }
    }
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines;
  }
}
