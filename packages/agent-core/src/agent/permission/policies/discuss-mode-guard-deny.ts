import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

const DISCUSS_DENIED_TOOLS = new Set([
  'Write',
  'Edit',
  'Bash',
  'TaskStop',
  'CronCreate',
  'CronDelete',
]);

export class DiscussModeGuardDenyPermissionPolicy implements PermissionPolicy {
  readonly name = 'discuss-mode-guard-deny';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const chairing = this.agent.discussMode.isActive;
    if (!chairing && !this.agent.teamWriteLocked) return;
    const toolName = context.toolCall.name;
    if (!DISCUSS_DENIED_TOOLS.has(toolName)) return;

    // Two different agents land here and need different instructions. The chair
    // is in Discuss and holds the exit (TeamAssign). A member is only
    // write-locked because its lead is meeting; telling it to "call TeamAssign"
    // sends it after a tool it does not have.
    const exit = chairing
      ? 'Call TeamAssign or leave Discuss first.'
      : 'Your lead is in Discuss; writes resume once it assigns work.';

    return {
      kind: 'deny',
      message:
        toolName === 'TaskStop'
          ? `TaskStop is not available while team writes are locked. ${exit}`
          : toolName === 'CronCreate' || toolName === 'CronDelete'
            ? `${toolName} is not available while team writes are locked because it would mutate scheduled work. ${exit}`
            : chairing
              ? `Discuss is active. ${toolName} is blocked so the meeting stays read-only. Use Read, Grep, and Glob, then TeamAssign to enter Code.`
              : `${toolName} is blocked: your lead is in Discuss, so the department is read-only until it assigns work. Use Read, Grep, and Glob meanwhile.`,
    };
  }
}
