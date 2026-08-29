import { describe, expect, it, vi } from 'vitest';
import type { McpServerInfo } from '@nori-code/sdk';

import { McpStatusListComponent } from '#/tui/components/dialogs/mcp-status-list';
import { SELECT_POINTER } from '#/tui/constant/symbols';

const ANSI = /\u001B\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');
const ESC = String.fromCodePoint(27);

const servers: readonly McpServerInfo[] = [
  { name: 'local-tools', transport: 'stdio', status: 'connected', toolCount: 2 },
  {
    name: 'remote-tools',
    transport: 'http',
    status: 'failed',
    toolCount: 0,
    error: 'connection refused',
  },
  { name: 'linear', transport: 'http', status: 'needs-auth', toolCount: 0 },
  { name: 'disabled-tools', transport: 'stdio', status: 'disabled', toolCount: 0 },
];

function text(component: McpStatusListComponent, width = 100): string {
  return component.render(width).map(strip).join('\n');
}

describe('McpStatusListComponent', () => {
  it('renders name, status, transport, and tools', () => {
    const onCancel = vi.fn();
    const panel = new McpStatusListComponent({ servers, onCancel });
    const out = text(panel);
    expect(out).toContain('MCP');
    expect(out).toContain('↑↓ navigate');
    expect(out).toContain('Esc cancel');
    expect(out).toContain(SELECT_POINTER);
    expect(out).toContain('local-tools');
    expect(out).toContain('connected');
    expect(out).toContain('stdio · 2 tools');
    expect(out).toContain('failed');
    expect(out).toContain('error: connection refused');
    expect(out).toContain('run /mcp-config login remote-tools');
    expect(out).toContain('needs auth');
    expect(out).toContain('run /mcp-config login linear');
    expect(out).toContain('disabled');
  });

  it('shows an empty state with /mcp-config', () => {
    const panel = new McpStatusListComponent({ servers: [], onCancel: vi.fn() });
    const out = text(panel);
    expect(out).toContain('No MCP servers');
    expect(out).toContain('run /mcp-config');
  });

  it('cancels on Enter or Esc', () => {
    const onCancel = vi.fn();
    const panel = new McpStatusListComponent({ servers, onCancel });
    panel.handleInput('\r');
    panel.handleInput(ESC);
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
