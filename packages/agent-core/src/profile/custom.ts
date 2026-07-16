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
      tools: filterTools(base.tools, toolPool, value.permissions),
      systemPrompt: context => `${base.systemPrompt(context)}\n\n<custom_agent_role>\n${value.role}\n</custom_agent_role>`,
    };
  }
  return profiles;
}

function filterTools(baseTools: string[], toolPool: string[], permissions: CustomAgentConfig['permissions']): string[] {
  if (!permissions) return [...baseTools];
  const groups: Record<keyof NonNullable<CustomAgentConfig['permissions']>, Set<string>> = {
    read: new Set(['Read', 'Grep', 'Glob', 'ReadMediaFile', 'nori_memory_search']),
    write: new Set(['Write', 'Edit', 'nori_memory_write', 'nori_memory_remove', 'nori_plan_write']),
    shell: new Set(['Bash', 'TaskList', 'TaskOutput', 'TaskStop']),
    web: new Set(['WebSearch', 'FetchURL']),
    delegate: new Set(['Agent', 'AgentSwarm', 'AgentSwarmControl', 'nori_swarm_launch', 'nori_swarm_status', 'nori_swarm_result']),
  };
  const category = (tool: string) => Object.entries(groups).find(([, names]) => names.has(tool))?.[0] as keyof NonNullable<CustomAgentConfig['permissions']> | undefined;
  return toolPool.filter(tool => {
    const key = category(tool);
    return key === undefined ? baseTools.includes(tool) : permissions[key] === true;
  });
}
