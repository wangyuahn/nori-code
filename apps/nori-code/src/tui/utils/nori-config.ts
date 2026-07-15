import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A single rule entry from nori.yaml.
 * Keys are stored as they appear in the YAML file (snake_case).
 */
export interface RuleEntry {
  /** Whether the rule is active. */
  enabled: boolean;
  /** The prompt template string for the rule. */
  promptTemplate: string;
}

/** Parsed rules section from nori.yaml. Keys are snake_case, matching the YAML file. */
export interface ParsedRules {
  [ruleName: string]: RuleEntry;
}

/** Built-in note-writing rule flags stored at the top level of the rules block. */
export interface NoteRuleFlags {
  requireAnalysisNote: boolean;
  requireDecisionNote: boolean;
  requirePatternNote: boolean;
}

/** YAML key → JS property mapping for note rule flags. */
const NOTE_FLAG_KEYS: Record<keyof NoteRuleFlags, string> = {
  requireAnalysisNote: 'require_analysis_note',
  requireDecisionNote: 'require_decision_note',
  requirePatternNote: 'require_pattern_note',
};

function resolvePath(cwd: string): string {
  return join(cwd, 'nori.yaml');
}

// ---------------------------------------------------------------------------
//  Simple YAML subset parser — scoped to the rules section only
// ---------------------------------------------------------------------------

/**
 * Parse the rules section from a nori.yaml string.
 *
 * Format:
 *   rules:
 *     rule_name_here:
 *       enabled: true|false
 *       prompt_template: "the template string"
 */
