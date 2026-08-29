import { describe, expect, it, vi } from 'vitest';
import type { SkillSummary } from '@nori-code/sdk';

import { SkillsSelectorComponent, type SkillPickerItem } from '#/tui/components/dialogs/skills-selector';
import { SELECT_POINTER } from '#/tui/constant/symbols';

const ANSI = /\u001B\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');
const ESC = String.fromCodePoint(27);

function skill(
  name: string,
  extra: Partial<SkillSummary> & { slashName?: string } = {},
): SkillPickerItem {
  const { slashName, ...rest } = extra;
  return {
    slashName: slashName ?? name,
    skill: {
      name,
      description: `${name} skill`,
      path: `/skills/${name}/SKILL.md`,
      source: 'project',
      ...rest,
    },
  };
}

function text(component: SkillsSelectorComponent, width = 100): string {
  return component.render(width).map(strip).join('\n');
}

describe('SkillsSelectorComponent', () => {
  it('renders a searchable list of skills', () => {
    const onSelect = vi.fn();
    const panel = new SkillsSelectorComponent({
      items: [skill('mcp-config', { source: 'builtin', slashName: 'mcp-config' }), skill('review', { slashName: 'skill:review' })],
      onSelect,
      onCancel: vi.fn(),
    });
    const out = text(panel);
    expect(out).toContain('Skills');
    expect(out).toContain('(type to search)');
    expect(out).toContain('↑↓ navigate');
    expect(out).toContain('Enter select');
    expect(out).toContain('Esc cancel');
    expect(out).toContain(SELECT_POINTER);
    expect(out).toContain('mcp-config');
    expect(out).toContain('skill:review');
  });

  it('shows No skills when the catalog is empty', () => {
    const panel = new SkillsSelectorComponent({
      items: [],
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    expect(text(panel)).toContain('No skills');
  });

  it('shows No matches when the query filters everything', () => {
    const panel = new SkillsSelectorComponent({
      items: [skill('review')],
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    panel.handleInput('z');
    expect(text(panel)).toContain('No matches');
    expect(text(panel)).toContain('Search: z');
  });

  it('selects on Enter and cancels on Esc after clearing search', () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const panel = new SkillsSelectorComponent({
      items: [skill('review', { slashName: 'skill:review' })],
      onSelect,
      onCancel,
    });
    panel.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ slashName: 'skill:review' }),
    );
    panel.handleInput('r');
    panel.handleInput(ESC);
    expect(onCancel).not.toHaveBeenCalled();
    panel.handleInput(ESC);
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
