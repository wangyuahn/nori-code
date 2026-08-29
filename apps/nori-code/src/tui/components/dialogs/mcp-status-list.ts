/**
 * MCP server status list for `/mcp`.
 *
 * Read-only: Enter and Esc both cancel. Login still goes through `/mcp-config`.
 */

import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@nori-code/pi-tui';
import type { McpServerInfo } from '@nori-code/sdk';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import {
  formatMcpErrorLine,
  formatMcpToolCount,
  mcpStatusLabel,
  paintMcpStatus,
} from '#/tui/components/messages/mcp-status-panel';
import { currentTheme } from '#/tui/theme';
import { SearchableList } from '#/tui/utils/searchable-list';

export interface McpStatusListOptions {
  readonly servers: readonly McpServerInfo[];
  readonly onCancel: () => void;
}

function serverSearchText(server: McpServerInfo): string {
  return `${server.name} ${server.status} ${server.transport}`;
}

function mcpLoginHint(name: string): string {
  return `run /mcp-config login ${name}`;
}

export class McpStatusListComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: McpStatusListOptions;
  private readonly list: SearchableList<McpServerInfo>;

  constructor(opts: McpStatusListOptions) {
    super();
    this.opts = opts;
    this.list = new SearchableList({
      items: opts.servers,
      toSearchText: serverSearchText,
      searchable: false,
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
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
    this.list.handleKey(data);
  }

  override render(width: number): string[] {
    const view = this.list.view();
    const hintParts = ['↑↓ navigate'];
    if (view.page.pageCount > 1) hintParts.push('←→ page');
    hintParts.push('Esc cancel');

    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ' MCP'),
      currentTheme.fg('textMuted', ` ${hintParts.join(' · ')}`),
      '',
    ];

    if (this.opts.servers.length === 0) {
      lines.push(currentTheme.fg('textMuted', '   No MCP servers'));
      lines.push(currentTheme.fg('textMuted', '   run /mcp-config'));
      lines.push(currentTheme.fg('primary', '─'.repeat(width)));
      return lines.map((line) => truncateToWidth(line, width));
    }

    const nameCap = Math.max(8, Math.floor(width * 0.4));
    let nameWidth = 0;
    for (let i = view.page.start; i < view.page.end; i++) {
      const server = view.items[i];
      if (server !== undefined) nameWidth = Math.max(nameWidth, visibleWidth(server.name));
    }
    nameWidth = Math.min(nameWidth, nameCap);

    for (let i = view.page.start; i < view.page.end; i++) {
      const server = view.items[i];
      if (server === undefined) continue;
      const isSelected = i === view.selectedIndex;
      const pointer = isSelected ? SELECT_POINTER : ' ';
      const truncatedName = truncateToWidth(server.name, nameWidth, '…');
      const namePad = ' '.repeat(Math.max(0, nameWidth - visibleWidth(truncatedName)));
      const status = mcpStatusLabel(server.status);
      const meta = `${server.transport} · ${formatMcpToolCount(server)}`;
      let line = currentTheme.fg(isSelected ? 'primary' : 'textDim', `  ${pointer} `);
      line +=
        (isSelected ? currentTheme.boldFg('primary', truncatedName) : currentTheme.fg('text', truncatedName)) +
        namePad;
      line += '  ' + paintMcpStatus(server.status, status);
      line += '  ' + currentTheme.fg('textMuted', meta);
      lines.push(truncateToWidth(line, width));

      if (server.status === 'failed' && server.error !== undefined && server.error.trim().length > 0) {
        lines.push(
          truncateToWidth(
            currentTheme.fg('textMuted', `      error: ${formatMcpErrorLine(server.error)}`),
            width,
          ),
        );
      }
      if (server.status === 'failed' || server.status === 'needs-auth') {
        lines.push(truncateToWidth(currentTheme.fg('textMuted', `      ${mcpLoginHint(server.name)}`), width));
      }
    }

    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width));
  }
}
