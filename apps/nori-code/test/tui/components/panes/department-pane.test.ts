import { describe, expect, it } from 'vitest';

import { DepartmentPaneComponent } from '#/tui/components/panes/department-pane';

const ANSI = /\u001B\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');

function text(component: DepartmentPaneComponent, width = 80): string {
  return component.render(width).map(strip).join('\n');
}

describe('DepartmentPaneComponent', () => {
  it('renders Discuss meeting speech with a hide hint', () => {
    const pane = new DepartmentPaneComponent(
      {
        mode: 'discuss',
        topic: 'Footer layout',
        lines: [
          { id: '1', speakerName: 'Reviewer', text: 'Drop the tips first.', speaking: true },
        ],
        emptyHint: 'No statements in this round yet.',
      },
      { terminalRows: () => 24, canUseScrollKeys: () => true },
    );
    const out = text(pane);
    expect(out).toContain('Discuss');
    expect(out).toContain('Ctrl-Y hide');
    expect(out).toContain('Esc hide');
    expect(out).toContain('Topic: Footer layout');
    expect(out).toContain('Reviewer');
    expect(out).toContain('speaking');
    expect(out).toContain('Drop the tips first.');
  });

  it('renders Chat messages when Discuss is off', () => {
    const pane = new DepartmentPaneComponent(
      {
        mode: 'chat',
        lines: [{ id: 'c1', speakerName: 'Coder', text: 'I will take the footer.', meta: '@all' }],
        emptyHint: 'No messages yet.',
      },
      { terminalRows: () => 24, canUseScrollKeys: () => false },
    );
    const out = text(pane);
    expect(out).toContain('Chat');
    expect(out).toContain('Coder');
    expect(out).toContain('I will take the footer.');
    expect(out).toContain('@all');
    expect(out).not.toContain('Discuss');
  });

  it('shows the empty hint when there are no lines', () => {
    const pane = new DepartmentPaneComponent(
      {
        mode: 'discuss',
        lines: [],
        emptyHint: 'No statements in this round yet.',
      },
      { terminalRows: () => 24, canUseScrollKeys: () => false },
    );
    expect(text(pane)).toContain('No statements in this round yet.');
  });
});
