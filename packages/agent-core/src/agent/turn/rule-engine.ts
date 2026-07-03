/* ------------------------------------------------------------------ */
/*  RuleEngine — Nori rule prompts integrated into agent-core           */
/*                                                                     */
/*  按条件激活自定义规则，并生成可注入 LLM 上下文的规则 prompt。         */
/*  规则配置来自 NoriConfig.rules.definitions。                         */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

export interface RuleCondition {
  type: 'always' | 'on_phase' | 'on_tool' | 'on_event';
  phase?: string;
  /** 'enter'|'exit' for on_phase, 'before'|'after' for on_tool */
  stage?: 'enter' | 'exit' | 'before' | 'after';
  tool?: string;
  event?: string;
}

export interface RuleConfig {
  name: string;
  description: string;
  condition: RuleCondition;
  prompt: string;
  enforced: boolean;
  editable: boolean;
}

export interface RulesConfig {
  preSwarmDocRequired: boolean;
  requireAnalysisNote: boolean;
  requireDecisionNote: boolean;
  requirePatternNote: boolean;
  definitions: RuleConfig[];
}

export interface RuleContext {
  /** Name of the current phase, if applicable. */
  currentPhase?: string;
  /** Whether the phase is being entered or exited. */
  phaseStage?: 'enter' | 'exit';
  /** Name of the tool being invoked, if applicable. */
  currentTool?: string;
  /** Whether the tool is about to run or has just run. */
  toolStage?: 'before' | 'after';
  /** Name of the event that was emitted, if applicable. */
  event?: string;
}

/* ------------------------------------------------------------------ */
/*  RuleEngine                                                          */
/* ------------------------------------------------------------------ */

export class RuleEngine {
  private rules: RuleConfig[];

  constructor(rules: RuleConfig[] = []) {
    this.rules = rules;
  }

  /**
   * Return all rules whose conditions match the given context.
   * Rules are returned in definition order; enforced rules come first.
   */
  getActivatedRules(context: RuleContext): RuleConfig[] {
    const matched = this.rules.filter((rule) =>
      this.checkPreCondition(rule, context),
    );

    // Enforced rules first, then non-enforced; preserve relative order.
    return matched.sort((a, b) => {
      if (a.enforced === b.enforced) return 0;
      return a.enforced ? -1 : 1;
    });
  }

  /**
   * Check whether a single rule's condition is satisfied by the context.
   */
  checkPreCondition(rule: RuleConfig, context: RuleContext): boolean {
    return checkCondition(rule.condition, context);
  }

  /**
   * Build the combined prompt block for a set of activated rules.
   * The returned string is ready for injection into the LLM context.
   */
  getRulePrompt(rules: RuleConfig[]): string {
    if (rules.length === 0) return '';

    const enforcedRules = rules.filter((r) => r.enforced);
    const advisoryRules = rules.filter((r) => !r.enforced);

    const blocks: string[] = [];

    if (enforcedRules.length > 0) {
      const lines = enforcedRules.map(
        (r) =>
          `- **${r.name}** (enforced): ${r.prompt}${r.editable ? '' : ' [not user-editable]'}`,
      );
      blocks.push(
        '<system>\n' +
          'The following **mandatory rules** are active. You MUST follow them:\n' +
          lines.join('\n') +
          '\n</system>',
      );
    }

    if (advisoryRules.length > 0) {
      const lines = advisoryRules.map(
        (r) => `- **${r.name}** (advisory): ${r.prompt}`,
      );
      blocks.push(
        '<system>\n' +
          'The following **advisory rules** are active. Follow them when applicable:\n' +
          lines.join('\n') +
          '\n</system>',
      );
    }

    return blocks.join('\n\n');
  }

  /**
   * Return all registered rule definitions for audit / display.
   */
  getAllRules(): RuleConfig[] {
    return [...this.rules];
  }
}

/* ------------------------------------------------------------------ */
/*  Condition evaluation                                                */
/* ------------------------------------------------------------------ */

function checkCondition(
  condition: RuleCondition,
  context: RuleContext,
): boolean {
  switch (condition.type) {
    case 'always':
      return true;

    case 'on_phase':
      if (context.currentPhase !== condition.phase) return false;
      if (condition.stage && context.phaseStage !== (condition.stage as 'enter' | 'exit')) return false;
      return true;

    case 'on_tool':
      if (context.currentTool !== condition.tool) return false;
      if (condition.stage && context.toolStage !== (condition.stage as 'before' | 'after')) return false;
      return true;

    case 'on_event':
      return context.event === condition.event;

    default:
      return false;
  }
}