function parseRules(raw: string): ParsedRules {
  const result: ParsedRules = {};

  // Locate the "rules:" block — from the line starting with "rules:" until
  // the next top-level key or end of file.
  const rulesMatch = raw.match(/^rules:\s*\n([\s\S]*?)(?:^[a-z]|^$)/m);
  if (!rulesMatch) return result;

  const block = rulesMatch[1] ?? '';

  // Each rule entry: indent-2 key, then indent-4 key:value lines.
  const entryRegex = /^\s{2}(\w[\w-]*?):\s*\n((?:\s{4}.+\n?)+)/gm;
  let entryMatch: RegExpExecArray | null;
  while ((entryMatch = entryRegex.exec(block)) !== null) {
    const key = entryMatch[1]!; // snake_case, as in YAML
    const body = entryMatch[2]!;

    const enabledMatch = /^\s{4}enabled:\s*(true|false)/m.exec(body);
    const promptMatch = /^\s{4}prompt_template:\s*["'](.+?)["']/m.exec(body);

    result[key] = {
      enabled: enabledMatch?.[1] === 'true',
      promptTemplate: promptMatch?.[1] ?? '',
    };
  }

  return result;
}

/**
 * Serialize the rules object back to YAML text.
 */
function formatRules(rules: ParsedRules): string {
  if (Object.keys(rules).length === 0) return 'rules: {}\n';
  const lines: string[] = ['rules:'];
  for (const [key, rule] of Object.entries(rules)) {
    lines.push(`  ${key}:`);
    lines.push(`    enabled: ${rule.enabled}`);
    lines.push(`    prompt_template: '${escapedPrompt(rule.promptTemplate)}'`);
  }
  return lines.join('\n') + '\n';
}

function escapedPrompt(text: string): string {
  // Use double-quote wrapping; escape embedded single quotes and backslashes.
  if (!text.includes("'") && !text.includes('\\')) return text;
  return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// ---------------------------------------------------------------------------
//  Public API
// ---------------------------------------------------------------------------

/**
 * Load the rules section from the nori.yaml file in `cwd`.
 * Returns an empty object when the file is missing or has no rules section.
 */
export function loadNoriRules(cwd: string): ParsedRules {
  const filePath = resolvePath(cwd);
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, 'utf-8');
  return parseRules(raw);
}

/**
 * Write the full rules section back to nori.yaml.
 * Preserves the rest of the file; replaces the rules block in-place.
 * When the file does not exist a minimal nori.yaml is created.
 */
export function saveNoriRules(cwd: string, rules: ParsedRules): void {
  const filePath = resolvePath(cwd);
  const rulesYaml = formatRules(rules);

  if (!existsSync(filePath)) {
    writeFileSync(filePath, `# nori.yaml\n\n${rulesYaml}`, 'utf-8');
    return;
  }

  let raw = readFileSync(filePath, 'utf-8');

  // Replace the existing rules block: from "rules:" line through to the
  // next top-level key, a blank-line terminator, or end of file.
  const rulesRegex = /^rules:[\t ]*\n[\s\S]*?(?=\n[a-z]|(?:\r?\n)*$)/m;
  if (rulesRegex.test(raw)) {
    raw = raw.replace(rulesRegex, rulesYaml.replace(/\n$/, ''));
  } else {
    raw = raw.trimEnd() + '\n' + rulesYaml;
  }

  writeFileSync(filePath, raw, 'utf-8');
}

/**
 * Update a single rule's prompt template in-place.
 * Returns the full rules object after the update, or null if the rule
 * was not found.
 */
export function updateRulePrompt(
  cwd: string,
  ruleName: string,
  promptTemplate: string,
): ParsedRules | null {
  const rules = loadNoriRules(cwd);
  const current = rules[ruleName];
  if (current === undefined) return null;
  rules[ruleName] = { ...current, promptTemplate };
  saveNoriRules(cwd, rules);
  return rules;
}

// ---------------------------------------------------------------------------
//  Note rule flags — simple boolean flags under the rules: block
// ---------------------------------------------------------------------------

/**
 * Parse the note-writing rule flags from the rules block in nori.yaml.
 * Defaults to false when the file or rules block is missing.
 */
export function loadNoteRuleFlags(cwd: string): NoteRuleFlags {
  const filePath = resolvePath(cwd);
  const flags: NoteRuleFlags = {
    requireAnalysisNote: false,
    requireDecisionNote: false,
    requirePatternNote: false,
  };

  if (!existsSync(filePath)) return flags;

  const raw = readFileSync(filePath, 'utf-8');

  for (const [prop, yamlKey] of Object.entries(NOTE_FLAG_KEYS)) {
    const re = new RegExp(`^\\s{2}${yamlKey}:\\s*(true|false)\\s*$`, 'm');
    const m = raw.match(re);
    if (m) {
      flags[prop as keyof NoteRuleFlags] = m[1] === 'true';
    }
  }

  return flags;
}

/**
 * Set a single note-writing rule flag in nori.yaml.
 * Creates the file with a minimal rules block when it does not exist.
 */
export function setNoteRuleFlag(
  cwd: string,
  flagName: keyof NoteRuleFlags,
  value: boolean,
): void {
  const filePath = resolvePath(cwd);
  const yamlKey = NOTE_FLAG_KEYS[flagName];

  if (!existsSync(filePath)) {
    writeFileSync(
      filePath,
      `# nori.yaml\n\nrules:\n  ${yamlKey}: ${value}\n`,
      'utf-8',
    );
    return;
  }

  let raw = readFileSync(filePath, 'utf-8');
  const lineRe = new RegExp(`^(\\s{2})${yamlKey}:\\s*(?:true|false)\\s*$`, 'm');

  if (lineRe.test(raw)) {
    raw = raw.replace(lineRe, `$1${yamlKey}: ${value}`);
  } else {
    // Find the rules block and insert the line after the "rules:" line
    const rulesHeaderRe = /^(rules:)\s*\n/m;
    const match = rulesHeaderRe.exec(raw);
    if (match) {
      const insertAt = match.index + match[0].length;
      raw = raw.slice(0, insertAt) + `  ${yamlKey}: ${value}\n` + raw.slice(insertAt);
    } else {
      // No rules block — append one at the end
      raw = raw.trimEnd() + `\n\nrules:\n  ${yamlKey}: ${value}\n`;
    }
  }

  writeFileSync(filePath, raw, 'utf-8');
}

// ---------------------------------------------------------------------------
//  Workflow config — persisted under workflow: in nori.yaml (top level)
// ---------------------------------------------------------------------------

export interface WorkflowConfig {
  reviewSuggestionThreshold: number;
  reviewRequiredThreshold: number;
  maxReviewGateContinuations: number;
  bugHuntSwarmRequired: boolean;
}

export const DEFAULT_WORKFLOW_CONFIG: WorkflowConfig = {
  reviewSuggestionThreshold: 4,
  reviewRequiredThreshold: 7,
  maxReviewGateContinuations: 2,
  bugHuntSwarmRequired: true,
};

/**
 * Load workflow config from nori.yaml's top-level workflow: section.
 * Agent-core resolveNoriWorkflowConfig reads workflow.review_suggestion_threshold
 * (flat top-level format) as a fallback path after workflow.review.* (nested).
 */
export function loadWorkflowConfig(cwd: string): WorkflowConfig {
  const filePath = resolvePath(cwd);
  const config = { ...DEFAULT_WORKFLOW_CONFIG };

  if (!existsSync(filePath)) return config;

  const raw = readFileSync(filePath, 'utf-8');

  // Parse top-level workflow: block (0-indent key, 2-indent values)
  const wfMatch = raw.match(/^workflow:\s*\n((?:\s{2}.+\n?)+)/m);
  if (!wfMatch) return config;

  const block = wfMatch[1];
  if (block === undefined) return config;

  const intMatch = (key: string): number | undefined => {
    const m = new RegExp(`^\\s{2}${key}:\\s*(\\d+)`, 'm').exec(block);
    if (!m || m[1] === undefined) return undefined;
    return parseInt(m[1], 10);
  };
  const boolMatch = (key: string): boolean | undefined => {
    const m = new RegExp(`^\\s{2}${key}:\\s*(true|false)`, 'm').exec(block);
    if (!m || m[1] === undefined) return undefined;
    return m[1] === 'true';
  };

  const st = intMatch('review_suggestion_threshold');
  if (st !== undefined) config.reviewSuggestionThreshold = st;
  const rt = intMatch('review_required_threshold');
  if (rt !== undefined) config.reviewRequiredThreshold = rt;
  const mgc = intMatch('max_review_gate_continuations');
  if (mgc !== undefined) config.maxReviewGateContinuations = mgc;
  const bhs = boolMatch('bug_hunt_swarm_required');
  if (bhs !== undefined) config.bugHuntSwarmRequired = bhs;

  return config;
}

/**
 * Save workflow config to nori.yaml's top-level workflow: section.
 * Uses the flat format (workflow.review_suggestion_threshold) that
 * agent-core resolveNoriWorkflowConfig supports as a fallback path.
 */
export function saveWorkflowConfig(cwd: string, config: WorkflowConfig): void {
  const filePath = resolvePath(cwd);

  const wfYaml = [
    'workflow:',
    `  review_suggestion_threshold: ${config.reviewSuggestionThreshold}`,
    `  review_required_threshold: ${config.reviewRequiredThreshold}`,
    `  max_review_gate_continuations: ${config.maxReviewGateContinuations}`,
    `  bug_hunt_swarm_required: ${config.bugHuntSwarmRequired}`,
    '',
  ].join('\n');

  if (!existsSync(filePath)) {
    writeFileSync(filePath, `# nori.yaml\n\n${wfYaml}`, 'utf-8');
    return;
  }

  let raw = readFileSync(filePath, 'utf-8');

  // Replace existing top-level workflow block
  const wfRegex = /^workflow:\s*\n(?:\s{2}.+\n?)+/m;
  if (wfRegex.test(raw)) {
    raw = raw.replace(wfRegex, wfYaml);
  } else {
    // No workflow block — append at end of file
    raw = raw.trimEnd() + '\n' + wfYaml;
  }

  writeFileSync(filePath, raw, 'utf-8');
}
