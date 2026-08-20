import { describe, expect, it } from 'vitest';

import {
  checkCondition,
  nextPhase,
  renderRules,
  ruleTargetsAgent,
  type RuleConfig,
} from '../src/rule-engine.js';

const RULES = [
  {
    name: 'search_before_code',
    condition: { type: 'on_phase', phase: 'implement', stage: 'enter' },
    prompt: 'Search the vault first.',
    enforced: true,
    targets: ['main'],
  },
  {
    name: 'review_after_subagent',
    condition: { type: 'on_tool', tool: 'TeamAssign', stage: 'after' },
    prompt: 'Review TeamAssign results.',
    enforced: true,
  },
  {
    name: 'write_adr',
    condition: { type: 'on_phase', phase: 'implement', stage: 'exit' },
    prompt: 'Write an ADR.',
    enforced: false,
    targets: ['main'],
  },
  {
    name: 'always_guide',
    condition: { type: 'always' },
    prompt: 'Be concise.',
  },
  {
    name: 'reviewer_only',
    condition: { type: 'on_phase', phase: 'review', stage: 'enter' },
    prompt: 'Reviewer checklist.',
    targets: ['agent_type:reviewer'],
  },
] as const satisfies readonly RuleConfig[];

const searchRule = RULES[0]!;
const teamAssignRule = RULES[1]!;
const adrRule = RULES[2]!;
const alwaysRule = RULES[3]!;
const reviewerRule = RULES[4]!;

describe('checkCondition', () => {
  it('evaluates always/on_phase/on_tool conditions', () => {
    expect(checkCondition(alwaysRule.condition, {})).toBe(true);
    expect(checkCondition(searchRule.condition, { currentPhase: 'implement', phaseStage: 'enter' })).toBe(true);
    expect(checkCondition(searchRule.condition, { currentPhase: 'implement', phaseStage: 'exit' })).toBe(false);
    expect(checkCondition(teamAssignRule.condition, { currentTool: 'TeamAssign', toolStage: 'after' })).toBe(true);
    expect(checkCondition(teamAssignRule.condition, { currentTool: 'TeamAssign', toolStage: 'before' })).toBe(false);
  });
});

describe('ruleTargetsAgent', () => {
  it('main-targeted rules skip subagents', () => {
    expect(ruleTargetsAgent(searchRule, false, undefined)).toBe(true);
    expect(ruleTargetsAgent(searchRule, true, 'coder')).toBe(false);
  });

  it('agent_type targets match only that subagent type', () => {
    expect(ruleTargetsAgent(reviewerRule, true, 'reviewer')).toBe(true);
    expect(ruleTargetsAgent(reviewerRule, true, 'coder')).toBe(false);
    expect(ruleTargetsAgent(reviewerRule, false, undefined)).toBe(false);
  });

  it('untargeted rules apply everywhere', () => {
    expect(ruleTargetsAgent(teamAssignRule, true, 'coder')).toBe(true);
  });
});

describe('renderRules', () => {
  it('puts enforced rules first and separates advisory blocks', () => {
    const text = renderRules([adrRule, searchRule]);
    const enforcedAt = text.indexOf('mandatory rules');
    const advisoryAt = text.indexOf('advisory rules');
    expect(enforcedAt).toBeGreaterThanOrEqual(0);
    expect(advisoryAt).toBeGreaterThan(enforcedAt);
    expect(text).toContain('**search_before_code** (enforced)');
    expect(text).toContain('**write_adr** (advisory)');
  });

  it('renders empty for no rules', () => {
    expect(renderRules([])).toBe('');
  });
});

describe('nextPhase', () => {
  it('folds Discuss toggles into discuss/implement', () => {
    expect(nextPhase(true, false, 'idle')).toBe('discuss');
    expect(nextPhase(false, true, 'discuss')).toBe('implement');
    expect(nextPhase(true, true, 'discuss')).toBe('discuss');
    expect(nextPhase(false, false, 'implement')).toBe('implement');
  });

  it('exits review back to implement when Discuss is off', () => {
    expect(nextPhase(false, false, 'review')).toBe('implement');
    expect(nextPhase(true, false, 'review')).toBe('discuss');
  });
});
