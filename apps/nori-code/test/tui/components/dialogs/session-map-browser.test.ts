import { describe, expect, it, vi } from 'vitest';

import { SessionMapBrowserComponent } from '#/tui/components/dialogs/session-map-browser';
import { CURRENT_MARK, SELECT_POINTER } from '#/tui/constant/symbols';

const ANSI = /\u001B\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');

const root = {
  id: 'sess_root',
  title: 'Main',
  workDir: '/tmp',
  sessionDir: '/tmp/root',
  createdAt: 1,
  updatedAt: 3,
  metadata: {},
};
const child = {
  id: 'sess_child',
  title: 'Reviewer',
  workDir: '/tmp',
  sessionDir: '/tmp/child',
  createdAt: 2,
  updatedAt: 2,
  metadata: { parent_session_id: 'sess_root', mount_role: 'review' },
};

function text(component: { render(width: number): string[] }, width = 80): string {
  return component.render(width).map(strip).join('\n');
}

describe('SessionMapBrowserComponent', () => {
  it('renders the mount forest with hints', () => {
    const picker = new SessionMapBrowserComponent({
      nodes: [root, child],
      edges: [{ childSessionId: 'sess_child', parentSessionId: 'sess_root' }],
      currentSessionId: 'sess_root',
      onOpen: vi.fn(),
      onMount: vi.fn(),
      onUnmount: vi.fn(),
      onCancel: vi.fn(),
    });
    const out = text(picker);
    expect(out).toContain('Conversation map');
    expect(out).toContain('M mount');
    expect(out).toContain('U unmount');
    expect(out).toContain(SELECT_POINTER);
    expect(out).toContain('Main');
    expect(out).toContain('Reviewer');
    expect(out).toContain(CURRENT_MARK);
    expect(out).toContain('review');
  });

  it('calls onUnmount for a mounted session', () => {
    const onUnmount = vi.fn();
    const picker = new SessionMapBrowserComponent({
      nodes: [root, child],
      edges: [{ childSessionId: 'sess_child', parentSessionId: 'sess_root' }],
      onOpen: vi.fn(),
      onMount: vi.fn(),
      onUnmount,
      onCancel: vi.fn(),
    });
    picker.handleInput('\u001b[B');
    picker.handleInput('u');
    expect(onUnmount).toHaveBeenCalledWith(child);
  });
});
