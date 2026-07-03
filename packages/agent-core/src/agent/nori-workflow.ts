export interface NoriWorkflowConfig {
  readonly reviewSuggestionThreshold: number;
  readonly reviewRequiredThreshold: number;
  readonly maxReviewGateContinuations: number;
  readonly memorySearchRequired?: boolean;
  readonly bugHuntSwarmRequired?: boolean;
  readonly preSwarmDocRequired?: boolean;
  readonly requireAnalysisNote?: boolean;
  readonly requireDecisionNote?: boolean;
  readonly requireReviewNote?: boolean;
}

export interface NoriReviewActivity {
  readonly filesCreated: number;
  readonly filesModified: number;
  readonly testFilesCreated: number;
  readonly shellCommandCount: number;
  readonly verificationCommandCount: number;
  readonly agentSwarmCount: number;
  readonly noriSwarmLaunchCount: number;
  readonly noriSwarmResultCheckCount: number;
  readonly swarmReviewCount: number;
}

export interface NoriWorkflowActivity extends NoriReviewActivity {
  readonly memorySearchCount: number;
  readonly memoryWriteCount: number;
  readonly userPromptText: string;
}

export interface NoriReviewGateDecision {
  readonly mode: 'required' | 'suggested';
  readonly score: number;
  readonly suggestionThreshold: number;
  readonly requiredThreshold: number;
  readonly reason: string;
}

export type NoriWorkflowGateKind = 'bug_hunt_swarm' | 'memory_search' | 'review';

export interface NoriWorkflowGateDecision {
  readonly kind: NoriWorkflowGateKind;
  readonly phase: 'plan' | 'implement' | 'review';
  readonly mode: 'required' | 'suggested';
  readonly reason: string;
  readonly requiredTool?: string;
  readonly review?: NoriReviewGateDecision;
}

export const DEFAULT_NORI_WORKFLOW_CONFIG: NoriWorkflowConfig = {
  reviewSuggestionThreshold: 4,
  reviewRequiredThreshold: 7,
  maxReviewGateContinuations: 2,
  bugHuntSwarmRequired: true,
};

export function resolveNoriWorkflowConfig(
  noriConfig: Record<string, unknown> | null | undefined,
): NoriWorkflowConfig | undefined {
  if (noriConfig === null || noriConfig === undefined) return undefined;

  const workflow = asRecord(noriConfig['workflow']);
  const review = asRecord(workflow?.['review']);
  const reviewGate = asRecord(workflow?.['review_gate']);
  const topReview = asRecord(noriConfig['review']);
  const rules = asRecord(noriConfig['rules']);

  return {
    reviewSuggestionThreshold: clampScore(
      firstNumber(
        review?.['suggestion_threshold'],
        reviewGate?.['suggestion_threshold'],
        workflow?.['review_suggestion_threshold'],
        topReview?.['suggestion_threshold'],
      ) ?? DEFAULT_NORI_WORKFLOW_CONFIG.reviewSuggestionThreshold,
    ),
    reviewRequiredThreshold: clampScore(
      firstNumber(
        review?.['required_threshold'],
        review?.['difficulty_threshold'],
        reviewGate?.['required_threshold'],
        workflow?.['review_required_threshold'],
        workflow?.['review_difficulty_threshold'],
        topReview?.['required_threshold'],
        topReview?.['difficulty_threshold'],
      ) ?? DEFAULT_NORI_WORKFLOW_CONFIG.reviewRequiredThreshold,
    ),
    maxReviewGateContinuations: clampInteger(
      firstNumber(
        review?.['max_gate_continuations'],
        reviewGate?.['max_gate_continuations'],
        workflow?.['max_review_gate_continuations'],
        topReview?.['max_gate_continuations'],
      ) ?? DEFAULT_NORI_WORKFLOW_CONFIG.maxReviewGateContinuations,
      1,
      5,
    ),
    memorySearchRequired:
      booleanValue(workflow?.['memory_search_required']) ??
      booleanValue(workflow?.['require_memory_search']) ??
      hasWorkflowToolStep(noriConfig, 'implement', 'nori_memory_search') ??
      hasEnforcedRule(rules?.['definitions'], 'search_before_code'),
    bugHuntSwarmRequired:
      booleanValue(workflow?.['bug_hunt_swarm_required']) ??
      booleanValue(workflow?.['require_swarm_for_bug_hunt']) ??
      DEFAULT_NORI_WORKFLOW_CONFIG.bugHuntSwarmRequired,
    preSwarmDocRequired: booleanValue(rules?.['pre_swarm_doc_required']),
    requireAnalysisNote: booleanValue(rules?.['require_analysis_note']),
    requireDecisionNote: booleanValue(rules?.['require_decision_note']),
    requireReviewNote: booleanValue(rules?.['require_pattern_note']),
  };
}

