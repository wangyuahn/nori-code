import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

const READONLY_DENIED_TOOLS = new Set(['Write', 'Edit']);

export class ReadonlyPermissionPolicy implements PermissionPolicy {
  readonly name = 'tools-readonly-deny';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (!this.agent.permission.toolsReadonly) return;
    if (this.agent.permission.mode !== 'manual') return;
    if (!READONLY_DENIED_TOOLS.has(context.toolCall.name)) return;
    // Persistent team members must receive an explicit TeamAssign before they
    // can write. This deliberate lock wins over the session-wide coder setting.
    if (this.agent.teamWriteLocked) {
      if (this.agent.teamWriteEnabled) return;
    } else if (this.agent.coderWriteEnabled) {
      return;
    }
    return {
      kind: 'deny',
      message: `Tool "${context.toolCall.name}" is not available because tools are set to readonly.`,
    };
  }
}
