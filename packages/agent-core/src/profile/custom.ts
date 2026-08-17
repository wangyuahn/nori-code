import type { CustomAgentConfig } from '../config';
import type { ResolvedAgentProfile } from './types';

export function configuredSubagentProfiles(
  builtins: Record<string, ResolvedAgentProfile> | undefined,
  configured: Record<string, CustomAgentConfig> | undefined,
): Record<string, ResolvedAgentProfile> | undefined {
  if (!configured || Object.keys(configured).length === 0) return builtins;
  const profiles = { ...builtins };
  const toolPool = [...new Set(Object.values(builtins ?? {}).flatMap(profile => profile.tools))];
  for (const [name, value] of Object.entries(configured)) {
    if (value.enabled === false) continue;
    const base = builtins?.[value.baseProfile];
    if (!base) continue;
    profiles[name] = {
      ...base,
      name,
      description: value.description,
      whenToUse: value.description,
      modelAlias: value.model,
      tools: filterTools(base.tools, toolPool, value.permissions),
      systemPrompt: context => `${base.systemPrompt(context)}\n\n<custom_agent_role>\n${value.role}\n</custom_agent_role>`,
    };
  }
  return profiles;
}

export function renderConfiguredAgentList(
  configured: Record<string, CustomAgentConfig> | undefined,
): string {
  if (configured === undefined) return '';
  const entries = Object.entries(configured).filter(([, value]) => value.enabled !== false);
  if (entries.length === 0) return '';
  return [
    '<available_custom_agents>',
    ...entries.map(([name, value]) => {
      const permissions = Object.entries(value.permissions ?? {})
        .filter(([, enabled]) => enabled === true)
        .map(([permission]) => permission)
        .join(', ') || 'base profile defaults';
      return [
        `<agent name="${escapeAttribute(name)}" base_profile="${escapeAttribute(value.baseProfile)}" model="${escapeAttribute(value.model ?? 'inherit-parent')}">`,
        `Description: ${value.description}`,
        `Role: ${value.role}`,
        `Model: ${value.model ?? 'inherit parent model'}`,
        `Permissions: ${permissions}`,
        '</agent>',
      ].join('\n');
    }),
    '</available_custom_agents>',
  ].join('\n');
}

function filterTools(baseTools: string[], toolPool: string[], permissions: CustomAgentConfig['permissions']): string[] {
  if (!permissions) return [...baseTools];
  const groups: Record<keyof NonNullable<CustomAgentConfig['permissions']>, Set<string>> = {
    read: new Set(['Read', 'Grep', 'Glob', 'ReadMediaFile', 'nori_memory_search']),
    write: new Set(['Write', 'Edit', 'nori_memory_write', 'nori_memory_remove', 'nori_plan_write']),
    shell: new Set(['Bash', 'TaskList', 'TaskOutput', 'TaskStop']),
    web: new Set(['WebSearch', 'FetchURL', 'Browser']),
    delegate: new Set(['Agent', 'AgentSwarm', 'AgentSwarmControl', 'nori_swarm_launch', 'nori_swarm_status', 'nori_swarm_result']),
  };
  const category = (tool: string) => Object.entries(groups).find(([, names]) => names.has(tool))?.[0] as keyof NonNullable<CustomAgentConfig['permissions']> | undefined;
  return toolPool.filter(tool => {
    const key = category(tool);
    return key === undefined ? baseTools.includes(tool) : permissions[key] === true;
  });
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
