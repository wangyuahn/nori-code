import { describe, expect, it, vi } from 'vitest';

import { TeamBrowserComponent } from '#/tui/components/dialogs/team-browser';
import { TeamMemberDetailComponent } from '#/tui/components/dialogs/team-member-detail';
import { CURRENT_MARK, SELECT_POINTER } from '#/tui/constant/symbols';
import type { TeamAgentSnapshot } from '#/tui/utils/team-tree';

const ANSI = /\u001B\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');
const ESC = String.fromCodePoint(27);

const agents: readonly TeamAgentSnapshot[] = [
  { agentId: 'main', kind: 'main', name: 'Main', parentAgentId: null },
  {
    agentId: 'reviewer',
    kind: 'team',
    name: 'Reviewer',
    parentAgentId: 'main',
    role: 'code review',
    status: 'idle',
  },
];

function text(component: { render(width: number): string[] }, width = 80): string {
  return component.render(width).map(strip).join('\n');
}

describe('TeamBrowserComponent', () => {
  it('renders the department tree with the current agent marked', () => {
    const picker = new TeamBrowserComponent({
      agents,
      toolsReadonly: false,
      discussMode: false,
      currentAgentId: 'main',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const out = text(picker);
    expect(out).toContain('Team');
    expect(out).toContain('↑↓ navigate');
    expect(out).toContain('Enter open');
    expect(out).toContain('Esc cancel');
    expect(out).not.toContain('Tab details');
    expect(out).toContain(SELECT_POINTER);
    expect(out).toContain('Main');
    expect(out).toContain('Reviewer');
    expect(out).toContain(CURRENT_MARK);
    expect(out).toContain('code review');
  });

  it('shows a read-only notice when Main cannot execute writes', () => {
    const picker = new TeamBrowserComponent({
      agents,
      toolsReadonly: true,
      discussMode: false,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    expect(text(picker)).toContain('Main is read-only');
  });

  it('shows a Discuss notice without telling members to call TeamAssign', () => {
    const picker = new TeamBrowserComponent({
      agents,
      toolsReadonly: false,
      discussMode: true,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const out = text(picker);
    expect(out).toContain('Discuss is on');
    expect(out).not.toContain('TeamAssign');
  });

  it('invokes onSelect with the highlighted member on Enter', () => {
    const onSelect = vi.fn();
    const picker = new TeamBrowserComponent({
      agents,
      toolsReadonly: false,
      discussMode: false,
      currentAgentId: 'main',
      onSelect,
      onCancel: vi.fn(),
    });
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith(agents[0]);
  });

  it('invokes onDetails with the highlighted member on Tab', () => {
    const onDetails = vi.fn();
    const picker = new TeamBrowserComponent({
      agents,
      toolsReadonly: false,
      discussMode: false,
      currentAgentId: 'main',
      onSelect: vi.fn(),
      onDetails,
      onCancel: vi.fn(),
    });
    expect(text(picker)).toContain('Tab details');
    picker.handleInput('\t');
    expect(onDetails).toHaveBeenCalledWith(agents[0]);
  });

  it('refreshes live getAgents on render after TeamDismiss removes a member', () => {
    let liveAgents: TeamAgentSnapshot[] = [...agents];
    const picker = new TeamBrowserComponent({
      getAgents: () => liveAgents,
      toolsReadonly: false,
      discussMode: false,
      currentAgentId: 'main',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    expect(text(picker)).toContain('Reviewer');

    liveAgents = [agents[0]!];
    const out = text(picker);
    expect(out).toContain('Main');
    expect(out).not.toContain('Reviewer');
  });

  it('cancels on Esc when the search query is empty', () => {
    const onCancel = vi.fn();
    const picker = new TeamBrowserComponent({
      agents,
      toolsReadonly: false,
      discussMode: false,
      onSelect: vi.fn(),
      onCancel,
    });
    picker.handleInput(ESC);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('shows the empty hire hint when no agents are present', () => {
    const picker = new TeamBrowserComponent({
      agents: [],
      toolsReadonly: false,
      discussMode: false,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    expect(text(picker)).toContain('No team members yet. Ask Nori to hire with TeamCreate.');
  });

  it('marks the speaking partner and blocked reports without using current-item marker for the speaker', () => {
    const speakingAgents: readonly TeamAgentSnapshot[] = [
      { agentId: 'main', kind: 'main', name: 'Main', parentAgentId: null },
      {
        agentId: 'reviewer',
        kind: 'team',
        name: 'Reviewer',
        parentAgentId: 'main',
        status: 'idle',
        reportStatus: 'blocked',
      },
      {
        agentId: 'discuss-1',
        kind: 'discussion',
        name: 'Discussion',
        parentAgentId: 'main',
        discussionTurnAgentId: 'reviewer',
      },
    ];
    const picker = new TeamBrowserComponent({
      agents: speakingAgents,
      toolsReadonly: false,
      discussMode: true,
      currentAgentId: 'main',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const out = text(picker);
    expect(out).toContain('speaking');
    expect(out).toContain('blocked');
    expect(out).toContain('discuss · speak:Reviewer');
    const reviewerLine = out.split('\n').find((line) => line.includes('Reviewer') && line.includes('speaking'));
    expect(reviewerLine).toBeDefined();
    expect(reviewerLine).not.toContain(CURRENT_MARK);
  });

  it('opens member details with Role / Mandate / Assigned / Report fields', () => {
    const onCancel = vi.fn();
    const agent: TeamAgentSnapshot = {
      agentId: 'reviewer',
      kind: 'team',
      name: 'Reviewer',
      parentAgentId: 'main',
      role: 'code review',
      mandate: 'Keep diffs small',
      assignedTask: 'Review footer',
      reportStatus: 'needs_decision',
      reportSummary: 'Which badge first?',
    };
    const detail = new TeamMemberDetailComponent({
      agent,
      agents: [
        { agentId: 'main', kind: 'main', name: 'Main', parentAgentId: null },
        agent,
      ],
      onCancel,
    });
    const out = text(detail);
    expect(out).toContain('Reviewer');
    expect(out).toContain('↑↓ scroll · Esc cancel');
    expect(out).toContain('Role: code review');
    expect(out).toContain('Mandate: Keep diffs small');
    expect(out).toContain('Assigned: Review footer');
    expect(out).toContain('Report: needs_decision');
    detail.handleInput(ESC);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('shows this-round Discuss speech on the member card', () => {
    const agent: TeamAgentSnapshot = {
      agentId: 'reviewer',
      kind: 'team',
      name: 'Reviewer',
      parentAgentId: 'main',
      role: 'code review',
    };
    const detail = new TeamMemberDetailComponent({
      agent,
      agents: [
        { agentId: 'main', kind: 'main', name: 'Main', parentAgentId: null },
        agent,
      ],
      recentSpeech: ['The footer should drop tips first.'],
      onCancel: vi.fn(),
    });
    const out = text(detail);
    expect(out).toContain('Role: code review');
    expect(out).toContain('Recent speech:');
    expect(out).toContain('The footer should drop tips first.');
  });
});
