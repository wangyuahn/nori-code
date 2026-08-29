import { describe, expect, it } from 'vitest';

import { DiscussUtteranceComponent } from '#/tui/components/messages/discuss-utterance';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('DiscussUtteranceComponent', () => {
  it('renders the speaker name, speaking tag, and body', () => {
    const component = new DiscussUtteranceComponent('Reviewer', true);
    component.updateContent('The footer should drop tips first.');
    const out = strip(component.render(80).join('\n'));
    expect(out).toContain('Reviewer');
    expect(out).toContain('speaking');
    expect(out).toContain('The footer should drop tips first.');
  });

  it('drops the speaking tag when finalized', () => {
    const component = new DiscussUtteranceComponent('Reviewer', true);
    component.updateContent('Done.', { speaking: false });
    const out = strip(component.render(80).join('\n'));
    expect(out).toContain('Reviewer');
    expect(out).toContain('Done.');
    expect(out).not.toContain('speaking');
  });

  it('truncates to the terminal width', () => {
    const component = new DiscussUtteranceComponent('Reviewer', true);
    component.updateContent('a'.repeat(80));
    for (const line of component.render(24)) {
      expect(strip(line).length).toBeLessThanOrEqual(24);
    }
  });

  it('does not participate in ctrl+o tool-output collapse', () => {
    const component = new DiscussUtteranceComponent('Reviewer', true);
    component.updateContent('Visible without expanding tools.');
    expect('setExpanded' in component).toBe(false);
    expect(strip(component.render(80).join('\n'))).toContain('Visible without expanding tools.');
  });
});
