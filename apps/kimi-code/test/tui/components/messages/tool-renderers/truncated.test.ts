import { visibleWidth } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'vitest';

import { TruncatedOutputComponent } from '#/tui/components/messages/tool-renderers/truncated';


function strip(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, '');
}

const ESC = '\u001B';

describe('TruncatedOutputComponent', () => {
  it('indents content and the truncation hint by the configured amount', () => {
    const component = new TruncatedOutputComponent(['a', 'b', 'c', 'd', 'e'].join('\n'), {
      expanded: false,
      isError: false,
      maxLines: 2,
      indent: 6,
    });

    const lines = strip(component.render(80).join('\n')).split('\n');
    expect(lines[0]?.startsWith('      a')).toBe(true);
    expect(lines[1]?.startsWith('      b')).toBe(true);
    expect(lines[2]).toBe('      ... (3 more lines, ctrl+o to expand)');
  });

  it('defaults to a two-space indent for both content and hint', () => {
    const component = new TruncatedOutputComponent('x\ny\nz', {
      expanded: false,
      isError: false,
      maxLines: 1,
    });

    const lines = strip(component.render(80).join('\n')).split('\n');
    expect(lines[0]?.startsWith('  x')).toBe(true);
    expect(lines[1]).toBe('  ... (2 more lines, ctrl+o to expand)');
  });

  it('omits the ctrl+o promise when expandHint is false', () => {
    const component = new TruncatedOutputComponent('a\nb\nc\nd', {
      expanded: false,
      isError: false,
      maxLines: 2,
      indent: 4,
      expandHint: false,
    });

    const lines = strip(component.render(80).join('\n')).split('\n');
    expect(lines[2]).toBe('    ... (2 more lines)');
  });

  it('renders all lines without a hint when expanded', () => {
    const component = new TruncatedOutputComponent('a\nb\nc\nd', {
      expanded: true,
      isError: false,
      maxLines: 2,
      indent: 4,
    });

    const out = strip(component.render(80).join('\n'));
    expect(out).toContain('d');
    expect(out).not.toContain('more lines, ctrl+o');
  });

  it('keeps the truncation footer within the requested render width', () => {
    const output = Array.from({ length: 20 }, (_, i) => `line ${String(i)}`).join('\n');
    const component = new TruncatedOutputComponent(output, {
      expanded: false,
      isError: false,
      maxLines: 3,
      indent: 2,
    });

    for (const line of component.render(37)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(37);
    }
  });

  it('strips terminal control sequences before rendering tool output', () => {
    const component = new TruncatedOutputComponent(
      `before${ESC}[2J${ESC}[?1049h${ESC}]0;title\u0007after`,
      {
        expanded: true,
        isError: false,
      },
    );

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('beforeafter');
    expect(out).not.toContain(`${ESC}[2J`);
    expect(out).not.toContain(`${ESC}[?1049h`);
    expect(out).not.toContain(`${ESC}]0;title`);
  });
});
