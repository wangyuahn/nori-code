import { renderPrompt } from '../utils/render-prompt';
import TEAM_ENGINEERING_PROMPT from './default/team-engineering.md?raw';
import type {
  RawAgentProfile,
  ResolvedAgentProfile,
  SystemPromptContext,
  SystemPromptRenderer,
} from './types';

interface MergedAgentProfile {
  readonly name: string;
  readonly description?: string | undefined;
  readonly systemPromptTemplate: string;
  readonly promptVars: Record<string, string>;
  readonly tools: string[];
  readonly toolsReadonly?: boolean | undefined;
  readonly whenToUse?: string | undefined;
}

/**
 * Resolve agent profiles with extends inheritance.
 *
 * Each resolved profile exposes its `systemPrompt` as a renderer that
 * closes over the merged template and prompt vars. The renderer is
 * invoked later with a {@link SystemPromptContext} to produce the
 * concrete prompt — this lets context that only exists at runtime
 * (cwd listing, AGENTS.md, skills) flow through without re-loading
 * profiles.
 */
export function resolveAgentProfiles(
  raw: readonly RawAgentProfile[],
): Record<string, ResolvedAgentProfile> {
  const profileMap = new Map<string, RawAgentProfile>();
  const mergedCache = new Map<string, MergedAgentProfile>();
  const result: Record<string, ResolvedAgentProfile> = {};

  for (const profile of raw) {
    if (profileMap.has(profile.name)) {
      throw new Error(`Duplicate agent profile name: "${profile.name}"`);
    }
    profileMap.set(profile.name, profile);
  }

  for (const profile of raw) {
    const merged = resolveMergedProfile(profile.name, profileMap, mergedCache, []);
    result[profile.name] = toResolvedProfile(merged);
  }

  return result;
}

function resolveMergedProfile(
  name: string,
  profileMap: Map<string, RawAgentProfile>,
  cache: Map<string, MergedAgentProfile>,
  stack: string[],
): MergedAgentProfile {
  const cached = cache.get(name);
  if (cached !== undefined) {
    return cached;
  }

  const cycleIndex = stack.indexOf(name);
  if (cycleIndex !== -1) {
    const cycle = [...stack.slice(cycleIndex), name].join(' -> ');
    throw new Error(`Agent profile extends cycle detected: ${cycle}`);
  }

  const profile = profileMap.get(name);
  if (profile === undefined) {
    throw new Error(`Agent profile "${name}" not found`);
  }

  let parent: MergedAgentProfile | undefined;
  if (profile.extends !== undefined) {
    if (!profileMap.has(profile.extends)) {
      throw new Error(
        `Agent profile "${profile.name}" extends "${profile.extends}" but parent profile was not found`,
      );
    }
    parent = resolveMergedProfile(profile.extends, profileMap, cache, [...stack, name]);
  }

  const merged: MergedAgentProfile = {
    name: profile.name,
    description: profile.description,
    systemPromptTemplate: profile.systemPromptTemplate ?? parent?.systemPromptTemplate ?? '',
    promptVars: {
      ...parent?.promptVars,
      ...profile.promptVars,
    },
    tools: profile.tools !== undefined ? [...profile.tools] : [...(parent?.tools ?? [])],
    toolsReadonly: profile.tools_readonly ?? parent?.toolsReadonly,
    whenToUse: profile.whenToUse ?? parent?.whenToUse,
  };

  cache.set(profile.name, merged);
  return merged;
}

function toResolvedProfile(merged: MergedAgentProfile): ResolvedAgentProfile {
  return {
    name: merged.name,
    description: merged.description,
    systemPrompt: createSystemPromptRenderer(merged),
    tools: [...merged.tools],
    toolsReadonly: merged.toolsReadonly,
    whenToUse: merged.whenToUse,
  };
}

/**
 * Build a renderer that captures the merged template and prompt vars.
 * The runtime SystemPromptContext is mapped to the template variables
 * (KIMI_OS, KIMI_AGENTS_MD, ...) at render time.
 *
 * Every agent — the root lead and every team member, at any depth — runs the
 * same Team Engineering operating rules, because every node can lead a
 * department of its own.
 */
function createSystemPromptRenderer(merged: MergedAgentProfile): SystemPromptRenderer {
  return (context: SystemPromptContext): string => {
    const vars = buildTemplateVars(context, merged.promptVars, merged.tools);
    try {
      return [
        renderPrompt(TEAM_ENGINEERING_PROMPT, vars).trim(),
        renderPrompt(merged.systemPromptTemplate, vars),
      ]
        .filter(Boolean)
        .join('\n\n');
    } catch (error) {
      throw new Error(
        `Failed to render system prompt for agent profile "${merged.name}": ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  };
}

function buildTemplateVars(
  context: SystemPromptContext,
  promptVars: Record<string, string>,
  tools: readonly string[],
): Record<string, string> {
  const skills =
    typeof context.skills === 'string'
      ? context.skills
      : (context.skills?.getModelSkillListing() ?? '');
  const now =
    context.now instanceof Date
      ? context.now.toISOString()
      : (context.now ?? new Date().toISOString());

  return {
    ...promptVars,
    KIMI_OS: context.osEnv.osKind,
    KIMI_SHELL: `${context.osEnv.shellName} (\`${context.osEnv.shellPath}\`)`,
    KIMI_NOW: now,
    KIMI_WORK_DIR: context.cwd,
    KIMI_WORK_DIR_LS: context.cwdListing ?? '',
    KIMI_AGENTS_MD: context.agentsMd ?? '',
    KIMI_SKILLS: tools.includes('Skill') ? skills : '',
    KIMI_ADDITIONAL_DIRS_INFO: context.additionalDirsInfo ?? '',
    KIMI_CUSTOM_AGENTS: context.customAgentsInfo ?? '',
    ROLE_ADDITIONAL:
      context.roleAdditional ?? promptVars['ROLE_ADDITIONAL'] ?? promptVars['roleAdditional'] ?? '',

    // NORI: 新增模板变量
    KIMI_NORI_PHASE: context.noriPhase ?? '',
    KIMI_NORI_VAULT_PATH: context.noriVaultPath ?? '',
    KIMI_NORI_TOOL_HINTS: context.noriToolHints ?? '',
  };
}