export function decideNoriWorkflowGate(
  config: NoriWorkflowConfig | undefined,
  activity: NoriWorkflowActivity,
): NoriWorkflowGateDecision | undefined {
  if (config === undefined) return undefined;

  if (
    (config.bugHuntSwarmRequired ?? true) &&
    hasNoriBugHuntIntent(activity.userPromptText) &&
    activity.agentSwarmCount <= 0 &&
    activity.noriSwarmLaunchCount <= 0
  ) {
    return {
      kind: 'bug_hunt_swarm',
      phase: 'review',
      mode: 'required',
      requiredTool: 'AgentSwarm',
      reason: 'the user asked for bug hunting, failure diagnosis, review, or broad problem finding',
    };
  }

  if (
    config.memorySearchRequired === true &&
    hasImplementationActivity(activity) &&
    activity.memorySearchCount <= 0
  ) {
    return {
      kind: 'memory_search',
      phase: 'plan',
      mode: 'required',
      requiredTool: 'nori_memory_search',
      reason: 'configured workflow requires memory retrieval before implementation work',
    };
  }

  const review = decideNoriReviewGate(config, activity);
  if (review === undefined) return undefined;
  return {
    kind: 'review',
    phase: 'review',
    mode: review.mode,
    reason: review.reason,
    review,
  };
}

export function hasNoriBugHuntIntent(text: string): boolean {
  return /(?:\bbugs?\b|\bdebug(?:ging)?\b|\bfailure\b|\bfailing\b|\bregression\b|\bdiagnos(?:e|is|tic)\b|\breview\b|\baudit\b|\bblack\s*screen\b|\brender(?:ing)?\s+pipeline\b|\bpermission\s+(?:bug|issue|problem|failure)\b|找\s*bug|查\s*bug|有\s*bug|修\s*bug|排查|诊断|回归|黑屏|渲染管线|权限(?:配置)?(?:混乱|问题|失效|错误)|审查|代码审计|找问题|多个问题)/i
    .test(text);
}

export function decideNoriReviewGate(
  config: NoriWorkflowConfig | undefined,
  activity: NoriReviewActivity,
): NoriReviewGateDecision | undefined {
  if (config === undefined) return undefined;

  if (activity.noriSwarmLaunchCount > 0 && activity.noriSwarmResultCheckCount <= 0) {
    return {
      mode: 'required',
      score: Math.max(
        config.reviewRequiredThreshold,
        scoreNoriReviewDifficulty(activity),
      ),
      suggestionThreshold: config.reviewSuggestionThreshold,
      requiredThreshold: config.reviewRequiredThreshold,
      reason: 'nori_swarm_launch was used but its result/status was not checked',
    };
  }

  if (!hasImplementationActivity(activity)) return undefined;

  const score = scoreNoriReviewDifficulty(activity);
  if (score >= config.reviewRequiredThreshold) {
    return {
      mode: 'required',
      score,
      suggestionThreshold: config.reviewSuggestionThreshold,
      requiredThreshold: config.reviewRequiredThreshold,
      reason: 'observed implementation complexity reached the required review threshold',
    };
  }
  if (score >= config.reviewSuggestionThreshold) {
    return {
      mode: 'suggested',
      score,
      suggestionThreshold: config.reviewSuggestionThreshold,
      requiredThreshold: config.reviewRequiredThreshold,
      reason: 'observed implementation complexity reached the suggested review threshold',
    };
  }
  return undefined;
}

export function scoreNoriReviewDifficulty(activity: NoriReviewActivity): number {
  const changedFiles = activity.filesCreated + activity.filesModified;
  let score = 0;

  score += Math.min(6, changedFiles * 2);
  score += Math.min(2, activity.filesCreated);
  score += Math.min(2, activity.shellCommandCount);
  score += Math.min(3, activity.agentSwarmCount * 3);
  if (
    changedFiles > 0 &&
    activity.testFilesCreated <= 0 &&
    activity.verificationCommandCount <= 0
  ) {
    score += 2;
  }
  if (changedFiles >= 3) {
    score += 1;
  }

  return clampInteger(score, 0, 10);
}

function hasImplementationActivity(activity: NoriReviewActivity): boolean {
  return (
    activity.filesCreated > 0 ||
    activity.filesModified > 0 ||
    activity.agentSwarmCount > 0 ||
    activity.noriSwarmLaunchCount > 0
  );
}

function hasWorkflowToolStep(
  noriConfig: Record<string, unknown>,
  phaseName: string,
  handlerName: string,
): boolean | undefined {
  const phases = noriConfig['phases'];
  if (!Array.isArray(phases)) return undefined;
  for (const phase of phases) {
    const phaseRecord = asRecord(phase);
    if (phaseRecord?.['name'] !== phaseName) continue;
    if (stepsIncludeHandler(phaseRecord['steps'], handlerName)) return true;
  }
  return undefined;
}

function stepsIncludeHandler(steps: unknown, handlerName: string): boolean {
  if (!Array.isArray(steps)) return false;
  return steps.some((step) => {
    const stepRecord = asRecord(step);
    return stepRecord?.['handler'] === handlerName || stepRecord?.['command'] === handlerName;
  });
}

function hasEnforcedRule(rawDefinitions: unknown, ruleName: string): boolean | undefined {
  if (!Array.isArray(rawDefinitions)) return undefined;
  for (const rule of rawDefinitions) {
    const record = asRecord(rule);
    if (record?.['name'] !== ruleName) continue;
    return booleanValue(record['enforced']) ?? true;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function clampScore(value: number): number {
  return clampInteger(Math.round(value), 0, 10);
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
