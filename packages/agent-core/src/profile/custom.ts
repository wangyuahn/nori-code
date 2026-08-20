import type { CustomAgentConfig } from '../config';

/**
 * Render the user-configured role catalog into the system prompt.
 *
 * These are role templates a lead hires team members from — a name, what the
 * role is for, and which capabilities it should get. They are not separate
 * agent profiles: a hired member runs the same profile as everyone else and
 * takes its identity from the role it was hired into.
 */
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

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
