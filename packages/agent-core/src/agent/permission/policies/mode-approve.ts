import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyResult } from '../types';

export class ModeApprovePermissionPolicy implements PermissionPolicy {
  readonly name: string;

  constructor(
    private readonly agent: Agent,
    private readonly mode: string,
    policyName?: string,
  ) {
    this.name = policyName ?? `${mode}-mode-approve`;
  }

  evaluate(): PermissionPolicyResult | undefined {
    if (this.agent.permission.mode !== this.mode) return;
    return {
      kind: 'approve',
    };
  }
}
