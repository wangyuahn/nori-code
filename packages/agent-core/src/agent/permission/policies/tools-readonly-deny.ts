import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

const READONLY_DENIED_TOOLS = new Set(['Write', 'Edit']);

export class ReadonlyPermissionPolicy implements PermissionPolicy {
  readonly name = 'tools-readonly-deny';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (!this.agent.permission.toolsReadonly) return;
    if (!READONLY_DENIED_TOOLS.has(context.toolCall.name)) return;
    // `/setting coder write` unlocks coding subagents / team members that
    // inherited a read-only profile. It must never let the main Agent bypass
    // `/setting readonly` — that switch is main-only.
    if (this.agent.coderWriteEnabled && this.agent.type !== 'main') return;
    const toolName = context.toolCall.name;
    return {
      kind: 'deny',
      message:
        this.agent.type === 'main'
          ? `Tool "${toolName}" is blocked while readonly is on. Assign the work with TeamAssign, or run \`/setting readonly off\` if the main Agent should write directly.`
          : `Tool "${toolName}" is not available because tools are set to readonly.`,
    };
  }
}
