/**
 * Pure rule-engine logic ported from nori's
 * `packages/agent-core/src/agent/turn/rule-engine.ts` and the loop phase
 * machine. Kept free of the Cordis context so behaviour tests cover the
 * decision surface directly.
 */

export type RuleConditionType = 'always' | 'on_phase' | 'on_tool' | 'on_event';

export interface RuleCondition {
  type: RuleConditionType;
  phase?: string;
  /** 'enter'|'exit' for on_phase, 'before'|'after' for on_tool. */
  stage?: 'enter' | 'exit' | 'before' | 'after';
  tool?: string;
  event?: string;
}

export interface RuleConfig {
  name: string;
  description?: string;
  condition: RuleCondition;
  prompt: string;
  enforced?: boolean;
  /** 'main', 'subagent', or 'agent_type:<type>'; empty = every agent. */
  targets?: string[];
}

export interface RuleContext {
  currentPhase?: string;
  phaseStage?: 'enter' | 'exit';
  currentTool?: string;
  toolStage?: 'before' | 'after';
  event?: string;
}

export function checkCondition(condition: RuleCondition, context: RuleContext): boolean {
  switch (condition.type) {
    case 'always':
      return true;
    case 'on_phase':
      if (context.currentPhase !== condition.phase) return false;
      if (condition.stage && context.phaseStage !== condition.stage) return false;
      return true;
    case 'on_tool':
      if (context.currentTool !== condition.tool) return false;
      if (condition.stage && context.toolStage !== condition.stage) return false;
      return true;
    case 'on_event':
      return context.event === condition.event;
    default:
      return false;
  }
}

export function ruleTargetsAgent(rule: RuleConfig, isSubagent: boolean, agentType: string | undefined): boolean {
  const targets = rule.targets;
  if (targets === undefined || targets.length === 0) return true;
  for (const raw of targets) {
    const t = String(raw);
    if (t === 'main' && !isSubagent) return true;
    if (t === 'subagent' && isSubagent) return true;
    if (t.startsWith('agent_type:') && isSubagent && agentType !== undefined && t.slice('agent_type:'.length) === agentType) {
      return true;
    }
  }
  return false;
}

export function renderRules(rules: RuleConfig[]): string {
  if (rules.length === 0) return '';
  const enforced = rules.filter((r) => r.enforced === true);
  const advisory = rules.filter((r) => r.enforced !== true);
  const blocks: string[] = [];
  if (enforced.length > 0) {
    blocks.push(
      `<system>\nThe following **mandatory rules** are active. You MUST follow them:\n${enforced
        .map((r) => `- **${r.name}** (enforced): ${r.prompt}`)
        .join('\n')}\n</system>`,
    );
  }
  if (advisory.length > 0) {
    blocks.push(
      `<system>\nThe following **advisory rules** are active. Follow them when applicable:\n${advisory
        .map((r) => `- **${r.name}** (advisory): ${r.prompt}`)
        .join('\n')}\n</system>`,
    );
  }
  return blocks.join('\n\n');
}

/**
 * Phase transition folding: Discuss active toggles discuss ⇄ implement;
 * review exits back to implement once Discuss is off.
 */
export function nextPhase(discussActive: boolean, wasActive: boolean, current: string): string {
  if (discussActive && !wasActive) return 'discuss';
  if (!discussActive && wasActive) return 'implement';
  if (discussActive) return 'discuss';
  if (current === 'review' && !discussActive) return 'implement';
  return current;
}

export interface PhaseSelection {
  /** Rules whose on_phase/on_tool condition matches the given context. */
  (rules: RuleConfig[], context: RuleContext): RuleConfig[];
}

export const selectPhaseRules: PhaseSelection = (rules, context) =>
  rules.filter((r) => checkCondition(r.condition, context));

export const selectToolRules: PhaseSelection = (rules, context) =>
  rules.filter((r) => checkCondition(r.condition, context));
