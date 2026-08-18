import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { SessionAgentTree } from '../src/components/SessionAgentTree';
import { I18nProvider } from '../src/i18n';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('SessionAgentTree', () => {
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
          title: 'Review partner',
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
      expect(document.body.textContent).toContain('Reviewing the streaming boundary');
      expect(document.body.textContent).not.toContain('<message');
      expect(document.body.querySelector('.session-agent-tree-menu > details')).toBeNull();
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

  it('clears the previous session tree while the next session is loading', async () => {
    let resolveNext: ((value: { items: [] }) => void) | undefined;
    vi.spyOn(api.sessions, 'getAgents').mockImplementation(async sessionId => {
      if (sessionId === 'session-a') {
        return {
          items: [{
            agent_id: 'old-child',
            kind: 'team',
            title: 'Old session branch',
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
      items: [{ agent_id: 'main', kind: 'main', title: 'Main session', status: 'idle' }],
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
