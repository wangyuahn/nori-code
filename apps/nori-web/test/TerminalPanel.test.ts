import { describe, expect, it, vi } from 'vitest';
import {
  isSuccessfulTerminalAttachAck,
  shouldAutoFocusTerminal,
} from '../src/components/TerminalPanel';

vi.mock('@xterm/xterm', () => ({ Terminal: vi.fn() }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn() }));

describe('TerminalPanel focus handling', () => {
  it('only treats the matching successful attach acknowledgement as attached', () => {
    expect(isSuccessfulTerminalAttachAck({ type: 'ack', id: 'terminal-attach-1', code: 0 }, 'terminal-attach-1')).toBe(true);
    expect(isSuccessfulTerminalAttachAck({ type: 'ack', id: 'terminal-resize-2', code: 0 }, 'terminal-attach-1')).toBe(false);
    expect(isSuccessfulTerminalAttachAck({ type: 'ack', id: 'terminal-attach-1', code: 500 }, 'terminal-attach-1')).toBe(false);
  });

  it('does not reclaim focus after the user moves to the chat input', () => {
    const terminalHost = document.createElement('div');
    const terminalInput = document.createElement('textarea');
    const chatInput = document.createElement('textarea');
    terminalHost.append(terminalInput);
    document.body.append(terminalHost, chatInput);

    terminalInput.focus();
    const focusOwnerAtOpen = document.activeElement;
    expect(shouldAutoFocusTerminal(terminalHost, focusOwnerAtOpen)).toBe(true);

    chatInput.focus();
    expect(shouldAutoFocusTerminal(terminalHost, focusOwnerAtOpen)).toBe(false);

    terminalHost.remove();
    chatInput.remove();
  });
});
