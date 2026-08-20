import agentYaml from './default/agent.yaml?raw';
import initMd from './default/init.md?raw';
import noriAgentYaml from './default/nori-agent.yaml?raw';
import noriCoderYaml from './default/nori-coder.yaml?raw';
import noriCoderSystemMd from './default/nori-coder-system.md?raw';
import noriSystemMd from './default/nori-system.md?raw';
import systemMd from './default/system.md?raw';
import { loadAgentProfilesFromSources } from './load';

// Keyed by the source path the profile loader expects: profile YAML files
// plus any file referenced through `systemPromptPath`.
const PROFILE_SOURCES: Record<string, string> = {
  'profile/default/agent.yaml': agentYaml,
  'profile/default/nori-agent.yaml': noriAgentYaml,
  'profile/default/nori-coder.yaml': noriCoderYaml,
  'profile/default/nori-coder-system.md': noriCoderSystemMd,
  'profile/default/nori-system.md': noriSystemMd,
  'profile/default/system.md': systemMd,
};

export const DEFAULT_INIT_PROMPT = initMd;

export const DEFAULT_AGENT_PROFILES = loadAgentProfilesFromSources(
  ['agent.yaml', 'nori-agent.yaml', 'nori-coder.yaml'].map(
    (file) => `profile/default/${file}`,
  ),
  PROFILE_SOURCES,
);
