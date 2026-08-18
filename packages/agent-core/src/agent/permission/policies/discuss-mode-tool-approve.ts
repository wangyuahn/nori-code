import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

export class DiscussModeToolApprovePermissionPolicy implements PermissionPolicy {
  readonly name = 'discuss-mode-tool-approve';

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (context.toolCall.name !== 'EnterDiscussMode') return;
    return { kind: 'approve' };
  }
}
