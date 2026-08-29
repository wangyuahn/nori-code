import { describe, expect, it } from 'vitest';

import {
  flattenSessionMapTree,
  parentSessionIdOf,
  sessionMapLabel,
} from '#/tui/utils/session-map-tree';

describe('session-map-tree', () => {
  it('reads parent_session_id from metadata', () => {
    expect(parentSessionIdOf({ parent_session_id: 'sess_p' })).toBe('sess_p');
    expect(parentSessionIdOf({})).toBeUndefined();
  });

  it('flattens a mount forest in depth-first order', () => {
    const root = {
      id: 'root',
      workDir: '/tmp',
      sessionDir: '/tmp/root',
      createdAt: 1,
      updatedAt: 3,
      metadata: {},
    };
    const child = {
      id: 'child',
      workDir: '/tmp',
      sessionDir: '/tmp/child',
      createdAt: 2,
      updatedAt: 2,
      metadata: { parent_session_id: 'root', mount_role: 'reviewer' },
    };
    const rows = flattenSessionMapTree({
      nodes: [child, root],
      edges: [{ childSessionId: 'child', parentSessionId: 'root' }],
    });
    expect(rows.map((row) => row.session.id)).toEqual(['root', 'child']);
    expect(rows[1]?.depth).toBe(1);
    expect(sessionMapLabel(root)).toBe('root');
  });
});
