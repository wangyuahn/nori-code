import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type SessionAgent } from '../src/api/client';
import { DepartmentMeetingPanel } from '../src/components/DepartmentPanel';
import { I18nProvider } from '../src/i18n';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * 开会不是人类开的：轮次由父级自己召集，面板只把议题、主持人、参会名单和发言
 * 摊开给人看，所以这里断言的是“显示了什么”，而不是任何发起入口。
 */
const agents: SessionAgent[] = [
  { agent_id: 'lead-1', kind: 'team', parent_agent_id: 'main', name: 'Wing Lead', status: 'idle' },
  { agent_id: 'member-1', kind: 'team', parent_agent_id: 'lead-1', name: 'Ada', status: 'idle' },
  { agent_id: 'member-2', kind: 'team', parent_agent_id: 'lead-1', name: 'Brio', status: 'idle' },
  { agent_id: 'member-3', kind: 'team', parent_agent_id: 'lead-1', name: 'Cyd', status: 'idle' },
  {
    agent_id: 'round-1',
    kind: 'discussion',
    parent_agent_id: 'lead-1',
    name: 'round-1',
    status: 'idle',
    summary: 'Ship the retry policy',
    discussion_participant_agent_ids: ['member-1', 'member-2'],
  },
];

function discussionMessage(id: string, agentId: string, name: string, text: string) {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    created_at: `2026-08-23T09:0${id.slice(-1)}:00.000Z`,
    metadata: { origin: { kind: 'system_trigger', name: 'team_discussion', speaker: { from: 'team', speakerId: agentId, speakerName: name } } },
  };
}

describe('department meeting panel', () => {
  it('shows the round topic, chair and invited members alongside the statements', async () => {
    vi.spyOn(api.sessions, 'getMessages').mockResolvedValue({
      items: [
        discussionMessage('m-1', 'member-1', 'Ada', 'Retries should back off.'),
        discussionMessage('m-2', 'member-2', 'Brio', 'Cap them at three.'),
      ],
    } as unknown as Awaited<ReturnType<typeof api.sessions.getMessages>>);

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(DepartmentMeetingPanel, {
          sessionId: 'session-meeting',
          discussionAgentId: 'round-1',
          selfAgentId: 'member-1',
          sessionAgents: agents,
          turnAgentId: 'member-2',
          revision: 1,
        })));
        await Promise.resolve();
      });

      expect(container.querySelector('.meeting-header-topic strong')?.textContent).toBe('Ship the retry policy');
      const chips = [...container.querySelectorAll('.meeting-header-chip')].map(node => node.textContent ?? '');
      expect(chips[0]).toMatch(/Wing Lead/);
      expect(chips.slice(1)).toEqual(['Ada', 'Brio']);
      // 名单外的成员不该出现在参会 chip 里。
      expect(chips.some(chip => chip.includes('Cyd'))).toBe(false);

      const rows = [...container.querySelectorAll('.department-rail-row')];
      expect(rows).toHaveLength(2);
      // 自己这方的气泡靠 own 区分，和交流面板一致。
      expect(rows[0]?.classList.contains('own')).toBe(true);
      expect(rows[1]?.classList.contains('own')).toBe(false);
      expect(rows[1]?.textContent).toMatch(/Brio/);
      expect(container.querySelector('.department-rail-body')?.textContent).toMatch(/Cap them at three\./);
      expect(container.querySelector('.department-rail-turn')?.textContent).toMatch(/Brio/);

      // 没有任何人类发起入口：召集是父级自己的动作。
      expect(container.querySelector('form')).toBeNull();
      expect(container.querySelector('button')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('keeps the header while a convened round has no statements yet', async () => {
    vi.spyOn(api.sessions, 'getMessages').mockResolvedValue({ items: [] } as unknown as Awaited<ReturnType<typeof api.sessions.getMessages>>);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(DepartmentMeetingPanel, {
          sessionId: 'session-meeting-empty',
          discussionAgentId: 'round-1',
          selfAgentId: 'lead-1',
          sessionAgents: agents,
          turnAgentId: null,
          revision: 1,
        })));
        await Promise.resolve();
      });

      expect(container.querySelector('.meeting-header-topic strong')?.textContent).toBe('Ship the retry policy');
      expect(container.querySelector('.department-rail-empty')?.textContent).toMatch(/No statements|还没有发言/);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
