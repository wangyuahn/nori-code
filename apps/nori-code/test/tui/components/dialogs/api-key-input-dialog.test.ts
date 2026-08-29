import { visibleWidth } from '@nori-code/pi-tui';
import { describe, expect, it } from 'vitest';

import { ApiKeyInputDialogComponent } from '#/tui/components/dialogs/api-key-input-dialog';

describe('ApiKeyInputDialogComponent', () => {
  it('keeps every line within narrow widths', () => {
    const dialog = new ApiKeyInputDialogComponent(
      'Kimi Code',
      ['Paste your API key below.', 'It will be stored locally.'],
      () => {},
    );
    dialog.focused = true;

    for (const width of [39, 20, 10]) {
      for (const line of dialog.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('masks the typed key with one bullet per character and does not clear on re-render', () => {
    const dialog = new ApiKeyInputDialogComponent('OpenRouter', ['Paste your API key below.'], () => {});
    dialog.focused = true;
    const key = 'sk-test-123';
    for (const ch of key) dialog.handleInput(ch);
    const first = dialog.render(60).join('\n');
    expect(first.replaceAll(/\u001B\[[0-9;]*m/g, '')).toContain('•'.repeat(key.length));
    expect(first).not.toContain(key);
    const second = dialog.render(60).join('\n');
    expect(second.replaceAll(/\u001B\[[0-9;]*m/g, '')).toContain('•'.repeat(key.length));
  });
});
