import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findBuiltInSlashCommand, resolveSlashCommandAvailability } from '#/tui/commands/index';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { handleWebCommand, webSessionUrl } from '#/tui/commands/web';
import type { OpenUrlResult } from '#/utils/open-url';

const mocks = vi.hoisted(() => ({
  ensureDaemon: vi.fn(),
  tryResolveServerToken: vi.fn(),
  getDataDir: vi.fn(() => '/tmp/kimi-home'),
  openUrlAsync: vi.fn(async (): Promise<OpenUrlResult> => ({ ok: true })),
}));

vi.mock('#/cli/sub/server/daemon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/cli/sub/server/daemon')>();
  return { ...actual, ensureDaemon: mocks.ensureDaemon };
});

vi.mock('#/cli/sub/server/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/cli/sub/server/shared')>();
  return { ...actual, tryResolveServerToken: mocks.tryResolveServerToken };
});

vi.mock('#/utils/open-url', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/utils/open-url')>();
  return { ...actual, openUrlAsync: mocks.openUrlAsync };
});

vi.mock('#/utils/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/utils/paths')>();
  return { ...actual, getDataDir: mocks.getDataDir };
});

type MountedPanel = {
  handleInput: (data: string) => void;
  render: (width: number) => string[];
};

function makeHost() {
  let mountedPanel: MountedPanel | null = null;
  const host = {
    session: { id: 'ses-1' },
    showStatus: vi.fn(),
    showError: vi.fn(),
    mountEditorReplacement: vi.fn((panel: MountedPanel) => {
      mountedPanel = panel;
    }),
    restoreEditor: vi.fn(),
    setExitOpenUrl: vi.fn(),
    stop: vi.fn(async () => {}),
  } as unknown as SlashCommandHost & {
    showStatus: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
    mountEditorReplacement: ReturnType<typeof vi.fn>;
    restoreEditor: ReturnType<typeof vi.fn>;
    setExitOpenUrl: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  };
  return { host, getMountedPanel: () => mountedPanel };
}

describe('web slash command', () => {
  it('is registered as an always-available built-in', () => {
    const command = findBuiltInSlashCommand('web');
    expect(command).toBeDefined();
    expect(resolveSlashCommandAvailability(command!, '')).toBe('always');
  });
});

describe('handleWebCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDataDir.mockReturnValue('/tmp/kimi-home');
    mocks.openUrlAsync.mockResolvedValue({ ok: true });
    mocks.ensureDaemon.mockResolvedValue({
      origin: 'http://127.0.0.1:58627',
      reused: false,
      host: '127.0.0.1',
      port: 58627,
    });
  });

  it('shows the token in green and opens the deep link carrying the token fragment', async () => {
    mocks.tryResolveServerToken.mockReturnValue('tok-1');
    const { host, getMountedPanel } = makeHost();

    const pending = handleWebCommand(host);
    getMountedPanel()?.handleInput('\r');
    await pending;

    expect(host.showStatus).toHaveBeenCalledWith('Starting Nori server and opening web UI…');
    expect(host.showStatus).toHaveBeenCalledWith(
      'open http://127.0.0.1:58627/#token=tok-1&session=ses-1',
      'success',
    );
    expect(host.showStatus).toHaveBeenCalledWith('Token:    tok-1', 'success');
    expect(mocks.openUrlAsync).toHaveBeenCalledWith(
      'http://127.0.0.1:58627/#token=tok-1&session=ses-1',
    );
    expect(host.setExitOpenUrl).toHaveBeenCalledWith(
      'http://127.0.0.1:58627/#token=tok-1&session=ses-1',
    );
    expect(host.stop).toHaveBeenCalledOnce();
  });

  it('skips the token line and fragment when no token is available', async () => {
    mocks.tryResolveServerToken.mockReturnValue(undefined);
    const { host, getMountedPanel } = makeHost();

    const pending = handleWebCommand(host);
    getMountedPanel()?.handleInput('\r');
    await pending;

    expect(host.showStatus).toHaveBeenCalledWith('Starting Nori server and opening web UI…');
    expect(host.showStatus).toHaveBeenCalledWith(
      'open http://127.0.0.1:58627/#session=ses-1',
      'success',
    );
    expect(host.showStatus).not.toHaveBeenCalledWith(expect.stringContaining('Token:'), 'success');
    expect(host.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('No server token found'),
      'warning',
    );
    expect(mocks.openUrlAsync).toHaveBeenCalledWith('http://127.0.0.1:58627/#session=ses-1');
    expect(host.setExitOpenUrl).toHaveBeenCalledWith('http://127.0.0.1:58627/#session=ses-1');
    expect(host.stop).toHaveBeenCalledOnce();
  });

  it('keeps the TUI open when the desktop opener fails', async () => {
    mocks.tryResolveServerToken.mockReturnValue('tok-1');
    mocks.openUrlAsync.mockResolvedValueOnce({ ok: false, error: 'xdg-open: no DISPLAY' });
    const { host, getMountedPanel } = makeHost();

    const pending = handleWebCommand(host);
    getMountedPanel()?.handleInput('\r');
    await pending;

    expect(host.showError).toHaveBeenCalledWith(
      expect.stringContaining('Could not open a browser'),
    );
    expect(host.stop).not.toHaveBeenCalled();
    expect(host.setExitOpenUrl).not.toHaveBeenCalled();
  });

  it('does not start the daemon when the user cancels', async () => {
    const { host, getMountedPanel } = makeHost();
    const pending = handleWebCommand(host);
    getMountedPanel()?.handleInput(String.fromCodePoint(27));
    await pending;
    expect(mocks.ensureDaemon).not.toHaveBeenCalled();
    expect(mocks.openUrlAsync).not.toHaveBeenCalled();
    expect(host.stop).not.toHaveBeenCalled();
  });

  it('errors when there is no active session', async () => {
    const { host } = makeHost();
    (host as { session?: unknown }).session = undefined;
    await handleWebCommand(host);
    expect(host.showError).toHaveBeenCalled();
    expect(mocks.ensureDaemon).not.toHaveBeenCalled();
  });
});

describe('webSessionUrl', () => {
  it('deep-links to the session in the hash so Vite relative assets stay on /', () => {
    expect(webSessionUrl('http://127.0.0.1:58627', 'abc123')).toBe(
      'http://127.0.0.1:58627/#session=abc123',
    );
  });

  it('strips a trailing slash from the origin', () => {
    expect(webSessionUrl('http://127.0.0.1:58627/', 'abc123')).toBe(
      'http://127.0.0.1:58627/#session=abc123',
    );
  });

  it('encodes session ids so the web UI can decode them', () => {
    expect(webSessionUrl('http://127.0.0.1:58627', 'a/b c')).toBe(
      'http://127.0.0.1:58627/#session=a%2Fb+c',
    );
  });

  it('carries the bearer token in the fragment so the browser authenticates on load', () => {
    expect(webSessionUrl('http://127.0.0.1:58627', 'abc123', 'tok-1')).toBe(
      'http://127.0.0.1:58627/#token=tok-1&session=abc123',
    );
  });

  it('omits the token when none is available but still selects the session', () => {
    expect(webSessionUrl('http://127.0.0.1:58627', 'abc123', undefined)).toBe(
      'http://127.0.0.1:58627/#session=abc123',
    );
  });
});
