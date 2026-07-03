import { describe, expect, it } from 'vitest';

import {
  decideNoriWorkflowGate,
  hasNoriBugHuntIntent,
  resolveNoriWorkflowConfig,
  type NoriWorkflowActivity,
} from '../../src/agent/nori-workflow';

const emptyActivity: NoriWorkflowActivity = {
  filesCreated: 0,
  filesModified: 0,
  testFilesCreated: 0,
  shellCommandCount: 0,
  verificationCommandCount: 0,
  agentSwarmCount: 0,
  noriSwarmLaunchCount: 0,
  noriSwarmResultCheckCount: 0,
  swarmReviewCount: 0,
  memorySearchCount: 0,
  memoryWriteCount: 0,
  userPromptText: '',
};

describe('Nori workflow gate', () => {
  it('resolves executable workflow flags from nori.yaml style config', () => {
    const config = resolveNoriWorkflowConfig({
      workflow: {
        review: {
          suggestion_threshold: 3,
          required_threshold: 8,
          max_gate_continuations: 4,
        },
      },
      phases: [
        {
          name: 'implement',
          steps: [{ handler: 'nori_memory_search' }],
        },
      ],
      rules: {
        require_analysis_note: true,
        require_decision_note: true,
        require_pattern_note: true,
      },
    });

    expect(config).toMatchObject({
      reviewSuggestionThreshold: 3,
      reviewRequiredThreshold: 8,
      maxReviewGateContinuations: 4,
      memorySearchRequired: true,
      bugHuntSwarmRequired: true,
      requireAnalysisNote: true,
      requireDecisionNote: true,
      requireReviewNote: true,
    });
  });

  it('forces swarm for bug hunt intent before ordinary review scoring', () => {
    const decision = decideNoriWorkflowGate(
      {
        reviewSuggestionThreshold: 4,
        reviewRequiredThreshold: 7,
        maxReviewGateContinuations: 2,
        bugHuntSwarmRequired: true,
      },
      {
        ...emptyActivity,
        filesCreated: 3,
        userPromptText: '帮我找 bug，排查渲染管线黑屏',
      },
    );

    expect(decision).toMatchObject({
      kind: 'bug_hunt_swarm',
      phase: 'review',
      mode: 'required',
      requiredTool: 'AgentSwarm',
    });
  });

  it('does not force bug hunt swarm after a swarm call already happened', () => {
    const decision = decideNoriWorkflowGate(
      {
        reviewSuggestionThreshold: 4,
        reviewRequiredThreshold: 7,
        maxReviewGateContinuations: 2,
        bugHuntSwarmRequired: true,
      },
      {
        ...emptyActivity,
        agentSwarmCount: 1,
        userPromptText: '找 bug 并 review',
      },
    );

    expect(decision).toBeUndefined();
  });

  it('requires memory search before treating implementation work as complete', () => {
    const decision = decideNoriWorkflowGate(
      {
        reviewSuggestionThreshold: 4,
        reviewRequiredThreshold: 7,
        maxReviewGateContinuations: 2,
        memorySearchRequired: true,
      },
      {
        ...emptyActivity,
        filesModified: 1,
        userPromptText: '实现这个改动',
      },
    );

    expect(decision).toMatchObject({
      kind: 'memory_search',
      phase: 'plan',
      mode: 'required',
      requiredTool: 'nori_memory_search',
    });
  });

  it('recognizes Chinese and English bug-hunt wording', () => {
    expect(hasNoriBugHuntIntent('diagnose the failing tests')).toBe(true);
    expect(hasNoriBugHuntIntent('帮我排查权限配置问题')).toBe(true);
    expect(hasNoriBugHuntIntent('实现一个按钮')).toBe(false);
  });
});
