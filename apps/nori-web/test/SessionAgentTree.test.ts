import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { AgentBreadcrumb } from '../src/App';
import { SessionAgentTree } from '../src/components/SessionAgentTree';
import { I18nProvider } from '../src/i18n';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('SessionAgentTree', () => {
  it('renders ID-based parent breadcrumbs and navigates parent/current agents', async () => {
    const onSelectAgent = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const agents = [
      { agent_id: 'main', kind: 'main', name: 'Main', status: 'idle' },
      { agent_id: 'team', kind: 'team', name: 'Team Engineering', status: 'idle', parent_agent_id: 'main' },
      { agent_id: 'child', kind: 'sub', name: 'Protocol trace', status: 'running', parent_agent_id: 'team' },
    ];
    try {
      await act(async () => {
        root.render(createElement(AgentBreadcrumb, {
          activeView: 'chat',
          activeAgentId: 'child',
          activeAgent: null,
          agents,
          sessionTitle: 'Conversation',
          viewLabel: 'Chat',
          locationLabel: 'Current location',
          onSelectAgent,
          onSelectWorkspace: vi.fn(),
        }));
      });
      expect(container.textContent).toContain('Nori Work');
      expect(container.textContent).toContain('Conversation');
      expect(container.textContent).toContain('Team Engineering');
      expect(container.textContent).toContain('Protocol trace');
      const links = [...container.querySelectorAll<HTMLButtonElement>('.workspace-breadcrumb-link')];
      await act(async () => links.find(link => link.textContent === 'Team Engineering')?.click());
      expect(onSelectAgent).toHaveBeenCalledWith(expect.objectContaining({ agent_id: 'team' }));
      await act(async () => links.find(link => link.textContent === 'Protocol trace')?.click());
      expect(onSelectAgent).toHaveBeenLastCalledWith(expect.objectContaining({ agent_id: 'child' }));
      expect(links.at(-1)?.getAttribute('aria-current')).toBe('page');
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.restoreAllMocks();
    }
  });

  it('renders the main-session root with identity-labelled branches and closes after selecting a child transcript', async () => {
    vi.spyOn(api.sessions, 'getAgents').mockResolvedValue({
      items: [
        {
          agent_id: 'main',
          kind: 'main',
          name: 'Main agent',
          status: 'running',
          last_active: new Date().toISOString(),
        },
        {
          agent_id: 'team-review',
          kind: 'team',
          name: 'Review partner',
          status: 'idle',
          summary: '<message from="sub">Reviewing the streaming boundary</message>',
          tokens: 120,
          last_active: new Date().toISOString(),
        },
        {
          agent_id: 'temp-main',
          kind: 'sub',
          parent_agent_id: 'main',
          name: 'Main spawned audit',
          status: 'running',
          summary: 'Temporary bucket child',
        },
        {
          agent_id: 'temp-audit',
          kind: 'sub',
          parent_agent_id: 'team-review',
          name: 'Audit task',
          status: 'running',
          summary: 'Check transcript routing',
        },
        {
          agent_id: 'discussion-1',
          kind: 'discussion',
          name: 'Architecture discussion',
          status: 'archived',
          archived: true,
        },
        {
          agent_id: 'discussion-live',
          kind: 'discussion',
          name: 'Live Discuss',
          status: 'idle',
          summary: 'Current round',
        },
      ],
    });
    const onSelectAgent = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SessionAgentTree, {
          sessionId: 'session-a',
          selectedAgentId: 'main',
          backgroundTasks: [],
          onSelectAgent,
        })));
      });
      await vi.waitFor(() => expect(container.textContent).toContain('Team'));
      const tree = container.querySelector<HTMLDetailsElement>('.session-agent-tree');
      expect(tree).not.toBeNull();
      await act(async () => { tree?.querySelector<HTMLElement>('summary')?.click(); });
      await vi.waitFor(() => expect(document.body.textContent).toContain('Review partner'));

      expect(document.body.textContent).toContain('Audit task');
      expect(document.body.textContent).toContain('Main spawned audit');
      expect(document.body.textContent).toContain('Architecture discussion');
      expect(document.body.textContent).toContain('Main agent');
      expect(document.body.textContent).toContain('Main session');
      expect(document.body.textContent).toContain('Team partner');
      expect(document.body.textContent).toContain('Temporary');
      expect(document.body.textContent).toContain('Archive');
      expect(document.body.textContent).toContain('(SubAgent)');
      expect(document.body.textContent).not.toContain('Temporary SubAgent');
      expect(document.body.textContent).toContain('Archived Discuss');
      expect(document.body.textContent).toContain('Live Discuss');
      expect(document.body.textContent).toContain('Discuss');
      expect(document.body.querySelector('[data-agent-id="discussion-live"]')?.classList.contains('discussion')).toBe(true);
      expect(document.body.querySelector('[data-agent-id="discussion-live"] .session-agent-tree-identity svg')).not.toBeNull();
      expect(document.body.textContent).toContain('Reviewing the streaming boundary');
      expect(document.body.textContent).not.toContain('<message');
      expect(document.body.querySelector('.session-agent-tree-menu > .session-agent-tree-section')).not.toBeNull();
      expect(container.textContent).not.toContain('subagents');

      const auditButton = [...document.body.querySelectorAll<HTMLButtonElement>('.session-agent-tree-node > button')]
        .find(button => button.textContent?.includes('Audit task'));
      expect(auditButton?.closest('.session-agent-tree-children')).not.toBeNull();
      const reviewButton = [...document.body.querySelectorAll<HTMLButtonElement>('.session-agent-tree-node > button')]
        .find(button => button.textContent?.includes('Review partner'));
      await act(async () => { reviewButton?.click(); });
      expect(onSelectAgent).toHaveBeenCalledWith(expect.objectContaining({ agent_id: 'team-review' }));
      expect(tree?.open).toBe(false);
      await act(async () => { tree?.querySelector<HTMLElement>('summary')?.click(); });
      await vi.waitFor(() => expect(document.body.textContent).toContain('Audit task'));
      const reopenedAuditButton = [...document.body.querySelectorAll<HTMLButtonElement>('.session-agent-tree-node > button')]
        .find(button => button.textContent?.includes('Audit task'));
      await act(async () => { reopenedAuditButton?.click(); });
      expect(onSelectAgent).toHaveBeenLastCalledWith(expect.objectContaining({ agent_id: 'temp-audit' }));
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.restoreAllMocks();
    }
  });

  it('shows Discuss only for an active discussion agent', async () => {
    let agents = [{ agent_id: 'main', kind: 'main', name: 'Main', status: 'idle' }];
    vi.spyOn(api.sessions, 'getAgents').mockImplementation(async () => ({ items: agents }));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const status = {
      status: 'ready',
      thinking_level: 'off',
      permission: 'manual',
      discuss_mode: false,
      main_write_enabled: true,
      goal: null,
      context_tokens: 0,
      max_context_tokens: 128_000,
      context_usage: 0,
    };
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SessionAgentTree, {
          sessionId: 'session-discuss',
          selectedAgentId: 'main',
          backgroundTasks: [],
          sessionStatus: status,
          onSelectAgent: () => undefined,
        })));
      });
      await vi.waitFor(() => expect(container.textContent).toContain('Team'));
      expect(container.querySelector('.session-agent-tree-mode')).toBeNull();

      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SessionAgentTree, {
          sessionId: 'session-discuss',
          selectedAgentId: 'main',
          backgroundTasks: [],
          sessionStatus: { ...status, discuss_mode: true },
          onSelectAgent: () => undefined,
        })));
      });
      expect(container.querySelector('.session-agent-tree-mode')).toBeNull();

      agents = [
        ...agents,
        { agent_id: 'discussion-live', kind: 'discussion', name: 'Live Discuss', status: 'idle' },
      ];
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SessionAgentTree, {
          sessionId: 'session-discuss',
          selectedAgentId: 'discussion-live',
          backgroundTasks: [],
          sessionStatus: { ...status, discuss_mode: false },
          onSelectAgent: () => undefined,
        })));
      });
      await vi.waitFor(() => expect(container.querySelector('.session-agent-tree-mode')?.textContent).toContain('Discuss'));
      expect(container.querySelector('.session-agent-tree')?.classList.contains('discussion-active')).toBe(true);

      agents = agents.map(agent => agent.agent_id === 'discussion-live' ? { ...agent, archived: true, status: 'archived' } : agent);
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SessionAgentTree, {
          sessionId: 'session-discuss',
          selectedAgentId: 'discussion-live',
          backgroundTasks: [],
          sessionStatus: { ...status, discuss_mode: false },
          onSelectAgent: () => undefined,
        })));
      });
      expect(container.querySelector('.session-agent-tree-mode')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.restoreAllMocks();
    }
  });

  it('highlights only the member whose Discuss turn is currently scheduled', async () => {
    vi.spyOn(api.sessions, 'getAgents').mockResolvedValue({
      items: [
        { agent_id: 'main', kind: 'main', name: 'Main', status: 'running' },
        { agent_id: 'wing-smith', kind: 'team', name: 'WING_SMITH', role: '机翼工程师', parent_agent_id: 'main', status: 'running' },
        { agent_id: 'fuselage-smith', kind: 'team', name: 'FUSELAGE_SMITH', role: '机身工程师', parent_agent_id: 'main', status: 'idle' },
        {
          agent_id: 'discussion-live',
          kind: 'discussion',
          name: 'Discussion',
          parent_agent_id: 'main',
          status: 'running',
          discussion_turn_agent_id: 'wing-smith',
        },
      ],
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SessionAgentTree, {
          sessionId: 'session-current-speaker',
          selectedAgentId: 'main',
          backgroundTasks: [],
          discussionTurnAgentId: 'wing-smith',
          onSelectAgent: () => undefined,
        })));
      });
      await vi.waitFor(() => expect(container.textContent).toContain('Team'));
      await act(async () => { container.querySelector<HTMLElement>('.session-agent-tree > summary')?.click(); });
      await vi.waitFor(() => expect(document.body.textContent).toContain('机翼工程师'));

      expect(document.body.querySelector('[data-agent-id="wing-smith"]')?.classList.contains('discussion-current-turn')).toBe(true);
      expect(document.body.querySelector('[data-agent-id="wing-smith"]')?.getAttribute('aria-current')).toBe('true');
      expect(document.body.querySelector('[data-agent-id="wing-smith"]')?.textContent).toContain('Speaking');
      expect(document.body.querySelector('[data-agent-id="fuselage-smith"]')?.classList.contains('discussion-current-turn')).toBe(false);
      expect(document.body.querySelector('.session-agent-tree-turn-chip')?.textContent).toContain('WING_SMITH');
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.restoreAllMocks();
    }
  });

  it('refreshes the tree when a discussion lifecycle revision arrives', async () => {
    let agents = [{ agent_id: 'main', kind: 'main', name: 'Main', status: 'idle' }];
    vi.spyOn(api.sessions, 'getAgents').mockImplementation(async () => ({ items: agents }));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const renderTree = (agentTreeRevision: number) => createElement(I18nProvider, null, createElement(SessionAgentTree, {
      sessionId: 'session-discussion-revision',
      selectedAgentId: 'main',
      backgroundTasks: [],
      agentTreeRevision,
      onSelectAgent: () => undefined,
    }));
    try {
      await act(async () => root.render(renderTree(0)));
      await vi.waitFor(() => expect(container.textContent).toContain('Team'));
      await act(async () => { container.querySelector<HTMLElement>('.session-agent-tree > summary')?.click(); });
      expect(document.body.querySelector('[data-agent-id="discussion-live"]')).toBeNull();

      agents = [
        ...agents,
        { agent_id: 'discussion-live', kind: 'discussion', name: 'Live Discuss', status: 'running' },
      ];
      await act(async () => root.render(renderTree(1)));
      await vi.waitFor(() => expect(document.body.querySelector('[data-agent-id="discussion-live"]')).not.toBeNull());
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.restoreAllMocks();
    }
  });

  it('collapses a team branch and keeps archive/background sections collapsed by default', async () => {
    vi.spyOn(api.sessions, 'getAgents').mockResolvedValue({
      items: [
        { agent_id: 'main', kind: 'main', name: 'Main', status: 'idle' },
        { agent_id: 'team', kind: 'team', name: 'Team', status: 'running' },
        { agent_id: 'child', kind: 'sub', parent_agent_id: 'team', name: 'Child', status: 'running' },
        { agent_id: 'archived', kind: 'sub', parent_agent_id: 'team', name: 'Archived child', status: 'archived', archived: true },
      ],
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SessionAgentTree, {
          sessionId: 'session-collapse',
          selectedAgentId: 'main',
          backgroundTasks: [{
            id: 'background',
            session_id: 'session-collapse',
            kind: 'bash',
            description: 'background work',
            status: 'running',
            created_at: new Date().toISOString(),
          }],
          onSelectAgent: () => undefined,
        })));
      });
      await act(async () => { container.querySelector<HTMLElement>('.session-agent-tree > summary')?.click(); });
      await vi.waitFor(() => expect(document.body.textContent).toContain('Child'));
      const team = [...document.body.querySelectorAll<HTMLElement>('.session-agent-tree-node')]
        .find(node => node.querySelector('strong')?.textContent === 'Team');
      expect(team?.querySelector<HTMLElement>('.session-agent-tree-toggle')?.getAttribute('aria-expanded')).toBe('true');
      await act(async () => team?.querySelector<HTMLButtonElement>('.session-agent-tree-toggle')?.click());
      expect(team?.querySelector<HTMLElement>('.session-agent-tree-toggle')?.getAttribute('aria-expanded')).toBe('false');
      expect(team?.querySelector('.session-agent-tree-children')).toBeNull();
      expect(document.body.textContent).not.toContain('Child');
      await act(async () => team?.querySelector<HTMLButtonElement>('.session-agent-tree-toggle')?.click());
      expect(team?.querySelector<HTMLElement>('.session-agent-tree-toggle')?.getAttribute('aria-expanded')).toBe('true');
      expect(team?.querySelector('.session-agent-tree-children')?.textContent).toContain('Child');
      expect(document.body.querySelector<HTMLDetailsElement>('.session-agent-tree-background-list')?.open).toBe(false);
      expect([...document.body.querySelectorAll<HTMLDetailsElement>('.session-agent-tree-section')]
        .find(section => section.textContent?.includes('Archive'))?.open).toBe(false);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.restoreAllMocks();
    }
  });

  it('keeps the Team section collapsed under Main across a deferred refresh', async () => {
    let agents = [
      { agent_id: 'main', kind: 'main', name: 'Main', status: 'idle' },
      { agent_id: 'team', kind: 'team', name: 'Team', status: 'running', parent_agent_id: 'main' },
      { agent_id: 'child', kind: 'sub', name: 'Child', status: 'running', parent_agent_id: 'team' },
    ];
    const getAgents = vi.spyOn(api.sessions, 'getAgents').mockImplementation(async () => ({ items: agents }));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const renderTree = (agentTreeRevision: number) => createElement(I18nProvider, null, createElement(SessionAgentTree, {
      sessionId: 'session-stable-collapse',
      selectedAgentId: 'main',
      backgroundTasks: [],
      agentTreeRevision,
      onSelectAgent: () => undefined,
    }));
    const findTeamSection = () => [...document.body.querySelectorAll<HTMLDetailsElement>('.session-agent-tree-section')]
      .find(section => section.querySelector('.session-agent-tree-section-label')?.textContent === 'Team partners');
    try {
      await act(async () => root.render(renderTree(0)));
      await vi.waitFor(() => expect(getAgents).toHaveBeenCalledTimes(1));
      const tree = container.querySelector<HTMLDetailsElement>('.session-agent-tree');
      await act(async () => { tree?.querySelector<HTMLElement>(':scope > summary')?.click(); });
      await vi.waitFor(() => expect(findTeamSection()).not.toBeUndefined());

      const main = document.body.querySelector<HTMLElement>('[data-agent-id="main"]');
      const teamSection = findTeamSection();
      expect(main?.querySelector('.session-agent-tree-children')?.contains(teamSection ?? null)).toBe(true);
      expect(teamSection?.open).toBe(true);
      await act(async () => { teamSection?.querySelector<HTMLElement>(':scope > summary')?.click(); });
      await vi.waitFor(() => expect(findTeamSection()?.open).toBe(false));

      agents = agents.map(agent => agent.agent_id === 'child' ? { ...agent, status: 'idle' } : agent);
      await act(async () => root.render(renderTree(1)));
      expect(getAgents).toHaveBeenCalledTimes(1);
      await act(async () => { tree?.querySelector<HTMLElement>(':scope > summary')?.click(); });
      await vi.waitFor(() => expect(getAgents).toHaveBeenCalledTimes(2));
      await act(async () => { tree?.querySelector<HTMLElement>(':scope > summary')?.click(); });
      await vi.waitFor(() => expect(findTeamSection()).not.toBeUndefined());
      expect(findTeamSection()?.open).toBe(false);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.restoreAllMocks();
    }
  });

  it('keeps sibling branches independent and renders the Main → Team → SubAgent hierarchy', async () => {
    vi.spyOn(api.sessions, 'getAgents').mockResolvedValue({
      items: [
        { agent_id: 'main', kind: 'main', name: 'Main', status: 'idle' },
        { agent_id: 'team-a', kind: 'team', name: 'Team A', status: 'running', parent_agent_id: 'main' },
        { agent_id: 'sub-a', kind: 'sub', name: 'Sub A', status: 'running', parent_agent_id: 'team-a' },
        { agent_id: 'team-b', kind: 'team', name: 'Team B', status: 'running', parent_agent_id: 'main' },
        { agent_id: 'sub-b', kind: 'sub', name: 'Sub B', status: 'running', parent_agent_id: 'team-b' },
      ],
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onSelectAgent = vi.fn();
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SessionAgentTree, {
          sessionId: 'session-hierarchy',
          selectedAgentId: 'main',
          backgroundTasks: [],
          onSelectAgent,
        })));
      });
      await vi.waitFor(() => expect(container.textContent).toContain('Team'));
      await act(async () => { container.querySelector<HTMLElement>('.session-agent-tree > summary')?.click(); });
      await vi.waitFor(() => expect(document.body.textContent).toContain('Sub A'));

      const main = document.body.querySelector<HTMLElement>('[data-agent-id="main"]');
      const teamA = document.body.querySelector<HTMLElement>('[data-agent-id="team-a"]');
      const teamB = document.body.querySelector<HTMLElement>('[data-agent-id="team-b"]');
      expect(main?.querySelector('.session-agent-tree-children')?.contains(teamA)).toBe(true);
      expect(teamA?.querySelector('.session-agent-tree-children')?.textContent).toContain('Sub A');
      expect(teamA?.classList.contains('has-children')).toBe(true);
      expect(teamA?.querySelector('.session-agent-tree-children > .session-agent-tree-node')?.classList.contains('depth-2')).toBe(true);

      await act(async () => { teamA?.querySelector<HTMLButtonElement>('.session-agent-tree-toggle')?.click(); });
      expect(onSelectAgent).not.toHaveBeenCalled();
      expect(teamA?.querySelector('.session-agent-tree-children')).toBeNull();
      expect(document.body.querySelector('[data-agent-id="team-b"]')?.querySelector('.session-agent-tree-children')?.textContent).toContain('Sub B');
      await act(async () => { teamA?.querySelector<HTMLButtonElement>('.session-agent-tree-toggle')?.click(); });
      expect(teamA?.querySelector('.session-agent-tree-children')?.textContent).toContain('Sub A');
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.restoreAllMocks();
    }
  });

  it('falls back safely for missing parents and cyclic parent data', async () => {
    vi.spyOn(api.sessions, 'getAgents').mockResolvedValue({
      items: [
        { agent_id: 'main', kind: 'main', name: 'Main', status: 'idle' },
        { agent_id: 'cycle-a', kind: 'sub', name: 'Cycle A', status: 'running', parent_agent_id: 'cycle-b' },
        { agent_id: 'cycle-b', kind: 'sub', name: 'Cycle B', status: 'running', parent_agent_id: 'cycle-a' },
        { agent_id: 'missing', kind: 'sub', name: 'Missing parent', status: 'running', parent_agent_id: 'does-not-exist' },
      ],
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SessionAgentTree, {
          sessionId: 'session-invalid-tree',
          selectedAgentId: 'main',
          backgroundTasks: [],
          onSelectAgent: vi.fn(),
        })));
      });
      await vi.waitFor(() => expect(container.textContent).toContain('SubAgent'));
      await act(async () => { container.querySelector<HTMLElement>('.session-agent-tree > summary')?.click(); });
      await vi.waitFor(() => expect(document.body.textContent).toContain('Cycle A'));
      expect(document.body.querySelectorAll('[data-agent-id="cycle-a"]')).toHaveLength(1);
      expect(document.body.querySelectorAll('[data-agent-id="cycle-b"]')).toHaveLength(1);
      expect(document.body.querySelectorAll('[data-agent-id="missing"]')).toHaveLength(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.restoreAllMocks();
    }
  });

  it('clears the previous session tree while the next session is loading', async () => {
    let resolveNext: ((value: { items: [] }) => void) | undefined;
    vi.spyOn(api.sessions, 'getAgents').mockImplementation(async sessionId => {
      if (sessionId === 'session-a') {
        return {
          items: [{
            agent_id: 'old-child',
            kind: 'team',
            name: 'Old session branch',
            status: 'running',
          }],
        };
      }
      return new Promise(resolve => { resolveNext = resolve as (value: { items: [] }) => void; });
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SessionAgentTree, {
          sessionId: 'session-a',
          selectedAgentId: 'main',
          backgroundTasks: [],
          onSelectAgent: () => undefined,
        })));
      });
      await vi.waitFor(() => expect(container.textContent).toContain('Team'));
      await act(async () => { container.querySelector<HTMLElement>('summary')?.click(); });
      await vi.waitFor(() => expect(document.body.textContent).toContain('Old session branch'));

      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SessionAgentTree, {
          sessionId: 'session-b',
          selectedAgentId: 'main',
          backgroundTasks: [],
          onSelectAgent: () => undefined,
        })));
      });
      expect(document.body.textContent).not.toContain('Old session branch');
      resolveNext?.({ items: [] });
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.restoreAllMocks();
    }
  });

  it('keeps background work out of the subagent count while showing activity', async () => {
    vi.spyOn(api.sessions, 'getAgents').mockResolvedValue({
      items: [{ agent_id: 'main', kind: 'main', name: 'Main session', status: 'idle' }],
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(SessionAgentTree, {
          sessionId: 'session-background',
          selectedAgentId: 'main',
          backgroundTasks: [{
            id: 'bash-1',
            session_id: 'session-background',
            kind: 'bash',
            description: 'pnpm test',
            status: 'running',
            created_at: new Date().toISOString(),
          }],
          onSelectAgent: () => undefined,
        })));
      });
      await vi.waitFor(() => expect(container.textContent).toContain('Team'));
      expect(container.querySelector('.session-agent-tree')?.classList.contains('activity-pending')).toBe(true);
      expect(container.textContent).not.toContain('subagents');
      expect(container.textContent).not.toContain('SubAgents');
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.restoreAllMocks();
    }
  });
});
