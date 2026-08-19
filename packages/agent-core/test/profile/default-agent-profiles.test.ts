import { describe, expect, it } from 'vitest';

import { DEFAULT_AGENT_PROFILES, loadAgentProfilesFromSources } from '../../src/profile';

const promptContext = {
  osEnv: {
    osKind: 'macOS',
    osArch: 'arm64',
    osVersion: '0',
    shellName: 'bash',
    shellPath: '/bin/bash',
  },
  cwd: '/workspace',
  now: '2026-05-09T00:00:00.000Z',
  cwdListing: 'LISTING_SNAPSHOT',
  agentsMd: 'AGENTS_MD_BODY',
  skills: '- test-skill: does things\n  Path: /skills/test/SKILL.md',
} as const;

describe('default agent profiles', () => {
  it('loads the bundled default system prompt from embedded sources', () => {
    const prompt = DEFAULT_AGENT_PROFILES['agent']?.systemPrompt(promptContext);

    expect(prompt).toContain('You are Nori Code');
    expect(prompt).toContain('Available skills');
    expect(prompt).toContain('/workspace');
  });

  it('keeps static instructions before dynamic prompt context', () => {
    const prompt = DEFAULT_AGENT_PROFILES['agent']?.systemPrompt(promptContext) ?? '';

    expect(prompt.indexOf('Use this as your basic understanding of the project structure.')).toBeLessThan(
      prompt.indexOf('LISTING_SNAPSHOT'),
    );
    expect(prompt.indexOf('User instructions given directly in the conversation')).toBeLessThan(
      prompt.indexOf('AGENTS_MD_BODY'),
    );
    expect(prompt.indexOf('Only read skill details when needed')).toBeLessThan(
      prompt.indexOf('- test-skill: does things'),
    );
  });

  it('lists the goal tools on the agent profile but not on subagent profiles', () => {
    const agentTools = DEFAULT_AGENT_PROFILES['agent']?.tools ?? [];
    expect(agentTools).toEqual(expect.arrayContaining(['CreateGoal', 'GetGoal']));
    for (const name of ['coder', 'explore', 'plan']) {
      const tools = DEFAULT_AGENT_PROFILES[name]?.tools ?? [];
      expect(tools).not.toContain('CreateGoal');
      expect(tools).not.toContain('GetGoal');
    }
  });

  it('exposes the SubAgent tool to every main-agent profile', () => {
    for (const name of ['agent', 'nori-agent']) {
      const profile = DEFAULT_AGENT_PROFILES[name];
      expect(profile?.tools).toContain('SubAgent');
      expect(profile?.systemPrompt(promptContext)).toContain('SubAgent');
    }
    expect(DEFAULT_AGENT_PROFILES['nori-agent']?.systemPrompt(promptContext)).toContain('bounded temporary work');
    expect(DEFAULT_AGENT_PROFILES['nori-agent']?.systemPrompt(promptContext)).not.toContain('Team Agent layer');
  });

  it('exposes Discuss names to default model profiles', () => {
    for (const name of ['agent', 'nori-agent', 'nori-coder']) {
      const tools = DEFAULT_AGENT_PROFILES[name]?.tools ?? [];
      expect(tools).toContain('TeamCreate');
      expect(tools).toContain('TeamDecide');
      expect(tools).toContain('TeamAssign');
      expect(tools).toContain('TeamSpeak');
      expect(tools).toContain('TeamStatus');
      expect(tools).not.toContain('ExitDiscussMode');
    }
    expect(DEFAULT_AGENT_PROFILES['nori-agent']?.systemPrompt(promptContext)).toContain('TeamDecide');
    expect(DEFAULT_AGENT_PROFILES['nori-coder']?.systemPrompt(promptContext)).toContain('TeamAssign');
  });

  it('fails loudly when an embedded system prompt source is missing', () => {
    expect(() =>
      loadAgentProfilesFromSources(['profile/default/agent.yaml'], {
        'profile/default/agent.yaml': 'name: agent\nsystemPromptPath: ./missing.md\n',
      }),
    ).toThrow(/Embedded agent profile source missing: profile\/default\/missing\.md/);
  });

  it('omits the Skills section for subagent profiles that lack the Skill tool', () => {
    // The root agent has the Skill tool, so the Skills section and listing render.
    const agentPrompt = DEFAULT_AGENT_PROFILES['agent']?.systemPrompt(promptContext) ?? '';
    expect(agentPrompt).toContain('# Skills');
    expect(agentPrompt).toContain('- test-skill: does things');

    // Subagents (coder/explore/plan) lack the Skill tool, so neither the section
    // heading nor the skill listing should appear in their prompt.
    for (const name of ['coder', 'explore', 'plan']) {
      const tools = DEFAULT_AGENT_PROFILES[name]?.tools ?? [];
      expect(tools).not.toContain('Skill');
      const prompt = DEFAULT_AGENT_PROFILES[name]?.systemPrompt(promptContext) ?? '';
      expect(prompt).not.toContain('# Skills');
      expect(prompt).not.toContain('- test-skill: does things');
    }
  });

  it('keeps optional-tool guidance out of the shared system prompt entirely', () => {
    // Tool-coupled guidance now lives in each tool's own description, which the schema
    // layer ships ONLY when the tool is registered — that is the availability gate, for
    // free. So the shared system.md must not name optional tools at all (no per-tool
    // {% if %} reconstruction of availability). This holds for the root `agent` too, not
    // just subagents. The cross-tool secret-file guard — built on the always-present
    // Read/Grep/Glob — stays shared.
    for (const name of ['agent', 'coder', 'explore']) {
      const prompt = DEFAULT_AGENT_PROFILES[name]?.systemPrompt(promptContext) ?? '';
      expect(prompt).not.toContain('Launch multiple explore agents concurrently'); // Agent → agent.md + explore whenToUse
      expect(prompt).not.toContain('long-running shell commands as background tasks'); // background → bash.md
      expect(prompt).not.toContain('maintain a `TodoList`'); // TodoList → todo-list.md
      expect(prompt).not.toContain('prefer entering Discuss mode first');
      expect(prompt).not.toContain('call `TaskList` to re-enumerate'); // compaction recovery → task-list.md
      // The dedicated-tool routing must name only universally-present tools (Read/Glob/Grep).
      // Write/Edit/Bash are absent from read-only profiles, so naming them in the shared
      // routing sentence would dangle —
      // that routing lives in bash.md (echo>file→Write, sed→Edit, etc.), which ships with Bash.
      expect(prompt).not.toContain('`Write` / `Edit` to change files');
      expect(prompt).not.toContain('Keep `Bash` for genuine shell work');
      expect(prompt).toContain('`Glob` to find files by name'); // universal routing stays
      expect(prompt).toContain('refuse a fixed set of well-known secret files'); // shared guard stays
    }
  });

  it('renders the main Agent as a process coordinator rather than a sole thinker', () => {
    for (const name of ['agent', 'nori-agent', 'nori-coder']) {
      const prompt = DEFAULT_AGENT_PROFILES[name]?.systemPrompt(promptContext) ?? '';
      expect(prompt).toContain("You are Nori Code's main Agent");
      expect(prompt).toMatch(/process administrator|process coordinator|project manager/);
      expect(prompt).toContain('not a coding agent');
      expect(prompt).toContain('not the sole');
      expect(prompt).toContain("user's goal");
      expect(prompt).toContain('record consensus');
      expect(prompt).toMatch(/deliver verified results|deliver a verified result|verified results/);
      expect(prompt).toMatch(/(?:Do not default to using Write, Edit, or Bash yourself|Write, Edit, Bash are not the default)/);
      expect(prompt).not.toContain('interactive coding agent');
    }
  });

  it('renders the current lead collaboration contract', () => {
    for (const name of ['agent', 'nori-agent', 'nori-coder']) {
      const prompt = DEFAULT_AGENT_PROFILES[name]?.systemPrompt(promptContext) ?? '';
      expect(prompt).toContain('SubAgent');
      expect(prompt).toContain('Discuss');
      expect(prompt).toContain('TeamAssign');
      expect(prompt).toContain('enters Code');
      expect(prompt).toContain('TeamDM');
      expect(prompt).toContain('available at any time');
      expect(prompt).toContain('action=continue');
      expect(prompt.indexOf('first call `TeamDecide` with `action=start`')).toBeLessThan(
        prompt.indexOf('After Discuss starts'),
      );
      expect(prompt).toContain('only the user\'s goal, background, known constraints, and open questions');
      expect(prompt).toContain('must not pre-commit a complete');
      expect(prompt).toContain('independent analysis');
      expect(prompt).toContain('agreement with the lead alone is not a contribution');
      expect(prompt).toContain('Discuss converges');
      expect(prompt).toContain('consume every report');
      expect(prompt).toContain('before coordinating shared review');
      expect(prompt).toMatch(/[Bb]ounded temporary work/);
      expect(prompt).not.toContain('Plan mode');
      expect(prompt).not.toContain('plan file');
      expect(prompt).not.toContain('Swarm');
      expect(prompt).not.toContain('Graph');
    }
  });

  it('renders the lead-first Discuss gate and current tool permissions', () => {
    for (const name of ['agent', 'nori-agent', 'nori-coder']) {
      const prompt = DEFAULT_AGENT_PROFILES[name]?.systemPrompt(promptContext) ?? '';
      expect(prompt).toContain('main Agent');
      expect(prompt).toMatch(/process administrator|process coordinator|project administrator/);
      expect(prompt).toContain('not a coding agent');
      expect(prompt).toContain('very simple');
      expect(prompt).toMatch(/joint|shared/);
      expect(prompt).toContain('TeamDecide');
      expect(prompt).toContain('action=start');
      expect(prompt).toContain('action=continue');
      expect(prompt).toContain('shared scope');
      expect(prompt).toContain('division of labor');
      expect(prompt).toContain('completion criteria');
      expect(prompt).toContain('member proposals');
      expect(prompt).toMatch(/material disagreement|disagrees on any material point/);
      expect(prompt).toContain('TeamDM');
      expect(prompt).toContain('TeamSpeak');
      expect(prompt).toContain('read-only');
      expect(prompt).toContain('latest content tag');
      expect(prompt).toContain('automatic branch or merge');
      expect(prompt).toContain('`completed`, `blocked`, or `needs_decision`');
      expect(prompt).toContain('TeamStatus');
      expect(prompt).toContain('Write');
      expect(prompt).toContain('Edit');
      expect(prompt).toContain('Bash');
      expect(prompt).toContain('SubAgent');
      expect(prompt).not.toContain('EnterDiscussMode');
    }
  });

  it('renders role-specific collaboration overviews for leads and temporary workers', () => {
    for (const name of ['agent', 'nori-agent', 'nori-coder']) {
      const prompt = DEFAULT_AGENT_PROFILES[name]?.systemPrompt(promptContext) ?? '';
      expect(prompt).toContain('## Team Engineering');
      expect(prompt).toContain('process administrator, discussion host, coordinator, consensus recorder');
      expect(prompt).toContain('Persistent Team members collaborate in the same parent session');
      expect(prompt).toContain('TeamSpeak');
      expect(prompt).toContain('TeamDM');
      expect(prompt).toContain('first call `TeamDecide` with `action=start`');
      expect(prompt).toContain('After Discuss starts');
      expect(prompt).toContain('independent analysis');
      expect(prompt).toContain('possible division of labor');
      expect(prompt).toContain('Discuss converges');
      expect(prompt).toContain('SubAgent');
      expect(prompt).toContain('preserving their identities and context');
      expect(prompt).toContain('parent session');
      expect(prompt).toContain('parallel execution');
      expect(prompt).toContain('Memory and regular tools may be shared only when');
      expect(prompt.match(/## Team Engineering/g)).toHaveLength(1);
      expect(prompt).not.toContain('EnterDiscussMode');
      expect(prompt).not.toContain('Swarm');
      expect(prompt).not.toContain('Graph');
      expect(prompt).toContain('There is no automatic branch or merge workflow');
    }

    for (const name of ['coder', 'explore', 'orchestrator']) {
      const profile = DEFAULT_AGENT_PROFILES[name];
      const prompt = profile?.systemPrompt(promptContext) ?? '';
      expect(prompt).toContain('## Temporary Execution Partner');
      expect(prompt).not.toContain('## Team Engineering');
      expect(prompt).not.toContain('first call `TeamDecide`');
      expect(prompt).not.toContain('Call `TeamAssign`');
      expect(prompt).toContain('/workspace');
    }
    for (const name of ['coder', 'explore']) {
      const tools = DEFAULT_AGENT_PROFILES[name]?.tools ?? [];
      expect(tools).not.toEqual(expect.arrayContaining([
        'TeamCreate',
        'TeamAssign',
        'TeamDM',
        'TeamDecide',
      ]));
    }
  });
});
