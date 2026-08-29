import { describe, expect, it } from 'vitest';

import { completeMountIdentityFromPrompt, parseMountIdentityJson } from '../src/components/mountIdentityComplete';
import {
  annotationBounds,
  emptySessionMapDoc,
  parseSessionMapDoc,
  sessionMatchesLabelFilter,
  toggleSessionLabel,
} from '../src/components/sessionMapDoc';

describe('completeMountIdentityFromPrompt', () => {
  it('fills from keyed lines', () => {
    expect(completeMountIdentityFromPrompt('title: Alice\nrole: reviewer\nmandate: Review auth PRs')).toEqual({
      title: 'Alice',
      role: 'reviewer',
      mandate: 'Review auth PRs',
    });
  });

  it('parses Chinese prose', () => {
    const filled = completeMountIdentityFromPrompt('作为 security engineer，负责审查认证相关变更');
    expect(filled.role).toMatch(/security engineer/i);
    expect(filled.mandate).toMatch(/审查认证/);
    expect(filled.title.length).toBeGreaterThan(0);
  });
});

describe('parseMountIdentityJson', () => {
  it('parses bare JSON and fenced replies', () => {
    expect(parseMountIdentityJson('{"title":"A","role":"r","mandate":"m"}')).toEqual({
      title: 'A',
      role: 'r',
      mandate: 'm',
    });
    expect(parseMountIdentityJson('Here:\n```json\n{"title":"B","role":"dev","mandate":"ship"}\n```')).toEqual({
      title: 'B',
      role: 'dev',
      mandate: 'ship',
    });
  });

  it('returns null for non-identity JSON', () => {
    expect(parseMountIdentityJson('not json')).toBeNull();
    expect(parseMountIdentityJson('{"ok":true}')).toBeNull();
  });
});

describe('sessionMapDoc', () => {
  it('parses empty / corrupt storage as empty doc', () => {
    expect(parseSessionMapDoc(null)).toEqual(emptySessionMapDoc());
    expect(parseSessionMapDoc('{')).toEqual(emptySessionMapDoc());
  });

  it('computes note bounds from soft-bound nodes and keeps empty rect', () => {
    const withNodes = annotationBounds(
      { id: 'a', title: 'Group', color: '#3b82f6', nodeIds: ['x', 'y'] },
      [
        { session: { id: 'x' }, x: 40, y: 40 },
        { session: { id: 'y' }, x: 280, y: 40 },
      ],
      { width: 200, height: 72 },
    );
    expect(withNodes.width).toBeGreaterThan(200);
    expect(withNodes.x).toBeLessThan(40);

    const empty = annotationBounds(
      {
        id: 'b',
        title: '',
        color: '#22c55e',
        nodeIds: [],
        rect: { x: 10, y: 20, width: 100, height: 80 },
      },
      [],
      { width: 200, height: 72 },
    );
    expect(empty).toEqual({ x: 10, y: 20, width: 100, height: 80 });
  });

  it('doc schema helpers for labels (Map page does not surface labels UI)', () => {
    const doc = toggleSessionLabel(
      {
        ...emptySessionMapDoc(),
        labels: [{ id: 'l1', name: 'hot', color: '#ef4444' }],
      },
      's1',
      'l1',
    );
    expect(sessionMatchesLabelFilter('s1', doc.sessionLabels, [])).toBe(true);
    expect(sessionMatchesLabelFilter('s1', doc.sessionLabels, ['l1'])).toBe(true);
    expect(sessionMatchesLabelFilter('s2', doc.sessionLabels, ['l1'])).toBe(false);
  });
});
