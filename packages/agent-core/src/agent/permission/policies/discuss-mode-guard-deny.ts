import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

const DISCUSS_DENIED_TOOLS = new Set([
  'Write',
  'Edit',
  'Bash',
  'SubAgent',
  'TaskStop',
  'CronCreate',
  'CronDelete',
]);

export class DiscussModeGuardDenyPermissionPolicy implements PermissionPolicy {
  readonly name = 'discuss-mode-guard-deny';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (!this.agent.discussMode.isActive) return;
    const toolName = context.toolCall.name;
    if (!DISCUSS_DENIED_TOOLS.has(toolName)) return;

    return {
      kind: 'deny',
      message:
        toolName === 'TaskStop'
          ? 'TaskStop is not available in Discuss. Call TeamAssign or leave Discuss first.'
          : toolName === 'CronCreate' || toolName === 'CronDelete'
            ? `${toolName} is not available in Discuss because it would mutate scheduled work. Call TeamAssign or leave Discuss first.`
            : `Discuss is active. ${toolName} is blocked so the meeting stays read-only. Use Read, Grep, and Glob, then TeamAssign to enter Code.`,
    };
  }
}
