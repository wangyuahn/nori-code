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

/**
 * The three bundled profiles are all main-agent profiles: every node in the
 * team tree can lead a department of its own, so they share one collaboration
 * contract (`team-engineering.md`) and differ only in tools and system prompt.
 */
const BUNDLED = ['agent', 'nori-agent', 'nori-coder'] as const;

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

  it('lists the goal tools only on the profiles that own a user goal', () => {
    for (const name of ['agent', 'nori-agent']) {
      const tools = DEFAULT_AGENT_PROFILES[name]?.tools ?? [];
      expect(tools).toEqual(expect.arrayContaining(['CreateGoal', 'GetGoal']));
    }
    // `nori-coder` is the read-only coordinating lead; it manages the Team but
    // does not own the goal lifecycle.
    const coderTools = DEFAULT_AGENT_PROFILES['nori-coder']?.tools ?? [];
    expect(coderTools).not.toContain('CreateGoal');
    expect(coderTools).not.toContain('GetGoal');
  });

  it('no longer ships a temporary-delegation tool on any profile', () => {
    for (const name of BUNDLED) {
      const profile = DEFAULT_AGENT_PROFILES[name];
      expect(profile?.tools).not.toContain('SubAgent');
      expect(profile?.systemPrompt(promptContext)).not.toContain('SubAgent');
    }
  });

  it('exposes Discuss names to every bundled profile', () => {
    for (const name of BUNDLED) {
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

  it('gates the Skills section on the Skill tool', () => {
    // `agent` and `nori-agent` render the listing; `nori-coder`'s prompt is a
    // deliberately minimal coordination brief with no {{ KIMI_SKILLS }} slot.
    for (const name of ['agent', 'nori-agent']) {
      const prompt = DEFAULT_AGENT_PROFILES[name]?.systemPrompt(promptContext) ?? '';
      expect(DEFAULT_AGENT_PROFILES[name]?.tools).toContain('Skill');
      expect(prompt).toContain('- test-skill: does things');
    }

    // A profile without the Skill tool must get neither the heading nor the
    // listing: `buildTemplateVars` blanks KIMI_SKILLS, which collapses the
    // `{% if %}` block. The gate is the tool list, not the YAML.
    const profiles = loadAgentProfilesFromSources(['profile/custom/skill-less.yaml'], {
      'profile/custom/skill-less.yaml':
        'name: skill-less\nsystemPromptPath: ./skill-less.md\ntools:\n  - Read\n',
      'profile/custom/skill-less.md':
        '{% if KIMI_SKILLS %}# Skills\n\n{{ KIMI_SKILLS }}\n{% endif %}',
    });
    const prompt = profiles['skill-less']?.systemPrompt(promptContext) ?? '';
    expect(prompt).not.toContain('# Skills');
    expect(prompt).not.toContain('- test-skill: does things');
  });

  it('keeps optional-tool guidance out of the shared system prompt entirely', () => {
    // Tool-coupled guidance lives in each tool's own description, which the schema
    // layer ships ONLY when the tool is registered — that is the availability gate, for
    // free. So the shared prompts must not name optional tools at all (no per-tool
    // {% if %} reconstruction of availability).
    for (const name of BUNDLED) {
      const prompt = DEFAULT_AGENT_PROFILES[name]?.systemPrompt(promptContext) ?? '';
      expect(prompt).not.toContain('Launch multiple explore agents concurrently');
      expect(prompt).not.toContain('long-running shell commands as background tasks'); // background → bash.md
      expect(prompt).not.toContain('maintain a `TodoList`'); // TodoList → todo-list.md
      expect(prompt).not.toContain('prefer entering Discuss mode first');
      expect(prompt).not.toContain('call `TaskList` to re-enumerate'); // compaction recovery → task-list.md
      // The dedicated-tool routing must name only universally-present tools (Read/Glob/Grep).
      // `nori-coder` has no Write/Edit/Bash, so naming them in a shared routing sentence
      // would dangle — that routing lives in bash.md, which ships with Bash.
      expect(prompt).not.toContain('`Write` / `Edit` to change files');
      expect(prompt).not.toContain('Keep `Bash` for genuine shell work');
    }

    const agentPrompt = DEFAULT_AGENT_PROFILES['agent']?.systemPrompt(promptContext) ?? '';
    expect(agentPrompt).toContain('`Glob` to find files by name'); // universal routing stays
    expect(agentPrompt).toContain('refuse a fixed set of well-known secret files'); // shared guard stays
  });

  it('renders the main Agent as a process coordinator rather than a sole thinker', () => {
    for (const name of BUNDLED) {
      const prompt = DEFAULT_AGENT_PROFILES[name]?.systemPrompt(promptContext) ?? '';
      expect(prompt).toContain("You are Nori Code's main Agent");
      expect(prompt).toMatch(/process administrator|process coordinator|project manager/);
      expect(prompt).toContain('not a coding agent');
      expect(prompt).toContain('not the sole');
      expect(prompt).toContain("user's goal");
      expect(prompt).toContain('record consensus');
      expect(prompt).toMatch(/deliver verified results|deliver a verified result|verified results/);
      expect(prompt).toContain('Do not default to using Write, Edit, or Bash yourself');
      expect(prompt).not.toContain('interactive coding agent');
    }
  });

  it('renders the sync-first collaboration contract', () => {
    for (const name of BUNDLED) {
      const prompt = DEFAULT_AGENT_PROFILES[name]?.systemPrompt(promptContext) ?? '';
      expect(prompt).toContain('silent parallel work');
      expect(prompt).toContain('TeamCreate');
      expect(prompt).toContain('TeamDecide action=start');
      expect(prompt).toContain('TeamSpeak');
      expect(prompt).toContain('TeamAssign');
      expect(prompt).toContain('enters Code');
      expect(prompt).toContain('TeamDecide action=continue');
      expect(prompt).toContain('TeamDM');
      expect(prompt).toContain('not after');
      expect(prompt).toContain('is not a contribution');
      expect(prompt).not.toContain('Plan mode');
      expect(prompt).not.toContain('plan file');
      expect(prompt).not.toContain('Swarm');
      expect(prompt).not.toContain('Graph');
    }
  });

  it('names the re-sync triggers and conflict handling', () => {
    for (const name of BUNDLED) {
      const prompt = DEFAULT_AGENT_PROFILES[name]?.systemPrompt(promptContext) ?? '';
      expect(prompt).toContain("don't wait for a final report");
      expect(prompt).toContain('completed`/`blocked`/`needs_decision');
      expect(prompt).toContain('Edit tag mismatches');
      expect(prompt).toContain('Never overwrite verified work');
      expect(prompt).not.toContain('EnterDiscussMode');
    }
  });

  it('keeps the department Chat guidance on member prompts only', () => {
    // Chat is a sibling-only channel: `main` has no siblings, so the guidance
    // lives in the member-only `team-agent.md`, not the shared contract.
    for (const name of BUNDLED) {
      const prompt = DEFAULT_AGENT_PROFILES[name]?.systemPrompt(promptContext) ?? '';
      expect(prompt).not.toContain('TeamChat');
    }
  });

  it('prepends exactly one Team Engineering contract to every bundled profile', () => {
    for (const name of BUNDLED) {
      const prompt = DEFAULT_AGENT_PROFILES[name]?.systemPrompt(promptContext) ?? '';
      expect(prompt).toContain('## Team Engineering');
      expect(prompt).toContain('Be concrete and brief in every Discuss turn and every report');
      expect(prompt).toContain('Never overwrite verified work');
      expect(prompt).toContain('do not use Write, Edit, or Bash yourself');
      expect(prompt.match(/## Team Engineering/g)).toHaveLength(1);
      expect(prompt).not.toContain('EnterDiscussMode');
      expect(prompt).not.toContain('Swarm');
      expect(prompt).not.toContain('Graph');
    }
  });
});
