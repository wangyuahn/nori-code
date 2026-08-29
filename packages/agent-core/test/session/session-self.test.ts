import { describe, expect, it } from 'vitest';

import {
  formatMountChangeNotice,
  formatSessionSelf,
} from '../../src/session/session-self';
import {
  canCreateMountedDepartment,
  departmentDepth,
  mountedChildrenOf,
  sessionMountDepth,
} from '../../src/session/team-tree';

describe('session-self', () => {
  it('formats identity without looking like a transcript summary', () => {
    const block = formatSessionSelf({
      sessionId: 'sess_a',
      title: 'Alpha',
      parentSessionId: 'sess_root',
      parentTitle: 'Root',
      role: 'reviewer',
      mandate: 'Review diffs',
      depth: 1,
      position: 'member',
      directChildren: [
        { sessionId: 'sess_b', title: 'Beta', role: 'impl' },
      ],
    });
    expect(block).toContain('<session_self>');
    expect(block).toContain('Parent: sess_root (Root)');
    expect(block).toContain('Role: reviewer');
    expect(block).toContain('sess_b');
    expect(block).not.toContain('summary');
  });

  it('describes mount changes for each recipient role', () => {
    const notice = formatMountChangeNotice(
      {
        session_id: 'sess_a',
        old_parent_session_id: 'sess_old',
        new_parent_session_id: 'sess_new',
        role: 'owner',
        reason: 'remount',
      },
      'old_parent',
    );
    expect(notice).toContain('<session_mount_changed>');
    expect(notice).toContain('previous parent');
    expect(notice).toContain('not a transcript summary');
  });
});

describe('session mount tree helpers', () => {
  const parentById = {
    root: undefined,
    mid: 'root',
    leaf: 'mid',
    other: undefined,
  };

  it('counts mount depth and children', () => {
    expect(sessionMountDepth(parentById, 'root')).toBe(0);
    expect(sessionMountDepth(parentById, 'mid')).toBe(1);
    expect(sessionMountDepth(parentById, 'leaf')).toBe(2);
    expect(mountedChildrenOf(parentById, 'root')).toEqual(['mid']);
    expect(canCreateMountedDepartment(parentById, 'mid', 2)).toBe(true);
    expect(canCreateMountedDepartment(parentById, 'leaf', 2)).toBe(false);
  });

  it('prefers mount depth when a session id is supplied', () => {
    expect(departmentDepth({
      agents: { main: {}, member: { kind: 'team', teamLeaderAgentId: 'main' } },
      agentId: 'member',
      parentById,
      sessionIdForAgent: 'leaf',
    })).toBe(2);
  });
});
