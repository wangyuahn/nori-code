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
    // When coderWriteEnabled is true, allow Write/Edit even in read-only mode.
    // This is toggled by the user via /setting → Coder Write.
    if (this.agent.coderWriteEnabled) return;
    return {
      kind: 'deny',
      message: `Tool "${context.toolCall.name}" is not available because tools are set to readonly.`,
    };
  }
}
