import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import type { Session } from '../src/api/client';
import { departmentAgentsFromSessions } from '../src/App';
import { SessionTeamBar } from '../src/components/SessionTeamBar';
import { I18nProvider } from '../src/i18n';
import { sessionsForSidebar } from '../src/utils/session-mount';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mounted: Root | null = null;

afterEach(() => {
  if (mounted !== null) {
    act(() => { mounted?.unmount(); });
    mounted = null;
  }
  document.body.replaceChildren();
});

const lead: Session = {
  id: 'sess_lead', title: 'Lead', status: 'idle',
  created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z',
  metadata: { cwd: '/work/demo' },
};
const reviewer: Session = {
  id: 'sess_reviewer', title: 'Reviewer', status: 'running',
  created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-03T00:00:00.000Z',
  metadata: { parent_session_id: 'sess_lead', mount_name: 'Reviewer', mount_role: 'reviewer' },
};
const writer: Session = {
  id: 'sess_writer', title: 'Writer', status: 'idle',
  created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-04T00:00:00.000Z',
  metadata: { parent_session_id: 'sess_lead', mount_name: 'Writer', mount_role: 'writer' },
};
const unrelated: Session = {
  id: 'sess_other', title: 'Other', status: 'idle',
  created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-05T00:00:00.000Z',
  metadata: { parent_session_id: 'sess_unrelated', mount_name: 'Outsider' },
};

async function renderBar(session: Session, sessions: Session[], onSelect: (id: string | null) => void) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted = root;
  const members = departmentAgentsFromSessions(sessions, session);
  await act(async () => {
    root.render(createElement(I18nProvider, null, createElement(SessionTeamBar, {
      session,
      members,
      activeAgentId: 'main',
      onSelectAgent: agent => onSelect(agent?.agent_id ?? null),
      onOpenTeam: () => undefined,
    })));
  });
  return container;
}

async function openMenu() {
  const summary = document.querySelector('summary');
  await act(async () => { summary?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

describe('SessionTeamBar', () => {
  it('shows only the current conversation members in the trigger and menu', async () => {
    const container = await renderBar(lead, [lead, reviewer, writer, unrelated], () => undefined);
    expect(container.querySelectorAll('.session-team-avatars .session-team-avatar')).toHaveLength(2);
    expect(container.querySelector('.session-agent-tree-trigger-context')?.textContent).toBe('2');

    await openMenu();

    const names = [...document.querySelectorAll('.session-team-member-copy strong')].map(n => n.textContent);
    expect(names).toContain('Reviewer');
    expect(names).toContain('Writer');
    expect(names).not.toContain('Outsider');
  });

  it('selects the clicked member and closes the menu', async () => {
    const selected: Array<string | null> = [];
    await renderBar(lead, [lead, reviewer], id => selected.push(id));
    await openMenu();

    const target = [...document.querySelectorAll<HTMLButtonElement>('.session-team-member')]
      .find(button => button.textContent?.includes('Reviewer'));
    await act(async () => { target?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(selected).toEqual(['sess_reviewer']);
    expect(document.querySelector('.session-team-menu')).toBeNull();
  });

  it('returns to the main conversation from the menu', async () => {
    const selected: Array<string | null> = [];
    await renderBar(lead, [lead, reviewer], id => selected.push(id));
    await openMenu();

    const main = [...document.querySelectorAll<HTMLButtonElement>('.session-team-member')]
      .find(button => button.textContent?.includes('Main conversation'));
    await act(async () => { main?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(selected).toEqual([null]);
  });

  it('explains the empty state instead of listing phantom members', async () => {
    const container = await renderBar(lead, [lead, unrelated], () => undefined);
    expect(container.querySelector('.session-agent-tree-trigger-context')?.textContent).toBe('0');
    await openMenu();
    expect(document.querySelector('.session-team-empty')).not.toBeNull();
    // 没有团队时只给引导文案，不列成员项，主对话入口也没有意义。
    expect(document.querySelectorAll('.session-team-member')).toHaveLength(0);
  });
});

describe('sessionsForSidebar', () => {
  it('lists conversations, not team members, and keeps the open member reachable', () => {
    const sessions = [lead, reviewer, writer, unrelated];
    expect(sessionsForSidebar(sessions, lead.id).map(s => s.id)).toEqual(['sess_lead']);
    // 正在查看的成员仍然留在列表里，否则它一被打开就会从侧栏消失。
    expect(sessionsForSidebar(sessions, reviewer.id).map(s => s.id))
      .toEqual(['sess_lead', 'sess_reviewer']);
  });
});
